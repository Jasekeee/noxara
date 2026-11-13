// Player progression (Clash-Royale-like): XP per match -> level -> upgrades for the HUMAN fighter.
// Pure, deterministic, integer-only, so the Rust contract can mirror it exactly
// (test vectors: src/sim/progression.vectors.json, checked by sim.test.ts).
//
// Fairness: the human's upgrades top out at weapon tier 2 + armor 1 (level 7+), i.e. never above the
// best bot (bots can buy tier 2 + armor 2). Levels 8–10 only unlock cosmetics.
// Progression does not change any match rule: it only fills FighterSpec.upgrades.
import type { Upgrades } from "./types";

/** XP for finishing 1st..10th (index = placement - 1). */
export const PLACEMENT_XP: readonly number[] = [100, 70, 55, 45, 38, 32, 26, 20, 15, 10];
export const XP_PER_KILL = 15;
/** kills above this don't add XP */
export const MAX_KILLS_XP = 9;
export const BOUNTY_XP = 50;

/** Cumulative XP needed for level i+1 (LEVELS[0] = level 1 = 0 XP). ~45 XP for an average match:
 *  level 2 after ~2 matches, level 10 after ~40. */
export const LEVELS: readonly number[] = [0, 90, 200, 340, 510, 710, 940, 1200, 1490, 1800];
export const MAX_LEVEL = LEVELS.length;

/** Human-only skins (palette ids 10..14; bots use 1..9, the default human skin is 0). */
export const SKIN_UNLOCKS: readonly [number, number][] = [
  [2, 10],
  [4, 11],
  [6, 12],
  [8, 13],
  [9, 14],
];

const int = (v: number) => (Number.isFinite(v) ? Math.trunc(v) : 0);

/**
 * XP earned in one match. placement 1..10 (anything else counts as 10th), kills >= 0 (capped at 9),
 * bountyClaimed = this player killed the bounty carrier.
 */
export function xpForMatch(placement: number, kills: number, bountyClaimed: boolean): number {
  let p = int(placement);
  if (p < 1 || p > PLACEMENT_XP.length) p = PLACEMENT_XP.length;
  const k = Math.max(0, Math.min(MAX_KILLS_XP, int(kills)));
  return PLACEMENT_XP[p - 1] + k * XP_PER_KILL + (bountyClaimed ? BOUNTY_XP : 0);
}

/** Level (1..MAX_LEVEL) for a total XP. */
export function levelForXp(totalXp: number): number {
  const xp = Math.max(0, int(totalXp));
  let lvl = 1;
  for (let i = 1; i < LEVELS.length; i++) if (xp >= LEVELS[i]) lvl = i + 1;
  return lvl;
}

/** Progress toward the next level (nextAt = null at max level). */
export function levelProgress(totalXp: number): { level: number; xp: number; levelAt: number; nextAt: number | null } {
  const xp = Math.max(0, int(totalXp));
  const level = levelForXp(xp);
  return { level, xp, levelAt: LEVELS[level - 1], nextAt: level < MAX_LEVEL ? LEVELS[level] : null };
}

const clampLevel = (level: number) => Math.max(1, Math.min(MAX_LEVEL, int(level)));

/** The human fighter's upgrades at a level. */
export function upgradesForLevel(level: number): Upgrades {
  const l = clampLevel(level);
  const weaponTier = l >= 7 ? 2 : l >= 3 ? 1 : 0;
  const armor = l >= 5 ? 1 : 0;
  let skin = 0;
  for (const [at, id] of SKIN_UNLOCKS) if (l >= at) skin = id;
  return { weaponTier, armor, skin };
}

/** What reaching `level` unlocks (empty for level 1). */
export function unlocksForLevel(level: number): string[] {
  const l = clampLevel(level);
  const out: string[] = [];
  const prev = l > 1 ? upgradesForLevel(l - 1) : null;
  const cur = upgradesForLevel(l);
  if (!prev) return out;
  if (cur.weaponTier > prev.weaponTier) out.push(`Weapon tier ${cur.weaponTier}: +${cur.weaponTier * 10}% damage, ${cur.weaponTier * 10}% faster reload`);
  if (cur.armor > prev.armor) out.push(`Armor ${cur.armor}: -${cur.armor * 2} damage from every hit`);
  if (cur.skin !== prev.skin) out.push(`New skin #${cur.skin}`);
  if (l === MAX_LEVEL) out.push("Max level: champion badge");
  return out;
}
