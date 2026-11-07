import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { importExport, parseExport, resolveAuthors } from '../src/import.js';
import { ingestMessage } from '../src/scores.js';
import { zonedTimeToUnix } from '../src/time.js';
import { message } from './helpers.js';

const TZ = 'Europe/Amsterdam';

const EXPORT = [
  '18/10/2026, 11:11 - Messages and calls are end-to-end encrypted. Only people in this chat can read them.',
  '18/10/2026, 00:26 - Anna created group "Spelletjes"',
  '18/10/2026, 00:27 - Anna: Hoi allemaal!',
  '18/10/2026, 00:56 - Anna: www.maptap.gg October 18',
  '99🔥 100🎯 100🎯 96🏅 95🏅',
  'Final score: 972',
  '18/10/2026, 01:29 - Bob Jansen: www.maptap.gg October 18',
  '100🎯 100🎯 100🎯 95🏅 95🏅',
  'Final score: 970',
  '18/10/2026, 09:00 - Bob Jansen: www.maptap.gg October 18',
  'Final score: 1000',
  '19/10/2026, 00:10 - Carla: www.maptap.gg October 18',
  'Final score: 900',
  '06/11/2026, 23:19 - Daan: #Polderprikker nummer 158 • 4691/5000',
  '🟦1000 🟦1000 🟩995 🟧504 🟩979',
  'https://polderprikker.nl/',
  '06/11/2026, 23:25 - Scorebot: 📋 *Tussenstand vrijdag 6 november*',
  '',
  '📍 *Polderprikker* #158',
  '🥇 Daan — 4691',
  '07/11/2026, 10:00 - Eva Bakker: #Polderprikker nummer 159 • 4000/5000',
].join('\n');

const player = (jid: string, phone: string, name: string) => ({ jid, phone_jid: phone, name, updated_at: 1 });

describe('parseExport', () => {
  it('reads multi-line messages, skips system lines and converts local time', () => {
    const msgs = parseExport(EXPORT, TZ);
    expect(msgs.map((m) => m.author)).toEqual([
      'Anna',
      'Anna',
      'Bob Jansen',
      'Bob Jansen',
      'Carla',
      'Daan',
      'Scorebot',
      'Eva Bakker',
    ]);
    expect(msgs[1]!.text).toBe('www.maptap.gg October 18\n99🔥 100🎯 100🎯 96🏅 95🏅\nFinal score: 972');
    // 18 Oct is summer time (UTC+2); minute-precision exports use second 59
    expect(msgs[1]!.timestamp).toBe(Date.parse('2026-10-17T22:56:59Z') / 1000);
  });

  it('reads the iOS format with seconds', () => {
    const [m] = parseExport('[06/11/2026, 23:19:09] Daan: hoi‎', TZ);
    expect(m).toEqual({ author: 'Daan', text: 'hoi', timestamp: Date.parse('2026-11-06T22:19:09Z') / 1000 });
  });

  it('handles winter time', () => {
    expect(zonedTimeToUnix('2026-11-06', 23, 19, 0, TZ)).toBe(Date.parse('2026-11-06T22:19:00Z') / 1000);
  });
});

describe('resolveAuthors', () => {
  const players = [
    player('1@lid', '31600000001@s.whatsapp.net', 'Anna de Vries'),
    player('2@lid', '31600000002@s.whatsapp.net', 'Bob Jansen'),
  ];
  const members = [
    { id: '1@lid', phone_jid: '31600000001@s.whatsapp.net', updated_at: 1 },
    { id: '2@lid', phone_jid: '31600000002@s.whatsapp.net', updated_at: 1 },
    { id: '3@lid', phone_jid: '31600000003@s.whatsapp.net', updated_at: 1 },
    { id: '4@lid', phone_jid: null, updated_at: 1 },
  ];

  it('matches by alias, WhatsApp name, first name, phone number and the last remaining member', () => {
    const aliases = new Map([['31600000003@s.whatsapp.net', 'Caro']]);
    const { mapping, unresolved } = resolveAuthors(
      ['Anna', 'Bob Jansen', 'Caro', '+31 6 00000005', 'Eva Bakker'],
      aliases,
      players,
      members,
    );
    expect(unresolved).toEqual([]);
    expect(Object.fromEntries([...mapping].map(([a, r]) => [a, r.jid]))).toEqual({
      Anna: '1@lid',
      'Bob Jansen': '2@lid',
      Caro: '3@lid',
      '+31 6 00000005': '31600000005@s.whatsapp.net',
      'Eva Bakker': '4@lid',
    });
    expect(mapping.get('Caro')?.phoneJid).toBe('31600000003@s.whatsapp.net');
  });

  it('reports names it cannot match', () => {
    const { unresolved } = resolveAuthors(['Xander', 'Yara'], new Map(), players, members);
    expect(unresolved).toEqual(['Xander', 'Yara']);
  });
});

