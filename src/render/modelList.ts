// Model names + an early prefetch. No three.js import: src/main.ts calls prefetchModels() at first paint so the
// GLB downloads run in parallel with the three.js / game chunks instead of after them.
import type { WeaponKind } from "../sim/types";

export const MODEL_BASE = `${import.meta.env.BASE_URL}models/`;

/** 10 distinct Kenney Mini Characters (no zombie). Fighter idx -> character. */
export const CHARS = [
  "character-male-a",
  "character-female-b",
  "character-robot",
  "character-male-c",
  "character-female-d",
  "character-knight",
  "character-alien",
  "character-female-a",
  "character-raider",
  "character-male-e",
];

/** Human-only skins unlocked by level (palette ids 10..14, see src/sim/progression.ts). */
export const HUMAN_SKINS: Record<number, string> = {
  10: "character-female-c",
  11: "character-male-d",
  12: "character-female-f",
  13: "character-male-g",
  14: "character-soldier",
};
export const HUMAN_SKIN_IDS = [0, 10, 11, 12, 13, 14];
/** character model for a fighter idx + skin id */
export function charFor(idx: number, skin: number): string {
  if (idx === 0 && HUMAN_SKINS[skin]) return HUMAN_SKINS[skin];
  return CHARS[idx % CHARS.length];
}

export const WEAPON_MODEL: Record<WeaponKind, string> = {
  popper: "blasters/blaster-b",
  blaster: "blasters/blaster-d",
  shotgun: "blasters/blaster-q",
  sniper: "blasters/blaster-f",
  grenade: "blasters/grenade-a",
};

export const NATURE = [
  "rock_largeA",
  "rock_largeB",
  "rock_tallA",
  "rock_tallB",
  "rock_smallA",
  "stone_tallA",
  "tree_default",
  "tree_detailed",
  "tree_fat_fall",
  "plant_bushLarge",
  "plant_bushDetailed",
  "grass",
  "grass_large",
  "grass_leafs",
  "flower_purpleA",
  "flower_redA",
  "flower_yellowA",
  "mushroom_red",
  "log",
  "stump_old",
].map((n) => `nature/${n}`);

export const PROPS = ["blasters/crate-medium", "blasters/crate-wide", "blasters/crate-small"];

/** Every model a match can need, in load order. */
export function modelNames(): string[] {
  return [...CHARS.map((c) => `chars/${c}`), ...Object.values(HUMAN_SKINS).map((c) => `chars/${c}`), ...Object.values(WEAPON_MODEL), ...NATURE, ...PROPS];
}

type Prefetch = Map<string, Promise<ArrayBuffer>>;
const g = globalThis as unknown as { __brModels?: Prefetch };

/** Start every GLB download now (idempotent); loadAll() picks the promises up. */
export function prefetchModels(): Prefetch {
  if (g.__brModels) return g.__brModels;
  const m: Prefetch = new Map();
  for (const n of modelNames()) {
    const p = fetch(`${MODEL_BASE}${n}.glb`).then((r) => {
      if (!r.ok) throw new Error(`asset ${n}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    p.catch(() => undefined); // surfaced by loadAll, never as an unhandled rejection here
    m.set(n, p);
  }
  g.__brModels = m;
  return m;
}
