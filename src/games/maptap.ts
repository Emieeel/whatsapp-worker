import type { GameParser, ParsedScore } from './types.js';
import { monthFromName, normalizeText, parseInteger } from './util.js';

// www.maptap.gg November 6
// 100🎯 100🎯 93🏆 97🔥 89🎉
// Final score: 944
//
// Tolerates: with/without www or https://, "Nov 6" / "6 November" / Dutch month names,
// "Final Score 944", extra lines from link previews.
const SITE = /maptap\.gg/i;
const FINAL_SCORE = /final\s*score\s*[:：=-]?\s*(\d{1,3}(?:[.,]\d{3})+|\d+)/i;
const DATE_MONTH_FIRST = /maptap\.gg\S*\s+([a-z]{3,9})\.?\s+(\d{1,2})\b/i;
const DATE_DAY_FIRST = /maptap\.gg\S*\s+(\d{1,2})\s+([a-z]{3,9})\b/i;

const MAX_SCORE = 1000;

function parseDate(text: string): ParsedScore['puzzleDate'] | undefined {
  let month: number | null = null;
  let day: number | null = null;
  const a = DATE_MONTH_FIRST.exec(text);
  if (a) {
    month = monthFromName(a[1]!);
    day = Number(a[2]);
  }
  if (month === null) {
    const b = DATE_DAY_FIRST.exec(text);
    if (b) {
      month = monthFromName(b[2]!);
      day = Number(b[1]);
    }
  }
  if (month === null || day === null || day < 1 || day > 31) return undefined;
  return { month, day };
}

export const maptap: GameParser = {
  id: 'maptap',
  name: 'MapTap',
  emoji: '🗺️',
  maxScore: MAX_SCORE,
  parse(text) {
    const t = normalizeText(text);
    if (!SITE.test(t)) return null;
    const m = FINAL_SCORE.exec(t);
    if (!m) return null;
    const score = parseInteger(m[1]!);
    if (score === null || score > MAX_SCORE) return null;
    const result: ParsedScore = { score, maxScore: MAX_SCORE };
    const date = parseDate(t);
    if (date) result.puzzleDate = date;
    return result;
  },
};
