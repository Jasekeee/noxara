// Asset loading + caching. Every GLB is loaded once; callers clone what they need.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { WeaponKind } from "../sim/types";

const BASE = `${import.meta.env.BASE_URL}models/`;

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

const PROPS = ["blasters/crate-medium", "blasters/crate-wide", "blasters/crate-small"];

const cache = new Map<string, GLTF>();

/** Kenney's nature kit is teal; pull it into our warmer, greener palette (sRGB hex). */
const RECOLOR: Record<string, number> = {
  grass: 0x5cb547,
  leafsGreen: 0x4fb54a,
  leafsDark: 0x2f9a55,
  stone: 0xc6ccd6,
  dirt: 0xb58a64,
  woodBark: 0x9c6440,
  woodBarkDark: 0x8a5638,
};

const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Fetch every model in parallel (network only), then parse them one at a time with a yield between
 * each, so loading never makes a long main-thread task (cold-cache first load stays responsive).
 */
export async function loadAll(onProgress: (p: number) => void): Promise<void> {
  const loader = new GLTFLoader();
  const names = [...CHARS.map((c) => `chars/${c}`), ...Object.values(HUMAN_SKINS).map((c) => `chars/${c}`), ...Object.values(WEAPON_MODEL), ...NATURE, ...PROPS];
  const buffers = names.map((n) => fetch(`${BASE}${n}.glb`).then((r) => {
    if (!r.ok) throw new Error(`asset ${n}: HTTP ${r.status}`);
    return r.arrayBuffer();
  }));
  let done = 0;
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    const buf = await buffers[i];
    const dir = `${BASE}${n.slice(0, n.lastIndexOf("/") + 1)}`;
    const g = await loader.parseAsync(buf, dir);
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats) {
          const sm = mat as THREE.MeshStandardMaterial;
          if (sm.map) {
            sm.map.colorSpace = THREE.SRGBColorSpace;
            sm.map.anisotropy = 4;
          }
          const rc = RECOLOR[sm.name];
          if (rc !== undefined && n.startsWith("nature/")) sm.color.setHex(rc);
          sm.roughness = Math.max(0.65, sm.roughness ?? 1);
          sm.metalness = 0;
        }
      }
    });
    cache.set(n, g);
    done++;
    onProgress(done / names.length);
    await yieldTask();
  }
}

export function gltf(name: string): GLTF {
  const g = cache.get(name);
  if (!g) throw new Error(`asset not loaded: ${name}`);
  return g;
}

/** Plain (non-skinned) deep clone sharing geometry + materials. */
export function model(name: string): THREE.Object3D {
  return gltf(name).scene.clone(true);
}

/** Size of a model's bounding box (unscaled). */
const sizeCache = new Map<string, THREE.Box3>();
export function bounds(name: string): THREE.Box3 {
  let b = sizeCache.get(name);
  if (!b) {
    b = new THREE.Box3().setFromObject(gltf(name).scene);
    sizeCache.set(name, b);
  }
  return b;
}
