import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import {
  buildDaily,
  buildOverview,
  buildWeekly,
  formatDaily,
  formatOverview,
  formatWeekly,
  gamePoints,
  rankEntries,
} from '../src/leaderboard.js';
import { makeNameLookup } from '../src/names.js';
import { ingestMessage } from '../src/scores.js';
import { cet, MAPTAP, message, POLDER } from './helpers.js';

const TZ = 'Europe/Amsterdam';
const ANNA = '1001@lid';
const BOB = '1002@lid';
const CARLA = '1003@lid';

function play(store: Store, jid: string, name: string, day: string, polder?: number, map?: number) {
  const date = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const puzzle = 100 + Number(day.slice(8));
  const timestamp = cet(`${day}T12:00:00`);
  if (polder !== undefined) ingestMessage(store, message({ text: POLDER(puzzle, polder), playerJid: jid, pushName: name, timestamp }), TZ);
  if (map !== undefined) ingestMessage(store, message({ text: MAPTAP(date, map), playerJid: jid, pushName: name, timestamp }), TZ);
}

describe('ranking', () => {
  it('assigns competition ranks with ties', () => {
    const ranked = rankEntries([
      { name: 'C', value: 10 },
      { name: 'A', value: 30 },
      { name: 'B', value: 30 },
      { name: 'D', value: 5 },
    ]);
    expect(ranked.map((e) => [e.name, e.rank])).toEqual([
      ['A', 1],
      ['B', 1],
      ['C', 3],
      ['D', 4],
    ]);
  });

  it('gives each game an equal share of 1000 points', () => {
    expect(gamePoints(4478, 5000)).toBeCloseTo(447.8);
    expect(gamePoints(944, 1000)).toBe(472);
    expect(gamePoints(5000, 5000) + gamePoints(1000, 1000)).toBe(1000);
  });
});

describe('daily standings', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });

  it('ranks per game, combines and lists who has not played', () => {
    play(store, ANNA, 'Anna', '2026-11-06', 4478, 902);
    play(store, BOB, 'Bob', '2026-11-06', 4210, 944);
    play(store, CARLA, 'Carla', '2026-11-05', 3000);

    const names = makeNameLookup(new Map([['1002@lid', 'Bobby']]), store.players());
    const s = buildDaily(store.scoresForDay('2026-11-06'), '2026-11-06', names, [ANNA, BOB, CARLA]);

    expect(s.games.map((g) => g.entries.map((e) => e.name))).toEqual([
      ['Anna', 'Bobby'],
      ['Bobby', 'Anna'],
    ]);
    // Anna: 4478/10 + 902/2 = 447.8 + 451 = 899; Bob: 421 + 472 = 893
    expect(s.combined?.map((e) => [e.name, e.value])).toEqual([
      ['Anna', 899],
      ['Bobby', 893],
    ]);
    expect(s.notPlayed).toEqual(['Carla']);

    expect(formatDaily(s, { final: true })).toBe(
      [
        '🏆 *Dagstand vrijdag 6 november*',
        '',
        '📍 *Polderprikker* #106',
        '🥇 Anna — 4478',
        '🥈 Bobby — 4210',
        '',
        '🗺️ *MapTap*',
        '🥇 Bobby — 944',
        '🥈 Anna — 902',
        '',
        '📊 *Totaal* (max 1000, uitleg: !help)',
        '🥇 Anna — 899',
        '🥈 Bobby — 893',
        '',
        '😴 Nog niet gespeeld: Carla',
      ].join('\n'),
    );
  });

  it('skips the combined ranking when only one game was played', () => {
    play(store, ANNA, 'Anna', '2026-11-06', 4478);
    const s = buildDaily(store.scoresForDay('2026-11-06'), '2026-11-06', makeNameLookup(new Map(), store.players()));
    expect(s.combined).toBeNull();
    expect(formatDaily(s, { final: false })).not.toContain('Totaal');
  });

  it('says so when nobody played', () => {
    const s = buildDaily([], '2026-11-06', makeNameLookup(new Map(), []));
    expect(formatDaily(s, { final: false })).toContain('Nog geen scores vandaag');
  });
});

