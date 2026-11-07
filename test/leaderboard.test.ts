import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { buildDaily, buildOverview, buildWeekly, formatDaily, formatOverview, formatWeekly, rankEntries } from '../src/leaderboard.js';
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
});

describe('daily standings', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });

  it('ranks each game separately and lists who has not played', () => {
    play(store, ANNA, 'Anna', '2026-11-06', 4478, 902);
    play(store, BOB, 'Bob', '2026-11-06', 4210, 944);
    play(store, CARLA, 'Carla', '2026-11-05', 3000);

    const names = makeNameLookup(new Map([['1002@lid', 'Bobby']]), store.players());
    const s = buildDaily(store.scoresForDay('2026-11-06'), '2026-11-06', names, [ANNA, BOB, CARLA]);

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
        '😴 Nog niet gespeeld: Carla',
      ].join('\n'),
    );
  });

  it('says so when nobody played', () => {
    const s = buildDaily([], '2026-11-06', makeNameLookup(new Map(), []));
    expect(formatDaily(s, { final: false })).toContain('Nog geen scores vandaag');
  });
});

describe('weekly summary', () => {
  it('ranks each game by average score and counts day wins', () => {
    const store = new Store(':memory:');
    play(store, ANNA, 'Anna', '2026-11-02', 5000, 1000);
    play(store, BOB, 'Bob', '2026-11-02', 4000, 900);
    play(store, BOB, 'Bob', '2026-11-03', 2500);
    play(store, ANNA, 'Anna', '2026-11-04', 3000);
    play(store, BOB, 'Bob', '2026-11-04', 3000); // tie: both win Wednesday

    const names = makeNameLookup(new Map(), store.players());
    const w = buildWeekly(store.scoresBetween('2026-11-02', '2026-11-08'), '2026-11-02', '2026-11-08', names);
    expect(formatWeekly(w, { final: true })).toBe(
      [
        '📅 *Weekoverzicht 2 – 8 november*',
        '',
        '📍 *Polderprikker* (gemiddelde)',
        '🥇 Anna — 4000 (2 dagen)',
        '🥈 Bob — 3167 (3 dagen)',
        '🏅 Dagwinsten: Anna 2 · Bob 2',
        '',
        '🗺️ *MapTap* (gemiddelde)',
        '🥇 Anna — 1000 (1 dag)',
        '🥈 Bob — 900 (1 dag)',
        '🏅 Dagwinsten: Anna 1',
      ].join('\n'),
    );
  });
});

describe('overview', () => {
  it('shows the winner per game per week, completed-week wins and averages', () => {
    const store = new Store(':memory:');
    play(store, ANNA, 'Anna', '2026-10-20', 5000, 1000); // week 19-25 Oct
    play(store, BOB, 'Bob', '2026-10-21', 2500);
    play(store, BOB, 'Bob', '2026-10-27', 4000, 900); // week 26 Oct - 1 Nov
    play(store, ANNA, 'Anna', '2026-11-03', 3000); // current week
    play(store, BOB, 'Bob', '2026-11-04', 4000, 800);

    const names = makeNameLookup(new Map(), store.players());
    const o = buildOverview(store.scoresBetween('2026-09-28', '2026-11-06'), '2026-11-06', 6, names);
    expect(formatOverview(o)).toBe(
      [
        '📈 *Overzicht per week* (gemiddelde per spel)',
        '',
        '*Deze week* (2 – 6 november)',
        '📍 Bob 4000 · 🗺️ Bob 800',
        '',
        '*26 oktober – 1 november*',
        '📍 Bob 4000 · 🗺️ Bob 900',
        '',
        '*19 – 25 oktober*',
        '📍 Anna 5000 · 🗺️ Anna 1000',
        '',
        '🏆 *Weekwinsten*',
        '📍 Anna 1× · Bob 1×',
        '🗺️ Anna 1× · Bob 1×',
        '',
        '📊 *Gemiddeld sinds 20 oktober*',
        '📍 Anna 4000 · Bob 3500',
        '🗺️ Anna 1000 · Bob 850',
      ].join('\n'),
    );
  });

  it('says so when there is nothing yet', () => {
    expect(formatOverview(buildOverview([], '2026-11-06', 6, makeNameLookup(new Map(), [])))).toContain('Nog geen scores');
  });
});
