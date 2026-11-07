import { extractReply, Pseudonyms, type AskFn } from './ai.js';
import type { ScoreRow } from './db.js';
import { GAMES } from './games/index.js';
import { addDays, minutesOfDay } from './time.js';

/** A roast looks at this many days of results. */
export const ROAST_DAYS = 14;

export interface Candidate {
  jid: string;
  name: string;
  phoneJid?: string;
  /** Other names that should also match, e.g. the full WhatsApp name. */
  altNames?: string[];
}

/** Who or what `!roast <query>` is about. */
export type RoastTarget =
  | { kind: 'player'; player: Candidate; topic?: string }
  | { kind: 'bot' }
  | { kind: 'other'; text: string; mentioned: Candidate[] };

// ---------------------------------------------------------------------------
// Prompts (English instructions, Dutch output)

const STYLE = `You write roasts for a Dutch WhatsApp group of close friends who play daily geography games and constantly tear into each other.

How this group talks: short, blunt and crude, with some swearing (godver, kut, tering, opgefokt, verneukt) and English gamer slang. They are merciless and never soften anything.

Rules for every roast:
- One or two short sentences, at most 30 words, in informal spoken Dutch.
- Mean and funny: pick one angle, exaggerate it and end on the punchline. One angle is enough; never force two facts together.
- Avoid stock phrases like "skill issue", "noob" and "tryhard" unless they really fit, and never end on them by habit.
- Swearing is optional: at most one swear word, only where it adds punch, never as filler at the start of a sentence.
- No politeness, no "ik zeg het gewoon", no explaining the joke, no compliments that are not sarcastic.
- Use only the given facts and check the numbers before you use them; never invent numbers, streaks or events about the players.
- Never about ethnicity, religion, gender, sexuality, health or family, and no slurs.
- Players appear as tokens like {p1}; write those tokens exactly as given and never invent names. You do not know anyone's gender.
- No hashtags, no quotation marks, at most one emoji.

Examples of the tone (never reuse their wording):
<roast>{p1}, elke ochtend om 9 uur stipt je score posten. Dit is geen hobby meer, dit is je hele persoonlijkheid.</roast>
<roast>Elke dag als eerste wakker en toch laatste, {p1}. Zelfs je wekker heeft meer talent.</roast>
<roast>9 van de 14 dagen geen Polderprikker, {p1}. Bang dat iemand ziet dat je Nederland niet kan vinden?</roast>

Put your roast between <roast> and </roast>, with nothing else around it.`;

const PLAYER_TASK = `Roast the player {p1}. Talk to {p1} directly (je/jij).
Use the statistics, or the running joke if one is given and it makes the roast funnier. A roast about only the running joke or only one stat is fine; never invent a link between them.
If the requester asked for a specific topic, make that topic the core of the roast; it may go beyond the games.
Never call someone bad at something their statistics show they are good at: mock a top player for trying too hard instead.`;

const BOT_TASK = `Someone asked you, the group's scorebot, to roast yourself. Talk about yourself (ik). Be self-deprecating and savage about being a cheap bot.`;

const OTHER_TASK = `The group asks you to roast someone or something that is not a player with statistics.
- A well-known public figure, company, place or thing: roast its public image using only well-known public facts.
- Players mentioned as tokens ({p2}, ...): you may roast them, but you know nothing about them beyond the request.
- If you do not know who or what is meant, invent nothing about them: roast the requester {p1} for asking about someone nobody knows instead.`;

// ---------------------------------------------------------------------------
// Target resolution

const SELF_WORDS = new Set(['mij', 'me', 'ik', 'mezelf', 'mijzelf', 'myself']);
const BOT_WORDS = new Set([
  'jezelf', 'jij', 'jou', 'yourself', 'bot', 'de bot', 'deze bot', 'scorebot', 'botje',
  'ai', 'de ai', 'deze ai', 'api', 'de api', 'this api', 'deze api', 'this bot',
]);

const lower = (s: string) => s.trim().toLocaleLowerCase('nl');
const namesOf = (c: Candidate) => [c.name, ...(c.altNames ?? [])];

/**
 * Players matching `query`: "@31612345678" / "@<lid>" (a WhatsApp mention), the full name,
 * the first name, the start of a name (3+ letters), or any word of a name (a surname).
 */
export function findPlayers(query: string, candidates: Candidate[]): Candidate[] {
  const q = lower(query).replace(/^@/, '');
  if (!q) return [];
  if (/^\d{5,}$/.test(q)) {
    return candidates.filter((c) => [c.jid, c.phoneJid].some((j) => j?.split('@')[0] === q));
  }
  const rules = [
    (n: string) => n === q,
    (n: string) => n.split(/\s+/)[0] === q,
    (n: string) => q.length >= 3 && n.startsWith(q),
    (n: string) => n.split(/\s+/).includes(q),
  ];
  for (const rule of rules) {
    const matches = candidates.filter((c) => namesOf(c).some((n) => rule(lower(n))));
    if (matches.length > 0) return matches;
  }
  return [];
}

