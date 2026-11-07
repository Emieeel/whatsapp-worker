import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAliases, loadConfig, normalizeIdForAlias } from '../src/config.js';
import { Store } from '../src/db.js';
import { buildJokePrompt, finishJoke } from '../src/joke.js';
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

    const out = buildJokePrompt(s)!;
    expect(out.winnerName).toBe('Annabel');
    expect(out.prompt).not.toMatch(/Annabel|Bob|lid/);
    expect(out.prompt).toContain('Polderprikker (max 5000): {winner} 4478; others: 4210');
    expect(out.prompt).toContain('MapTap (max 1000): {winner} 944; nobody else played');
    expect(out.prompt).toContain('Day total (max 1000): {winner} 920');
  });

  it('fills in the winner locally', () => {
    expect(finishJoke('"{winner} kent de polder beter dan de polder zichzelf."', 'Anna')).toBe(
      'Anna kent de polder beter dan de polder zichzelf.',
    );
    expect(finishJoke('   ', 'Anna')).toBeNull();
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
  });

  it('validates the environment', () => {
    const base = { CONFIG_PATH: '/nonexistent/config.json' };
    expect(() => loadConfig([], { ...base, WA_GROUP_JID: '12345' })).toThrow(/@g\.us/);
    expect(() => loadConfig([], { ...base, LEADERBOARD_TIME: '25:00' })).toThrow(/HH:MM/);
    const cfg = loadConfig(['--dry-run'], { ...base, WA_PHONE_NUMBER: '+31 6 1234 5678' });
    expect(cfg.dryRun).toBe(true);
    expect(cfg.phoneNumber).toBe('31612345678');
    expect(cfg.leaderboardTime).toEqual({ hour: 22, minute: 0 });
    expect(cfg.jokes).toMatchObject({ enabled: false, model: 'claude-haiku-5-5' });
  });
});
