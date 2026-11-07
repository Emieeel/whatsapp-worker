import { maptap } from './maptap.js';
import { polderprikker } from './polderprikker.js';
import type { GameParser, ParsedScore } from './types.js';

export type { GameParser, ParsedScore } from './types.js';

/** All supported games, in the order they appear in the leaderboard. Register new parsers here. */
export const GAMES: readonly GameParser[] = [polderprikker, maptap];

const byId = new Map(GAMES.map((g) => [g.id, g]));

export function getGame(id: string): GameParser | undefined {
  return byId.get(id);
}

/** Run every parser over a message; one message may contain results for several games. */
export function parseScores(text: string): Array<{ game: GameParser; result: ParsedScore }> {
  const out: Array<{ game: GameParser; result: ParsedScore }> = [];
  for (const game of GAMES) {
    const result = game.parse(text);
    if (result) out.push({ game, result });
  }
  return out;
}
