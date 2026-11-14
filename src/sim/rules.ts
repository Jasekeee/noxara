// Game-rule constants for the deterministic simulation (owned by agent B / sim).
// All distances are fixed point (FP = 1000 per world unit), times are ticks (20 per second).
// Renderer/UI may import these read-only (e.g. weapon range for an aim line, magazine size for the HUD).
import { BIG_MATCH_TICKS, MATCH_TICKS, type MatchConfig, type Storm, type WeaponKind } from "./types";
import { FP } from "./fixed";

export const ISLAND_R = 32 * FP;
/** spawns on a 26 u ring (±1 u, ±30 angle units): neighbours start >= 13 u apart, beyond every bot's
 *  tick-0 vision (<= 13 u), so nobody sees anybody at spawn */
export const SPAWN_RING = 26 * FP;
/** spawn protection: no damage is dealt or received while state.tick <= SPAWN_PROTECT (3 s).
 *  Everyone spawns at tick 0, so the renderer can show a shield while state.tick <= SPAWN_PROTECT. */
export const SPAWN_PROTECT = 60;
export const FIGHTER_R = 500;
export const MAX_HP = 100;
/** 5 u/s at 20 Hz */
export const SPEED = 250;
export const CHEST_R = 900;
export const HEAL_R = 900;
export const HEAL_AMOUNT = 35;
export const BULLET_R = 150;

export const N_OBSTACLES = 18;
/** 1 central chest + 1 near each spawn */
export const N_CHESTS = 11;
/** every spawn has a chest within this distance (FP) */
export const CHEST_NEAR_SPAWN = 6 * FP;
export const N_HEALS = 6;

/** Bush stealth: visible anyway within this distance, or this long after shooting / being hurt. */
export const BUSH_REVEAL_DIST = 2500;
export const BUSH_REVEAL_SHOT = 20;
export const BUSH_REVEAL_HURT = 10;

/** Out-of-combat regen: after REGEN_DELAY ticks without being hurt or shooting, +REGEN_HP every REGEN_EVERY ticks. */
export const REGEN_DELAY = 50;
export const REGEN_EVERY = 10;
export const REGEN_HP = 5;

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
  popper: { dmg: 12, cd: 6, range: 9 * FP, speed: 1000, mag: 6, reload: 30, pellets: 1, spread: 0, blast: 0, fuse: 0 },
  blaster: { dmg: 14, cd: 4, range: 11 * FP, speed: 1000, mag: 10, reload: 36, pellets: 1, spread: 0, blast: 0, fuse: 0 },
  shotgun: { dmg: 8, cd: 16, range: 6 * FP, speed: 900, mag: 4, reload: 40, pellets: 5, spread: 150, blast: 0, fuse: 0 },
  sniper: { dmg: 48, cd: 30, range: 22 * FP, speed: 2500, mag: 3, reload: 50, pellets: 1, spread: 0, blast: 0, fuse: 0 },
  grenade: { dmg: 40, cd: 20, range: 9 * FP, speed: 563, mag: 3, reload: 50, pellets: 1, spread: 0, blast: 2500, fuse: 16 },
};

/**
 * Input.aimDist (FP) is quantised to 0.1 u so it fits in a MatchRecord: q = 0 means "absent"
 * (max range), otherwise q - 1 = tenths of a unit. Used identically by the sim and the recorder.
 */
