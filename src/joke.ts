import type { Logger } from 'pino';
import type { JokeConfig } from './config.js';
import { DAY_MAX, type DailyStandings } from './leaderboard.js';

const PLACEHOLDER = '{winner}';

const SYSTEM_PROMPT = [
  'Write one short, dry joke in Dutch for a WhatsApp group of friends who play word and',
  'geography games every day. At most 25 words. Dry and friendly, never mean.',
  'Refer to the daily winner only as {winner}.',
  'No emoji, no hashtags, no quotation marks. Reply with the joke only.',
].join(' ');

/**
 * Builds the prompt from scores only. Player names never leave the machine: the winner is
 * the placeholder {winner}, everybody else is just a number.
 */
export function buildJokePrompt(s: DailyStandings): { prompt: string; winnerName: string } | null {
  const ranking = s.combined ?? s.games[0]?.entries;
  const winner = ranking?.[0];
  if (!winner) return null;

  const lines = ["Today's results:"];
  for (const g of s.games) {
    const own = g.entries.find((e) => e.playerJid === winner.playerJid);
    const others = g.entries.filter((e) => e.playerJid !== winner.playerJid).map((e) => e.value);
    const ownPart = own ? `${PLACEHOLDER} ${own.value}` : `${PLACEHOLDER} did not play`;
    const otherPart = others.length ? `; others: ${others.join(', ')}` : '; nobody else played';
    lines.push(`${g.game.name} (max ${g.game.maxScore}): ${ownPart}${otherPart}`);
  }
  if (s.combined) {
    lines.push(`Day total (max ${DAY_MAX}): ${PLACEHOLDER} ${winner.value}`);
  }
  return { prompt: lines.join('\n'), winnerName: winner.name };
}

export function finishJoke(raw: string, winnerName: string): string | null {
  const text = raw
    .replace(/\s+/g, ' ')
    .replace(/^["'“”„]+|["'“”„]+$/g, '')
    .trim();
  if (!text || text.length > 300) return null;
  return text.replace(/\{\s*winner\s*\}/gi, winnerName);
}

/** One dry joke about today's winner, or null when disabled or anything goes wrong. */
export async function generateJoke(cfg: JokeConfig, s: DailyStandings, log: Logger): Promise<string | null> {
  if (!cfg.enabled) return null;
  if (!cfg.apiKey) {
    log.warn('ENABLE_JOKES is on but ANTHROPIC_API_KEY is empty; skipping joke');
    return null;
  }
  const input = buildJokePrompt(s);
  if (!input) return null;

  try {
    // Loaded lazily so the SDK costs no memory when jokes are off.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: cfg.apiKey, timeout: 30_000, maxRetries: 1 });
    const response = await client.messages.create({
      model: cfg.model,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input.prompt }],
    });
    if (response.stop_reason !== 'end_turn') {
      log.warn({ stopReason: response.stop_reason }, 'Joke generation did not finish; skipping');
      return null;
    }
    const raw = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
    return finishJoke(raw, input.winnerName);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Joke generation failed; posting without joke');
    return null;
  }
}
