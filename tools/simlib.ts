// Shared, environment-free helpers for the headless tools and the unit tests. Only type imports from
// the sim (plus the constants/math in types.ts and fixed.ts, which have no imports), so this file loads
// both under Vitest and under plain Node.
import type { FighterSpec, Input, Match, MatchConfig, MatchRecord, Personality } from "../src/sim/types.ts";
import { BIG_MATCH_TICKS, MATCH_TICKS } from "../src/sim/types.ts";
import { icos, isin } from "../src/sim/fixed.ts";

/** The documented cross-agent API (docs/OWNERSHIP.md). */
export interface Sim {
  createMatch(cfg: MatchConfig): Match;
  botInput(match: Match, idx: number): Input;
  Recorder: new () => { inputs: MatchRecord["inputs"]; push(tick: number, idx: number, input: Input): void };
  replayRecord(cfg: MatchConfig, inputs: MatchRecord["inputs"]): { hash: string; winner: number | null; placements: number[] };
  t1Roster(): FighterSpec[];
}

export const PERSONALITIES: Personality[] = ["aggressive", "camper", "sniper", "looter", "coward", "balanced"];

/** All 10 fighters as bots: idx 0 ("You") becomes a bot with personality `p0`. */
export function botRoster(sim: Sim, p0: Personality = "balanced"): FighterSpec[] {
  return sim.t1Roster().map((f, i) => (i === 0 ? { ...f, human: false, personality: p0 } : { ...f, human: false }));
}

/** Deterministic "human" input script: a wandering strafe with a sweeping aim and bursts of fire. */
export function scriptedInput(m: Match, _idx: number): Input {
  const t = m.state.tick;
  const s = Math.floor(t / 5); // change at most every 5 ticks (≈4 Hz), like a real thumb on a stick
  const dir = (s * 65 + 1024 * Math.floor(t / 60)) % 4096;
  const still = Math.floor(t / 40) % 5 === 4; // stand still now and then
  return {
    mx: still ? 0 : Math.trunc((icos(dir) * 1000) / 1024),
    my: still ? 0 : Math.trunc((isin(dir) * 1000) / 1024),
    aim: (s * 145) % 4096,
    fire: s % 3 === 0,
  };
}

export interface RunOptions {
  /** Stop after this tick even if the match is not over (default MATCH_TICKS). */
  maxTicks?: number;
  /** Fighter idxs driven from outside (human slots). Default: every fighter with spec.human. */
  humans?: number[];
  /** Input source for the human slots (default scriptedInput). */
  human?: (m: Match, idx: number) => Input;
  /** Receives every human input exactly as sent: push(tick-before-step, idx, input). */
  recorder?: { push(tick: number, idx: number, input: Input): void };
  /** Called after every step (e.g. to sample hashes). */
  onTick?: (m: Match) => void;
}

export interface MatchRun {
  seed: number;
  ticks: number;
  over: boolean;
  winner: number | null;
  placements: number[];
  hash: string;
  /** kills credited to each fighter idx */
  kills: number[];
  deaths: number;
  stormDeaths: number;
  /** over with more than one fighter alive (the clock decided it) */
  endedByClock: boolean;
}

/** Steps a match to the end (or the tick cap). Pure: same match + same options → same result. */
export function runMatch(m: Match, opts: RunOptions = {}): MatchRun {
  const maxTicks = opts.maxTicks ?? (m.cfg.map === "big" ? BIG_MATCH_TICKS : MATCH_TICKS);
  const humans = opts.humans ?? m.cfg.fighters.flatMap((f, i) => (f.human ? [i] : []));
  const human = opts.human ?? scriptedInput;
  const kills = new Array<number>(m.cfg.fighters.length).fill(0);
  let deaths = 0;
  let stormDeaths = 0;
  let guard = 0; // protects against a sim whose tick never advances
  while (!m.state.over && m.state.tick < maxTicks && guard++ < maxTicks * 2) {
    const inputs = new Map<number, Input>();
    for (const idx of humans) {
      if (!m.state.fighters[idx]?.alive) continue;
      const input = human(m, idx);
      opts.recorder?.push(m.state.tick, idx, input);
      inputs.set(idx, input);
    }
    for (const ev of m.step(inputs)) {
      if (ev.t !== "kill") continue;
      deaths++;
      if (ev.weapon === "storm" || ev.by === null) stormDeaths++;
      else if (ev.by !== ev.who) kills[ev.by]++;
    }
    opts.onTick?.(m);
  }
  const s = m.state;
  return {
    seed: m.cfg.seed,
    ticks: s.tick,
    over: s.over,
    winner: s.winner,
    placements: s.fighters.map((f) => f.placement),
    hash: m.hash(),
    kills,
    deaths,
    stormDeaths,
    endedByClock: s.over && s.alive > 1,
  };
}

/** Build a MatchRecord (types.ts) from a finished run. */
export function toRecord(cfg: MatchConfig, inputs: MatchRecord["inputs"], run: MatchRun): MatchRecord {
  return { version: 1, cfg, inputs, hash: run.hash, winner: run.winner, placements: run.placements };
}
