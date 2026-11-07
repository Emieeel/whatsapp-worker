import type { GameParser } from './types.js';
import { normalizeText, parseInteger } from './util.js';

// #Polderprikker nummer 158 • 4478/5000
// 🟦1000 🟦1000 🟩995 🟧504 🟩979
// https://polderprikker.nl/
//
// Tolerates: missing '#', "nr"/"#" instead of "nummer", other separators than '•',
// a line break between number and score, thousands separators and spaces around '/'.
const PATTERN =
  /#?\s*polderprikker\b[^\d\n]{0,25}?(\d{1,6})[^\d]{1,15}?(\d{1,3}(?:[.,]\d{3})+|\d+)\s*\/\s*(\d{1,3}(?:[.,]\d{3})+|\d+)/i;

export const polderprikker: GameParser = {
  id: 'polderprikker',
  name: 'Polderprikker',
  emoji: '📍',
  maxScore: 5000,
  parse(text) {
    const m = PATTERN.exec(normalizeText(text));
    if (!m) return null;
    const puzzle = parseInteger(m[1]!);
    const score = parseInteger(m[2]!);
    const max = parseInteger(m[3]!);
    if (puzzle === null || score === null || max === null) return null;
    if (max <= 0 || max > 100_000 || score > max) return null;
    return { score, maxScore: max, puzzle: String(puzzle) };
  },
};