export function aimDistQ(aimDist: number | undefined): number {
  if (aimDist === undefined || !Number.isFinite(aimDist)) return 0;
  return Math.max(0, Math.min(400, Math.trunc(aimDist / 100))) + 1;
}
/** Lob distance (FP) for a quantised aimDist, clamped to [1 u, range]. */
export function lobDist(q: number, range: number): number {
  return q === 0 ? range : Math.max(1000, Math.min(range, (q - 1) * 100));
}

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
  { announce: 1, shrinkStart: 30 * S, shrinkEnd: 50 * S, r: 22 * FP, dps: 3 },
  { announce: 50 * S, shrinkStart: 75 * S, shrinkEnd: 95 * S, r: 15 * FP, dps: 5 },
  { announce: 95 * S, shrinkStart: 112 * S, shrinkEnd: 127 * S, r: 9500, dps: 8 },
  { announce: 127 * S, shrinkStart: 137 * S, shrinkEnd: 150 * S, r: 5500, dps: 11 },
  { announce: 150 * S, shrinkStart: 155 * S, shrinkEnd: 166 * S, r: 2500, dps: 15 },
  { announce: 166 * S, shrinkStart: 169 * S, shrinkEnd: 177 * S, r: 0, dps: 22 },
];
/** Storm damage is applied every STORM_EVERY ticks (= dps / 2, rounded up). */
export const STORM_EVERY = 10;
/** stepping out of the safe zone: no storm damage for the first STORM_GRACE ticks (1 s) */
export const STORM_GRACE = 20;

/**
 * Idle reload (Brawl-Stars-like): a partly used magazine refills completely once the fighter has not
 * fired for IDLE_RELOAD ticks (1.2 s). Progress for the HUD = (tick - lastShotTick) / IDLE_RELOAD while
 * 0 < ammo < mag. An EMPTY magazine reloads until readyTick (the weapon's reload time).
 */
export const IDLE_RELOAD = 24;

/** The sim's storm object carries the target centre too (tx, ty) so the renderer/AI can draw/plan it. */
export type StormX = Storm & { tx: number; ty: number };

// ------------------------------------------------------------------ Big Island (cfg.map === "big")
// An offline / server-replayable mode (no stakes, never on chain): a ~3.3x larger island with dense
// cover (forests, tall grass, rocks, walled ruins), more chests + heals, a slower 7-phase storm and a
// 10-minute clock. Everything below only applies when cfg.map === "big"; standard matches are untouched.

export const BIG_ISLAND_R = 58 * FP;
/** spawns on a ring at 40 u (±1.5 u): neighbours start ~25 u apart */
export const BIG_SPAWN_RING = 40 * FP;
export { BIG_MATCH_SECONDS, BIG_MATCH_TICKS } from "./types";
/** 1 central + 1 near each spawn + the rest in ruins / scattered */
export const BIG_N_CHESTS = 30;
export const BIG_N_HEALS = 18;
export const BIG_FORESTS = 7;
export const BIG_RUINS = 5;
export const BIG_ROCKS = 34;
export const BIG_CRATES = 16;
export const BIG_BUSHES = 56;

export const BIG_STORM_PHASES: StormPhase[] = [
  { announce: 1, shrinkStart: 60 * S, shrinkEnd: 115 * S, r: 42 * FP, dps: 2 },
  { announce: 115 * S, shrinkStart: 175 * S, shrinkEnd: 235 * S, r: 30 * FP, dps: 3 },
  { announce: 235 * S, shrinkStart: 290 * S, shrinkEnd: 345 * S, r: 20 * FP, dps: 5 },
  { announce: 345 * S, shrinkStart: 395 * S, shrinkEnd: 445 * S, r: 12 * FP, dps: 8 },
  { announce: 445 * S, shrinkStart: 480 * S, shrinkEnd: 515 * S, r: 6500, dps: 11 },
  { announce: 515 * S, shrinkStart: 535 * S, shrinkEnd: 560 * S, r: 2800, dps: 15 },
  { announce: 560 * S, shrinkStart: 570 * S, shrinkEnd: 588 * S, r: 0, dps: 22 },
];

export const isBig = (cfg: MatchConfig): boolean => cfg.map === "big";
/** The storm schedule of this match. */
export function stormPhasesFor(cfg: MatchConfig): StormPhase[] {
  return isBig(cfg) ? BIG_STORM_PHASES : STORM_PHASES;
}
/** The match clock (ticks) of this match: replays/verifiers must loop to this, not MATCH_TICKS. */
export function matchTicksFor(cfg: MatchConfig): number {
  return isBig(cfg) ? BIG_MATCH_TICKS : MATCH_TICKS;
}
