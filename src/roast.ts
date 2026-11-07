import { cleanReply, Pseudonyms, type AskFn } from './ai.js';
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

const ROAST_SYSTEM = `You roast one player for a Dutch WhatsApp group of close friends who play daily geography games and constantly tear into each other.

How this group talks: short, blunt and crude. Casual swearing (godver, kut, tering, opgefokt, verneukt) mixed with English gamer slang (noob, tryhard, whack, choke, ez, skill issue, nerd). They are merciless about each other's scores and never soften anything.

Write one roast of {p1}:
- One or two short sentences, at most 30 words, in informal spoken Dutch. Talk to {p1} directly (je/jij).
- Be mean and funny: if a running joke is given, build the roast around it (ideally tied to a stat); otherwise take the most painful stat. Exaggerate it and end on the punchline.
- Vary the insults. Do not end with "noob" by habit, and never call someone a noob when their stats are good: mock a top player for trying too hard instead.
- No politeness, no "ik zeg het gewoon", no explaining the joke, no compliments that are not sarcastic.
- Use only the given facts and check the numbers before you use them; never invent numbers, streaks or events.
- Stick to the games, the statistics and the given running jokes (those may be about anything). Beyond them, nothing about looks, ethnicity, gender, sexuality, health, family, work or real-world events.
- Write {p1} for their name; you do not know their gender. No hashtags, no quotation marks, at most one emoji.

Examples of the tone (never reuse their wording):
<roast>{p1}, elke dag MapTap en elke dag vierde. Dat is geen pech meer, dat is gewoon je niveau, noob.</roast>
<roast>Weer eerste, {p1}. Gefeliciteerd tryhard, ga eens naar buiten, de wereldkaart mist je echt niet.</roast>
<roast>9 van de 14 dagen geen Polderprikker, {p1}. Bang dat iemand ziet dat je Nederland niet kan vinden?</roast>

Put your roast between <roast> and </roast>, with nothing else around it.`;

/**
 * Players matching `query`: "@31612345678" / "@<lid>" (a WhatsApp mention), the full name,
 * the first name, or the start of a name (3+ letters). Stops at the first rule that matches.
 */
export function findPlayers(query: string, candidates: Candidate[]): Candidate[] {
  const q = query.trim().replace(/^@/, '').toLocaleLowerCase('nl');
  if (!q) return [];
  if (/^\d{5,}$/.test(q)) {
    return candidates.filter((c) => [c.jid, c.phoneJid].some((j) => j?.split('@')[0] === q));
  }
  const rules = [
    (n: string) => n === q,
    (n: string) => n.split(/\s+/)[0] === q,
    (n: string) => q.length >= 3 && n.startsWith(q),
  ];
  for (const rule of rules) {
    const matches = candidates.filter((c) =>
      [c.name, ...(c.altNames ?? [])].some((n) => rule(n.toLocaleLowerCase('nl'))),
    );
    if (matches.length > 0) return matches;
  }
  // Last resort: any word of a name, so a surname works too ("!roast jansen").
  const byWord = candidates.filter((c) =>
    [c.name, ...(c.altNames ?? [])].some((n) => n.toLocaleLowerCase('nl').split(/\s+/).includes(q)),
  );
  if (byWord.length > 0) return byWord;
  return [];
}

const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export interface RoastContext {
  today: string;
  timeZone: string;
  /** Running jokes to use for this roast (the bot picks one at random from config.json). */
  notes?: string[];
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
    lines.push(`Running joke in the group about ${t} (build the roast around it):`, ...notes.map((n) => `- ${n}`));
  }
  return lines.join('\n');
}

export async function generateRoast(
  rows: ScoreRow[],
  target: Candidate,
  ask: AskFn,
  ctx: RoastContext,
): Promise<string | null> {
  const pseudo = new Pseudonyms();
  const raw = await ask(ROAST_SYSTEM, buildRoastPrompt(rows, target, pseudo, ctx));
  return raw ? cleanReply(raw, pseudo, 'roast') : null;
}
