import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface ScoreRecord {
  messageId: string;
  game: string;
  gameDay: string;
  playerJid: string;
  displayName: string;
  score: number;
  maxScore: number;
  puzzle?: string;
  /** Unix seconds. */
  ts: number;
}

export interface ScoreRow {
  id: number;
  message_id: string;
  game: string;
  game_day: string;
  player_jid: string;
  display_name: string;
  score: number;
  max_score: number;
  puzzle: string | null;
  ts: number;
}

export interface MemberRow {
  id: string;
  phone_jid: string | null;
  updated_at: number;
}

export interface PlayerRow {
  jid: string;
  phone_jid: string | null;
  name: string;
  updated_at: number;
}

/**
 * - `inserted`: first score for this player/game/day
 * - `replaced`: an earlier-timestamped message arrived late and now counts instead
 * - `duplicate`: this message was already stored
 * - `ignored`: the player already has an earlier score for this game today
 */
export type InsertOutcome = 'inserted' | 'replaced' | 'duplicate' | 'ignored';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scores (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   TEXT    NOT NULL,
  game         TEXT    NOT NULL,
  game_day     TEXT    NOT NULL,  -- YYYY-MM-DD in the configured timezone
  player_jid   TEXT    NOT NULL,
  display_name TEXT    NOT NULL,  -- pushName at the time of the message
  score        INTEGER NOT NULL,
  max_score    INTEGER NOT NULL,
  puzzle       TEXT,
  ts           INTEGER NOT NULL,  -- message timestamp, unix seconds
  UNIQUE (message_id, game),
  UNIQUE (game, game_day, player_jid)
);
CREATE INDEX IF NOT EXISTS idx_scores_day ON scores (game_day);
CREATE INDEX IF NOT EXISTS idx_scores_puzzle ON scores (game, puzzle);
CREATE INDEX IF NOT EXISTS idx_scores_player ON scores (player_jid);

