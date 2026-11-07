import { describe, expect, it } from 'vitest';
import type { AskFn } from '../src/ai.js';
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

function setup(nowIso: string, opts: { cfg?: object; ask?: AskFn | null } = {}) {
  const store = new Store(':memory:');
  const messenger = new FakeMessenger();
  let now = new Date(`${nowIso}+01:00`);
  const bot = new ScoreBot(testConfig(opts.cfg), store, messenger, silentLogger, {
    now: () => now,
    random: () => 0,
    ask: opts.ask === undefined ? null : opts.ask,
  });
  return { store, messenger, bot, setNow: (iso: string) => (now = new Date(`${iso}+01:00`)) };
}

const at = (iso: string) => cet(`2026-11-06T${iso}`);

describe('commands', () => {
  it('parses only exact commands; only !roast takes a name', () => {
    expect(parseCommand('!stand')).toEqual({ command: 'stand' });
    expect(parseCommand('  !WEEK ')).toEqual({ command: 'week' });
    expect(parseCommand('!weken')).toEqual({ command: 'overview' });
    expect(parseCommand('!help')).toEqual({ command: 'help' });
    expect(parseCommand('!roast')).toEqual({ command: 'roast' });
    expect(parseCommand('!roast jan')).toEqual({ command: 'roast', arg: 'jan' });
    expect(parseCommand('!roast @31612345678 ')).toEqual({ command: 'roast', arg: '@31612345678' });
    expect(parseCommand('!stand graag')).toBeNull();
    expect(parseCommand('wat is de !stand')).toBeNull();
    expect(parseCommand('!foo')).toBeNull();
    expect(parseCommand(`!roast ${'x'.repeat(80)}`)).toBeNull();
    expect(parseCommand('!roast Davids skatevaardigheden')).toEqual({ command: 'roast', arg: 'Davids skatevaardigheden' });
  });

  it("answers !stand with today's standings", async () => {
    const { bot, messenger } = setup('2026-11-06T15:00:00');
    await bot.handleGroupMessage(message({ text: POLDER(158, 4478), timestamp: at('09:00:00') }));
    await bot.handleGroupMessage(message({ text: '!stand', timestamp: at('15:00:00') }));
    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]).toContain('Tussenstand vrijdag 6 november');
    expect(messenger.sent[0]).toContain('🥇 Anna — 4478');
  });

  it('keeps !help short and only lists !roast when it works', async () => {
    const without = setup('2026-11-06T15:00:00');
    await without.bot.handleGroupMessage(message({ text: '!help', timestamp: at('15:00:00') }));
    expect(without.messenger.sent[0]).not.toContain('!roast');
    expect(without.messenger.sent[0]).toContain('Plak je 📍 Polderprikker, 🗺️ MapTap of 🕰️ TimeGuessr-resultaat');
    expect(without.messenger.sent[0]!.split('\n').length).toBeLessThanOrEqual(10);

    const withAi = setup('2026-11-06T15:00:00', { ask: async () => 'x' });
    await withAi.bot.handleGroupMessage(message({ text: '!help', timestamp: at('15:00:00') }));
    expect(withAi.messenger.sent[0]).toContain('*!roast* [naam/iets]');
  });

  it('answers !weken with the overview', async () => {
    const { bot, messenger } = setup('2026-11-06T15:00:00');
    await bot.handleGroupMessage(message({ text: POLDER(158, 4478), timestamp: at('09:00:00') }));
    await bot.handleGroupMessage(message({ text: '!weken', timestamp: at('15:00:00') }));
    expect(messenger.sent[0]).toContain('📈 *Overzicht per week*');
    expect(messenger.sent[0]).toContain('📍 Anna 4478');
  });

  it('ignores commands from a backlog and applies a cooldown', async () => {
    const { bot, messenger, setNow } = setup('2026-11-06T15:00:00');
    await bot.handleGroupMessage(message({ text: '!help', timestamp: at('14:50:00') }));
    expect(messenger.sent).toHaveLength(0);

    await bot.handleGroupMessage(message({ text: '!help', timestamp: at('15:00:00') }));
    await bot.handleGroupMessage(message({ text: '!help', timestamp: at('15:00:00') }));
    expect(messenger.sent).toHaveLength(1);

    setNow('2026-11-06T15:01:00');
    await bot.handleGroupMessage(message({ text: '!help', timestamp: at('15:01:00') }));
    expect(messenger.sent).toHaveLength(2);
  });

  it('does not react to normal chat', async () => {
    const { bot, messenger, store } = setup('2026-11-06T15:00:00');
    await bot.handleGroupMessage(message({ text: 'haha goeie' }));
    expect(messenger.sent).toHaveLength(0);
    expect(store.scoresForDay('2026-11-06')).toHaveLength(0);
  });
});

