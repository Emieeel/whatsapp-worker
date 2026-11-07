import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAliases, loadConfig, loadRoastNotes, normalizeIdForAlias } from '../src/config.js';
import { Store } from '../src/db.js';
import { cleanReply, Pseudonyms } from '../src/ai.js';
import { buildJokePrompt } from '../src/joke.js';
import { buildDaily } from '../src/leaderboard.js';
import { makeNameLookup } from '../src/names.js';
import { ingestMessage } from '../src/scores.js';
import { MAPTAP, message, POLDER } from './helpers.js';

describe('joke prompt', () => {
  it('contains scores but no names', () => {
    const store = new Store(':memory:');
    ingestMessage(store, message({ text: POLDER(158, 4478), pushName: 'Annabel' }), 'Europe/Amsterdam');
    ingestMessage(store, message({ text: MAPTAP('November 6', 944), pushName: 'Annabel' }), 'Europe/Amsterdam');
    ingestMessage(store, message({ text: POLDER(158, 4210), playerJid: '1002@lid', pushName: 'Bob' }), 'Europe/Amsterdam');
    const s = buildDaily(store.scoresForDay('2026-11-06'), '2026-11-06', makeNameLookup(new Map(), store.players()));

    const { prompt, pseudo } = buildJokePrompt(s)!;
    expect(prompt).not.toMatch(/Annabel|Bob|lid/);
    expect(prompt).toContain('Polderprikker (max 5000): {p1} 4478, {p2} 4210');
    expect(prompt).toContain('MapTap (max 1000): {p1} 944');
    expect(cleanReply('"{p1} wint, { p2 } huilt, {p9} kijkt toe."', pseudo)).toBe('Annabel wint, Bob huilt, iemand kijkt toe.');
  });

  it('keeps only the tagged part of a chatty reply', () => {
    const pseudo = new Pseudonyms();
    pseudo.token('1@lid', 'Anna');
    expect(cleanReply('Leuke opdracht! Hier komt hij:\n<roast>{p1}, je mist vaker dan je raakt.</roast>\nSucces!', pseudo, 'roast')).toBe(
      'Anna, je mist vaker dan je raakt.',
    );
  });

  it('rejects empty replies', () => {
    expect(cleanReply('   ', new Pseudonyms())).toBeNull();
  });
});

describe('config', () => {
  it('normalises alias keys', () => {
    expect(normalizeIdForAlias('+31 6 1234 5678')).toBe('31612345678@s.whatsapp.net');
    expect(normalizeIdForAlias('31612345678:12@s.whatsapp.net')).toBe('31612345678@s.whatsapp.net');
    expect(normalizeIdForAlias('123456789@LID')).toBe('123456789@lid');
  });

  it('loads aliases from config.json and tolerates a missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ aliases: { _comment: 'x', '31612345678': 'Jan', '99@lid': 'Anna' } }));
    expect([...loadAliases(file)]).toEqual([
      ['31612345678@s.whatsapp.net', 'Jan'],
      ['99@lid', 'Anna'],
    ]);
    expect(loadAliases(path.join(dir, 'missing.json')).size).toBe(0);

    fs.writeFileSync(file, JSON.stringify({ roastNotes: { _comment: 'x', '99@lid': ['a', ' ', 'b'], '31612345678': 'c' } }));
    expect([...loadRoastNotes(file)]).toEqual([
      ['99@lid', ['a', 'b']],
      ['31612345678@s.whatsapp.net', ['c']],
    ]);
  });

  it('validates the environment', () => {
    const base = { CONFIG_PATH: '/nonexistent/config.json' };
    expect(() => loadConfig([], { ...base, WA_GROUP_JID: '12345' })).toThrow(/@g\.us/);
    expect(() => loadConfig([], { ...base, LEADERBOARD_TIME: '25:00' })).toThrow(/HH:MM/);
    const cfg = loadConfig(['--dry-run'], { ...base, WA_PHONE_NUMBER: '+31 6 1234 5678' });
    expect(cfg.dryRun).toBe(true);
    expect(cfg.phoneNumber).toBe('31612345678');
    expect(cfg.leaderboardTime).toEqual({ hour: 22, minute: 0 });
    expect(cfg.ai).toEqual({ provider: 'anthropic', apiKey: undefined, model: 'claude-haiku-5-5', dailyJoke: false, roast: true });
  });

  it('uses OpenRouter for an OpenRouter key, also when it sits in ANTHROPIC_API_KEY', () => {
    const base = { CONFIG_PATH: '/nonexistent/config.json' };
    expect(loadConfig([], { ...base, ANTHROPIC_API_KEY: 'sk-or-v1-abc', ANTHROPIC_MODEL: 'claude-haiku-5-5' }).ai).toMatchObject({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-abc',
      model: 'anthropic/claude-haiku-5.5',
    });
    expect(loadConfig([], { ...base, OPENROUTER_API_KEY: 'sk-or-x', OPENROUTER_MODEL: 'anthropic/other' }).ai).toMatchObject({
      provider: 'openrouter',
      model: 'anthropic/other',
    });
    expect(loadConfig([], { ...base, ANTHROPIC_API_KEY: 'sk-ant-abc' }).ai.provider).toBe('anthropic');
  });
});
