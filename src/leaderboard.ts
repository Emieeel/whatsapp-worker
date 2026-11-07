import type { ScoreRow } from './db.js';
import { GAMES, type GameParser } from './games/index.js';
import type { NameLookup } from './names.js';
import { addDays, daysBetween, formatDayLong, formatDayMonth, formatWeekdayShort, weekStart } from './time.js';

/** A day is worth at most this many points. Every game counts equally (DAY_MAX / number of games). */
export const DAY_MAX = 1000;

export function pointsPerGame(): number {
  return DAY_MAX / GAMES.length;
}

/** Points for one result: the share of the game's max, scaled to that game's part of DAY_MAX. */
export function gamePoints(score: number, maxScore: number): number {
  return maxScore > 0 ? (score / maxScore) * pointsPerGame() : 0;
}

export interface RankedEntry {
  playerJid: string;
  name: string;
  value: number;
  rank: number;
}

export interface GameStandings {
  game: GameParser;
  puzzle?: string;
  entries: RankedEntry[];
}

export interface DailyStandings {
  day: string;
  games: GameStandings[];
  /** Day totals (0-DAY_MAX); null when fewer than two games were played that day. */
  combined: RankedEntry[] | null;
  notPlayed: string[];
  scoreCount: number;
}

export interface WeeklyEntry extends RankedEntry {
  wins: number;
  daysPlayed: number;
  /** Average day total over the days played. */
  average: number;
}

export interface WeeklySummary {
  from: string;
  to: string;
  totals: WeeklyEntry[];
  winners: Array<{ day: string; names: string[] }>;
}

export interface OverviewWeek {
  from: string;
  to: string;
  current: boolean;
  totals: WeeklyEntry[];
}

export interface Overview {
  weeks: OverviewWeek[];
  /** Number of completed weeks each player won. */
  weekWins: RankedEntry[];
  /** Average day total over all shown weeks. */
  averages: WeeklyEntry[];
  /** First day with data in the shown period. */
  since: string;
}

/** Sort descending and assign competition ranks (1, 1, 3, ...). Ties are ordered by name. */
export function rankEntries<T extends { value: number; name: string }>(items: T[]): Array<T & { rank: number }> {
  const sorted = [...items].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'nl'));
  let rank = 0;
  return sorted.map((item, i) => {
    if (i === 0 || item.value !== sorted[i - 1]!.value) rank = i + 1;
    return { ...item, rank };
  });
}

function mostCommon(values: Array<string | null>): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) [best, bestCount] = [v, c];
  }
  return best;
}

/** Day totals of one day: sum of game points per player, rounded to whole points. */
export function combinedRanking(rows: ScoreRow[], nameOf: NameLookup): RankedEntry[] {
  const totals = new Map<string, { points: number; fallback: string }>();
  for (const r of rows) {
    const t = totals.get(r.player_jid) ?? { points: 0, fallback: r.display_name };
    t.points += gamePoints(r.score, r.max_score);
    totals.set(r.player_jid, t);
  }
  return rankEntries(
    [...totals].map(([jid, t]) => ({ playerJid: jid, name: nameOf(jid, t.fallback), value: Math.round(t.points) })),
  );
}

export function buildDaily(
  rows: ScoreRow[],
  day: string,
  nameOf: NameLookup,
  expectedPlayers: Iterable<string> = [],
): DailyStandings {
  const dayRows = rows.filter((r) => r.game_day === day);
  const games: GameStandings[] = [];
  for (const game of GAMES) {
    const gameRows = dayRows.filter((r) => r.game === game.id);
    if (gameRows.length === 0) continue;
    games.push({
      game,
      puzzle: mostCommon(gameRows.map((r) => r.puzzle)),
      entries: rankEntries(
        gameRows.map((r) => ({ playerJid: r.player_jid, name: nameOf(r.player_jid, r.display_name), value: r.score })),
      ),
    });
  }

  const played = new Set(dayRows.map((r) => r.player_jid));
  const notPlayed = [...new Set(expectedPlayers)]
    .filter((jid) => !played.has(jid))
    .map((jid) => nameOf(jid))
    .sort((a, b) => a.localeCompare(b, 'nl'));

  return {
    day,
    games,
    combined: games.length >= 2 ? combinedRanking(dayRows, nameOf) : null,
    notPlayed,
    scoreCount: dayRows.length,
  };
}

/** Week totals: day totals summed per player, plus daily wins and the average per day played. */
export function buildWeekly(rows: ScoreRow[], from: string, to: string, nameOf: NameLookup): WeeklySummary {
  const acc = new Map<string, { points: number; wins: number; days: Set<string>; fallback: string }>();
  const winners: WeeklySummary['winners'] = [];

  for (const day of daysBetween(from, to)) {
    const ranking = combinedRanking(
      rows.filter((r) => r.game_day === day),
      nameOf,
    );
    winners.push({ day, names: ranking.filter((e) => e.rank === 1).map((e) => e.name) });
    for (const e of ranking) {
      const a = acc.get(e.playerJid) ?? { points: 0, wins: 0, days: new Set<string>(), fallback: e.name };
      a.points += e.value;
      a.days.add(day);
      if (e.rank === 1) a.wins += 1;
      acc.set(e.playerJid, a);
    }
  }

  const totals = rankEntries(
    [...acc].map(([jid, a]) => ({
      playerJid: jid,
      name: nameOf(jid, a.fallback),
      value: a.points,
      wins: a.wins,
      daysPlayed: a.days.size,
      average: Math.round(a.points / a.days.size),
    })),
  );
  return { from, to, totals, winners };
}

