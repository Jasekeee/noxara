// Big Island (cfg.map === "big"): map shape, determinism + replay, bots don't get stuck, matches end.
import { describe, expect, it } from "vitest";
import { BIG_MATCH_TICKS, FIGHTERS, MATCH_TICKS, type Input, type MatchConfig } from "./types";
import { createMatch } from "./match";
import { generateWorld } from "./mapgen";
import { Recorder, replayRecord } from "./record";
import { botOnlyRoster, t1Roster } from "./roster";
import { pacingReport } from "./headless";
import { BIG_ISLAND_R, BIG_N_CHESTS, BIG_N_HEALS, BIG_STORM_PHASES, FIGHTER_R, ISLAND_R, matchTicksFor, stormPhasesFor } from "./rules";
import { icos, isin } from "./fixed";

const big = (seed: number, fighters = t1Roster()): MatchConfig => ({ seed, fighters, map: "big" });

/** wandering scripted human with bursts of fire (same idea as tools/simlib scriptedInput) */
function scripted(t: number): Input {
  const s = Math.floor(t / 5);
  const dir = (s * 65 + 1024 * Math.floor(t / 60)) % 4096;
  return { mx: Math.trunc((icos(dir) * 1000) / 1024), my: Math.trunc((isin(dir) * 1000) / 1024), aim: (s * 145) % 4096, fire: s % 3 === 0 };
}

describe("Big Island map (cfg.map = big)", () => {
  it("is ~3.3x the area, with dense cover, more loot and its own storm + clock", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const w = generateWorld(seed, "big");
      expect(w.map.radius).toBe(BIG_ISLAND_R);
      expect((BIG_ISLAND_R * BIG_ISLAND_R) / (ISLAND_R * ISLAND_R)).toBeGreaterThan(3);
      expect(w.map.spawns.length).toBe(FIGHTERS);
      expect(w.chests.length).toBe(BIG_N_CHESTS);
      expect(w.heals.length).toBe(BIG_N_HEALS);
      expect(w.map.obstacles.length).toBeGreaterThan(150);
      expect(w.map.bushes.length).toBeGreaterThan(40);
      for (const k of ["rock", "tree", "crate", "wall"] as const) expect(w.map.obstacles.some((o) => o.kind === k)).toBe(true);
      // nothing spawns or lies inside an obstacle; everything is on the island
      for (const p of [...w.map.spawns, ...w.chests, ...w.heals]) {
        expect(p.x * p.x + p.y * p.y).toBeLessThan(BIG_ISLAND_R * BIG_ISLAND_R);
        for (const o of w.map.obstacles) expect((o.x - p.x) ** 2 + (o.y - p.y) ** 2).toBeGreaterThan((o.r + FIGHTER_R) ** 2);
      }
    }
    const cfg = big(1);
    expect(stormPhasesFor(cfg)).toBe(BIG_STORM_PHASES);
    expect(matchTicksFor(cfg)).toBe(BIG_MATCH_TICKS);
    expect(matchTicksFor({ seed: 1, fighters: t1Roster() })).toBe(MATCH_TICKS);
  });

  it("the standard island is unchanged when map is absent", () => {
    for (let seed = 1; seed <= 5; seed++) expect(generateWorld(seed, undefined)).toEqual(generateWorld(seed));
    expect(createMatch({ seed: 3, fighters: t1Roster() }).map.radius).toBe(ISLAND_R);
  });

  it("is deterministic and replays from its record (cfg carries the map)", () => {
    const cfg = big(7);
    const m = createMatch(structuredClone(cfg));
    const rec = new Recorder();
    while (!m.state.over && m.state.tick < BIG_MATCH_TICKS) {
      const inp = m.state.fighters[0].alive ? scripted(m.state.tick) : { mx: 0, my: 0, aim: 0, fire: false };
      rec.push(m.state.tick, 0, inp);
      m.step(new Map([[0, inp]]));
    }
    expect(m.state.over).toBe(true);
    const r = replayRecord(structuredClone(cfg), rec.inputs);
    expect(r.hash).toBe(m.hash());
    expect(r.winner).toBe(m.state.winner);
    // the same inputs on the standard island don't reproduce it
    expect(replayRecord({ seed: cfg.seed, fighters: cfg.fighters }, rec.inputs).hash).not.toBe(m.hash());
  });

  it("50 seeds: no bot stuck (within 2 u for > 10 s while trying to move), one winner before the clock", () => {
    const lengths: number[] = [];
    for (let seed = 1; seed <= 50; seed++) {
      const r = pacingReport(big(seed, botOnlyRoster()));
      expect(r.stuck, `seed ${seed}`).toEqual([]);
      expect(r.winner, `seed ${seed}`).not.toBeNull();
      expect(r.ticks, `seed ${seed}`).toBeLessThan(BIG_MATCH_TICKS);
      expect(r.firstContact, `seed ${seed}`).toBeGreaterThan(0);
      lengths.push(r.ticks);
    }
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length / 20;
    // pacing target: ~7–8 minute bot-only matches (humans usually leave earlier)
    expect(mean).toBeGreaterThan(330);
    expect(mean).toBeLessThan(560);
  });
});
