import { describe, expect, it } from 'vitest';
import { ScoreBot, type Messenger } from '../src/bot.js';
import { parseCommand } from '../src/commands.js';
import { Store } from '../src/db.js';
import { cet, MAPTAP, message, POLDER, silentLogger, testConfig } from './helpers.js';

class FakeMessenger implements Messenger {
  sent: string[] = [];
  members: Set<string> | null = null;
  async send(text: string) {
    this.sent.push(text);
  }
  async memberIds() {
    return this.members;
  }
}

function setup(nowIso: string, cfgOver = {}) {
  const store = new Store(':memory:');
  const messenger = new FakeMessenger();
  let now = new Date(`${nowIso}+01:00`);
  const bot = new ScoreBot(testConfig(cfgOver), store, messenger, silentLogger, () => now);
  return { store, messenger, bot, setNow: (iso: string) => (now = new Date(`${iso}+01:00`)) };
}

describe('commands', () => {
  it('parses only exact commands', () => {
    expect(parseCommand('!stand')).toBe('stand');
    expect(parseCommand('  !WEEK ')).toBe('week');
    expect(parseCommand('!help')).toBe('help');
    expect(parseCommand('!weken')).toBe('overview');
    expect(parseCommand('!stand graag')).toBeNull();
    expect(parseCommand('wat is de !stand')).toBeNull();
    expect(parseCommand('!foo')).toBeNull();
  });

  it('answers !stand with today\'s standings', async () => {
    const { bot, messenger } = setup('2026-11-06T15:00:00');
    await bot.handleGroupMessage(message({ text: POLDER(158, 4478), timestamp: cet('2026-11-06T09:00:00') }));
    await bot.handleGroupMessage(message({ text: '!stand', timestamp: cet('2026-11-06T15:00:00') }));
    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]).toContain('Tussenstand vrijdag 6 november');
    expect(messenger.sent[0]).toContain('🥇 Anna — 4478');
  });

  it('explains the total in !help', async () => {
    const { bot, messenger } = setup('2026-11-06T15:00:00');
    await bot.handleGroupMessage(message({ text: '!help', timestamp: cet('2026-11-06T15:00:00') }));
    const help = messenger.sent[0]!;
    expect(help).toContain('*!weken* – overzicht van de afgelopen weken');
    expect(help).toContain('📍 Polderprikker: score ÷ 10 (5000 → 500)');
    expect(help).toContain('🗺️ MapTap: score ÷ 2 (1000 → 500)');
    expect(help).toContain('Dagtotaal = die punten opgeteld, max 1000. Spel niet gespeeld = 0.');
    expect(help).toContain('Voorbeeld: Polderprikker 4500 + MapTap 950 → 450 + 475 = 925');
  });

  it('answers !weken with the overview', async () => {
    const { bot, messenger } = setup('2026-11-06T15:00:00');
    await bot.handleGroupMessage(message({ text: POLDER(158, 4478), timestamp: cet('2026-11-06T09:00:00') }));
    await bot.handleGroupMessage(message({ text: '!weken', timestamp: cet('2026-11-06T15:00:00') }));
    expect(messenger.sent[0]).toContain('📈 *Overzicht per week*');
    expect(messenger.sent[0]).toContain('🥇 Anna 448');
  });

  it('ignores commands from a backlog and applies a cooldown', async () => {
    const { bot, messenger, setNow } = setup('2026-11-06T15:00:00');
    await bot.handleGroupMessage(message({ text: '!help', timestamp: cet('2026-11-06T14:50:00') }));
    expect(messenger.sent).toHaveLength(0);

    await bot.handleGroupMessage(message({ text: '!help', timestamp: cet('2026-11-06T15:00:00') }));
    await bot.handleGroupMessage(message({ text: '!help', timestamp: cet('2026-11-06T15:00:00') }));
    expect(messenger.sent).toHaveLength(1);

    setNow('2026-11-06T15:01:00');
    await bot.handleGroupMessage(message({ text: '!help', timestamp: cet('2026-11-06T15:01:00') }));
    expect(messenger.sent).toHaveLength(2);
  });

  it('does not react to normal chat', async () => {
    const { bot, messenger, store } = setup('2026-11-06T15:00:00');
    await bot.handleGroupMessage(message({ text: 'haha goeie' }));
    expect(messenger.sent).toHaveLength(0);
    expect(store.scoresForDay('2026-11-06')).toHaveLength(0);
  });
});

describe('scheduled posts', () => {
  it('posts the daily leaderboard once', async () => {
    const { bot, messenger } = setup('2026-11-06T22:00:00');
    await bot.handleGroupMessage(message({ text: MAPTAP('November 6', 944), timestamp: cet('2026-11-06T10:00:00') }));
    await bot.postScheduled();
    await bot.postScheduled();
    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]).toContain('🏆 *Dagstand vrijdag 6 november*');
  });

  it('stays quiet when nobody played', async () => {
    const { bot, messenger } = setup('2026-11-06T22:00:00');
    await bot.postScheduled();
    expect(messenger.sent).toHaveLength(0);
  });

  it('adds the weekly summary on Sunday', async () => {
    const { bot, messenger } = setup('2026-11-08T22:00:00');
    await bot.handleGroupMessage(message({ text: POLDER(160, 4000), timestamp: cet('2026-11-08T10:00:00') }));
    await bot.postScheduled();
    expect(messenger.sent).toHaveLength(2);
    expect(messenger.sent[1]).toContain('Weekoverzicht 2 – 8 november');
  });

  it('does not mark posts as sent in dry-run mode', async () => {
    const { bot, store } = setup('2026-11-06T22:00:00', { dryRun: true });
    await bot.handleGroupMessage(message({ text: POLDER(158, 4000), timestamp: cet('2026-11-06T10:00:00') }));
    await bot.postScheduled();
    expect(store.wasPosted('daily', '2026-11-06')).toBe(false);
  });

  it('catches up after a restart past the post time, not before', async () => {
    const { bot, messenger, setNow } = setup('2026-11-06T21:30:00');
    await bot.handleGroupMessage(message({ text: POLDER(158, 4000), timestamp: cet('2026-11-06T10:00:00') }));
    await bot.catchUp();
    expect(messenger.sent).toHaveLength(0);
    setNow('2026-11-06T22:40:00');
    await bot.catchUp();
    expect(messenger.sent).toHaveLength(1);
  });

  it('lists only active players who are still in the group as not played', async () => {
    const { bot, messenger } = setup('2026-11-06T22:00:00');
    const yesterday = cet('2026-11-05T10:00:00');
    await bot.handleGroupMessage(message({ text: POLDER(157, 4000), playerJid: '1002@lid', pushName: 'Bob', timestamp: yesterday }));
    await bot.handleGroupMessage(message({ text: POLDER(157, 4000), playerJid: '1003@lid', pushName: 'Carla', timestamp: yesterday }));
    await bot.handleGroupMessage(message({ text: POLDER(158, 4000), timestamp: cet('2026-11-06T10:00:00') }));
    messenger.members = new Set(['1001@lid', '1002@lid']); // Carla left the group
    await bot.postScheduled();
    expect(messenger.sent[0]).toContain('😴 Nog niet gespeeld: Bob');
    expect(messenger.sent[0]).not.toContain('Carla');
  });
});
