import fs from 'node:fs';
import path from 'node:path';

export interface AiConfig {
  /** Where requests go: the Anthropic API, or OpenRouter (which forwards to Claude). */
  provider: 'anthropic' | 'openrouter';
  /** API key for that provider; without it there are no jokes or roasts. */
  apiKey?: string;
  model: string;
  /** Add a joke about the day's results to the 22:00 post. */
  dailyJoke: boolean;
  /** Answer !roast. */
  roast: boolean;
}

export interface AppConfig {
  /** Bot account's phone number (digits only, with country code) used for the pairing code. */
  phoneNumber?: string;
  /** Target group JID (`...@g.us`). Without it the bot only logs the groups it is in. */
  groupJid?: string;
  timezone: string;
  /** Daily leaderboard time, `HH:MM` in `timezone`. */
  leaderboardTime: { hour: number; minute: number };
  dryRun: boolean;
  logLevel: string;
  baileysLogLevel: string;
  authDir: string;
  dbPath: string;
  configPath: string;
  /** Normalised JID / phone number -> display name. */
  aliases: Map<string, string>;
  /** Normalised JID -> running jokes for !roast (from config.json). */
  roastNotes: Map<string, string[]>;
  /** Players who posted a score within this many days are listed under "not played yet". */
  activePlayerDays: number;
  ai: AiConfig;
}

/** Load `.env` from the working directory if present. Real environment variables win. */
export function loadDotEnv(file = '.env'): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function parseTime(v: string | undefined): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v ?? '22:00').trim());
  const hour = m ? Number(m[1]) : NaN;
  const minute = m ? Number(m[2]) : NaN;
  if (!m || hour > 23 || minute > 59) {
    throw new Error(`LEADERBOARD_TIME must be HH:MM, got "${v}"`);
  }
  return { hour, minute };
}

/**
 * Normalise a JID or phone number for alias lookup:
 * "+31 6 1234 5678" / "31612345678" -> "31612345678@s.whatsapp.net",
 * "123@lid" stays, device suffixes ("31612345678:12@s.whatsapp.net") are dropped.
 */
export function normalizeIdForAlias(id: string): string {
  const trimmed = id.trim().toLowerCase();
  if (!trimmed.includes('@')) return `${trimmed.replace(/[^\d]/g, '')}@s.whatsapp.net`;
  const [user = '', server = ''] = trimmed.split('@');
  return `${user.split(':')[0]}@${server === 'c.us' ? 's.whatsapp.net' : server}`;
}

function readConfigFile(configPath: string): { aliases?: Record<string, unknown>; roastNotes?: Record<string, unknown> } {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read ${configPath}: ${(err as Error).message}`);
  }
  return JSON.parse(raw) as { aliases?: Record<string, unknown>; roastNotes?: Record<string, unknown> };
}

export function loadAliases(configPath: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const [key, value] of Object.entries(readConfigFile(configPath).aliases ?? {})) {
    if (key.startsWith('_') || typeof value !== 'string' || !value.trim()) continue;
    aliases.set(normalizeIdForAlias(key), value.trim());
  }
  return aliases;
}

/** Running jokes per player (id -> notes) that !roast may use. They are sent to the AI, so no names. */
export function loadRoastNotes(configPath: string): Map<string, string[]> {
  const notes = new Map<string, string[]>();
  for (const [key, value] of Object.entries(readConfigFile(configPath).roastNotes ?? {})) {
    if (key.startsWith('_')) continue;
    const list = (Array.isArray(value) ? value : [value])
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim());
    // "bot" holds running jokes about the bot itself (for !roast jezelf).
    if (list.length > 0) notes.set(key === 'bot' ? 'bot' : normalizeIdForAlias(key), list);
  }
  return notes;
}

function aiConfig(env: NodeJS.ProcessEnv): AiConfig {
  // An OpenRouter key ("sk-or-...") also works when it was put in ANTHROPIC_API_KEY.
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  const openRouterKey =
    env.OPENROUTER_API_KEY?.trim() || (anthropicKey?.startsWith('sk-or-') ? anthropicKey : undefined);
  const common = { dailyJoke: bool(env.ENABLE_JOKES), roast: bool(env.ENABLE_ROAST, true) };
  if (openRouterKey) {
    return { provider: 'openrouter', apiKey: openRouterKey, model: env.OPENROUTER_MODEL || 'anthropic/claude-haiku-5.5', ...common };
  }
  return { provider: 'anthropic', apiKey: anthropicKey, model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5', ...common };
}

export function loadConfig(argv: string[] = process.argv.slice(2), env = process.env): AppConfig {
  const phone = env.WA_PHONE_NUMBER?.replace(/[^\d]/g, '') || undefined;
  const groupJid = env.WA_GROUP_JID?.trim() || undefined;
  if (groupJid && !groupJid.endsWith('@g.us')) {
    throw new Error(`WA_GROUP_JID must end with @g.us, got "${groupJid}"`);
  }
  const configPath = path.resolve(env.CONFIG_PATH || './config.json');

  return {
    phoneNumber: phone,
    groupJid,
    timezone: env.TIMEZONE || 'Europe/Amsterdam',
    leaderboardTime: parseTime(env.LEADERBOARD_TIME),
    dryRun: argv.includes('--dry-run') || bool(env.DRY_RUN),
    logLevel: env.LOG_LEVEL || 'info',
    baileysLogLevel: env.BAILEYS_LOG_LEVEL || 'warn',
    authDir: path.resolve(env.AUTH_DIR || './auth'),
    dbPath: path.resolve(env.DB_PATH || './data/scores.db'),
    configPath,
    aliases: loadAliases(configPath),
    roastNotes: loadRoastNotes(configPath),
    activePlayerDays: Number(env.ACTIVE_PLAYER_DAYS || 14),
    ai: aiConfig(env),
  };
}
