import fs from 'node:fs';
import path from 'node:path';

export interface JokeConfig {
  enabled: boolean;
  apiKey?: string;
  model: string;
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
  /** Players who posted a score within this many days are listed under "not played yet". */
  activePlayerDays: number;
  jokes: JokeConfig;
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

export function loadAliases(configPath: string): Map<string, string> {
  const aliases = new Map<string, string>();
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return aliases;
    throw new Error(`Cannot read ${configPath}: ${(err as Error).message}`);
  }
  const parsed = JSON.parse(raw) as { aliases?: Record<string, unknown> };
  for (const [key, value] of Object.entries(parsed.aliases ?? {})) {
    if (key.startsWith('_') || typeof value !== 'string' || !value.trim()) continue;
    aliases.set(normalizeIdForAlias(key), value.trim());
  }
  return aliases;
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
    activePlayerDays: Number(env.ACTIVE_PLAYER_DAYS || 14),
    jokes: {
      enabled: bool(env.ENABLE_JOKES),
      apiKey: env.ANTHROPIC_API_KEY || undefined,
      model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
    },
  };
}
