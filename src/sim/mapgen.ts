// Seeded island generation: obstacles, bushes, chests, heals and spawns. Pure + deterministic.
import { FIGHTERS, type Ruin, type Bush, type Chest, type Heal, type MapData, type Obstacle, type ObstacleKind, type WeaponKind } from "./types";
import { FP, Rng, dist2, icos, isin, isqrt, mixSeed } from "./fixed";
import {
  BIG_BUSHES,
  BIG_CRATES,
  BIG_FORESTS,
  BIG_ISLAND_R,
  BIG_N_CHESTS,
  BIG_N_HEALS,
  BIG_ROCKS,
  BIG_RUINS,
  BIG_SPAWN_RING,
  CHEST_LOOT,
  CHEST_NEAR_SPAWN,
  FIGHTER_R,
  HEAL_AMOUNT,
  ISLAND_R,
  N_CHESTS,
  N_HEALS,
  N_OBSTACLES,
  SPAWN_RING,
} from "./rules";

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

export function generateWorld(seed: number, mode?: "big"): GeneratedWorld {
  if (mode === "big") return generateBigWorld(seed);
  const rng = new Rng(mixSeed(seed, 0x15a7d));
  const R = ISLAND_R;

  // Spawns: evenly on a ring, random rotation + small jitter.
  const rot = rng.below(4096);
  const spawns: { x: number; y: number }[] = [];
  for (let i = 0; i < FIGHTERS; i++) {
    const a = rot + Math.trunc((i * 4096) / FIGHTERS) + rng.range(-30, 30);
    const rr = SPAWN_RING + rng.range(-1000, 1000);
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

  // Chests: one in the middle + one per spawn, 3–6 u from it toward the centre, so every fighter
  // (a new player too) has loot right next to its spawn and the opening isn't a brawl for chests.
  const placeNear = (cx: number, cy: number, spread: number, home: { x: number; y: number } | null): { x: number; y: number } => {
    for (let tries = 0; tries < 600; tries++) {
      const sp = spread + Math.trunc(tries / 60) * 500;
      const x = cx + rng.range(-sp, sp), y = cy + rng.range(-sp, sp);
      if (x * x + y * y > sq(R - 4 * FP)) continue;
      if (home && dist2(home.x, home.y, x, y) > sq(CHEST_NEAR_SPAWN)) continue;
      if (obstacles.some((o) => dist2(o.x, o.y, x, y) < sq(o.r + FIGHTER_R + 1200))) continue;
      if (items.some((q) => dist2(q.x, q.y, x, y) < sq(tries < 300 ? 4 * FP : 2 * FP))) continue;
      if (spawns.some((s) => dist2(s.x, s.y, x, y) < sq(3 * FP))) continue;
      items.push({ x, y });
      return { x, y };
    }
    return placeItem(0, R - 5 * FP, 4 * FP);
  };
  const chests: Chest[] = [];
  for (let i = 0; i < N_CHESTS; i++) {
    let p: { x: number; y: number };
    if (i === 0) p = placeNear(0, 0, 2500, null);
    else {
      const s = spawns[(i - 1) % FIGHTERS];
      const d = isqrt(s.x * s.x + s.y * s.y) || 1;
      const k = 4500;
      p = placeNear(s.x - Math.trunc((s.x * k) / d), s.y - Math.trunc((s.y * k) / d), 1200, s);
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

// ------------------------------------------------------------------ Big Island

/** wall posts of a ruin: radius and spacing (overlapping, so neither fighters nor bullets pass) */
const POST_R = 650;
const POST_STEP = 1200;
/** walkable gap kept between free-standing obstacles (fighter diameter is 1 u) */
const BIG_GAP = 1600;

/**
 * Big Island (cfg.map === "big"): radius 58 u. Walled ruins (square rings of overlapping "wall" posts
 * with 2–4 wide doorways, a chest inside), tree forests, boulders, crates, lots of tall grass (bushes),
 * 30 chests (1 per spawn) and 18 heals. Pure + deterministic like generateWorld.
 */
function generateBigWorld(seed: number): GeneratedWorld {
  const rng = new Rng(mixSeed(seed, 0xb16b16));
  const R = BIG_ISLAND_R;

  const spawns: { x: number; y: number }[] = [];
  const rot = rng.below(4096);
  for (let i = 0; i < FIGHTERS; i++) {
    const a = rot + Math.trunc((i * 4096) / FIGHTERS) + rng.range(-30, 30);
    const rr = BIG_SPAWN_RING + rng.range(-1500, 1500);
    spawns.push({ x: Math.trunc((icos(a) * rr) / 1024), y: Math.trunc((isin(a) * rr) / 1024) });
  }
  const nearSpawn = (x: number, y: number, d: number) => spawns.some((s) => dist2(s.x, s.y, x, y) < sq(d));

  // Ruins: ruin 0 near the centre (a landmark with the central chest), the others spread out.
  const obstacles: Obstacle[] = [];
  const ruins: { x: number; y: number; h: number }[] = [];
  for (let tries = 0; ruins.length < BIG_RUINS && tries < 3000; tries++) {
    const h = rng.range(3600, 4600);
    const p = ruins.length === 0 ? randPoint(rng, 5 * FP) : randPoint(rng, R - 12 * FP);
    if (ruins.length > 0 && p.x * p.x + p.y * p.y < sq(14 * FP)) continue;
    if (nearSpawn(p.x, p.y, h * 2 + 5 * FP)) continue;
    if (ruins.some((q) => dist2(q.x, q.y, p.x, p.y) < sq(q.h + h + 14 * FP))) continue;
    ruins.push({ x: p.x, y: p.y, h });
  }
  const ruinInfo: Ruin[] = [];
  for (const ru of ruins) {
    const openings: { x: number; y: number }[] = [];
    ruinInfo.push({ x: ru.x, y: ru.y, h: ru.h, openings });
    const n = Math.trunc((2 * ru.h + POST_STEP - 1) / POST_STEP); // posts per side (corner included)
    const step = Math.trunc((2 * ru.h) / n); // <= POST_STEP: neighbouring posts overlap
    // doorways: two opposite sides always, the other two often
    const axis = rng.below(2);
    const doors = [0, 1, 2, 3].map((side) => side % 2 === axis || rng.chance(55));
    for (let side = 0; side < 4; side++) {
      // posts 0..n-1 along this side (the next side's post 0 is this side's end corner)
      const doorAt = doors[side] ? rng.range(1, n - 4) : -99; // posts doorAt..doorAt+2 removed: a 3.5 u gap
      const breakAt = !doors[side] && rng.chance(35) ? rng.range(1, n - 3) : -99; // a 2.3 u breach
      const at = (u: number) => (side === 0 ? [u, -ru.h] : side === 1 ? [ru.h, u] : side === 2 ? [-u, ru.h] : [-ru.h, -u]);
      const gap = doorAt >= 0 ? -ru.h + (doorAt + 1) * step : breakAt >= 0 ? -ru.h + breakAt * step + Math.trunc(step / 2) : null;
      if (gap !== null) {
        const [gx, gy] = at(gap);
        openings.push({ x: ru.x + gx, y: ru.y + gy });
      }
      for (let k = 0; k < n; k++) {
        if (k >= doorAt && k <= doorAt + 2) continue;
        if (k >= breakAt && k <= breakAt + 1) continue;
        const u = -ru.h + k * step;
        const [dx, dy] = at(u);
        obstacles.push({ kind: "wall", x: ru.x + dx, y: ru.y + dy, r: POST_R });
      }
    }
  }
  const inRuinZone = (x: number, y: number, pad: number) =>
    ruins.some((ru) => Math.abs(x - ru.x) < ru.h + pad && Math.abs(y - ru.y) < ru.h + pad);

  const free = (x: number, y: number, r: number, gap: number) => {
    if (x * x + y * y > sq(R - 3 * FP)) return false;
    if (nearSpawn(x, y, r + 3 * FP)) return false;
    if (inRuinZone(x, y, r + 2200)) return false;
    return !obstacles.some((o) => o.kind !== "wall" && dist2(o.x, o.y, x, y) < sq(o.r + r + gap));
  };

  // Forests: clusters of trees with walkable gaps.
  const forests: { x: number; y: number }[] = [];
  for (let tries = 0; forests.length < BIG_FORESTS && tries < 3000; tries++) {
    const p = randPoint(rng, R - 9 * FP);
    if (nearSpawn(p.x, p.y, 9 * FP) || inRuinZone(p.x, p.y, 6 * FP)) continue;
    if (forests.some((q) => dist2(q.x, q.y, p.x, p.y) < sq(16 * FP))) continue;
    forests.push(p);
  }
  for (const fo of forests) {
    const want = rng.range(10, 15);
    let placed = 0;
    for (let tries = 0; placed < want && tries < 400; tries++) {
      const r = rng.range(600, 850);
      const d = randPoint(rng, 6500);
      const x = fo.x + d.x, y = fo.y + d.y;
      if (!free(x, y, r, BIG_GAP)) continue;
      obstacles.push({ kind: "tree", x, y, r });
      placed++;
    }
  }
  // Boulders and crates anywhere else.
  for (let i = 0, tries = 0; i < BIG_ROCKS && tries < 6000; tries++) {
    const r = rng.range(1000, 1800);
    const p = randPoint(rng, R - 3 * FP);
    if (!free(p.x, p.y, r, BIG_GAP)) continue;
    obstacles.push({ kind: "rock", x: p.x, y: p.y, r });
    i++;
  }
  for (let i = 0, tries = 0; i < BIG_CRATES && tries < 6000; tries++) {
    // mostly stacked outside the ruins (cover on the approach), some loose
    let p: { x: number; y: number };
    if (ruins.length > 0 && rng.chance(65)) {
      const ru = ruins[rng.below(ruins.length)];
      const a = rng.below(4096), d = ru.h + rng.range(3000, 5500);
      p = { x: ru.x + Math.trunc((icos(a) * d) / 1024), y: ru.y + Math.trunc((isin(a) * d) / 1024) };
    } else p = randPoint(rng, R - 4 * FP);
    if (!free(p.x, p.y, 800, BIG_GAP)) continue;
    obstacles.push({ kind: "crate", x: p.x, y: p.y, r: 800 });
    i++;
  }

  // Tall grass: a third in the forests, the rest everywhere (never on a spawn, never inside a ruin).
  const bushes: Bush[] = [];
  for (let tries = 0; bushes.length < BIG_BUSHES && tries < 8000; tries++) {
    const r = rng.range(1600, 2800);
    let p: { x: number; y: number };
    if (forests.length > 0 && rng.chance(35)) {
      const fo = forests[rng.below(forests.length)];
      const d = randPoint(rng, 7 * FP);
      p = { x: fo.x + d.x, y: fo.y + d.y };
    } else p = randPoint(rng, R - 3 * FP);
    if (p.x * p.x + p.y * p.y > sq(R - 3 * FP)) continue;
    if (nearSpawn(p.x, p.y, r + 1500)) continue;
    if (inRuinZone(p.x, p.y, r)) continue;
    if (obstacles.some((o) => dist2(o.x, o.y, p.x, p.y) < sq(o.r + Math.trunc(r / 2) + 300))) continue;
    if (bushes.some((b) => dist2(b.x, b.y, p.x, p.y) < sq(b.r + r + 1200))) continue;
    bushes.push({ x: p.x, y: p.y, r });
  }

  // Items.
  const items: { x: number; y: number }[] = [];
  const clearOf = (x: number, y: number) => !obstacles.some((o) => dist2(o.x, o.y, x, y) < sq(o.r + FIGHTER_R + 1200));
  const placeItem = (minFromCenter: number, maxR: number, sep: number): { x: number; y: number } => {
    let relax = 0;
    for (let tries = 0; ; tries++) {
      if (tries > 0 && tries % 300 === 0) relax++;
      const p = randPoint(rng, maxR);
      if (p.x * p.x + p.y * p.y < sq(minFromCenter)) continue;
      if (!clearOf(p.x, p.y)) continue;
      if (relax < 3 && items.some((q) => dist2(q.x, q.y, p.x, p.y) < sq(Math.max(0, sep - relax * 1500)))) continue;
      if (relax < 2 && nearSpawn(p.x, p.y, 3 * FP)) continue;
      items.push(p);
      return p;
    }
  };
  const placeNear = (cx: number, cy: number, spread: number, home: { x: number; y: number }): { x: number; y: number } => {
    for (let tries = 0; tries < 600; tries++) {
      const sp = spread + Math.trunc(tries / 60) * 500;
      const x = cx + rng.range(-sp, sp), y = cy + rng.range(-sp, sp);
      if (x * x + y * y > sq(R - 4 * FP)) continue;
      if (dist2(home.x, home.y, x, y) > sq(CHEST_NEAR_SPAWN)) continue;
      if (!clearOf(x, y)) continue;
      if (items.some((q) => dist2(q.x, q.y, x, y) < sq(tries < 300 ? 4 * FP : 2 * FP))) continue;
      if (nearSpawn(x, y, 3 * FP)) continue;
      items.push({ x, y });
      return { x, y };
    }
    return placeItem(0, R - 5 * FP, 4 * FP);
  };
  const chests: Chest[] = [];
  const addChest = (p: { x: number; y: number }) => chests.push({ id: chests.length, x: p.x, y: p.y, open: false, weapon: pickLoot(rng) });
  // ruin centres first (chest 0 = the central ruin), then one per spawn, then scattered
  for (const ru of ruins) {
    items.push({ x: ru.x, y: ru.y });
    addChest({ x: ru.x, y: ru.y });
  }
  for (let i = 0; i < FIGHTERS; i++) {
    const s = spawns[i];
    const d = isqrt(s.x * s.x + s.y * s.y) || 1;
    const k = 4500;
    addChest(placeNear(s.x - Math.trunc((s.x * k) / d), s.y - Math.trunc((s.y * k) / d), 1200, s));
  }
  while (chests.length < BIG_N_CHESTS) addChest(placeItem(6 * FP, R - 6 * FP, 8 * FP));
  const heals: Heal[] = [];
  for (let i = 0; i < BIG_N_HEALS; i++) {
    const p = placeItem(4 * FP, R - 5 * FP, 6 * FP);
    heals.push({ id: i, x: p.x, y: p.y, taken: false, amount: HEAL_AMOUNT });
  }

  return { map: { radius: R, obstacles, bushes, spawns, ruins: ruinInfo }, chests, heals };
}
