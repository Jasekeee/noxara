// SHARED CONTRACT between the simulation (src/sim), the renderer (src/render, src/ui, src/input),
// the tools/tests and (later) the chain. Owned by the lead: agents read it, never edit it.
// All positions/velocities are integers in fixed point (FP = 1000 per world unit). Angles are
// integers 0..4095 (4096 per turn; 0 = +x, 1024 = +y). The world is the x/y plane; the renderer maps
// sim y to three.js z.

/**
 * Version of the simulation RULES. Bump on ANY change that can alter a replay (rules, AI, mapgen,
 * numbers). The match server refuses records made with a different version.
 */
export const SIM_VERSION = "r6";

export const TICK_HZ = 20;
export const MATCH_SECONDS = 180;
export const MATCH_TICKS = TICK_HZ * MATCH_SECONDS;
export const FIGHTERS = 10;

export type Personality = "aggressive" | "camper" | "sniper" | "looter" | "coward" | "balanced";
export type WeaponKind = "popper" | "blaster" | "shotgun" | "sniper" | "grenade";
export type ObstacleKind = "rock" | "tree" | "crate" | "wall";

/** Bought with winnings between matches (bots) or unlocked by progression (player). */
export interface Upgrades {
  /** 0..2: +damage / faster reload per tier */
  weaponTier: number;
  /** 0..2: flat damage reduction per hit */
  armor: number;
  /** cosmetic id (palette index for the character tint) */
  skin: number;
}

export interface FighterSpec {
  id: string; // stable id (e.g. NEAR account of the bot, or "you")
  name: string; // display name
  personality: Personality; // ignored for humans
  human: boolean;
  upgrades: Upgrades;
  /** true if this fighter carries the bounty this match */
  bounty: boolean;
}

export interface MatchConfig {
  seed: number; // uint32 (from next-block randomness in T2)
  fighters: FighterSpec[]; // exactly FIGHTERS entries; index = fighter idx
  /**
   * Training island (r6): bots aim worse and react slower AGAINST THE HUMAN. Offline only — never set on chain
   * matches (their config comes from the contract), the daily tournament or challenges (the server rebuilds
   * those configs without it), so a training run can't be passed off as a real one.
   */
  training?: boolean;
}

/** One fighter's control for one tick. Humans: from keyboard/mouse/touch. Bots: from their AI. */
export interface Input {
  /** movement vector, each axis -1000..1000 (normalised by the sim) */
  mx: number;
  my: number;
  /** aim angle 0..4095 */
  aim: number;
  /** trigger held this tick */
  fire: boolean;
  /** optional aim distance (FP) for lobbed weapons (grenade); absent = max range */
  aimDist?: number;
}

export interface FighterState {
  idx: number;
  id: string;
  name: string;
  human: boolean;
  personality: Personality;
  x: number;
  y: number;
  aim: number;
  hp: number;
  maxHp: number;
  armor: number;
  weapon: WeaponKind;
  /** shots left before a reload (Infinity is not allowed: use a number) */
  ammo: number;
  /** tick when the next shot is allowed */
  readyTick: number;
  alive: boolean;
  /** standing inside a bush */
  inBush: boolean;
  /** tick of this fighter's last shot (revealed from bushes for a moment after shooting) */
  lastShotTick: number;
  /** tick this fighter last took damage (for hit flashes / regen) */
  lastHurtTick: number;
  kills: number;
  damageDealt: number;
  /** 1 = winner, 10 = first out; 0 while alive */
  placement: number;
  bounty: boolean;
}

export interface Projectile {
  id: number;
  owner: number;
  weapon: WeaponKind;
  x: number;
  y: number;
  vx: number; // FP units per tick
  vy: number;
  ttl: number; // ticks left
  dmg: number;
}

export interface Obstacle {
  kind: ObstacleKind;
  x: number;
  y: number;
  r: number; // collision radius (FP)
}

export interface Bush {
  x: number;
  y: number;
  r: number;
}

export interface Chest {
  id: number;
  x: number;
  y: number;
  open: boolean;
  weapon: WeaponKind;
}

export interface Heal {
  id: number;
  x: number;
  y: number;
  taken: boolean;
  amount: number;
}

export interface Storm {
  cx: number;
  cy: number;
  r: number; // current safe radius (FP)
  targetR: number; // radius it is shrinking toward
  /** centre of the next safe circle */
  tx: number;
  ty: number;
  phase: number;
  /** damage per second outside the safe zone */
  dps: number;
}

export interface MapData {
  /** island radius (FP); outside is water (not walkable) */
  radius: number;
  obstacles: Obstacle[];
  bushes: Bush[];
  spawns: { x: number; y: number }[]; // FIGHTERS entries
}

export interface MatchState {
  tick: number;
  fighters: FighterState[];
  projectiles: Projectile[];
  chests: Chest[];
  heals: Heal[];
  storm: Storm;
  alive: number;
  over: boolean;
  /** fighter idx of the winner once over */
  winner: number | null;
}

export type SimEvent =
  | { t: "shot"; who: number; weapon: WeaponKind; x: number; y: number; aim: number }
  | { t: "hit"; who: number; by: number; dmg: number; crit: boolean; x: number; y: number } // by = -1: storm
  | { t: "kill"; who: number; by: number | null; weapon: WeaponKind | "storm" }
  | { t: "bounty"; who: number; by: number } // the bounty carrier was killed by `by`
  | { t: "chest"; who: number; chest: number; weapon: WeaponKind }
  | { t: "heal"; who: number; amount: number }
  | { t: "explode"; x: number; y: number; r: number; by: number }
  | { t: "storm"; phase: number; targetR: number }
  | { t: "win"; who: number };

/** Everything needed to re-run a match and get the same result (stored / verified offline). */
export interface MatchRecord {
  version: 1;
  cfg: MatchConfig;
  /** human inputs only: [tick, idx, mx, my, aim, fire(0|1)] whenever they change */
  inputs: [number, number, number, number, number, number][];
  /** result hash after the final tick (see Match.hash) */
  hash: string;
  winner: number | null;
  placements: number[]; // by fighter idx
}

export interface Match {
  readonly cfg: MatchConfig;
  readonly map: MapData;
  readonly state: MatchState;
  /**
   * Advance one tick. `human` = inputs for human fighters (by idx); bots are driven by the sim's own
   * deterministic AI. Returns the events of this tick.
   */
  step(human: Map<number, Input>): SimEvent[];
  /** Can fighter `viewer` see fighter `target` right now? (bushes; used by AI and renderer) */
  canSee(viewer: number, target: number): boolean;
  /** Deterministic digest of the full state (hex string). */
  hash(): string;
}
