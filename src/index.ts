import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { ScoreBot } from './bot.js';
import { parseCommand } from './commands.js';
import { loadConfig, loadDotEnv } from './config.js';
import { Store } from './db.js';
import { parseScores } from './games/index.js';
import { createLogger } from './logger.js';
import { LOGGED_OUT_MARKER, WhatsAppClient } from './whatsapp.js';

/** Exit code for "logged out": systemd is told not to restart on it (RestartPreventExitStatus). */
const EXIT_LOGGED_OUT = 78;

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);
  const baileysLogger = log.child({ module: 'baileys' }, { level: cfg.baileysLogLevel });
  const { hour, minute } = cfg.leaderboardTime;
  const postTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  log.info(
    { group: cfg.groupJid ?? '(not set)', post: `${postTime} ${cfg.timezone}`, aliases: cfg.aliases.size },
    'Starting WhatsApp score bot',
  );
  if (cfg.dryRun) log.warn('DRY RUN: messages are printed here instead of being sent');
  if (cfg.ai.apiKey) {
    log.info({ provider: cfg.ai.provider, model: cfg.ai.model, dailyJoke: cfg.ai.dailyJoke, roast: cfg.ai.roast }, 'Claude features');
  } else if (cfg.ai.dailyJoke || cfg.ai.roast) {
    log.info('No ANTHROPIC_API_KEY or OPENROUTER_API_KEY; !roast and jokes are off');
  }

  // After a logout the stored credentials are dead. Don't reconnect in a loop; wait for a relink.
  const marker = path.join(cfg.authDir, LOGGED_OUT_MARKER);
  if (fs.existsSync(marker)) {
    const msg =
      `This device was logged out of WhatsApp (${fs.readFileSync(marker, 'utf8').trim()}). ` +
      `To link again: stop the bot, delete everything in ${cfg.authDir}, start the bot and enter the new pairing code.`;
    log.fatal(msg);
    setInterval(() => log.fatal(msg), 6 * 3600_000);
    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
    return;
  }

  const store = new Store(cfg.dbPath);
  let bot: ScoreBot | undefined;

  const client = new WhatsAppClient({
    authDir: cfg.authDir,
    phoneNumber: cfg.phoneNumber,
    groupJid: cfg.groupJid,
    dryRun: cfg.dryRun,
    logger: log,
    baileysLogger,
    isRelevant: (text) => parseCommand(text) !== null || parseScores(text).length > 0,
    onGroupMessage: (msg) => bot!.handleGroupMessage(msg),
    onGroupMembers: (members) => store.setMembers(members),
    onFirstOpen: async () => {
      if (cfg.groupJid) await bot!.catchUp();
    },
    onLoggedOut: () => void shutdown(EXIT_LOGGED_OUT),
  });
  bot = new ScoreBot(cfg, store, client, log);

  if (!cfg.phoneNumber) log.info('WA_PHONE_NUMBER is not set; linking (if needed) uses a QR code');

  if (cfg.groupJid) {
    cron.schedule(
      `${minute} ${hour} * * *`,
      async () => {
        log.info('Posting scheduled leaderboard');
        await bot!.postScheduled();
      },
      { timezone: cfg.timezone, name: 'daily-leaderboard', noOverlap: true },
    );
  }

  let shuttingDown = false;
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down');
    await cron.shutdown().catch(() => undefined);
    await client.stop();
    store.close();
    process.exit(code);
  }
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  process.on('unhandledRejection', (err) => log.error({ err }, 'Unhandled promise rejection'));

  await client.start();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
