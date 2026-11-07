/** Parse an integer that may contain thousands separators ("4.478", "4,478", "4 478"). */
export function parseInteger(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 0 || digits.length > 9) return null;
  return Number(digits);
}

/** Normalise text before matching: unify whitespace and drop invisible formatting characters. */
export function normalizeText(text: string): string {
  return (
    text
      // zero-width chars, BOM, variation selectors (emoji presentation)
      .replace(/[​-‍⁠﻿︎️]/g, '')
      // all exotic spaces (NBSP, narrow NBSP, ...) become plain spaces
      .replace(/[^\S\n]+/g, ' ')
      .replace(/\r\n?/g, '\n')
  );
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, januari: 1,
  feb: 2, february: 2, februari: 2,
  mar: 3, march: 3, maart: 3, mrt: 3,
  apr: 4, april: 4,
  may: 5, mei: 5,
  jun: 6, june: 6, juni: 6,
  jul: 7, july: 7, juli: 7,
  aug: 8, august: 8, augustus: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, okt: 10, oktober: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Month number for an English or Dutch month name/abbreviation, or null. */
export function monthFromName(name: string): number | null {
  return MONTHS[name.toLowerCase().replace(/\.$/, '')] ?? null;
}
