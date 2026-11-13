// TEMPORARY STUB so the renderer can start. Agent B replaces this file with the real simulation.
import { FIGHTERS, type Input, type Match, type MatchConfig, type MatchState, type MapData, type SimEvent } from "./types";
import { FP, Rng } from "./fixed";

export function createMatch(cfg: MatchConfig): Match {
  const rng = new Rng(cfg.seed);
  const radius = 30 * FP;
  const map: MapData = {
    radius,
    obstacles: Array.from({ length: 20 }, () => ({ kind: "rock" as const, x: rng.range(-25, 25) * FP, y: rng.range(-25, 25) * FP, r: 1200 })),
    bushes: Array.from({ length: 12 }, () => ({ x: rng.range(-22, 22) * FP, y: rng.range(-22, 22) * FP, r: 2000 })),
    spawns: Array.from({ length: FIGHTERS }, (_, i) => ({ x: Math.round(20 * FP * Math.cos((i / FIGHTERS) * 6.283)), y: Math.round(20 * FP * Math.sin((i / FIGHTERS) * 6.283)) })),
  };
  const state: MatchState = {
    tick: 0,
    fighters: cfg.fighters.map((f, idx) => ({
      idx, id: f.id, name: f.name, human: f.human, personality: f.personality, x: map.spawns[idx].x, y: map.spawns[idx].y, aim: 0,
      hp: 100, maxHp: 100, armor: f.upgrades.armor, weapon: "popper", ammo: 6, readyTick: 0, alive: true, inBush: false,
      lastShotTick: -999, lastHurtTick: -999, kills: 0, damageDealt: 0, placement: 0, bounty: f.bounty,
    })),
    projectiles: [], chests: [], heals: [],
    storm: { cx: 0, cy: 0, r: radius, targetR: radius, phase: 0, dps: 0 },
    alive: FIGHTERS, over: false, winner: null,
  };
  return {
    cfg, map, state,
    step(human: Map<number, Input>): SimEvent[] {
      state.tick++;
      for (const [idx, inp] of human) {
        const f = state.fighters[idx];
        f.x += Math.trunc(inp.mx / 5);
        f.y += Math.trunc(inp.my / 5);
        f.aim = inp.aim;
      }
      return [];
    },
    canSee: () => true,
    hash: () => String(state.tick),
  };
}
