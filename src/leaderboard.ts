import type { ScoreRow } from './db.js';
import { GAMES, type GameParser } from './games/index.js';
import type { NameLookup } from './names.js';
import { addDays, formatDayLong, formatDayMonth, weekStart } from './time.js';

// Every game is ranked on its own. There is deliberately no combined score.

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
  notPlayed: string[];
  scoreCount: number;
}

/** One player's week in one game: `value` is the average score. */
export interface WeekEntry extends RankedEntry {
  days: number;
}

export interface GameWeek {
  game: GameParser;
  /** Ranked by average score. */
  entries: WeekEntry[];
  /** Number of days each player had the best score (ties count for everyone). */
  dayWins: RankedEntry[];
}

export interface WeeklySummary {
  from: string;
  to: string;
  games: GameWeek[];
}

export interface OverviewWeek {
  from: string;
  to: string;
  current: boolean;
  /** Best average per game that week. */
  winners: Array<{ game: GameParser; names: string[]; value: number }>;
}

export interface Overview {
  weeks: OverviewWeek[];
  /** Completed weeks won, per game. */
  weekWins: Array<{ game: GameParser; entries: RankedEntry[] }>;
  /** Average score per game over all shown weeks. */
  averages: Array<{ game: GameParser; entries: WeekEntry[] }>;
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

  return { day, games, notPlayed, scoreCount: dayRows.length };
}

/** Per game: average score per player over [from, to], and how many days each player won. */
export function buildWeekly(rows: ScoreRow[], from: string, to: string, nameOf: NameLookup): WeeklySummary {
  const inRange = rows.filter((r) => r.game_day >= from && r.game_day <= to);
  const games: GameWeek[] = [];

  for (const game of GAMES) {
    const gameRows = inRange.filter((r) => r.game === game.id);
    if (gameRows.length === 0) continue;

    const perPlayer = new Map<string, { sum: number; days: number; fallback: string }>();
    const bestOfDay = new Map<string, number>();
    for (const r of gameRows) {
      const p = perPlayer.get(r.player_jid) ?? { sum: 0, days: 0, fallback: r.display_name };
      p.sum += r.score;
      p.days += 1;
      perPlayer.set(r.player_jid, p);
      bestOfDay.set(r.game_day, Math.max(bestOfDay.get(r.game_day) ?? -Infinity, r.score));
    }
    const wins = new Map<string, number>();
    for (const r of gameRows) {
      if (r.score === bestOfDay.get(r.game_day)) wins.set(r.player_jid, (wins.get(r.player_jid) ?? 0) + 1);
    }

    const name = (jid: string) => nameOf(jid, perPlayer.get(jid)?.fallback);
    games.push({
      game,
      entries: rankEntries(
        [...perPlayer].map(([jid, p]) => ({ playerJid: jid, name: name(jid), value: Math.round(p.sum / p.days), days: p.days })),
      ),
      dayWins: rankEntries([...wins].map(([jid, n]) => ({ playerJid: jid, name: name(jid), value: n }))),
    });
  }
  return { from, to, games };
}

/** The last `weekCount` calendar weeks up to `today` (newest first), week wins and averages. */
export function buildOverview(rows: ScoreRow[], today: string, weekCount: number, nameOf: NameLookup): Overview {
  const currentStart = weekStart(today);
  const weeks: OverviewWeek[] = [];
  const wins = new Map<string, Map<string, { playerJid: string; name: string; value: number }>>();

  for (let i = 0; i < weekCount; i++) {
    const from = addDays(currentStart, -7 * i);
    const to = i === 0 ? today : addDays(from, 6);
    const week = buildWeekly(rows, from, to, nameOf);
    if (week.games.length === 0) continue;
    const current = i === 0;
    weeks.push({
      from,
      to,
      current,
      winners: week.games.map((g) => {
        const top = g.entries.filter((e) => e.rank === 1);
        return { game: g.game, names: top.map((e) => e.name), value: top[0]!.value };
      }),
    });
    if (current) continue;
    for (const g of week.games) {
      const perGame = wins.get(g.game.id) ?? new Map();
      for (const e of g.entries.filter((x) => x.rank === 1)) {
        const w = perGame.get(e.playerJid) ?? { playerJid: e.playerJid, name: e.name, value: 0 };
        w.value += 1;
        perGame.set(e.playerJid, w);
      }
      wins.set(g.game.id, perGame);
    }
  }

  const oldest = weeks[weeks.length - 1]?.from ?? today;
  const since = rows
    .filter((r) => r.game_day >= oldest && r.game_day <= today)
    .reduce((min, r) => (r.game_day < min ? r.game_day : min), today);

  return {
    weeks,
    weekWins: GAMES.filter((g) => wins.has(g.id)).map((game) => ({
      game,
      entries: rankEntries([...wins.get(game.id)!.values()]),
    })),
    averages: buildWeekly(rows, oldest, today, nameOf).games.map((g) => ({ game: g.game, entries: g.entries })),
    since,
  };
}