describe('weekly summary', () => {
  it('sums daily points and counts daily wins', () => {
    const store = new Store(':memory:');
    play(store, ANNA, 'Anna', '2026-11-02', 5000, 1000); // Anna wins Monday
    play(store, BOB, 'Bob', '2026-11-02', 4000, 900);
    play(store, BOB, 'Bob', '2026-11-03', 2500); // Bob alone on Tuesday
    play(store, ANNA, 'Anna', '2026-11-04', 3000);
    play(store, BOB, 'Bob', '2026-11-04', 3000); // tie on Wednesday

    const names = makeNameLookup(new Map(), store.players());
    const w = buildWeekly(store.scoresBetween('2026-11-02', '2026-11-08'), '2026-11-02', '2026-11-08', names);

    // Mon: Anna 1000, Bob 400+450=850; Tue: Bob 250; Wed: both 300
    expect(w.totals.map((e) => [e.name, e.value, e.wins, e.daysPlayed, e.average])).toEqual([
      ['Bob', 1400, 2, 3, 467],
      ['Anna', 1300, 2, 2, 650],
    ]);
    const text = formatWeekly(w, { final: true });
    expect(text).toContain('📅 *Weekoverzicht 2 – 8 november*');
    expect(text).toContain('🥇 Bob — 1.400 · 3 dagen · 2× dagwinst');
    expect(text).toContain('🥈 Anna — 1.300 · 2 dagen · 2× dagwinst');
    expect(text).toContain('ma Anna · di Bob · wo Anna & Bob · do – · vr – · za – · zo –');
  });
});

describe('overview', () => {
  it('shows recent weeks, completed-week wins and averages', () => {
    const store = new Store(':memory:');
    play(store, ANNA, 'Anna', '2026-10-20', 5000, 1000); // week 19-25 Oct: Anna wins
    play(store, BOB, 'Bob', '2026-10-21', 2500);
    play(store, BOB, 'Bob', '2026-10-27', 4000, 900); // week 26 Oct - 1 Nov: Bob wins
    play(store, ANNA, 'Anna', '2026-11-03', 3000); // current week
    play(store, BOB, 'Bob', '2026-11-04', 4000, 800);

    const names = makeNameLookup(new Map(), store.players());
    const o = buildOverview(store.scoresBetween('2026-09-28', '2026-11-06'), '2026-11-06', 6, names);
    expect(o.weeks.map((w) => [w.from, w.to, w.current, w.totals[0]?.name])).toEqual([
      ['2026-11-02', '2026-11-06', true, 'Bob'],
      ['2026-10-26', '2026-11-01', false, 'Bob'],
      ['2026-10-19', '2026-10-25', false, 'Anna'],
    ]);
    expect(o.weekWins.map((e) => [e.name, e.value])).toEqual([
      ['Anna', 1],
      ['Bob', 1],
    ]);
    // Anna: (1000 + 300) / 2 = 650; Bob: (250 + 850 + 800) / 3 = 633
    expect(o.averages.map((e) => [e.name, e.value, e.daysPlayed])).toEqual([
      ['Anna', 650, 2],
      ['Bob', 633, 3],
    ]);
    expect(o.since).toBe('2026-10-20');

    const text = formatOverview(o);
    expect(text).toContain('*Deze week* (2 – 6 november)\n🥇 Bob 800 · 🥈 Anna 300');
    expect(text).toContain('*26 oktober – 1 november*\n🥇 Bob 850');
    expect(text).toContain('🏆 *Weekwinsten*: Anna 1× · Bob 1×');
    expect(text).toContain('📊 *Gemiddeld dagtotaal* (sinds 20 oktober)\n🥇 Anna — 650 · 2 dagen\n🥈 Bob — 633 · 3 dagen');
  });

  it('says so when there is nothing yet', () => {
    expect(formatOverview(buildOverview([], '2026-11-06', 6, makeNameLookup(new Map(), [])))).toContain('Nog geen scores');
  });
});
