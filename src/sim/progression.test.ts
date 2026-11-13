import { describe, expect, it } from "vitest";
import raw from "./progression.vectors.json?raw";
import {
  LEVELS,
  MAX_LEVEL,
  levelForXp,
  levelProgress,
  unlocksForLevel,
  upgradesForLevel,
  xpForMatch,
} from "./progression";

interface Vectors {
  xpForMatch: { placement: number; kills: number; bountyClaimed: boolean; xp: number }[];
  levelForXp: { xp: number; level: number }[];
  upgradesForLevel: { level: number; weaponTier: number; armor: number; skin: number }[];
}
const V = JSON.parse(raw) as Vectors;

describe("progression", () => {
  it("matches the committed test vectors (mirrored by the Rust contract)", () => {
    expect(V.xpForMatch.length + V.levelForXp.length + V.upgradesForLevel.length).toBeGreaterThanOrEqual(30);
    for (const c of V.xpForMatch) expect(xpForMatch(c.placement, c.kills, c.bountyClaimed)).toBe(c.xp);
    for (const c of V.levelForXp) expect(levelForXp(c.xp)).toBe(c.level);
    for (const c of V.upgradesForLevel) expect(upgradesForLevel(c.level)).toEqual({ weaponTier: c.weaponTier, armor: c.armor, skin: c.skin });
  });

  it("pacing: level 2 after ~2 average matches, level 10 after ~40", () => {
    const avg = xpForMatch(6, 1, false); // a typical mid-table match with one kill (~47 XP)
    let xp = 0, n = 0;
    while (levelForXp(xp) < 2) { xp += avg; n++; }
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(3);
    while (levelForXp(xp) < MAX_LEVEL) { xp += avg; n++; }
    expect(n).toBeGreaterThanOrEqual(30);
    expect(n).toBeLessThanOrEqual(45);
  });

  it("fair: the human never exceeds tier 2 / armor 1; monotonic; every level unlocks something", () => {
    let prev = upgradesForLevel(1);
    expect(prev).toEqual({ weaponTier: 0, armor: 0, skin: 0 });
    expect(unlocksForLevel(1)).toEqual([]);
    for (let l = 2; l <= MAX_LEVEL; l++) {
      const u = upgradesForLevel(l);
      expect(u.weaponTier).toBeLessThanOrEqual(2);
      expect(u.armor).toBeLessThanOrEqual(1);
      expect(u.weaponTier).toBeGreaterThanOrEqual(prev.weaponTier);
      expect(u.armor).toBeGreaterThanOrEqual(prev.armor);
      expect(unlocksForLevel(l).length).toBeGreaterThan(0);
      prev = u;
    }
    expect(upgradesForLevel(MAX_LEVEL)).toMatchObject({ weaponTier: 2, armor: 1 });
  });

  it("levelProgress reports thresholds", () => {
    expect(levelProgress(0)).toEqual({ level: 1, xp: 0, levelAt: 0, nextAt: LEVELS[1] });
    expect(levelProgress(99999)).toEqual({ level: MAX_LEVEL, xp: 99999, levelAt: LEVELS[MAX_LEVEL - 1], nextAt: null });
  });
});
