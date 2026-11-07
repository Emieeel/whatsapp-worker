import { normalizeIdForAlias } from './config.js';
import type { PlayerRow } from './db.js';

export type NameLookup = (jid: string, fallback?: string) => string;

/** Last resort when we know nothing about a player: "~5678". */
export function shortId(jid: string): string {
  const user = jid.split('@')[0]?.split(':')[0] ?? jid;
  return `~${user.slice(-4)}`;
}

/** Name priority: alias (by LID or phone JID) > latest pushName from a score message > fallback. */
export function makeNameLookup(aliases: Map<string, string>, players: PlayerRow[]): NameLookup {
  const byJid = new Map(players.map((p) => [p.jid, p]));
  return (jid, fallback) => {
    const player = byJid.get(jid);
    return (
      aliases.get(normalizeIdForAlias(jid)) ??
      (player?.phone_jid ? aliases.get(normalizeIdForAlias(player.phone_jid)) : undefined) ??
      player?.name ??
      fallback ??
      shortId(jid)
    );
  };
}
