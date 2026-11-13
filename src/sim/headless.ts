// Headless helpers for tools/tests/balance runs (pure, deterministic, Node or browser).
import type { Input, MatchConfig, Personality, SimEvent } from "./types";
import { createMatch } from "./match";
import { botOnlyRoster } from "./roster";

export interface MatchSummary {
  seed: number;
  ticks: number;
  hash: string;
  winner: number | null;
  winnerPersonality: Personality | null;
  placements: number[];
  kills: number[];
  stormDeaths: number;
  shots: number;
}

/**
 * Run a whole match. `human` (optional) supplies inputs for human fighters each tick
 * (called with the pre-step tick, like a Recorder). Without it humans stand still.
 */
export function simulate(cfg: MatchConfig, human?: (tick: number, idx: number) => Input, onEvents?: (tick: number, ev: SimEvent[]) => void): MatchSummary {
  const m = createMatch(cfg);
  const humans = cfg.fighters.map((f, i) => (f.human ? i : -1)).filter((i) => i >= 0);
  let stormDeaths = 0, shots = 0;
  while (!m.state.over) {
    const inputs = new Map<number, Input>();
    if (human) for (const i of humans) inputs.set(i, human(m.state.tick, i));
    const ev = m.step(inputs);
    for (const e of ev) {
      if (e.t === "kill" && e.by === null) stormDeaths++;
      if (e.t === "shot") shots++;
    }
    onEvents?.(m.state.tick, ev);
  }
  const w = m.state.winner;
  return {
    seed: cfg.seed,
    ticks: m.state.tick,
    hash: m.hash(),
    winner: w,
    winnerPersonality: w === null ? null : m.state.fighters[w].personality,
    placements: m.state.fighters.map((f) => f.placement),
    kills: m.state.fighters.map((f) => f.kills),
    stormDeaths,
    shots,
  };
}

/** Bot-only match (idx 0 is an AI "Autopilot" too) for balance runs. */
export function simulateBots(seed: number): MatchSummary {
  return simulate({ seed: seed >>> 0, fighters: botOnlyRoster() });
}