// ---------------------------------------------------------------------------
// Formatting (Dutch, WhatsApp markup: *bold*)

const MEDALS = ['🥇', '🥈', '🥉'];

export function medal(rank: number): string {
  return MEDALS[rank - 1] ?? `${rank}.`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatRange(from: string, to: string): string {
  return from.slice(0, 7) === to.slice(0, 7)
    ? `${Number(from.slice(8))} – ${formatDayMonth(to)}`
    : `${formatDayMonth(from)} – ${formatDayMonth(to)}`;
}

export function formatDaily(s: DailyStandings, opts: { final: boolean; joke?: string }): string {
  const title = opts.final ? '🏆 *Dagstand' : '📋 *Tussenstand';
  const lines = [`${title} ${formatDayLong(s.day)}*`];

  if (s.scoreCount === 0) lines.push('', 'Nog geen scores vandaag. 🦗');
  for (const g of s.games) {
    const puzzle = g.puzzle && /^\d+$/.test(g.puzzle) ? ` #${g.puzzle}` : '';
    lines.push('', `${g.game.emoji} *${g.game.name}*${puzzle}`);
    for (const e of g.entries) lines.push(`${medal(e.rank)} ${e.name} — ${e.value}`);
  }
  if (s.notPlayed.length > 0) lines.push('', `😴 Nog niet gespeeld: ${s.notPlayed.join(', ')}`);
  if (opts.joke) lines.push('', `😏 ${opts.joke}`);
  return lines.join('\n');
}

export function formatWeekly(w: WeeklySummary, opts: { final: boolean }): string {
  const title = opts.final
    ? `📅 *Weekoverzicht ${formatRange(w.from, w.to)}*`
    : `📅 *Week tot nu toe* (${formatRange(w.from, w.to)})`;
  const lines = [title];

  if (w.games.length === 0) {
    lines.push('', 'Deze week nog geen scores. 🦗');
    return lines.join('\n');
  }
  for (const g of w.games) {
    lines.push('', `${g.game.emoji} *${g.game.name}* (gemiddelde)`);
    for (const e of g.entries) lines.push(`${medal(e.rank)} ${e.name} — ${e.value} (${plural(e.days, 'dag', 'dagen')})`);
    lines.push(`🏅 Dagwinsten: ${g.dayWins.map((e) => `${e.name} ${e.value}`).join(' · ')}`);
  }
  return lines.join('\n');
}

export function formatOverview(o: Overview): string {
  const lines = ['📈 *Overzicht per week* (gemiddelde per spel)'];
  if (o.weeks.length === 0) {
    lines.push('', 'Nog geen scores. 🦗');
    return lines.join('\n');
  }

  for (const w of o.weeks) {
    lines.push('', w.current ? `*Deze week* (${formatRange(w.from, w.to)})` : `*${formatRange(w.from, w.to)}*`);
    lines.push(w.winners.map((x) => `${x.game.emoji} ${x.names.join(' & ')} ${x.value}`).join(' · '));
  }

  if (o.weekWins.length > 0) {
    lines.push('', '🏆 *Weekwinsten*');
    for (const g of o.weekWins) lines.push(`${g.game.emoji} ${g.entries.map((e) => `${e.name} ${e.value}×`).join(' · ')}`);
  }

  lines.push('', `📊 *Gemiddeld sinds ${formatDayMonth(o.since)}*`);
  for (const g of o.averages) lines.push(`${g.game.emoji} ${g.entries.map((e) => `${e.name} ${e.value}`).join(' · ')}`);
  return lines.join('\n');
}
