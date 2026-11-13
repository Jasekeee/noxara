// The on-chain match (from `start_match` / `get_match`) -> the simulation's MatchConfig.
// The client and the match server MUST both build the config with this function, otherwise the
// replay hash differs and the server refuses to settle.
import type { FighterSpec, MatchConfig, Personality } from "../sim/types";

export type ChainUpgrades = { weaponTier: number; armor: number; skin: number };
export type ChainRosterEntry = {
  idx: number; // 1..9
  account: string;
  name: string;
  personality: string;
  upgrades: ChainUpgrades;
  bounty: boolean;
  paid: string;
};
/** `start_match`'s final value (MatchStart) and `get_match` (MatchV1) share these fields. */
export type ChainMatch = {
  match_id?: string;
  id?: string;
  seed: number;
  player: string;
  guest: boolean;
  bounty_idx: number | null;
  roster: ChainRosterEntry[];
  status?: "Pending" | "Settled";
  start_block?: string;
  pot?: string;
  player_paid?: string;
  /** fighter idx 0's upgrades from the player's level (contract state V2); absent on old matches */
  player_upgrades?: ChainUpgrades;
  player_level?: number;
};

const PERSONALITIES: readonly Personality[] = ["aggressive", "camper", "sniper", "looter", "coward", "balanced"];

/** Cosmetic choices of the human fighter (they don't change gameplay). */
export type YouOptions = { name?: string; skin?: number };

export function matchConfigFromChain(m: ChainMatch, you: YouOptions = {}): MatchConfig {
  if (!m.seed) throw new Error("match seed not fixed yet");
  if (m.roster.length !== 9) throw new Error("roster must have 9 bots");
  const human: FighterSpec = {
    id: m.player,
    name: you.name ?? "You",
    personality: "balanced",
    human: true,
    // the level's upgrades come from the chain (progression); old matches: base stats + chosen skin
    upgrades: m.player_upgrades
      ? { weaponTier: m.player_upgrades.weaponTier, armor: m.player_upgrades.armor, skin: m.player_upgrades.skin }
      : { weaponTier: 0, armor: 0, skin: you.skin ?? 0 },
    bounty: false,
  };
  const bots: FighterSpec[] = [...m.roster]
    .sort((a, b) => a.idx - b.idx)
    .map((r, i) => {
      if (r.idx !== i + 1) throw new Error("roster idx out of order");
      const personality = PERSONALITIES.includes(r.personality as Personality) ? (r.personality as Personality) : "balanced";
      return {
        id: r.account,
        name: r.name,
        personality,
        human: false,
        upgrades: { weaponTier: r.upgrades.weaponTier, armor: r.upgrades.armor, skin: r.upgrades.skin },
        bounty: r.bounty,
      };
    });
  return { seed: m.seed >>> 0, fighters: [human, ...bots] };
}

/** First difference between two configs (for a readable rejection), or null if equal. */
export function configDiff(a: MatchConfig, b: MatchConfig): string | null {
  if (a.seed !== b.seed) return "seed";
  if (a.fighters.length !== b.fighters.length) return "fighters.length";
  const keys: (keyof FighterSpec)[] = ["id", "name", "personality", "human", "bounty"];
  for (let i = 0; i < a.fighters.length; i++) {
    const x = a.fighters[i];
    const y = b.fighters[i];
    for (const k of keys) if (x[k] !== y[k]) return `fighters[${i}].${k}`;
    for (const k of ["weaponTier", "armor", "skin"] as const) if (x.upgrades[k] !== y.upgrades[k]) return `fighters[${i}].upgrades.${k}`;
  }
  return null;
}

/** Minimal lobby card fields needed to rebuild a roster (FighterInfo is a superset). */
export type RosterCard = { slot: number; account: string; name: string; personality: string; upgrades: ChainUpgrades; bounty: boolean; status: string };

/** The 9 active bots of the last chain lobby as sim specs (offline practice reuses tonight's real names), or null. */
export function specsFromFighters(list: readonly RosterCard[] | null | undefined): FighterSpec[] | null {
  if (!list) return null;
  const active = list.filter((f) => f.status === "active").sort((a, b) => a.slot - b.slot);
  if (active.length !== 9) return null;
  return active.map((f) => ({
    id: f.account,
    name: f.name,
    personality: PERSONALITIES.includes(f.personality as Personality) ? (f.personality as Personality) : "balanced",
    human: false,
    upgrades: { weaponTier: f.upgrades.weaponTier, armor: f.upgrades.armor, skin: f.upgrades.skin },
    bounty: f.bounty,
  }));
}
