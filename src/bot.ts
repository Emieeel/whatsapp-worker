import type { Logger } from 'pino';
import { makeAsk, Pseudonyms, type AskFn } from './ai.js';
import { helpText, parseCommand, type Command } from './commands.js';
import { normalizeIdForAlias, type AppConfig } from './config.js';
import type { Store } from './db.js';
import { GAMES } from './games/index.js';
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
import {
  buildBotPrompt,
  buildOtherPrompt,
  buildRoastPrompt,
  generateBotRoast,
  generateOtherRoast,
  generateRoast,
  resolveRoastTarget,
  ROAST_DAYS,
  type BotFacts,
  type Candidate,
  type RoastResult,
  type RoastTarget,
} from './roast.js';
import { ingestMessage, type IncomingMessage } from './scores.js';
import { addDays, dayKey, formatDayMonth, isSunday, minutesOfDay, weekStart } from './time.js';

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
/** !roast is the fun one: a shorter cooldown, so a quick second request is not silently dropped. */
const ROAST_COOLDOWN_MS = 10_000;
/** Earlier roasts per target that are shown to the model, so it does not repeat itself. */
const ROAST_MEMORY = 3;
/** Number of calendar weeks in the !weken overview. */
const OVERVIEW_WEEKS = 6;

export class ScoreBot {
  private readonly lastAnswered = new Map<Command, number>();
  /** Per roast target: recent roasts (with tokens) and the last running joke used. Lost on restart. */
  private readonly roastMemory = new Map<string, { recent: string[]; lastNote?: string }>();
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
      await this.handleCommand(parsed.command, parsed.arg, msg);
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

  private async handleCommand(command: Command, arg: string | undefined, msg: IncomingMessage): Promise<void> {
    const ageS = this.now().getTime() / 1000 - msg.timestamp;
    if (ageS > COMMAND_MAX_AGE_S) {
      this.log.debug({ command, ageS }, 'Ignoring old command');
      return;
    }
    if (command === 'roast' && !this.roastAvailable) {
      this.log.info('Ignoring !roast: set ANTHROPIC_API_KEY (and keep ENABLE_ROAST on) to use it');
      return;
    }
    const last = this.lastAnswered.get(command) ?? 0;
    const cooldown = command === 'roast' ? ROAST_COOLDOWN_MS : COMMAND_COOLDOWN_MS;
    if (this.now().getTime() - last < cooldown) {
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
    else if (command === 'roast') {
      text = await this.roast(arg, { requester: { jid: msg.playerJid, pushName: msg.pushName, phoneJid: msg.phoneJid } });
    }
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
   * `!roast [query]`: a player (name, mention, "mij", or a topic like "Jans geheugen"), the bot
   * itself ("jezelf"), or anyone/anything else; a random active player without a query.
   * Returns the message to send, or null when there is nothing to say.
   */
  async roast(
    query?: string,
    opts: {
      requester?: { jid: string; pushName?: string; phoneJid?: string };
      showPrompt?: (prompt: string) => void;
    } = {},
  ): Promise<string | null> {
    const day = this.today();
    const nameOf = this.nameLookup();
    const candidates: Candidate[] = this.store.players().map((p) => ({
      jid: p.jid,
      name: nameOf(p.jid),
      phoneJid: p.phone_jid ?? undefined,
      altNames: [p.name],
    }));
    const r = opts.requester;
    const requester = r
      ? (candidates.find((c) => c.jid === r.jid) ?? { jid: r.jid, name: nameOf(r.jid, r.pushName), phoneJid: r.phoneJid })
      : undefined;

    let target: RoastTarget;
    if (query) {
      const resolved = resolveRoastTarget(query, candidates, requester);
      if ('ambiguous' in resolved) return `🤔 Wie bedoel je: ${resolved.ambiguous.map((m) => m.name).join(' of ')}?`;
      target = resolved;
    } else {
      const active = (await this.expectedPlayers(day)).sort();
      const jid = active[Math.floor(this.random() * active.length)];
      if (!jid) return null;
      target = { kind: 'player', player: candidates.find((c) => c.jid === jid) ?? { jid, name: nameOf(jid) } };
    }

    const key =
      target.kind === 'player' ? target.player.jid : target.kind === 'bot' ? 'bot' : `other:${target.text.toLocaleLowerCase('nl')}`;
    const memory = this.roastMemory.get(key) ?? { recent: [] };
    let result: RoastResult | null;
    let usedNote: string | undefined;

    if (target.kind === 'player') {
      const player = target.player;
      const rows = this.store.scoresBetween(addDays(day, -(ROAST_DAYS - 1)), day);
      usedNote = this.pickNote(this.notesFor(player), memory.lastNote);
      const ctx = {
        today: day,
        timeZone: this.cfg.timezone,
        notes: usedNote ? [usedNote] : [],
        topic: target.topic,
        recent: memory.recent,
      };
      opts.showPrompt?.(buildRoastPrompt(rows, player, new Pseudonyms(), ctx));
      if (!this.ask) return null;
      result = await generateRoast(rows, player, this.ask, ctx);
    } else if (target.kind === 'bot') {
      const facts = this.botFacts();
      const notes = this.cfg.roastNotes.get('bot') ?? [];
      opts.showPrompt?.(buildBotPrompt(facts, notes, memory.recent));
      if (!this.ask) return null;
      result = await generateBotRoast(facts, this.ask, notes, memory.recent);
    } else {
      opts.showPrompt?.(buildOtherPrompt(target.text, requester, target.mentioned, new Pseudonyms(), memory.recent));
      if (!this.ask) return null;
      result = await generateOtherRoast(target.text, requester, target.mentioned, this.ask, memory.recent);
    }
    if (!result) return null;

    this.roastMemory.set(key, {
      recent: [...memory.recent, result.tokens].slice(-ROAST_MEMORY),
      lastNote: usedNote ?? memory.lastNote,
    });
    this.log.info({ target: target.kind === 'player' ? target.player.name : target.kind }, 'Roast generated');
    return `🔥 ${result.text}`;
  }

  private notesFor(player: Candidate): string[] {
    const phone = player.phoneJid ?? this.store.players().find((p) => p.jid === player.jid)?.phone_jid ?? undefined;
    return (
      this.cfg.roastNotes.get(normalizeIdForAlias(player.jid)) ??
      (phone ? this.cfg.roastNotes.get(normalizeIdForAlias(phone)) : undefined) ??
      []
    );
  }

  /** Running jokes are seasoning: only half of the roasts get one, and never the same twice in a row. */
  private pickNote(notes: string[], last?: string): string | undefined {
    if (notes.length === 0 || this.random() >= 0.5) return undefined;
    const options = notes.length > 1 ? notes.filter((n) => n !== last) : notes;
    return options[Math.floor(this.random() * options.length)];
  }

  private botFacts(): BotFacts {
    const rows = this.store.scoresBetween('0000-01-01', '9999-12-31');
    const since = rows.reduce((min, r) => (r.game_day < min ? r.game_day : min), this.today());
    return {
      scores: rows.length,
      players: new Set(rows.map((r) => r.player_jid)).size,
      since: formatDayMonth(since),
      games: [...new Set(rows.map((r) => r.game))].map((id) => GAMES.find((g) => g.id === id)?.name ?? id),
    };
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
