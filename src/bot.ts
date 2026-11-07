import type { Logger } from 'pino';
import { makeAsk, Pseudonyms, type AskFn } from './ai.js';
import { helpText, parseCommand, type Command } from './commands.js';
import { normalizeIdForAlias, type AppConfig } from './config.js';
import type { Store } from './db.js';
import { generateJoke } from './joke.js';
import {
  buildDaily,
  buildOverview,
  buildWeekly,
  formatDaily,
  formatOverview,
  formatWeekly,
  type DailyStandings,
} from './leaderboard.js';
import { makeNameLookup } from './names.js';
import { buildRoastPrompt, findPlayers, generateRoast, ROAST_DAYS, type Candidate } from './roast.js';
import { ingestMessage, type IncomingMessage } from './scores.js';
import { addDays, dayKey, isSunday, minutesOfDay, weekStart } from './time.js';

/** What the bot needs from the chat transport. Implemented by WhatsAppClient (and fakes in tests). */
export interface Messenger {
  send(text: string): Promise<void>;
  /** All known ids (LID and phone JID) of current group members, or null if unknown. */
  memberIds(): Promise<Set<string> | null>;
}

export interface BotDeps {
  now?: () => Date;
  random?: () => number;
  /** Claude client; defaults to one built from the config (null without an API key). */
  ask?: AskFn | null;
}

/** Commands older than this are from a backlog (e.g. after a restart) and are not answered. */
const COMMAND_MAX_AGE_S = 120;
/** Minimum time between two answers to the same command. */
const COMMAND_COOLDOWN_MS = 30_000;
/** Number of calendar weeks in the !weken overview. */
const OVERVIEW_WEEKS = 6;

