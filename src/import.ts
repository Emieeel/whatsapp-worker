// Import past scores from a WhatsApp "Export chat" text file (without media).
// Only messages that parse as game results are used; nothing else from the export is stored.
import crypto from 'node:crypto';
import type { MemberRow, PlayerRow, Store } from './db.js';
import { parseScores } from './games/index.js';
import { ingestMessage, type IngestOutcome } from './scores.js';
import { zonedTimeToUnix } from './time.js';

export interface ExportMessage {
  author: string;
  text: string;
  /** Unix seconds. */
  timestamp: number;
}

export interface PlayerRef {
  jid: string;
  phoneJid?: string;
  /** How the export name was matched, for the report. */
  how: string;
}

export interface ImportReport {
  mapping: Map<string, PlayerRef>;
  unresolved: string[];
  scoreMessages: number;
  counts: Record<string, Partial<Record<IngestOutcome, number>>>;
  stale: Array<{ author: string; day: string; game: string; score: number; reason: string }>;
  applied: boolean;
}

// Android: "18/10/2026, 00:56 - Name: text"   iOS: "[18/10/2026, 00:56:12] Name: text"
// Also accepts '-' or '.' as date separator and a missing comma. Dates are day-first.
const HEADER =
  /^\[?(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\]?(?:\s+-)?\s+(.*)$/;

const pad = (n: string | number) => String(n).padStart(2, '0');

export function parseExport(content: string, timeZone: string): ExportMessage[] {
  const out: Array<{ author: string | null; text: string; timestamp: number }> = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/[‎‏]/g, '');
    const m = HEADER.exec(line);
    if (!m) {
      // Continuation of a multi-line message.
      if (out.length > 0) out[out.length - 1]!.text += `\n${line}`;
      continue;
    }
    const [, d, mo, y, h, mi, s, rest = ''] = m;
    const year = y!.length === 2 ? 2000 + Number(y) : Number(y);
    // Exports without seconds: use the end of the minute, so a copy of the same message that the
    // bot already recorded live (with exact seconds) keeps counting as the earlier one.
    const timestamp = zonedTimeToUnix(`${year}-${pad(mo!)}-${pad(d!)}`, Number(h), Number(mi), s ? Number(s) : 59, timeZone);
    const sep = rest.indexOf(': ');
    out.push(
      sep > 0
        ? { author: rest.slice(0, sep).trim(), text: rest.slice(sep + 2), timestamp }
        : { author: null, text: rest, timestamp }, // system message ("X added Y")
    );
  }
  return out.filter((msg): msg is ExportMessage => msg.author !== null);
}

const lower = (s: string) => s.trim().toLocaleLowerCase('nl');

/**
 * Map export names (as saved in the exporting phone's contacts) to player ids, in this order:
 * alias in config.json, WhatsApp name the bot has seen (exact, or first name only),
 * a phone number as name, and finally: if exactly one name and one group member are left, they match.
 */
export function resolveAuthors(
  authors: string[],
  aliases: Map<string, string>,
  players: PlayerRow[],
  members: MemberRow[],
): { mapping: Map<string, PlayerRef>; unresolved: string[] } {
  const lidForPhone = new Map<string, string>();
  for (const m of members) if (m.phone_jid && m.id !== m.phone_jid) lidForPhone.set(m.phone_jid, m.id);
  for (const p of players) if (p.phone_jid && p.jid !== p.phone_jid) lidForPhone.set(p.phone_jid, p.jid);
  const phoneOf = (jid: string) =>
    players.find((p) => p.jid === jid)?.phone_jid ?? members.find((m) => m.id === jid)?.phone_jid ?? undefined;

  const ref = (jid: string, how: string): PlayerRef => {
    if (jid.endsWith('@s.whatsapp.net')) return { jid: lidForPhone.get(jid) ?? jid, phoneJid: jid, how };
    return { jid, phoneJid: phoneOf(jid), how };
  };

  const mapping = new Map<string, PlayerRef>();
  const unresolved: string[] = [];
  for (const author of authors) {
    const a = lower(author);
    const alias = [...aliases].filter(([, name]) => lower(name) === a);
    if (alias.length === 1) {
      mapping.set(author, ref(alias[0]![0], 'alias in config.json'));
      continue;
    }
    const exact = players.filter((p) => lower(p.name) === a);
    const candidates = exact.length
      ? exact
      : players.filter((p) => lower(p.name).startsWith(`${a} `) || a.startsWith(`${lower(p.name)} `));
    if (candidates.length === 1) {
      mapping.set(author, ref(candidates[0]!.jid, `WhatsApp name "${candidates[0]!.name}"`));
      continue;
    }
    const digits = author.replace(/[\s()+-]/g, '');
    if (/^\d{8,15}$/.test(digits)) {
      mapping.set(author, ref(`${digits}@s.whatsapp.net`, 'phone number'));
      continue;
    }
    unresolved.push(author);
  }

  if (unresolved.length === 1) {
    const taken = new Set([...mapping.values()].map((r) => r.jid));
    const known = new Set(players.map((p) => p.jid));
    const left = members.filter((m) => !taken.has(m.id) && !known.has(m.id));
    if (left.length === 1) {
      mapping.set(unresolved[0]!, ref(left[0]!.id, 'only remaining group member'));
      unresolved.length = 0;
    }
  }

  const byJid = new Map<string, string>();
  for (const [author, r] of mapping) {
    const other = byJid.get(r.jid);
    if (other) throw new Error(`"${other}" and "${author}" both map to ${r.jid}; add aliases in config.json`);
    byJid.set(r.jid, author);
  }
  return { mapping, unresolved };
}

class Rollback extends Error {}

/** Import scores from an export. Without `apply`, everything runs inside a transaction that is rolled back. */
export function importExport(
  store: Store,
  content: string,
  opts: { timeZone: string; aliases: Map<string, string>; apply: boolean },
): ImportReport {
  const messages = parseExport(content, opts.timeZone).filter((m) => parseScores(m.text).length > 0);
  const authors = [...new Set(messages.map((m) => m.author))];
  const { mapping, unresolved } = resolveAuthors(authors, opts.aliases, store.players(), store.members());
  const report: ImportReport = { mapping, unresolved, scoreMessages: messages.length, counts: {}, stale: [], applied: false };
  if (unresolved.length > 0) return report;

  const run = store.db.transaction(() => {
    for (const m of messages) {
      const player = mapping.get(m.author)!;
      const id = `import-${crypto.createHash('sha1').update(`${m.timestamp}|${m.author}|${m.text}`).digest('hex').slice(0, 20)}`;
      const results = ingestMessage(
        store,
        { id, playerJid: player.jid, phoneJid: player.phoneJid, pushName: m.author, text: m.text, timestamp: m.timestamp },
        opts.timeZone,
      );
      for (const r of results) {
        const c = (report.counts[r.game] ??= {});
        c[r.outcome] = (c[r.outcome] ?? 0) + 1;
        if (r.outcome === 'stale') {
          report.stale.push({ author: m.author, day: r.day, game: r.game, score: r.score, reason: r.reason ?? '' });
        }
      }
    }
    if (!opts.apply) throw new Rollback();
  });

  try {
    run();
    report.applied = true;
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return report;
}
