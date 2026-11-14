// Asset loading + caching. Every GLB is loaded once; callers clone what they need.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { WeaponKind } from "../sim/types";


export { CHARS, HUMAN_SKINS, HUMAN_SKIN_IDS, WEAPON_MODEL, NATURE, charFor } from "./modelList";
import { CHARS, MODEL_BASE as BASE, SKIN_NAMES, prefetchModels, modelNames } from "./modelList";


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

// Every Kenney character GLB references the same external Textures/colormap.png: without the cache the loader
// fetched (and on Vercel re-validated) it once per model, one after another — ~4 s of a cold first load.
THREE.Cache.enabled = true;

const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Fetch every model in parallel (network only), then parse them one at a time with a yield between
 * each, so loading never makes a long main-thread task (cold-cache first load stays responsive).
 */
export async function loadAll(onProgress: (p: number) => void, names = modelNames()): Promise<void> {
  const loader = new GLTFLoader();
  const pre = prefetchModels(names); // started at first paint by src/main.ts (or now)
  const buffers = names.map((n) => pre.get(n)!);
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

/** The level-unlocked player skins, after the island is ready. */
export const loadSkins = () => loadAll(() => undefined, SKIN_NAMES.filter((n) => !cache.has(n)));

export function gltf(name: string): GLTF {
  // a player skin requested before loadSkins() finished: the default character until then
  const g = cache.get(name) ?? (SKIN_NAMES.includes(name) ? cache.get(`chars/${CHARS[0]}`) : undefined);
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
