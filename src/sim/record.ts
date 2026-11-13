// Recording human inputs and replaying a match from its record (agent B).
// Convention: push(match.state.tick /* read BEFORE match.step() */, idx, input) for every human input
// you pass to step(). Only changes are stored. Replay feeds each recorded input from its tick until the
// next change for that idx, so the replayed match is bit-identical (same hash()).
import { MATCH_TICKS, type Input, type MatchConfig, type MatchRecord } from "./types.ts";
import { createMatch } from "./match.ts";

const norm = (v: number) => Math.trunc(v) || 0;

export class Recorder {
  readonly inputs: MatchRecord["inputs"] = [];
  private last = new Map<number, string>();
  push(tick: number, idx: number, i: Input) {
    const row: [number, number, number, number, number, number] = [norm(tick), idx, norm(i.mx), norm(i.my), norm(i.aim), i.fire ? 1 : 0];
    const k = `${row[2]},${row[3]},${row[4]},${row[5]}`;
    if (this.last.get(idx) === k) return;
    this.last.set(idx, k);
    this.inputs.push(row);
  }
}

export function replayRecord(
  cfg: MatchConfig,
  inputs: MatchRecord["inputs"],
): { hash: string; winner: number | null; placements: number[] } {
  const m = createMatch(cfg);
  const rows = [...inputs].sort((a, b) => a[0] - b[0]); // stable: keeps push order within a tick
  const cur = new Map<number, Input>();
  for (let i = 0; i < cfg.fighters.length; i++) if (cfg.fighters[i].human) cur.set(i, { mx: 0, my: 0, aim: 0, fire: false });
  let k = 0;
  while (!m.state.over && m.state.tick < MATCH_TICKS) {
    while (k < rows.length && rows[k][0] <= m.state.tick) {
      const [, idx, mx, my, aim, fire] = rows[k++];
      cur.set(idx, { mx, my, aim, fire: fire === 1 });
    }
    m.step(cur);
  }
  return { hash: m.hash(), winner: m.state.winner, placements: m.state.fighters.map((f) => f.placement) };
}