describe('importExport', () => {
  function setup() {
    const store = new Store(':memory:');
    store.setMembers([
      { id: '1@lid', phoneJid: '31600000001@s.whatsapp.net' },
      { id: '2@lid' },
      { id: '3@lid' },
      { id: '4@lid' },
      { id: '5@lid' },
    ]);
    for (const [jid, name] of [
      ['1@lid', 'Anna de Vries'],
      ['2@lid', 'Bob Jansen'],
      ['3@lid', 'Carla'],
      ['4@lid', 'Daan'],
    ] as const) {
      store.upsertPlayer(jid, undefined, name, 2_000_000_000);
    }
    // Daan's Polderprikker was already recorded live, with exact seconds.
    ingestMessage(
      store,
      message({
        id: 'LIVE1',
        playerJid: '4@lid',
        pushName: 'Daan',
        text: '#Polderprikker nummer 158 • 4691/5000',
        timestamp: Date.parse('2026-11-06T22:19:09Z') / 1000,
      }),
      TZ,
    );
    return store;
  }
  const opts = { timeZone: TZ, aliases: new Map<string, string>() };

  it('previews without storing anything', () => {
    const store = setup();
    const report = importExport(store, EXPORT, { ...opts, apply: false });
    expect(report.applied).toBe(false);
    expect(report.counts.maptap).toEqual({ inserted: 2, ignored: 1, stale: 1 });
    expect(report.counts.polderprikker).toEqual({ ignored: 1, inserted: 1 });
    expect(store.scoresBetween('2026-10-01', '2026-11-30')).toHaveLength(1);
  });

  it('imports scores, keeps the first one per day and is safe to run twice', () => {
    const store = setup();
    const report = importExport(store, EXPORT, { ...opts, apply: true });
    expect(report.applied).toBe(true);
    expect(report.mapping.get('Eva Bakker')?.jid).toBe('5@lid');
    expect(report.stale).toEqual([
      { author: 'Carla', day: '2026-10-19', game: 'maptap', score: 900, reason: 'result is for 2026-10-18' },
    ]);

    const rows = store.scoresBetween('2026-10-01', '2026-11-30');
    expect(rows.map((r) => [r.game_day, r.player_jid, r.score, r.message_id.startsWith('import-')])).toEqual([
      ['2026-10-18', '1@lid', 972, true],
      ['2026-10-18', '2@lid', 970, true], // the later 1000 does not count
      ['2026-11-06', '4@lid', 4691, false], // live copy kept
      ['2026-11-07', '5@lid', 4000, true],
    ]);
    // Name for a player the bot has not seen live yet comes from the export.
    expect(store.players().find((p) => p.jid === '5@lid')?.name).toBe('Eva Bakker');
    // Names the bot already knows are not overwritten by older export names.
    expect(store.players().find((p) => p.jid === '1@lid')?.name).toBe('Anna de Vries');

    const again = importExport(store, EXPORT, { ...opts, apply: true });
    expect(again.counts.maptap).toEqual({ duplicate: 2, ignored: 1, stale: 1 });
    expect(store.scoresBetween('2026-10-01', '2026-11-30')).toHaveLength(4);
  });
});