/** "Jans" / "Jan's" / "Klaas'" -> the bare word. */
const stripPossessive = (word: string) => word.replace(/['’]s$|['’]$|s$/i, '');

/** Players whose first name (or alias) appears as a word in `text`, also with a possessive. */
export function playersMentioned(text: string, candidates: Candidate[]): Candidate[] {
  const words = lower(text)
    .split(/[^\p{L}\p{N}'’]+/u)
    .filter(Boolean);
  return candidates.filter((c) =>
    namesOf(c).some((n) => {
      const first = lower(n).split(/\s+/)[0] ?? '';
      return first.length >= 3 && words.some((w) => w === first || stripPossessive(w) === first);
    }),
  );
}

export function resolveRoastTarget(
  query: string,
  candidates: Candidate[],
  requester?: Candidate,
): RoastTarget | { ambiguous: Candidate[] } {
  const q = lower(query).replace(/[!?.]+$/, '');
  if (SELF_WORDS.has(q) && requester) return { kind: 'player', player: requester };
  if (BOT_WORDS.has(q)) return { kind: 'bot' };

  const direct = findPlayers(query, candidates);
  if (direct.length === 1) return { kind: 'player', player: direct[0]! };
  if (direct.length > 1) return { ambiguous: direct };

  const mentioned = playersMentioned(query, candidates);
  if (mentioned.length === 1) return { kind: 'player', player: mentioned[0]!, topic: query.trim() };
  return { kind: 'other', text: query.trim(), mentioned };
}

/** Replace mentions of players in free text by their tokens, keeping a possessive "s". */
export function pseudonymizeText(text: string, players: Candidate[], pseudo: Pseudonyms): string {
  let out = text;
  for (const p of players) {
    const token = pseudo.token(p.jid, p.name);
    for (const n of namesOf(p)) {
      const first = n.trim().split(/\s+/)[0];
      if (!first || first.length < 3) continue;
      const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![\\p{L}])${escaped}(['’]?s)?(?![\\p{L}])`, 'giu'), (_m, s?: string) => `${token}${s ?? ''}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt building

const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export interface RoastContext {
  today: string;
  timeZone: string;
  /** Running jokes to offer for this roast (the bot picks at most one from config.json). */
  notes?: string[];
  /** What the requester wants the roast to be about, if anything. */
  topic?: string;
  /** Earlier roasts of the same target, as sent back by the model (with tokens). */
  recent?: string[];
}

function recentLines(recent: string[] | undefined): string[] {
  return recent && recent.length > 0
    ? ['Recent roasts of this target. Do not repeat their jokes, angles or running jokes:', ...recent.map((r) => `- ${r}`)]
    : [];
}

/** Statistics about one player (as {p1}); the rest of the group only appears as numbers. */
export function buildRoastPrompt(rows: ScoreRow[], target: Candidate, pseudo: Pseudonyms, ctx: RoastContext): string {
  const t = pseudo.token(target.jid, target.name);
  const players = new Set([...rows.map((r) => r.player_jid), target.jid]);
  const lines = [`Game results of the last ${ROAST_DAYS} days in a group of ${players.size} players. Player: ${t}.`];

  for (const game of GAMES) {
    const gameRows = rows.filter((r) => r.game === game.id);
    if (gameRows.length === 0) continue; // nobody played it: nothing to roast about
    const own = gameRows.filter((r) => r.player_jid === target.jid).map((r) => r.score);
    const others = gameRows.filter((r) => r.player_jid !== target.jid).map((r) => r.score);
    let line = `- ${game.name} (max ${game.maxScore}): `;
    if (own.length === 0) {
      line += `${t} did not play it once`;
    } else {
      const byPlayer = new Map<string, number[]>();
      for (const r of gameRows) byPlayer.set(r.player_jid, [...(byPlayer.get(r.player_jid) ?? []), r.score]);
      const averages = [...byPlayer.values()].map(avg);
      const ownAvg = avg(own);
      const rank = 1 + averages.filter((a) => a > ownAvg).length;

      // Daily wins and last places, only on days with at least two players.
      let wins = 0;
      let lasts = 0;
      const byDay = new Map<string, ScoreRow[]>();
      for (const r of gameRows) byDay.set(r.game_day, [...(byDay.get(r.game_day) ?? []), r]);
      for (const dayRows of byDay.values()) {
        const mine = dayRows.find((r) => r.player_jid === target.jid);
        if (!mine || dayRows.length < 2) continue;
        const scores = dayRows.map((r) => r.score);
        if (mine.score === Math.max(...scores)) wins += 1;
        if (mine.score === Math.min(...scores)) lasts += 1;
      }

      line +=
        `${t} played it on ${own.length} of the ${plural(byDay.size, 'day', 'days')} anyone played it, average ${ownAvg}, best ${Math.max(...own)}, ` +
        `worst ${Math.min(...own)}, rank ${rank} of ${byPlayer.size} by average (group's best average ${Math.max(...averages)}), ` +
        `${plural(wins, 'daily win', 'daily wins')}, ${plural(lasts, 'time', 'times')} last of the day`;
    }
    if (others.length > 0) line += `; the others average ${avg(others)}`;
    lines.push(line);
  }

  const ownRows = rows.filter((r) => r.player_jid === target.jid);
  if (ownRows.length === 0) {
    lines.push(`${t} posted no results at all in the last ${ROAST_DAYS} days.`);
  } else {
    const days = new Set(ownRows.map((r) => r.game_day));
    const minutes = median(ownRows.map((r) => minutesOfDay(new Date(r.ts * 1000), ctx.timeZone)));
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const lastDay = [...days].sort().at(-1)!;
    let ago = 0;
    while (addDays(lastDay, ago) < ctx.today) ago += 1;
    const last = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days ago`;
    lines.push(
      `${t} posted a result on ${days.size} of the last ${ROAST_DAYS} days, usually around ${time}; last result ${last}.`,
    );
  }

  const notes = ctx.notes ?? [];
  if (notes.length > 0) {
    lines.push(`Running joke in the group about ${t} (only use it if it makes the roast funnier):`, ...notes.map((n) => `- ${n}`));
  }
  if (ctx.topic) lines.push(`The requester wants the roast to be about: ${pseudonymizeText(ctx.topic, [target], pseudo)}`);
  lines.push(...recentLines(ctx.recent));
  return lines.join('\n');
}

export interface BotFacts {
  scores: number;
  players: number;
  since: string;
  games: string[];
}

export function buildBotPrompt(facts: BotFacts, notes: string[], recent?: string[]): string {
  const lines = [
    'Facts about you:',
    '- You only count game scores and roast people; you cannot do anything else.',
    '- You run on a free cloud server and use the cheapest AI model there is.',
    `- Since ${facts.since} you have counted ${facts.scores} results of ${facts.players} players (${facts.games.join(', ')}).`,
    ...notes.map((n) => `- ${n}`),
  ];
  lines.push(...recentLines(recent));
  return lines.join('\n');
}

export function buildOtherPrompt(text: string, requester: Candidate | undefined, mentioned: Candidate[], pseudo: Pseudonyms, recent?: string[]): string {
  const req = requester ? pseudo.token(requester.jid, requester.name) : 'the requester';
  const subject = pseudonymizeText(text, mentioned, pseudo);
  return [`Roast this: ${subject}`, `Requested by ${req}.`, ...recentLines(recent)].join('\n');
}

// ---------------------------------------------------------------------------
// Generation

export interface RoastResult {
  /** Ready to post: names restored. */
  text: string;
  /** As the model wrote it, with tokens: remembered to avoid repeats. */
  tokens: string;
}

async function run(ask: AskFn, task: string, prompt: string, pseudo: Pseudonyms): Promise<RoastResult | null> {
  const raw = await ask(`${STYLE}\n\n${task}`, prompt);
  const tokens = raw ? extractReply(raw, 'roast') : null;
  return tokens ? { text: pseudo.restore(tokens), tokens } : null;
}

export function generateRoast(rows: ScoreRow[], target: Candidate, ask: AskFn, ctx: RoastContext): Promise<RoastResult | null> {
  const pseudo = new Pseudonyms();
  return run(ask, PLAYER_TASK, buildRoastPrompt(rows, target, pseudo, ctx), pseudo);
}

export function generateBotRoast(facts: BotFacts, ask: AskFn, notes: string[], recent?: string[]): Promise<RoastResult | null> {
  return run(ask, BOT_TASK, buildBotPrompt(facts, notes, recent), new Pseudonyms());
}

export function generateOtherRoast(
  text: string,
  requester: Candidate | undefined,
  mentioned: Candidate[],
  ask: AskFn,
  recent?: string[],
): Promise<RoastResult | null> {
  const pseudo = new Pseudonyms();
  return run(ask, OTHER_TASK, buildOtherPrompt(text, requester, mentioned, pseudo, recent), pseudo);
}