export class ScoreBot {
  private readonly lastAnswered = new Map<Command, number>();
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly ask: AskFn | null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly store: Store,
    private readonly messenger: Messenger,
    private readonly log: Logger,
    deps: BotDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.ask = deps.ask !== undefined ? deps.ask : makeAsk(cfg.ai, log);
  }

  get roastAvailable(): boolean {
    return this.cfg.ai.roast && this.ask !== null;
  }

  today(): string {
    return dayKey(this.now(), this.cfg.timezone);
  }

  /** Entry point for every message from the target group. */
  async handleGroupMessage(msg: IncomingMessage): Promise<void> {
    const parsed = parseCommand(msg.text);
    if (parsed) {
      await this.handleCommand(parsed.command, parsed.arg, msg.timestamp);
      return;
    }

    for (const r of ingestMessage(this.store, msg, this.cfg.timezone)) {
      const level = r.outcome === 'inserted' || r.outcome === 'replaced' ? 'info' : 'debug';
      this.log[level](
        { game: r.game, score: r.score, day: r.day, player: msg.pushName, outcome: r.outcome, reason: r.reason },
        r.outcome === 'stale' ? 'Ignored old result' : 'Score received',
      );
    }
  }

  private async handleCommand(command: Command, arg: string | undefined, timestamp: number): Promise<void> {
    const ageS = this.now().getTime() / 1000 - timestamp;
    if (ageS > COMMAND_MAX_AGE_S) {
      this.log.debug({ command, ageS }, 'Ignoring old command');
      return;
    }
    if (command === 'roast' && !this.roastAvailable) {
      this.log.info('Ignoring !roast: set ANTHROPIC_API_KEY (and keep ENABLE_ROAST on) to use it');
      return;
    }
    const last = this.lastAnswered.get(command) ?? 0;
    if (this.now().getTime() - last < COMMAND_COOLDOWN_MS) {
      this.log.debug({ command }, 'Command on cooldown');
      return;
    }
    this.lastAnswered.set(command, this.now().getTime());
    this.log.info({ command }, 'Answering command');

    const day = this.today();
    let text: string | null;
    if (command === 'stand') text = formatDaily(await this.daily(day), { final: false });
    else if (command === 'week') text = formatWeekly(this.weekly(day), { final: false });
    else if (command === 'overview') text = formatOverview(this.overview(day));
    else if (command === 'roast') text = await this.roast(arg);
    else text = helpText(this.cfg.leaderboardTime, { roast: this.roastAvailable });
    if (text) await this.safeSend(text);
  }

  async daily(day: string): Promise<DailyStandings> {
    const rows = this.store.scoresForDay(day);
    return buildDaily(rows, day, this.nameLookup(), await this.expectedPlayers(day));
  }

  weekly(day: string) {
    const from = weekStart(day);
    return buildWeekly(this.store.scoresBetween(from, day), from, day, this.nameLookup());
  }

  overview(day: string) {
    const from = addDays(weekStart(day), -7 * (OVERVIEW_WEEKS - 1));
    return buildOverview(this.store.scoresBetween(from, day), day, OVERVIEW_WEEKS, this.nameLookup());
  }

  /**
   * Roast `query` (a name or @mention), or a random active player without one. Returns the
   * message to send, a short "who?" reply for unknown names, or null when there is nothing to say.
   */
  async roast(query?: string, opts: { showPrompt?: (prompt: string) => void } = {}): Promise<string | null> {
    const day = this.today();
    const nameOf = this.nameLookup();
    let target: Candidate | undefined;

    if (query) {
      const candidates = this.store.players().map((p) => ({
        jid: p.jid,
        name: nameOf(p.jid),
        phoneJid: p.phone_jid ?? undefined,
      }));
      const matches = findPlayers(query, candidates);
      if (matches.length === 0) return `🤔 Wie is ${query.slice(0, 30)}?`;
      if (matches.length > 1) return `🤔 Wie bedoel je: ${matches.map((m) => m.name).join(' of ')}?`;
      target = matches[0];
    } else {
      const active = (await this.expectedPlayers(day)).sort();
      const jid = active[Math.floor(this.random() * active.length)];
      if (jid) target = { jid, name: nameOf(jid) };
    }
    if (!target) return null;

    const rows = this.store.scoresBetween(addDays(day, -(ROAST_DAYS - 1)), day);
    const phone = target.phoneJid ?? this.store.players().find((p) => p.jid === target.jid)?.phone_jid ?? undefined;
    const allNotes =
      this.cfg.roastNotes.get(normalizeIdForAlias(target.jid)) ??
      (phone ? this.cfg.roastNotes.get(normalizeIdForAlias(phone)) : undefined) ??
      [];
    // One running joke per roast, so they all come by in turn.
    const note = allNotes[Math.floor(this.random() * allNotes.length)];
    const notes = note ? [note] : [];
    const ctx = { today: day, timeZone: this.cfg.timezone, notes };
    opts.showPrompt?.(buildRoastPrompt(rows, target, new Pseudonyms(), ctx));
    if (!this.ask) return null;
    const roast = await generateRoast(rows, target, this.ask, ctx);
    if (!roast) return null;
    this.log.info({ target: target.name }, 'Roast generated');
    return `🔥 ${roast}`;
  }

  /** The 22:00 post: daily standings, plus the weekly summary on Sundays. Idempotent per day. */
  async postScheduled(day = this.today()): Promise<void> {
    if (!this.store.wasPosted('daily', day)) {
      const standings = await this.daily(day);
      if (standings.scoreCount === 0) {
        this.log.info({ day }, 'No scores today; skipping daily leaderboard');
      } else {
        const joke = this.cfg.ai.dailyJoke && this.ask ? await generateJoke(standings, this.ask) : null;
        if (await this.safeSend(formatDaily(standings, { final: true, joke: joke ?? undefined }))) {
          this.markPosted('daily', day);
        }
      }
    }

    if (isSunday(day) && !this.store.wasPosted('weekly', day)) {
      const summary = this.weekly(day);
      if (summary.games.length === 0) {
        this.log.info({ day }, 'No scores this week; skipping weekly summary');
      } else if (await this.safeSend(formatWeekly(summary, { final: true }))) {
        this.markPosted('weekly', day);
      }
    }
  }

  /** After a restart: if today's post time has passed and nothing was posted yet, post now. */
  async catchUp(): Promise<void> {
    const { hour, minute } = this.cfg.leaderboardTime;
    if (minutesOfDay(this.now(), this.cfg.timezone) >= hour * 60 + minute) {
      this.log.info('Post time already passed today; checking for a missed leaderboard');
      await this.postScheduled();
    }
  }

  private markPosted(kind: string, day: string): void {
    // A dry run must not stop the real bot from posting later.
    if (!this.cfg.dryRun) this.store.markPosted(kind, day);
  }

  private async safeSend(text: string): Promise<boolean> {
    try {
      await this.messenger.send(text);
      return true;
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'Failed to send message');
      return false;
    }
  }

  private nameLookup() {
    return makeNameLookup(this.cfg.aliases, this.store.players());
  }

  /** Players active in the last N days who are still in the group. */
  private async expectedPlayers(day: string): Promise<string[]> {
    const active = this.store.activePlayersSince(addDays(day, -this.cfg.activePlayerDays));
    const members = await this.messenger.memberIds().catch(() => null);
    if (!members) return active;
    const phoneOf = new Map(this.store.players().map((p) => [p.jid, p.phone_jid]));
    return active.filter((jid) => {
      const phone = phoneOf.get(jid);
      return members.has(jid) || (phone ? members.has(phone) : false);
    });
  }
}
