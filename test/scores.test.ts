import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { ingestMessage } from '../src/scores.js';
import { cet, MAPTAP, message, POLDER } from './helpers.js';

const TZ = 'Europe/Amsterdam';

describe('ingestMessage', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });

  it('stores a score with the Amsterdam game day', () => {
    const msg = message({ text: POLDER(158, 4478), timestamp: cet('2026-11-06T00:30:00') });
    expect(ingestMessage(store, msg, TZ)).toMatchObject([{ game: 'polderprikker', outcome: 'inserted', day: '2026-11-06' }]);
    const [row] = store.scoresForDay('2026-11-06');
    expect(row).toMatchObject({ player_jid: '1001@lid', display_name: 'Anna', score: 4478, max_score: 5000, puzzle: '158' });
  });

  it('ignores non-score messages and stores nothing', () => {
    expect(ingestMessage(store, message({ text: 'goedemorgen!' }), TZ)).toEqual([]);
    expect(store.scoresForDay('2026-11-06')).toHaveLength(0);
    expect(store.players()).toHaveLength(0);
  });

  it('deduplicates on message id', () => {
    const msg = message({ text: POLDER(158, 4478) });
    ingestMessage(store, msg, TZ);
    expect(ingestMessage(store, msg, TZ)[0]?.outcome).toBe('duplicate');
    expect(store.scoresForDay('2026-11-06')).toHaveLength(1);
  });

  it('counts only the first score per player, game and day', () => {
    ingestMessage(store, message({ text: POLDER(158, 3000), timestamp: cet('2026-11-06T09:00:00') }), TZ);
    const second = ingestMessage(store, message({ text: POLDER(158, 5000), timestamp: cet('2026-11-06T10:00:00') }), TZ);
    expect(second[0]?.outcome).toBe('ignored');
    expect(store.scoresForDay('2026-11-06')[0]?.score).toBe(3000);
  });

  it('lets an earlier message that arrives late win', () => {
    ingestMessage(store, message({ text: POLDER(158, 5000), timestamp: cet('2026-11-06T10:00:00') }), TZ);
    const late = ingestMessage(store, message({ text: POLDER(158, 3000), timestamp: cet('2026-11-06T09:00:00') }), TZ);
    expect(late[0]?.outcome).toBe('replaced');
    expect(store.scoresForDay('2026-11-06')[0]?.score).toBe(3000);
  });

  it('keeps games and players separate', () => {
    ingestMessage(store, message({ text: POLDER(158, 4000) }), TZ);
    ingestMessage(store, message({ text: MAPTAP('November 6', 900) }), TZ);
    ingestMessage(store, message({ text: POLDER(158, 4100), playerJid: '1002@lid', pushName: 'Bob' }), TZ);
    expect(store.scoresForDay('2026-11-06')).toHaveLength(3);
  });

  it('rejects a MapTap result for another date', () => {
    const r = ingestMessage(store, message({ text: MAPTAP('November 5', 900), timestamp: cet('2026-11-06T08:00:00') }), TZ);
    expect(r[0]).toMatchObject({ outcome: 'stale' });
    expect(store.scoresForDay('2026-11-06')).toHaveLength(0);
  });

  it('accepts MapTap around new year', () => {
    const r = ingestMessage(store, message({ text: MAPTAP('December 31', 900), timestamp: cet('2026-12-31T20:00:00') }), TZ);
    expect(r[0]?.outcome).toBe('inserted');
  });

  it('rejects a Polderprikker puzzle that was already played on an earlier day', () => {
    ingestMessage(store, message({ text: POLDER(157, 4000), timestamp: cet('2026-11-05T12:00:00') }), TZ);
    const r = ingestMessage(
      store,
      message({ text: POLDER(157, 4500), playerJid: '1002@lid', pushName: 'Bob', timestamp: cet('2026-11-06T12:00:00') }),
      TZ,
    );
    expect(r[0]).toMatchObject({ outcome: 'stale' });
  });

  it('remembers the latest pushName from score messages', () => {
    ingestMessage(store, message({ text: POLDER(158, 4000), pushName: 'Anna B', phoneJid: '31600000001@s.whatsapp.net' }), TZ);
    expect(store.players()).toMatchObject([{ jid: '1001@lid', name: 'Anna B', phone_jid: '31600000001@s.whatsapp.net' }]);
  });

  it('merges scores stored under a phone JID into the LID', () => {
    const pn = '31600000001@s.whatsapp.net';
    ingestMessage(store, message({ text: POLDER(158, 4000), playerJid: pn, timestamp: cet('2026-11-06T09:00:00') }), TZ);
    ingestMessage(store, message({ text: MAPTAP('November 6', 900), playerJid: '1001@lid', phoneJid: pn }), TZ);
    expect(new Set(store.scoresForDay('2026-11-06').map((r) => r.player_jid))).toEqual(new Set(['1001@lid']));
    expect(store.players().map((p) => p.jid)).toEqual(['1001@lid']);
  });
});

describe('Store', () => {
  it('tracks scheduled posts', () => {
    const store = new Store(':memory:');
    expect(store.wasPosted('daily', '2026-11-06')).toBe(false);
    store.markPosted('daily', '2026-11-06');
    store.markPosted('daily', '2026-11-06');
    expect(store.wasPosted('daily', '2026-11-06')).toBe(true);
  });
});
