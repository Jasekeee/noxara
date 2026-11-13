// Game-rule constants for the deterministic simulation (owned by agent B / sim).
// All distances are fixed point (FP = 1000 per world unit), times are ticks (20 per second).
// Renderer/UI may import these read-only (e.g. weapon range for an aim line, magazine size for the HUD).
import type { Storm, WeaponKind } from "./types";
import { FP } from "./fixed";

export const ISLAND_R = 32 * FP;
export const SPAWN_RING = 24 * FP;
export const FIGHTER_R = 500;
export const MAX_HP = 100;
/** 5 u/s at 20 Hz */
export const SPEED = 250;
export const CHEST_R = 900;
export const HEAL_R = 900;
export const HEAL_AMOUNT = 35;
export const BULLET_R = 150;

export const N_OBSTACLES = 18;
export const N_CHESTS = 9;
export const N_HEALS = 6;

/** Bush stealth: visible anyway within this distance, or this long after shooting / being hurt. */
export const BUSH_REVEAL_DIST = 2500;
export const BUSH_REVEAL_SHOT = 20;
export const BUSH_REVEAL_HURT = 10;

/** Out-of-combat regen: after REGEN_DELAY ticks without being hurt or shooting, +REGEN_HP every REGEN_EVERY ticks. */
export const REGEN_DELAY = 60;
export const REGEN_EVERY = 10;
export const REGEN_HP = 4;

export const CRIT_PCT = 8;
/** crit multiplier ×1.5 */
export const CRIT_NUM = 3;
export const CRIT_DEN = 2;

export interface WeaponStats {
  dmg: number; // per bullet / pellet (grenade: at the centre)
  cd: number; // ticks between shots
  range: number; // FP
  speed: number; // FP per tick
  mag: number; // shots per magazine
  reload: number; // ticks
  pellets: number;
  spread: number; // angle units between outer pellets and the aim (shotgun) / random spread
  /** grenade only: explosion radius (FP) and fuse (ticks) */
  blast: number;
  fuse: number;
}

export const WEAPONS: Record<WeaponKind, WeaponStats> = {
  popper: { dmg: 12, cd: 6, range: 9 * FP, speed: 900, mag: 6, reload: 30, pellets: 1, spread: 0, blast: 0, fuse: 0 },
  blaster: { dmg: 16, cd: 4, range: 11 * FP, speed: 1000, mag: 10, reload: 36, pellets: 1, spread: 0, blast: 0, fuse: 0 },
  shotgun: { dmg: 9, cd: 16, range: 6 * FP, speed: 900, mag: 4, reload: 40, pellets: 5, spread: 150, blast: 0, fuse: 0 },
  sniper: { dmg: 55, cd: 30, range: 22 * FP, speed: 2500, mag: 3, reload: 50, pellets: 1, spread: 0, blast: 0, fuse: 0 },
  grenade: { dmg: 45, cd: 20, range: 9 * FP, speed: 563, mag: 3, reload: 50, pellets: 1, spread: 0, blast: 2500, fuse: 16 },
};

/** Stable order (used by the hash). */
export const WEAPON_ORDER: WeaponKind[] = ["popper", "blaster", "shotgun", "sniper", "grenade"];

/** Chest loot weights (sum 100). */
export const CHEST_LOOT: [WeaponKind, number][] = [
  ["blaster", 38],
  ["shotgun", 27],
  ["sniper", 15],
  ["grenade", 20],
];

/** Damage after upgrades: +10 % per weapon tier, −2 per armor level, minimum 1. */
export function scaledDamage(base: number, tier: number): number {
  return Math.trunc((base * (10 + tier)) / 10);
}
export function armored(dmg: number, armor: number): number {
  return Math.max(1, dmg - 2 * armor);
}

/**
 * Storm schedule. Each phase is announced at `announce` (event "storm"), waits, then shrinks from
 * `shrinkStart` to `shrinkEnd` to `r` (FP) around a new centre drifting inside the current circle.
 * `dps` = damage per second outside the safe circle during this phase (applied every 10 ticks, half).
 */
export interface StormPhase {
  announce: number;
  shrinkStart: number;
  shrinkEnd: number;
  r: number;
  dps: number;
}
const S = 20;
export const STORM_PHASES: StormPhase[] = [
  { announce: 1, shrinkStart: 20 * S, shrinkEnd: 35 * S, r: 22 * FP, dps: 4 },
  { announce: 35 * S, shrinkStart: 50 * S, shrinkEnd: 65 * S, r: 14 * FP, dps: 6 },
  { announce: 65 * S, shrinkStart: 80 * S, shrinkEnd: 95 * S, r: 8 * FP, dps: 9 },
  { announce: 95 * S, shrinkStart: 108 * S, shrinkEnd: 123 * S, r: 4500, dps: 12 },
  { announce: 123 * S, shrinkStart: 135 * S, shrinkEnd: 150 * S, r: 2500, dps: 16 },
  { announce: 150 * S, shrinkStart: 160 * S, shrinkEnd: 176 * S, r: 0, dps: 20 },
];
/** Storm damage is applied every STORM_EVERY ticks (= dps / 2, rounded up). */
export const STORM_EVERY = 10;

/** The sim's storm object carries the target centre too (tx, ty) so the renderer/AI can draw/plan it. */
export type StormX = Storm & { tx: number; ty: number };
