import { GAMES } from './games/index.js';
import { DAY_MAX, pointsPerGame } from './leaderboard.js';

export type Command = 'stand' | 'week' | 'overview' | 'help';

/** Chat keyword (Dutch, as typed in the group) -> internal command. */
const KEYWORDS: Record<string, Command> = {
  stand: 'stand',
  week: 'week',
  weken: 'overview',
  help: 'help',
};

/** Only an exact command (case-insensitive, surrounding whitespace allowed) counts. */
export function parseCommand(text: string): Command | null {
  const m = /^\s*!([a-z]+)\s*$/i.exec(text);
  return m ? (KEYWORDS[m[1]!.toLowerCase()] ?? null) : null;
}

/** Example results used in the help text (fraction of each game's max score). */
const EXAMPLE_SHARES = [0.9, 0.95, 0.85, 0.8];

function pointsRule(maxScore: number, perGame: number): string {
  const factor = maxScore / perGame;
  return Number.isInteger(factor) ? `score ÷ ${factor}` : `score × ${perGame} ÷ ${maxScore}`;
}

export function helpText(leaderboardTime: { hour: number; minute: number }): string {
  const time = `${String(leaderboardTime.hour).padStart(2, '0')}:${String(leaderboardTime.minute).padStart(2, '0')}`;
  const perGame = Math.round(pointsPerGame() * 10) / 10;

  const examples = GAMES.map((g, i) => {
    const score = Math.round(g.maxScore * (EXAMPLE_SHARES[i % EXAMPLE_SHARES.length] ?? 0.9));
    return { game: g, score, points: Math.round((score / g.maxScore) * pointsPerGame()) };
  });
  const exampleTotal = examples.reduce((sum, e) => sum + e.points, 0);

  return [
    '🤖 *Scorebot*',
    `Ik houd de scores bij van ${GAMES.map((g) => `${g.emoji} ${g.name}`).join(' en ')}.`,
    'Plak je resultaat gewoon in de groep; je eerste score per spel per dag telt.',
    '',
    '*!stand* – stand van vandaag',
    '*!week* – deze week tot nu toe',
    '*!weken* – overzicht van de afgelopen weken',
    '*!help* – dit bericht',
    '',
    '*Hoe werkt het totaal?*',
    `Elk spel telt even zwaar: max ${perGame} punten.`,
    ...GAMES.map((g) => `${g.emoji} ${g.name}: ${pointsRule(g.maxScore, perGame)} (${g.maxScore} → ${perGame})`),
    `Dagtotaal = die punten opgeteld, max ${DAY_MAX}. Spel niet gespeeld = 0.`,
    `Voorbeeld: ${examples.map((e) => `${e.game.name} ${e.score}`).join(' + ')} → ${examples
      .map((e) => e.points)
      .join(' + ')} = ${exampleTotal}`,
    'Weektotaal = je dagtotalen opgeteld (elke dag spelen loont dus).',
    '',
    `Elke avond om ${time} de dagstand, op zondag ook het weekoverzicht.`,
  ].join('\n');
}