-- Latest known name per player, taken from their score messages only.
CREATE TABLE IF NOT EXISTS players (
  jid        TEXT PRIMARY KEY,
  phone_jid  TEXT,
  name       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Current members of the target group (excluding the bot), refreshed on every connect.
CREATE TABLE IF NOT EXISTS members (
  id         TEXT PRIMARY KEY,  -- LID when known, otherwise phone JID
  phone_jid  TEXT,
  updated_at INTEGER NOT NULL
);

-- Which scheduled posts went out, so a restart never posts twice.
CREATE TABLE IF NOT EXISTS posts (
  kind    TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (kind, day)
);
`;

export class Store {
  readonly db: Database.Database;
  private readonly stmts;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);

    this.stmts = {
      byMessage: this.db.prepare<[string, string], { id: number }>(
        'SELECT id FROM scores WHERE message_id = ? AND game = ?',
      ),
      byKey: this.db.prepare<[string, string, string], { id: number; ts: number }>(
        'SELECT id, ts FROM scores WHERE game = ? AND game_day = ? AND player_jid = ?',
      ),
      insert: this.db.prepare(
        `INSERT INTO scores (message_id, game, game_day, player_jid, display_name, score, max_score, puzzle, ts)
         VALUES (@messageId, @game, @gameDay, @playerJid, @displayName, @score, @maxScore, @puzzle, @ts)`,
      ),
      replace: this.db.prepare(
        `UPDATE scores SET message_id = @messageId, display_name = @displayName, score = @score,
           max_score = @maxScore, puzzle = @puzzle, ts = @ts
         WHERE id = @id`,
      ),
      puzzleOnEarlierDay: this.db.prepare<[string, string, string], { one: number }>(
        'SELECT 1 AS one FROM scores WHERE game = ? AND puzzle = ? AND game_day < ? LIMIT 1',
      ),
      between: this.db.prepare<[string, string], ScoreRow>(
        'SELECT * FROM scores WHERE game_day BETWEEN ? AND ? ORDER BY game_day, ts',
      ),
      activeSince: this.db.prepare<[string], { player_jid: string }>(
        'SELECT DISTINCT player_jid FROM scores WHERE game_day >= ?',
      ),
      upsertPlayer: this.db.prepare(
        `INSERT INTO players (jid, phone_jid, name, updated_at) VALUES (@jid, @phoneJid, @name, @ts)
         ON CONFLICT (jid) DO UPDATE SET
           name = excluded.name,
           phone_jid = COALESCE(excluded.phone_jid, players.phone_jid),
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= players.updated_at`,
      ),
      moveScores: this.db.prepare('UPDATE OR IGNORE scores SET player_jid = ? WHERE player_jid = ?'),
      deleteScores: this.db.prepare('DELETE FROM scores WHERE player_jid = ?'),
      deletePlayer: this.db.prepare('DELETE FROM players WHERE jid = ?'),
      players: this.db.prepare<[], PlayerRow>('SELECT * FROM players ORDER BY name COLLATE NOCASE'),
      clearMembers: this.db.prepare('DELETE FROM members'),
      insertMember: this.db.prepare('INSERT OR REPLACE INTO members (id, phone_jid, updated_at) VALUES (?, ?, ?)'),
      members: this.db.prepare<[], MemberRow>('SELECT * FROM members'),
      wasPosted: this.db.prepare<[string, string], { one: number }>(
        'SELECT 1 AS one FROM posts WHERE kind = ? AND day = ?',
      ),
      markPosted: this.db.prepare('INSERT OR IGNORE INTO posts (kind, day, sent_at) VALUES (?, ?, ?)'),
    };
  }

  /** Store a score; the earliest message per player/game/day wins, duplicates are ignored. */
  insertScore(rec: ScoreRecord): InsertOutcome {
    const params = { ...rec, puzzle: rec.puzzle ?? null };
    return this.db.transaction((): InsertOutcome => {
      if (this.stmts.byMessage.get(rec.messageId, rec.game)) return 'duplicate';
      const existing = this.stmts.byKey.get(rec.game, rec.gameDay, rec.playerJid);
      if (!existing) {
        this.stmts.insert.run(params);
        return 'inserted';
      }
      if (rec.ts < existing.ts) {
        this.stmts.replace.run({ ...params, id: existing.id });
        return 'replaced';
      }
      return 'ignored';
    })();
  }

  puzzleSeenBefore(game: string, puzzle: string, day: string): boolean {
    return this.stmts.puzzleOnEarlierDay.get(game, puzzle, day) !== undefined;
  }

  scoresBetween(fromDay: string, toDay: string): ScoreRow[] {
    return this.stmts.between.all(fromDay, toDay);
  }

  scoresForDay(day: string): ScoreRow[] {
    return this.scoresBetween(day, day);
  }

  /** Players with at least one score on or after `sinceDay`. */
  activePlayersSince(sinceDay: string): string[] {
    return this.stmts.activeSince.all(sinceDay).map((r) => r.player_jid);
  }

  upsertPlayer(jid: string, phoneJid: string | undefined, name: string, ts: number): void {
    this.stmts.upsertPlayer.run({ jid, phoneJid: phoneJid ?? null, name, ts });
  }

  /**
   * Move everything stored under `fromJid` (a phone JID) to `toJid` (the same person's LID).
   * Where both ids have a score for the same game and day, the one under `toJid` is kept.
   */
  mergePlayerIds(fromJid: string, toJid: string): number {
    if (fromJid === toJid) return 0;
    return this.db.transaction(() => {
      const moved = this.stmts.moveScores.run(toJid, fromJid).changes;
      this.stmts.deleteScores.run(fromJid);
      this.stmts.deletePlayer.run(fromJid);
      return moved;
    })();
  }

  players(): PlayerRow[] {
    return this.stmts.players.all();
  }

  setMembers(members: Array<{ id: string; phoneJid?: string }>): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.transaction(() => {
      this.stmts.clearMembers.run();
      for (const m of members) this.stmts.insertMember.run(m.id, m.phoneJid ?? null, now);
    })();
  }

  members(): MemberRow[] {
    return this.stmts.members.all();
  }

  wasPosted(kind: string, day: string): boolean {
    return this.stmts.wasPosted.get(kind, day) !== undefined;
  }

  markPosted(kind: string, day: string): void {
    this.stmts.markPosted.run(kind, day, Math.floor(Date.now() / 1000));
  }

  /** Consistent online copy of the database (safe while the bot is running). */
  async backup(destination: string): Promise<void> {
    fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
    await this.db.backup(destination);
  }

  close(): void {
    this.db.close();
  }
}
