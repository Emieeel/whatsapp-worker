import pino from 'pino';
import type { AppConfig } from '../src/config.js';
import type { IncomingMessage } from '../src/scores.js';

export const silentLogger = pino({ level: 'silent' });

export const POLDER = (n: number, score: number) => `#Polderprikker nummer ${n} • ${score}/5000\n🟦1000\nhttps://polderprikker.nl/`;
export const MAPTAP = (date: string, score: number) => `www.maptap.gg ${date}\n100🎯 100🎯\nFinal score: ${score}`;

/** Unix seconds for a wall-clock time in Amsterdam (CET, UTC+1, valid for November). */
export function cet(isoLocal: string): number {
  return Math.floor(new Date(`${isoLocal}+01:00`).getTime() / 1000);
}

let counter = 0;
export function message(over: Partial<IncomingMessage> & { text: string }): IncomingMessage {
  counter += 1;
  return {
    id: `MSG${counter}`,
    playerJid: '1001@lid',
    pushName: 'Anna',
    timestamp: cet('2026-11-06T12:00:00'),
    ...over,
  };
}

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    groupJid: '120363000000000000@g.us',
    timezone: 'Europe/Amsterdam',
    leaderboardTime: { hour: 22, minute: 0 },
    dryRun: false,
    logLevel: 'silent',
    baileysLogLevel: 'silent',
    authDir: '/tmp/unused-auth',
    dbPath: ':memory:',
    configPath: '/tmp/unused-config.json',
    aliases: new Map(),
    activePlayerDays: 14,
    jokes: { enabled: false, model: 'claude-haiku-5-5' },
    ...over,
  };
}
