// Uniform spatial grid over a map's obstacles (Big Island only: hundreds of obstacles). Pure + deterministic.
// Each obstacle sits in the cell of its centre; queries expand their box by the largest obstacle radius,
// so a query returns a SUPERSET of the obstacles that can touch it, in a fixed order (row-major cells,
// ascending obstacle index inside a cell). Standard maps (few obstacles) get no grid and keep the old
// linear scans, so their replays stay bit-identical.
import type { MapData, Obstacle } from "./types";

export interface ObsGrid {
  cell: number;
  min: number; // grid origin (FP), same for x and y
  n: number; // cells per side
  cells: Obstacle[][];
  maxR: number;
}

const CELL = 4000;
/** maps with more obstacles than this get a grid */
export const GRID_MIN_OBSTACLES = 60;
const grids = new WeakMap<MapData, ObsGrid | null>();

export function obsGrid(map: MapData): ObsGrid | null {
  let g = grids.get(map);
  if (g !== undefined) return g;
  if (map.obstacles.length <= GRID_MIN_OBSTACLES) g = null;
  else {
    const min = -map.radius - CELL;
    const n = Math.trunc((2 * map.radius + 2 * CELL) / CELL) + 1;
    const cells: Obstacle[][] = [];
    for (let i = 0; i < n * n; i++) cells.push([]);
    let maxR = 0;
    for (const o of map.obstacles) {
      const cx = Math.max(0, Math.min(n - 1, Math.trunc((o.x - min) / CELL)));
      const cy = Math.max(0, Math.min(n - 1, Math.trunc((o.y - min) / CELL)));
      cells[cy * n + cx].push(o);
      if (o.r > maxR) maxR = o.r;
    }
    g = { cell: CELL, min, n, cells, maxR };
  }
  grids.set(map, g);
  return g;
}

/**
 * Obstacles that may lie within `pad` of the box (x0,y0)-(x1,y1) (any corner order). Fills and returns
 * `out` (reused to avoid garbage). Without a grid: all obstacles.
 */
export function obstaclesNear(map: MapData, x0: number, y0: number, x1: number, y1: number, pad: number, out: Obstacle[]): Obstacle[] {
  const g = obsGrid(map);
  if (!g) return map.obstacles;
  out.length = 0;
  const e = pad + g.maxR;
  const lo = (v: number) => Math.max(0, Math.min(g.n - 1, Math.trunc((v - e - g.min) / g.cell)));
  const hi = (v: number) => Math.max(0, Math.min(g.n - 1, Math.trunc((v + e - g.min) / g.cell)));
  const ax = lo(Math.min(x0, x1)), bx = hi(Math.max(x0, x1));
  const ay = lo(Math.min(y0, y1)), by = hi(Math.max(y0, y1));
  for (let cy = ay; cy <= by; cy++) {
    for (let cx = ax; cx <= bx; cx++) {
      const c = g.cells[cy * g.n + cx];
      for (let i = 0; i < c.length; i++) out.push(c[i]);
    }
  }
  return out;
}
