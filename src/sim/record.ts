// Recording human inputs and replaying a match from its record (agent B).
// Convention: push(match.state.tick /* read BEFORE match.step() */, idx, input) for every human input
// you pass to step(). Only changes are stored. Replay feeds each recorded input from its tick until the
// next change for that idx, so the replayed match is bit-identical (same hash()).
// Packing: the "aim" column holds aim (0..4095) + 4096 * q, where q = aimDistQ(input.aimDist)
// (0 = no aimDist). Old records (aim < 4096) replay unchanged. Proposal for the lead: a 7th column.
import { type Input, type MatchConfig, type MatchRecord } from "./types";
import { createMatch } from "./match";
import { aimDistQ, matchTicksFor } from "./rules";

const norm = (v: number) => Math.trunc(v) || 0;

export class Recorder {
  readonly inputs: MatchRecord["inputs"] = [];
  private last = new Map<number, string>();
  push(tick: number, idx: number, i: Input) {
    const aim = ((norm(i.aim) % 4096) + 4096) % 4096;
    const row: [number, number, number, number, number, number] = [
      norm(tick), idx, norm(i.mx), norm(i.my), aim + 4096 * aimDistQ(i.aimDist), i.fire ? 1 : 0,
    ];
    const k = `${row[2]},${row[3]},${row[4]},${row[5]}`;
    if (this.last.get(idx) === k) return;
    this.last.set(idx, k);
    this.inputs.push(row);
  }
}

export interface ReplayResult {
  hash: string;
  winner: number | null;
  placements: number[];
  /** kills by fighter idx */
  kills: number[];
  /** idx of whoever killed the bounty carrier; null if it survived or the storm got it */
  bountyKiller: number | null;
}

export function replayRecord(
  cfg: MatchConfig,
  inputs: MatchRecord["inputs"],
): ReplayResult {
  const m = createMatch(cfg);
  let bountyKiller: number | null = null;
  const rows = [...inputs].sort((a, b) => a[0] - b[0]); // stable: keeps push order within a tick
  const cur = new Map<number, Input>();
  for (let i = 0; i < cfg.fighters.length; i++) if (cfg.fighters[i].human) cur.set(i, { mx: 0, my: 0, aim: 0, fire: false });
  let k = 0;
  while (!m.state.over && m.state.tick < matchTicksFor(cfg)) {
    while (k < rows.length && rows[k][0] <= m.state.tick) {
      const [, idx, mx, my, packed, fire] = rows[k++];
      const q = Math.floor(packed / 4096);
      const inp: Input = { mx, my, aim: packed - q * 4096, fire: fire === 1 };
      if (q > 0) inp.aimDist = (q - 1) * 100;
      cur.set(idx, inp);
    }
    for (const e of m.step(cur)) if (e.t === "bounty") bountyKiller = e.by;
  }
  return {
    hash: m.hash(),
    winner: m.state.winner,
    placements: m.state.fighters.map((f) => f.placement),
    kills: m.state.fighters.map((f) => f.kills),
    bountyKiller,
  };
}
