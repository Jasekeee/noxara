// The match server's judgement: re-run a recorded match with the shared simulation and turn the
// result into `settle_match` arguments. Pure (no network): unit-tested in test/settle.test.ts.
import type { Input, MatchConfig, MatchRecord } from "../../src/sim/types.ts";
import { FIGHTERS, MATCH_TICKS } from "../../src/sim/types.ts";
import { replayRecord } from "../../src/sim/record.ts";
import { createMatch } from "../../src/sim/match.ts";
import { configDiff, matchConfigFromChain, type ChainMatch } from "./roster.ts";
import { inputLogHash, settleMessage } from "./protocol.ts";

export type SettleArgs = {
  match_id: string;
  placements: number[];
  kills: number[];
  bounty_killer: number | null;
  input_log_hash: string;
  result_hash: string;
};

export type ReplayResult = { hash: string; winner: number | null; placements: number[]; kills?: number[]; bountyKiller?: number | null };
export type Replayer = (cfg: MatchConfig, inputs: MatchRecord["inputs"]) => ReplayResult;

export type Verdict =
  | { ok: true; args: SettleArgs; winner: number | null; ms: number; killsFrom: "replay" | "detailed" | "none" }
  | { ok: false; status: number; reason: string };

export { inputLogHash, settleMessage };

export const MAX_INPUTS = MATCH_TICKS * 2;

export function checkInputs(inputs: unknown): string | null {
  if (!Array.isArray(inputs)) return "inputs must be an array";
  if (inputs.length > MAX_INPUTS) return "input log too long";
  let last = -1;
  for (const row of inputs) {
    if (!Array.isArray(row) || row.length !== 6 || !row.every((x) => Number.isInteger(x))) return "bad input row";
    const [tick, idx, mx, my, aim, fire] = row as number[];
    if (tick < 0 || tick > MATCH_TICKS || tick < last) return "input ticks out of order";
    if (idx !== 0) return "only the human fighter (idx 0) records inputs";
    // aim column = aim (0..4095) + 4096 * q, q = quantised grenade distance 0..401 (src/sim/record.ts)
    if (Math.abs(mx) > 1000 || Math.abs(my) > 1000 || aim < 0 || aim >= 4096 * 402 || (fire !== 0 && fire !== 1)) return "input out of range";
    last = tick;
  }
  return null;
}

/**
 * Our own replay that also collects kills and the bounty killer from the simulation's events.
 * Mirrors replayRecord in src/sim/record.ts (inputs apply from their tick; the aim column packs
 * aimDist); the caller only trusts it when its hash equals replayRecord's.
 */
export function detailedReplay(cfg: MatchConfig, inputs: MatchRecord["inputs"]) {
  const m = createMatch(cfg);
  const rows = [...inputs].sort((a, b) => a[0] - b[0]);
  const cur = new Map<number, Input>();
  cfg.fighters.forEach((f, i) => f.human && cur.set(i, { mx: 0, my: 0, aim: 0, fire: false }));
  let k = 0;
  let bountyKiller: number | null = null;
  while (!m.state.over && m.state.tick < MATCH_TICKS) {
    while (k < rows.length && rows[k][0] <= m.state.tick) {
      const [, idx, mx, my, packed, fire] = rows[k++];
      const q = Math.floor(packed / 4096);
      const inp: Input = { mx, my, aim: packed - q * 4096, fire: fire === 1 };
      if (q > 0) inp.aimDist = (q - 1) * 100;
      cur.set(idx, inp);
    }
    for (const e of m.step(cur)) if (e.t === "bounty") bountyKiller = e.by;
  }
  return { hash: m.hash(), kills: m.state.fighters.map((f) => f.kills), bountyKiller };
}

export function judge(chain: ChainMatch, record: MatchRecord, replay: Replayer = replayRecord): Verdict {
  const t0 = performance.now();
  if (!record || record.version !== 1) return { ok: false, status: 400, reason: "unsupported record version" };
  if (chain.status && chain.status !== "Pending") return { ok: false, status: 409, reason: "match already settled" };
  if (!chain.seed) return { ok: false, status: 409, reason: "match seed not fixed yet" };
  const bad = checkInputs(record.inputs);
  if (bad) return { ok: false, status: 400, reason: bad };
  const you = record.cfg?.fighters?.[0];
  let cfg: MatchConfig;
  try {
    cfg = matchConfigFromChain(chain, { name: you?.name, skin: you?.upgrades?.skin });
  } catch (e) {
    return { ok: false, status: 409, reason: (e as Error).message };
  }
  const diff = record.cfg ? configDiff(cfg, record.cfg) : "cfg";
  if (diff) return { ok: false, status: 409, reason: `record does not match the on-chain match (${diff})` };

  const r = replay(cfg, record.inputs);
  if (r.hash !== record.hash) return { ok: false, status: 409, reason: "replay mismatch: the server's simulation disagrees with this record" };
  if (!Array.isArray(r.placements) || r.placements.length !== FIGHTERS) return { ok: false, status: 500, reason: "simulation returned bad placements" };

  let kills: number[] = new Array(FIGHTERS).fill(0);
  let bountyKiller: number | null = null;
  let killsFrom: "replay" | "detailed" | "none" = "none";
  if (Array.isArray(r.kills) && r.kills.length === FIGHTERS) {
    kills = r.kills;
    bountyKiller = r.bountyKiller ?? null;
    killsFrom = "replay";
  } else {
    const d = detailedReplay(cfg, record.inputs);
    if (d.hash === r.hash) {
      kills = d.kills;
      bountyKiller = d.bountyKiller;
      killsFrom = "detailed";
    }
  }
  const clamp = (x: number) => Math.max(0, Math.min(FIGHTERS, Math.trunc(x) || 0));
  const placements = r.placements.map(clamp);
  // the contract rejects impossible kill totals; trust the sim but keep it within the rules
  kills = kills.map(clamp);
  while (kills.reduce((a, b) => a + b, 0) >= FIGHTERS) kills[kills.indexOf(Math.max(...kills))]--;
  if (bountyKiller !== null && (bountyKiller < 0 || bountyKiller >= FIGHTERS)) bountyKiller = null;

  return {
    ok: true,
    winner: r.winner,
    ms: Math.round(performance.now() - t0),
    killsFrom,
    args: {
      match_id: String(chain.match_id ?? chain.id),
      placements,
      kills,
      bounty_killer: bountyKiller,
      input_log_hash: inputLogHash(record.inputs),
      result_hash: r.hash,
    },
  };
}
