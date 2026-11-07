import type { Logger } from 'pino';
import { helpText, parseCommand, type Command } from './commands.js';
import type { AppConfig } from './config.js';
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
import { ingestMessage, type IncomingMessage } from './scores.js';
import { addDays, dayKey, isSunday, minutesOfDay, weekStart } from './time.js';

/** What the bot needs from the chat transport. Implemented by WhatsAppClient (and fakes in tests). */
export interface Messenger {
  send(text: string): Promise<void>;
  /** All known ids (LID and phone JID) of current group members, or null if unknown. */
  memberIds(): Promise<Set<string> | null>;
}

/** Commands older than this are from a backlog (e.g. after a restart) and are not answered. */
const COMMAND_MAX_AGE_S = 120;
/** Minimum time between two answers to the same command. */
const COMMAND_COOLDOWN_MS = 30_000;
/** Number of calendar weeks in the !weken overview. */
const OVERVIEW_WEEKS = 6;

export class ScoreBot {
  private readonly lastAnswered = new Map<Command, number>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly store: Store,
    private readonly messenger: Messenger,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  today(): string {
    return dayKey(this.now(), this.cfg.timezone);
  }

  /** Entry point for every message from the target group. */
  async handleGroupMessage(msg: IncomingMessage): Promise<void> {
    const command = parseCommand(msg.text);
    if (command) {
      await this.handleCommand(command, msg.timestamp);
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

  private async handleCommand(command: Command, timestamp: number): Promise<void> {
    const ageS = this.now().getTime() / 1000 - timestamp;
    if (ageS > COMMAND_MAX_AGE_S) {
      this.log.debug({ command, ageS }, 'Ignoring old command');
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
    let text: string;
    if (command === 'stand') text = formatDaily(await this.daily(day), { final: false });
    else if (command === 'week') text = formatWeekly(this.weekly(day), { final: false });
    else if (command === 'overview') text = formatOverview(this.overview(day));
    else text = helpText(this.cfg.leaderboardTime);
    await this.safeSend(text);
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

  /** The 22:00 post: daily standings, plus the weekly summary on Sundays. Idempotent per day. */
  async postScheduled(day = this.today()): Promise<void> {
    if (!this.store.wasPosted('daily', day)) {
      const standings = await this.daily(day);
      if (standings.scoreCount === 0) {
        this.log.info({ day }, 'No scores today; skipping daily leaderboard');
      } else {
        const joke = (await generateJoke(this.cfg.jokes, standings, this.log)) ?? undefined;
        if (await this.safeSend(formatDaily(standings, { final: true, joke }))) this.markPosted('daily', day);
      }
    }

    if (isSunday(day) && !this.store.wasPosted('weekly', day)) {
      const summary = this.weekly(day);
      if (summary.totals.length === 0) {
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
