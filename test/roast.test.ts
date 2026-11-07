import { describe, expect, it } from 'vitest';
import { Pseudonyms } from '../src/ai.js';
import { Store } from '../src/db.js';
import { buildRoastPrompt, findPlayers } from '../src/roast.js';
import { ingestMessage } from '../src/scores.js';
import { cet, MAPTAP, message, POLDER } from './helpers.js';

const players = [
  { jid: '111@lid', name: 'Jan de Boer', phoneJid: '31600000001@s.whatsapp.net' },
  { jid: '222@lid', name: 'Joris' },
  { jid: '333@lid', name: 'Eva Bakker' },
];

describe('findPlayers', () => {
  const names = (q: string) => findPlayers(q, players).map((p) => p.name);

  it('matches full name, first name and the start of a name', () => {
    expect(names('Eva Bakker')).toEqual(['Eva Bakker']);
    expect(names('jan')).toEqual(['Jan de Boer']);
    expect(names('JOR')).toEqual(['Joris']);
    expect(names('th')).toEqual([]); // too short to guess
    expect(names('jor')).toEqual(['Joris']);
    expect(names('t')).toEqual([]);
  });

  it('returns every candidate when the start of a name is ambiguous', () => {
    expect(names('eva')).toEqual(['Eva Bakker']);
    expect(findPlayers('th', [...players, { jid: '4@lid', name: 'Thea' }])).toEqual([]);
    expect(findPlayers('the', [...players, { jid: '4@lid', name: 'Thea' }, { jid: '5@lid', name: 'Theo' }]).map((p) => p.name)).toEqual([
      'Thea',
      'Theo',
    ]);
  });

  it('understands WhatsApp mentions by phone number or LID', () => {
    expect(names('@31600000001')).toEqual(['Jan de Boer']);
    expect(names('@333')).toEqual([]); // ids are long; short numbers are not ids
    expect(findPlayers('@99999', [{ jid: '99999@lid', name: 'X' }]).map((p) => p.name)).toEqual(['X']);
  });
});

describe('buildRoastPrompt', () => {
  it('describes the player as {p1} with ranks, and no names at all', () => {
    const store = new Store(':memory:');
    const day = (d: number, h = 12) => cet(`2026-11-0${d}T${h}:00:00`);
    for (const [jid, name, polder, map] of [
      ['111@lid', 'Jan de Boer', 2000, 700],
      ['222@lid', 'Joris', 4000, 900],
      ['333@lid', 'Eva Bakker', 4500, undefined],
    ] as const) {
      ingestMessage(store, message({ text: POLDER(155, polder), playerJid: jid, pushName: name, timestamp: day(3) }), 'Europe/Amsterdam');
      if (map) ingestMessage(store, message({ text: MAPTAP('November 3', map), playerJid: jid, pushName: name, timestamp: day(3) }), 'Europe/Amsterdam');
    }
    ingestMessage(store, message({ text: POLDER(156, 3000), playerJid: '111@lid', pushName: 'Jan de Boer', timestamp: day(4) }), 'Europe/Amsterdam');

    const prompt = buildRoastPrompt(store.scoresBetween('2026-10-24', '2026-11-06'), players[0]!, new Pseudonyms(), {
      today: '2026-11-06',
      timeZone: 'Europe/Amsterdam',
      notes: ['speelt altijd om 7 uur'],
    });
    expect(prompt).not.toMatch(/Jan|Joris|Eva|Boer|Bakker|@lid/);
    expect(prompt).toBe(
      [
        'Game results of the last 14 days in a group of 3 players. Player: {p1}.',
        "- Polderprikker (max 5000): {p1} played it on 2 of the 2 days anyone played it, average 2500, best 3000, worst 2000, rank 3 of 3 by average (group's best average 4500), 0 daily wins, 1 time last of the day; the others average 4250",
        "- MapTap (max 1000): {p1} played it on 1 of the 1 day anyone played it, average 700, best 700, worst 700, rank 2 of 2 by average (group's best average 900), 0 daily wins, 1 time last of the day; the others average 900",
        '{p1} posted a result on 2 of the last 14 days, usually around 12:00; last result 2 days ago.',
        'Running joke in the group about {p1} (build the roast around it):',
        '- speelt altijd om 7 uur',
      ].join('\n'),
    );
  });
});
