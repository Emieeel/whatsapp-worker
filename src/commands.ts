import { GAMES } from './games/index.js';

export type Command = 'stand' | 'week' | 'overview' | 'roast' | 'help';

export interface ParsedCommand {
  command: Command;
  /** Only `roast` takes an argument: who to roast. */
  arg?: string;
}

/** Chat keyword (Dutch, as typed in the group) -> internal command. */
const KEYWORDS: Record<string, Command> = {
  stand: 'stand',
  week: 'week',
  weken: 'overview',
  roast: 'roast',
  help: 'help',
};

/** A command must be the whole message. Only `!roast` may be followed by a name (max 40 chars). */
export function parseCommand(text: string): ParsedCommand | null {
  const m = /^\s*!([a-z]+)(?:\s+(\S.{0,39}?))?\s*$/is.exec(text);
  if (!m) return null;
  const command = KEYWORDS[m[1]!.toLowerCase()];
  if (!command) return null;
  const arg = m[2]?.trim();
  if (arg && command !== 'roast') return null;
  return arg ? { command, arg } : { command };
}

export function helpText(leaderboardTime: { hour: number; minute: number }, opts: { roast: boolean }): string {
  const time = `${String(leaderboardTime.hour).padStart(2, '0')}:${String(leaderboardTime.minute).padStart(2, '0')}`;
  return [
    '🤖 *Scorebot*',
    `Plak je ${GAMES.map((g) => `${g.emoji} ${g.name}`).join(' of ')}-resultaat in de groep; je eerste score per dag telt.`,
    '',
    '*!stand* – vandaag',
    '*!week* – deze week (gemiddelde per spel)',
    '*!weken* – de afgelopen weken',
    ...(opts.roast ? ['*!roast* [naam] – roast iemand (zonder naam: willekeurig)'] : []),
    '*!help* – dit bericht',
    '',
    `Elke avond om ${time} de dagstand, zondag ook de week.`,
  ].join('\n');
}
