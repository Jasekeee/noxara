// Small integer geometry helpers shared by the sim and the bot AI.
import { dist2 } from "./fixed.ts";

/** Closest-approach parameter (0..1024) of segment (x0,y0)+(dx,dy) to circle (cx,cy,r), or -1 if it misses. */
export function segHit(x0: number, y0: number, dx: number, dy: number, cx: number, cy: number, r: number): number {
  const den = dx * dx + dy * dy;
  let t = 0;
  if (den > 0) {
    const num = (cx - x0) * dx + (cy - y0) * dy;
    t = num <= 0 ? 0 : num >= den ? 1024 : Math.trunc((num * 1024) / den);
  }
  const px = x0 + Math.trunc((dx * t) / 1024);
  const py = y0 + Math.trunc((dy * t) / 1024);
  return dist2(px, py, cx, cy) <= r * r ? t : -1;
}
