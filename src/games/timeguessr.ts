import type { GameParser } from './types.js';
import { normalizeText, parseInteger } from './util.js';

// TimeGuessr #1236 — 36,960/50,000
//
// 1️⃣ 🏆6,769 · 📅 8y · 🌍 230.8km
// ...
// https://timeguessr.com
//
// Tolerates: '—', '–' or '-' after the number, ',' or '.' as thousands separator, extra spaces,
// and the alternative round format ("🏆8102 - 📅0y - 🌍909.3km"), which is ignored anyway.
const PATTERN =
  /timeguessr\s*#\s*(\d{1,6})\D{1,10}?(\d{1,3}(?:[.,]\d{3})+|\d+)\s*\/\s*(\d{1,3}(?:[.,]\d{3})+|\d+)/i;

export const timeguessr: GameParser = {
  id: 'timeguessr',
  name: 'TimeGuessr',
  emoji: '🕰️',
  maxScore: 50000,
  parse(text) {
    const m = PATTERN.exec(normalizeText(text));
    if (!m) return null;
    const puzzle = parseInteger(m[1]!);
    const score = parseInteger(m[2]!);
    const max = parseInteger(m[3]!);
    if (puzzle === null || score === null || max === null) return null;
    if (max <= 0 || max > 1_000_000 || score > max) return null;
    return { score, maxScore: max, puzzle: String(puzzle) };
  },
};
