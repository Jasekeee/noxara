// Headless helpers for tools/tests/balance runs (pure, deterministic, Node or browser).
import type { Input, MatchConfig, Personality, SimEvent } from "./types";
import { createMatch } from "./match";
import { botOnlyRoster } from "./roster";
import { botMode } from "./ai";
import { dist2 } from "./fixed";

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

// ------------------------------------------------------------------ Big Island QA (stuck + pacing)

export interface PacingReport {
  seed: number;
  ticks: number;
  winner: number | null;
  kills: number;
  stormDeaths: number;
  /** first tick a fighter damaged another fighter (-1: never) */
  firstContact: number;
  /** ticks of each death */
  deathTicks: number[];
  /** longest stretch (ticks) without any fighter-vs-fighter damage, after spawn protection */
  longestQuiet: number;
  /** per fighter: first tick it dealt or took fighter damage (-1: never) */
  firstFight: number[];
  /** per fighter: longest stretch (ticks) alive without dealing or taking fighter damage */
  quietAlive: number[];
  /** bots that stayed inside STUCK_R for > STUCK_TICKS while alive, wanting to move and not fighting */
  stuck: { idx: number; tick: number; x: number; y: number; mode: string }[];
}

/** stuck = stays within 2 u for more than 10 s while trying to go somewhere and not fighting */
export const STUCK_R = 2000;
export const STUCK_TICKS = 200;
/** modes where standing still is intended (bush camping / lurking / ambush / hiding) or fighting */
const STILL_OK = /^(camp|lurk|ambush|hide|fight|flee)/;

/**
 * Bot-only match on `cfg` with per-tick pacing and stuck tracking (reads the AI's debug mode only:
 * it does not drive anything, so the match is the same as an untracked one).
 */
export function pacingReport(cfg: MatchConfig): PacingReport {
  const m = createMatch(cfg);
  const n = cfg.fighters.length;
  const ax = m.state.fighters.map((f) => f.x), ay = m.state.fighters.map((f) => f.y), at = new Array(n).fill(0);
  const stuck: PacingReport["stuck"] = [];
  const flagged = new Set<number>();
  let firstContact = -1, lastHit = 0, longestQuiet = 0, kills = 0, stormDeaths = 0;
  const deathTicks: number[] = [];
  const firstFight: number[] = new Array(n).fill(-1), lastFight: number[] = new Array(n).fill(60), quietAlive: number[] = new Array(n).fill(0);
  while (!m.state.over) {
    const ev = m.step(new Map());
    const t = m.state.tick;
    for (const e of ev) {
      if (e.t === "hit" && e.by >= 0) {
        if (firstContact < 0) firstContact = t;
        for (const i of [e.who, e.by]) {
          if (firstFight[i] < 0) firstFight[i] = t;
          quietAlive[i] = Math.max(quietAlive[i], t - lastFight[i]);
          lastFight[i] = t;
        }
        longestQuiet = Math.max(longestQuiet, t - Math.max(lastHit, 60));
        lastHit = t;
      }
      if (e.t === "kill") {
        deathTicks.push(t);
        quietAlive[e.who] = Math.max(quietAlive[e.who], t - lastFight[e.who]);
        lastFight[e.who] = 1e9;
        if (e.by === null) stormDeaths++;
        else kills++;
      }
    }
    const st = m.state.storm;
    for (const f of m.state.fighters) {
      if (!f.alive) continue;
      const mode = botMode(m, f.idx);
      const busy = STILL_OK.test(mode) || t - f.lastShotTick < 40 || t - f.lastHurtTick < 40 || st.targetR < 4000;
      if (busy || dist2(f.x, f.y, ax[f.idx], ay[f.idx]) > STUCK_R * STUCK_R) {
        ax[f.idx] = f.x;
        ay[f.idx] = f.y;
        at[f.idx] = t;
      } else if (t - at[f.idx] > STUCK_TICKS && !flagged.has(f.idx)) {
        flagged.add(f.idx);
        stuck.push({ idx: f.idx, tick: t, x: f.x, y: f.y, mode });
      }
    }
  }
  longestQuiet = Math.max(longestQuiet, m.state.tick - Math.max(lastHit, 60));
  for (let i = 0; i < n; i++) if (lastFight[i] < 1e9) quietAlive[i] = Math.max(quietAlive[i], m.state.tick - lastFight[i]);
  return { seed: cfg.seed, ticks: m.state.tick, winner: m.state.winner, kills, stormDeaths, firstContact, deathTicks, longestQuiet, firstFight, quietAlive, stuck };
}
