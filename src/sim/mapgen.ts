// Seeded island generation: obstacles, bushes, chests, heals and spawns. Pure + deterministic.
import { FIGHTERS, type Bush, type Chest, type Heal, type MapData, type Obstacle, type ObstacleKind, type WeaponKind } from "./types";
import { FP, Rng, dist2, icos, isin, mixSeed } from "./fixed";
import { CHEST_LOOT, FIGHTER_R, HEAL_AMOUNT, ISLAND_R, N_CHESTS, N_HEALS, N_OBSTACLES, SPAWN_RING } from "./rules";

export interface GeneratedWorld {
  map: MapData;
  chests: Chest[];
  heals: Heal[];
}

const sq = (v: number) => v * v;

/** Random point in a disc of radius `r` (FP) around the origin, uniform-ish (rejection sampling). */
function randPoint(rng: Rng, r: number): { x: number; y: number } {
  for (;;) {
    const x = rng.range(-r, r);
    const y = rng.range(-r, r);
    if (x * x + y * y <= r * r) return { x, y };
  }
}

function pickLoot(rng: Rng): WeaponKind {
  let roll = rng.below(100);
  for (const [w, p] of CHEST_LOOT) {
    if (roll < p) return w;
    roll -= p;
  }
  return "blaster";
}

export function generateWorld(seed: number): GeneratedWorld {
  const rng = new Rng(mixSeed(seed, 0x15a7d));
  const R = ISLAND_R;

  // Spawns: evenly on a ring, random rotation + small jitter.
  const rot = rng.below(4096);
  const spawns: { x: number; y: number }[] = [];
  for (let i = 0; i < FIGHTERS; i++) {
    const a = rot + Math.trunc((i * 4096) / FIGHTERS) + rng.range(-60, 60);
    const rr = SPAWN_RING + rng.range(-1500, 1500);
    spawns.push({ x: Math.trunc((icos(a) * rr) / 1024), y: Math.trunc((isin(a) * rr) / 1024) });
  }

  // Obstacles: keep a walkable gap (>= 1.4 u) between any two, clear of spawns and the shore.
  const obstacles: Obstacle[] = [];
  for (let tries = 0; obstacles.length < N_OBSTACLES && tries < 4000; tries++) {
    const roll = rng.below(100);
    const kind: ObstacleKind = roll < 40 ? "rock" : roll < 75 ? "tree" : "crate";
    const r = kind === "rock" ? rng.range(1000, 1600) : kind === "tree" ? rng.range(600, 800) : 800;
    const p = randPoint(rng, R - 3 * FP);
    if (spawns.some((s) => dist2(s.x, s.y, p.x, p.y) < sq(r + 3 * FP))) continue;
    if (obstacles.some((o) => dist2(o.x, o.y, p.x, p.y) < sq(o.r + r + 1400))) continue;
    obstacles.push({ kind, x: p.x, y: p.y, r });
  }

  // Bushes: may touch obstacles a little, never cover a spawn, spread out.
  const nBushes = rng.range(14, 18);
  const bushes: Bush[] = [];
  for (let tries = 0; bushes.length < nBushes && tries < 4000; tries++) {
    const r = rng.range(1600, 2400);
    const p = randPoint(rng, R - 3 * FP);
    if (spawns.some((s) => dist2(s.x, s.y, p.x, p.y) < sq(r + 1500))) continue;
    if (obstacles.some((o) => dist2(o.x, o.y, p.x, p.y) < sq(o.r + Math.trunc(r / 2) + 300))) continue;
    if (bushes.some((b) => dist2(b.x, b.y, p.x, p.y) < sq(b.r + r + 2 * FP))) continue;
    bushes.push({ x: p.x, y: p.y, r });
  }

  // Items: on free land, apart from each other.
  const items: { x: number; y: number }[] = [];
  const placeItem = (minFromCenter: number, maxR: number, sep: number): { x: number; y: number } => {
    let relax = 0;
    for (let tries = 0; ; tries++) {
      if (tries > 0 && tries % 300 === 0) relax++;
      const p = randPoint(rng, maxR);
      if (p.x * p.x + p.y * p.y < sq(minFromCenter)) continue;
      if (obstacles.some((o) => dist2(o.x, o.y, p.x, p.y) < sq(o.r + FIGHTER_R + 1200))) continue;
      if (relax < 3 && items.some((q) => dist2(q.x, q.y, p.x, p.y) < sq(sep - relax * 1500))) continue;
      if (relax < 2 && spawns.some((s) => dist2(s.x, s.y, p.x, p.y) < sq(3 * FP))) continue;
      items.push(p);
      return p;
    }
  };

  // Chests: one in the middle, the rest spread in sectors on an inner ring so every spawn has loot
  // nearby (early game = looting, not a brawl in the centre).
  const placeNear = (cx: number, cy: number, spread: number): { x: number; y: number } => {
    for (let tries = 0; tries < 400; tries++) {
      const sp = spread + Math.trunc(tries / 40) * 1000;
      const x = cx + rng.range(-sp, sp), y = cy + rng.range(-sp, sp);
      if (x * x + y * y > sq(R - 4 * FP)) continue;
      if (obstacles.some((o) => dist2(o.x, o.y, x, y) < sq(o.r + FIGHTER_R + 1200))) continue;
      if (items.some((q) => dist2(q.x, q.y, x, y) < sq(4 * FP))) continue;
      if (spawns.some((s) => dist2(s.x, s.y, x, y) < sq(3 * FP))) continue;
      items.push({ x, y });
      return { x, y };
    }
    return placeItem(0, R - 5 * FP, 4 * FP);
  };
  const chests: Chest[] = [];
  for (let i = 0; i < N_CHESTS; i++) {
    let p: { x: number; y: number };
    if (i === 0) p = placeNear(0, 0, 2500);
    else {
      const a = rot + Math.trunc(((2 * i - 1) * 4096) / (2 * (N_CHESTS - 1)));
      const rr = rng.range(14 * FP, 21 * FP);
      p = placeNear(Math.trunc((icos(a) * rr) / 1024), Math.trunc((isin(a) * rr) / 1024), 2000);
    }
    chests.push({ id: i, x: p.x, y: p.y, open: false, weapon: pickLoot(rng) });
  }
  const heals: Heal[] = [];
  for (let i = 0; i < N_HEALS; i++) {
    const p = placeItem(4 * FP, R - 5 * FP, 5 * FP);
    heals.push({ id: i, x: p.x, y: p.y, taken: false, amount: HEAL_AMOUNT });
  }

  return { map: { radius: R, obstacles, bushes, spawns }, chests, heals };
}
