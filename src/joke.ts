import { cleanReply, Pseudonyms, type AskFn } from './ai.js';
import type { DailyStandings } from './leaderboard.js';

const JOKE_SYSTEM = [
  'Write one short, dry joke in Dutch for a WhatsApp group of friends who play word and',
  "geography games every day, about today's results. At most 25 words. Dry and friendly.",
  'Players are pseudonyms like {p1}; use those tokens exactly as written, never invent names.',
  'No hashtags, no quotation marks. Put the joke between <joke> and </joke>, with nothing else around it.',
].join(' ');

/** Prompt with scores only; every player is a pseudonym. The first player per game won. */
export function buildJokePrompt(s: DailyStandings): { prompt: string; pseudo: Pseudonyms } | null {
  if (s.games.length === 0) return null;
  const pseudo = new Pseudonyms();
  const lines = ["Today's results (highest first):"];
  for (const g of s.games) {
    const scores = g.entries.map((e) => `${pseudo.token(e.playerJid, e.name)} ${e.value}`).join(', ');
    lines.push(`${g.game.name} (max ${g.game.maxScore}): ${scores}`);
  }
  return { prompt: lines.join('\n'), pseudo };
}

export async function generateJoke(s: DailyStandings, ask: AskFn): Promise<string | null> {
  const input = buildJokePrompt(s);
  if (!input) return null;
  const raw = await ask(JOKE_SYSTEM, input.prompt);
  return raw ? cleanReply(raw, input.pseudo, 'joke') : null;
}
