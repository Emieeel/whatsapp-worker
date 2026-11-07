import type { InsertOutcome, Store } from './db.js';
import { parseScores } from './games/index.js';
import { shortId } from './names.js';
import { dayKey, resolveMonthDay } from './time.js';

/** The minimum we need from a WhatsApp message. Nothing else is ever stored. */
export interface IncomingMessage {
  id: string;
  /** Canonical player id (LID when known, otherwise phone JID). */
  playerJid: string;
  phoneJid?: string;
  pushName?: string;
  text: string;
  /** Unix seconds. */
  timestamp: number;
}

export type IngestOutcome = InsertOutcome | 'stale';

export interface IngestResult {
  game: string;
  score: number;
  maxScore: number;
  day: string;
  outcome: IngestOutcome;
  reason?: string;
}

/** Parse a group message and store any valid scores in it. Returns one result per game found. */
export function ingestMessage(store: Store, msg: IncomingMessage, timeZone: string): IngestResult[] {
  const found = parseScores(msg.text);
  if (found.length === 0) return [];

  if (msg.phoneJid && msg.phoneJid !== msg.playerJid) {
    // Same person might have been stored under their phone JID before their LID was known.
    store.mergePlayerIds(msg.phoneJid, msg.playerJid);
  }

  const day = dayKey(new Date(msg.timestamp * 1000), timeZone);
  const name = msg.pushName?.trim() || shortId(msg.playerJid);
  const results: IngestResult[] = [];
  let anyValid = false;

  for (const { game, result } of found) {
    const base = { game: game.id, score: result.score, maxScore: result.maxScore, day };
    let puzzle = result.puzzle;

    if (result.puzzleDate) {
      const printed = resolveMonthDay(result.puzzleDate.month, result.puzzleDate.day, day);
      if (printed !== day) {
        results.push({ ...base, outcome: 'stale', reason: `result is for ${printed ?? 'an invalid date'}` });
        continue;
      }
      puzzle ??= printed;
    }
    if (puzzle && store.puzzleSeenBefore(game.id, puzzle, day)) {
      results.push({ ...base, outcome: 'stale', reason: `puzzle ${puzzle} was already played on an earlier day` });
      continue;
    }

    anyValid = true;
    const outcome = store.insertScore({
      messageId: msg.id,
      game: game.id,
      gameDay: day,
      playerJid: msg.playerJid,
      displayName: name,
      score: result.score,
      maxScore: result.maxScore,
      puzzle,
      ts: msg.timestamp,
    });
    results.push({ ...base, outcome });
  }

  if (anyValid && msg.pushName?.trim()) {
    store.upsertPlayer(msg.playerJid, msg.phoneJid, msg.pushName.trim(), msg.timestamp);
  }
  return results;
}