describe('!roast', () => {
  async function withPlayers(ask: AskFn | null) {
    const ctx = setup('2026-11-06T15:00:00', { ask });
    await ctx.bot.handleGroupMessage(message({ text: POLDER(158, 4478), timestamp: at('09:00:00') }));
    await ctx.bot.handleGroupMessage(
      message({ text: MAPTAP('November 6', 610), playerJid: '1002@lid', pushName: 'Bob Jansen', timestamp: at('09:30:00') }),
    );
    return ctx;
  }

  it('roasts the named player without sending names to Claude', async () => {
    const calls: string[] = [];
    const ask: AskFn = async (system, prompt) => {
      calls.push(system, prompt);
      return '"{p1} zoekt Nederland nog steeds op de kaart van België."';
    };
    const { bot, messenger } = await withPlayers(ask);
    await bot.handleGroupMessage(message({ text: '!roast bob', timestamp: at('15:00:00') }));
    expect(messenger.sent).toEqual(['🔥 Bob zoekt Nederland nog steeds op de kaart van België.']);
    expect(calls.join('\n')).not.toMatch(/Bob|Anna|Jansen|@lid/);
    expect(calls[1]).toContain('MapTap (max 1000): {p1} played it on 1 of the 1 day anyone played it, average 610');
    expect(calls[1]).toContain('Polderprikker (max 5000): {p1} did not play it once; the others average 4478');
  });

  it('adds running jokes from config.json for that player only', async () => {
    let prompt = '';
    const ctx = setup('2026-11-06T15:00:00', {
      cfg: { roastNotes: new Map([['1002@lid', ['denkt dat Zwolle in Friesland ligt', 'slaapt door zijn wekker heen']]]) },
      ask: async (_s, p) => {
        prompt = p;
        return '<roast>{p1}, zelfs Zwolle weet waar jij ligt.</roast>';
      },
    });
    await ctx.bot.handleGroupMessage(
      message({ text: MAPTAP('November 6', 610), playerJid: '1002@lid', pushName: 'Bob Jansen', timestamp: at('09:30:00') }),
    );
    await ctx.bot.handleGroupMessage(message({ text: '!roast bob', timestamp: at('15:00:00') }));
    expect(ctx.messenger.sent).toEqual(['🔥 Bob, zelfs Zwolle weet waar jij ligt.']);
    expect(prompt).toContain('Running joke in the group about {p1} (only use it if it makes the roast funnier):\n- denkt dat Zwolle in Friesland ligt');
    expect(prompt).not.toContain('wekker'); // one joke per roast
  });

  it('picks a random active player without a name', async () => {
    let prompt = '';
    const { bot, messenger } = await withPlayers(async (_s, p) => {
      prompt = p;
      return '{p1} is consistent: altijd net niet.';
    });
    await bot.handleGroupMessage(message({ text: '!roast', timestamp: at('15:00:00') }));
    expect(messenger.sent).toEqual(['🔥 Anna is consistent: altijd net niet.']);
    expect(prompt).toContain('Polderprikker (max 5000): {p1} played it on 1 of the 1 day anyone played it, average 4478');
  });

  it('finds a player by surname too', async () => {
    const { bot, messenger } = await withPlayers(async () => '<roast>{p1}, nee.</roast>');
    await bot.handleGroupMessage(message({ text: '!roast jansen', timestamp: at('15:00:00') }));
    expect(messenger.sent).toEqual(['🔥 Bob, nee.']);
  });

  it('roasts anyone or anything else, and knows who asked', async () => {
    let prompt = '';
    const { bot, messenger } = await withPlayers(async (_s, p) => {
      prompt = p;
      return '<roast>Wie is dat nou weer, {p1}?</roast>';
    });
    await bot.handleGroupMessage(message({ text: '!roast zorro', timestamp: at('15:00:00') }));
    expect(messenger.sent).toEqual(['🔥 Wie is dat nou weer, Anna?']);
    expect(prompt).toBe('Roast this: zorro\nRequested by {p1}.');
  });

  it('roasts the requester for !roast mij and itself for !roast jezelf', async () => {
    const prompts: string[] = [];
    const ctx = await withPlayers(async (system, p) => {
      prompts.push(system + '\n' + p);
      return '<roast>{p1}, tja.</roast>';
    });
    await ctx.bot.handleGroupMessage(message({ text: '!roast mij', playerJid: '1002@lid', pushName: 'Bob Jansen', timestamp: at('15:00:00') }));
    ctx.setNow('2026-11-06T15:00:20');
    await ctx.bot.handleGroupMessage(message({ text: '!roast jezelf', timestamp: at('15:00:20') }));
    expect(ctx.messenger.sent[0]).toBe('🔥 Bob, tja.');
    expect(prompts[0]).toContain('MapTap (max 1000): {p1} played it on 1 of the 1 day anyone played it, average 610');
    expect(prompts[1]).toContain('roast yourself');
    expect(prompts[1]).toContain('you have counted 2 results of 2 players (Polderprikker, MapTap)');
  });

  it('roasts a player about a requested topic', async () => {
    let prompt = '';
    const { bot } = await withPlayers(async (_s, p) => {
      prompt = p;
      return '<roast>{p1}, nee.</roast>';
    });
    await bot.handleGroupMessage(message({ text: "!roast Bobs geheugen", timestamp: at('15:00:00') }));
    expect(prompt).toContain('The requester wants the roast to be about: {p1}s geheugen');
    expect(prompt).not.toMatch(/Bob/);
  });

  it('remembers recent roasts so it does not repeat itself, with a short cooldown', async () => {
    const prompts: string[] = [];
    let n = 0;
    const ctx = await withPlayers(async (_s, p) => {
      prompts.push(p);
      n += 1;
      return `<roast>{p1}, grap ${n}.</roast>`;
    });
    await ctx.bot.handleGroupMessage(message({ text: '!roast bob', timestamp: at('15:00:00') }));
    ctx.setNow('2026-11-06T15:00:05');
    await ctx.bot.handleGroupMessage(message({ text: '!roast bob', timestamp: at('15:00:05') })); // cooldown
    ctx.setNow('2026-11-06T15:00:12');
    await ctx.bot.handleGroupMessage(message({ text: '!roast bob', timestamp: at('15:00:12') }));
    expect(ctx.messenger.sent).toEqual(['🔥 Bob, grap 1.', '🔥 Bob, grap 2.']);
    expect(prompts[0]).not.toContain('Recent roasts');
    expect(prompts[1]).toContain('Recent roasts of this target. Do not repeat their jokes, angles or running jokes:\n- {p1}, grap 1.');
  });

  it('stays quiet without an API key', async () => {
    const { bot, messenger } = await withPlayers(null);
    await bot.handleGroupMessage(message({ text: '!roast bob', timestamp: at('15:00:00') }));
    expect(messenger.sent).toHaveLength(0);
  });
});

