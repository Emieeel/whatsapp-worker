import { normalizeIdForAlias } from './config.js';
import type { PlayerRow } from './db.js';

export type NameLookup = (jid: string, fallback?: string) => string;

/** Last resort when we know nothing about a player: "~5678". */
export function shortId(jid: string): string {
  const user = jid.split('@')[0]?.split(':')[0] ?? jid;
  return `~${user.slice(-4)}`;
}

/** First word of a name that contains a letter ("~ Jan de Vries" -> "Jan"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/).find((w) => /\p{L}/u.test(w)) ?? name.trim();
}

/**
 * Name priority: alias (by LID or phone JID) > latest WhatsApp name from a score message >
 * fallback. WhatsApp names are shortened to the first name, unless two players share it.
 */
export function makeNameLookup(aliases: Map<string, string>, players: PlayerRow[]): NameLookup {
  const byJid = new Map(players.map((p) => [p.jid, p]));
  const firstNameCount = new Map<string, number>();
  for (const p of players) {
    const key = firstName(p.name).toLocaleLowerCase('nl');
    firstNameCount.set(key, (firstNameCount.get(key) ?? 0) + 1);
  }
  const display = (full: string) => {
    const first = firstName(full);
    return (firstNameCount.get(first.toLocaleLowerCase('nl')) ?? 0) > 1 ? full.trim() : first;
  };

  return (jid, fallback) => {
    const player = byJid.get(jid);
    const alias =
      aliases.get(normalizeIdForAlias(jid)) ??
      (player?.phone_jid ? aliases.get(normalizeIdForAlias(player.phone_jid)) : undefined);
    if (alias) return alias;
    const full = player?.name ?? fallback;
    return full ? display(full) : shortId(jid);
  };
}