/** The last `weekCount` calendar weeks up to `today` (newest first), week wins and averages. */
export function buildOverview(rows: ScoreRow[], today: string, weekCount: number, nameOf: NameLookup): Overview {
  const currentStart = weekStart(today);
  const weeks: OverviewWeek[] = [];
  for (let i = 0; i < weekCount; i++) {
    const from = addDays(currentStart, -7 * i);
    const to = i === 0 ? today : addDays(from, 6);
    const weekRows = rows.filter((r) => r.game_day >= from && r.game_day <= to);
    if (weekRows.length === 0) continue;
    weeks.push({ from, to, current: i === 0, totals: buildWeekly(weekRows, from, to, nameOf).totals });
  }

  const wins = new Map<string, { playerJid: string; name: string; value: number }>();
  for (const w of weeks) {
    if (w.current) continue;
    for (const e of w.totals.filter((t) => t.rank === 1)) {
      const entry = wins.get(e.playerJid) ?? { playerJid: e.playerJid, name: e.name, value: 0 };
      entry.value += 1;
      wins.set(e.playerJid, entry);
    }
  }

  const oldest = weeks[weeks.length - 1]?.from ?? today;
  const periodRows = rows.filter((r) => r.game_day >= oldest && r.game_day <= today);
  const since = periodRows.reduce((min, r) => (r.game_day < min ? r.game_day : min), today);
  const averages = rankEntries(
    buildWeekly(periodRows, oldest, today, nameOf).totals.map(({ rank: _rank, ...e }) => ({ ...e, value: e.average })),
  );

  return { weeks, weekWins: rankEntries([...wins.values()]), averages, since };
}

// ---------------------------------------------------------------------------
// Formatting (Dutch, WhatsApp markup: *bold*)

const MEDALS = ['🥇', '🥈', '🥉'];
const pointsFormat = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 });

export function medal(rank: number): string {
  return MEDALS[rank - 1] ?? `${rank}.`;
}

function formatPoints(x: number): string {
  return pointsFormat.format(x);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatDaily(s: DailyStandings, opts: { final: boolean; joke?: string }): string {
  const title = opts.final ? '🏆 *Dagstand' : '📋 *Tussenstand';
  const lines = [`${title} ${formatDayLong(s.day)}*`];

  if (s.scoreCount === 0) {
    lines.push('', 'Nog geen scores vandaag. 🦗');
  }
  for (const g of s.games) {
    const puzzle = g.puzzle && /^\d+$/.test(g.puzzle) ? ` #${g.puzzle}` : '';
    lines.push('', `${g.game.emoji} *${g.game.name}*${puzzle}`);
    for (const e of g.entries) lines.push(`${medal(e.rank)} ${e.name} — ${e.value}`);
  }
  if (s.combined) {
    lines.push('', `📊 *Totaal* (max ${DAY_MAX}, uitleg: !help)`);
    for (const e of s.combined) lines.push(`${medal(e.rank)} ${e.name} — ${formatPoints(e.value)}`);
  }
  if (s.notPlayed.length > 0) {
    lines.push('', `😴 Nog niet gespeeld: ${s.notPlayed.join(', ')}`);
  }
  if (opts.joke) lines.push('', `😏 ${opts.joke}`);
  return lines.join('\n');
}

function formatRange(from: string, to: string): string {
  return from.slice(0, 7) === to.slice(0, 7)
    ? `${Number(from.slice(8))} – ${formatDayMonth(to)}`
    : `${formatDayMonth(from)} – ${formatDayMonth(to)}`;
}

export function formatWeekly(w: WeeklySummary, opts: { final: boolean }): string {
  const title = opts.final ? `📅 *Weekoverzicht ${formatRange(w.from, w.to)}*` : `📅 *Week tot nu toe* (${formatRange(w.from, w.to)})`;
  const lines = [title];

  if (w.totals.length === 0) {
    lines.push('', 'Deze week nog geen scores. 🦗');
    return lines.join('\n');
  }

  lines.push('', '📊 *Totaal* (dagtotalen opgeteld)');
  for (const e of w.totals) {
    const wins = e.wins > 0 ? ` · ${e.wins}× dagwinst` : '';
    lines.push(`${medal(e.rank)} ${e.name} — ${formatPoints(e.value)} · ${plural(e.daysPlayed, 'dag', 'dagen')}${wins}`);
  }

  lines.push('', '🏅 *Dagwinnaars*');
  lines.push(
    w.winners.map((d) => `${formatWeekdayShort(d.day)} ${d.names.length ? d.names.join(' & ') : '–'}`).join(' · '),
  );
  return lines.join('\n');
}

export function formatOverview(o: Overview): string {
  const lines = ['📈 *Overzicht per week*'];
  if (o.weeks.length === 0) {
    lines.push('', 'Nog geen scores. 🦗');
    return lines.join('\n');
  }

  for (const w of o.weeks) {
    lines.push('', w.current ? `*Deze week* (${formatRange(w.from, w.to)})` : `*${formatRange(w.from, w.to)}*`);
    lines.push(
      w.totals
        .slice(0, 3)
        .map((e) => `${medal(e.rank)} ${e.name} ${formatPoints(e.value)}`)
        .join(' · '),
    );
  }

  if (o.weekWins.length > 0) {
    lines.push('', `🏆 *Weekwinsten*: ${o.weekWins.map((e) => `${e.name} ${e.value}×`).join(' · ')}`);
  }

  lines.push('', `📊 *Gemiddeld dagtotaal* (sinds ${formatDayMonth(o.since)})`);
  for (const e of o.averages) {
    lines.push(`${medal(e.rank)} ${e.name} — ${formatPoints(e.value)} · ${plural(e.daysPlayed, 'dag', 'dagen')}`);
  }
  return lines.join('\n');
}