describe('scheduled posts', () => {
  it('posts the daily leaderboard once', async () => {
    const { bot, messenger } = setup('2026-11-06T22:00:00');
    await bot.handleGroupMessage(message({ text: MAPTAP('November 6', 944), timestamp: at('10:00:00') }));
    await bot.postScheduled();
    await bot.postScheduled();
    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]).toContain('🏆 *Dagstand vrijdag 6 november*');
  });

  it('adds a joke when enabled', async () => {
    const { bot, messenger } = setup('2026-11-06T22:00:00', {
      cfg: { ai: { provider: 'anthropic', model: 'm', dailyJoke: true, roast: true } },
      ask: async () => '{p1} had vandaag de kaart ondersteboven.',
    });
    await bot.handleGroupMessage(message({ text: MAPTAP('November 6', 944), timestamp: at('10:00:00') }));
    await bot.postScheduled();
    expect(messenger.sent[0]).toContain('😏 Anna had vandaag de kaart ondersteboven.');
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
    const { bot, store } = setup('2026-11-06T22:00:00', { cfg: { dryRun: true } });
    await bot.handleGroupMessage(message({ text: POLDER(158, 4000), timestamp: at('10:00:00') }));
    await bot.postScheduled();
    expect(store.wasPosted('daily', '2026-11-06')).toBe(false);
  });

  it('catches up after a restart past the post time, not before', async () => {
    const { bot, messenger, setNow } = setup('2026-11-06T21:30:00');
    await bot.handleGroupMessage(message({ text: POLDER(158, 4000), timestamp: at('10:00:00') }));
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
    await bot.handleGroupMessage(message({ text: POLDER(158, 4000), timestamp: at('10:00:00') }));
    messenger.members = new Set(['1001@lid', '1002@lid']); // Carla left the group
    await bot.postScheduled();
    expect(messenger.sent[0]).toContain('😴 Nog niet gespeeld: Bob');
    expect(messenger.sent[0]).not.toContain('Carla');
  });
});
