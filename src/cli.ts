// Offline helper: inspect the database and test parsers without connecting to WhatsApp.
//   node dist/cli.js stand [YYYY-MM-DD]
//   node dist/cli.js week [YYYY-MM-DD]
//   node dist/cli.js weken [YYYY-MM-DD]
//   node dist/cli.js roast [name]
//   node dist/cli.js players
//   node dist/cli.js import <export.txt> [--apply]
//   node dist/cli.js parse < message.txt
//   node dist/cli.js backup <file>
import fs from 'node:fs';
import { ScoreBot, type Messenger } from './bot.js';
import { loadConfig, loadDotEnv, normalizeIdForAlias } from './config.js';
import { Store } from './db.js';
import { parseScores } from './games/index.js';
import { importExport } from './import.js';
import { formatDaily, formatOverview, formatWeekly } from './leaderboard.js';
import { createLogger } from './logger.js';

const USAGE = `Usage: cli <command>
  stand [YYYY-MM-DD]   standings for a day (default: today)
  week [YYYY-MM-DD]    week summary up to that day (default: today)
  weken [YYYY-MM-DD]   overview of the last weeks (the !weken command)
  roast [who] [--as name] [--times n]
                       roast someone or something (SHOW_PROMPT=1 also prints the prompt)
  players              known players and their ids (for aliases in config.json)
  import <file> [--apply]
                       import past scores from a WhatsApp chat export (.txt);
                       without --apply it only shows what would be imported
  parse                read a game result from stdin and show what would be stored
  backup <file>        consistent copy of the database (safe while the bot runs)`;

const offline: Messenger = {
  send: async (text) => console.log(text),
  memberIds: async () => null,
};

async function main(): Promise<void> {
  loadDotEnv();
  const [command, arg] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  if (command === 'parse') {
    const text = fs.readFileSync(0, 'utf8');
    const found = parseScores(text);
    if (found.length === 0) console.log('No game result recognised.');
    for (const { game, result } of found) console.log(game.name, JSON.stringify(result));
    return;
  }

  const cfg = loadConfig([]);
  const store = new Store(cfg.dbPath);
  try {
    const bot = new ScoreBot(cfg, store, offline, createLogger('warn'));
    if (command === 'import') {
      if (!arg) throw new Error('import needs the path of the exported .txt file');
      const report = importExport(store, fs.readFileSync(arg, 'utf8'), {
        timeZone: cfg.timezone,
        aliases: cfg.aliases,
        apply: process.argv.includes('--apply'),
      });
      console.log(`Score messages found: ${report.scoreMessages}\n\nPlayers:`);
      for (const [author, ref] of report.mapping) console.log(`  ${author.padEnd(20)} -> ${ref.jid.padEnd(30)} (${ref.how})`);
      if (report.unresolved.length > 0) {
        console.log(`\nCould not match: ${report.unresolved.join(', ')}`);
        console.log('Add them to "aliases" in config.json (phone number or id -> exactly this name) and run again.');
        process.exitCode = 1;
        return;
      }
      console.log('\nResult per game:');
      for (const [game, counts] of Object.entries(report.counts)) console.log(`  ${game.padEnd(15)} ${JSON.stringify(counts)}`);
      if (report.stale.length > 0) {
        console.log('\nSkipped as old results:');
        for (const s of report.stale) console.log(`  ${s.day} ${s.author}: ${s.game} ${s.score} (${s.reason})`);
      }
      console.log(report.applied ? '\nImported.' : '\nPreview only, nothing stored. Run again with --apply to import.');
      return;
    }

    const day = command !== 'roast' && arg ? arg : bot.today();
    if (command === 'stand') {
      console.log(formatDaily(await bot.daily(day), { final: false }));
    } else if (command === 'week') {
      console.log(formatWeekly(bot.weekly(day), { final: false }));
    } else if (command === 'weken') {
      console.log(formatOverview(bot.overview(day)));
    } else if (command === 'roast') {
      // roast [who or what...] [--as <name>] [--times <n>]
      const args = process.argv.slice(3);
      const option = (flag: string) => {
        const i = args.indexOf(flag);
        return i >= 0 ? args.splice(i, 2)[1] : undefined;
      };
      const asName = option('--as');
      const times = Number(option('--times') ?? 1);
      const query = args.join(' ') || undefined;
      const asPlayer = asName
        ? store.players().find((p) => p.name.toLocaleLowerCase('nl').startsWith(asName.toLocaleLowerCase('nl')))
        : undefined;
      const requester = asPlayer ? { jid: asPlayer.jid, pushName: asPlayer.name } : undefined;
      for (let i = 0; i < times; i++) {
        const result = await bot.roast(query, {
          requester,
          showPrompt: process.env.SHOW_PROMPT ? (p) => console.log(`--- prompt sent to Claude ---\n${p}\n---`) : undefined,
        });
        console.log(result ?? '(no roast: no API key, or Claude gave no answer)');
      }
    } else if (command === 'players') {
      for (const p of store.players()) {
        const alias = cfg.aliases.get(normalizeIdForAlias(p.jid)) ??
          (p.phone_jid ? cfg.aliases.get(normalizeIdForAlias(p.phone_jid)) : undefined);
        console.log(`${p.name.padEnd(20)} ${p.jid.padEnd(32)} ${(p.phone_jid ?? '').padEnd(32)} ${alias ? `alias: ${alias}` : ''}`);
      }
    } else if (command === 'backup') {
      if (!arg) throw new Error('backup needs a destination file');
      await store.backup(arg);
      console.log(`Database copied to ${arg}`);
    } else {
      console.log(USAGE);
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
