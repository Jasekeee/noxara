// STUB — agent B replaces. Recording human inputs and replaying a match from its record.
import type { Input, MatchConfig, MatchRecord } from "./types";
import { createMatch } from "./match";

export class Recorder {
  readonly inputs: MatchRecord["inputs"] = [];
  private last = new Map<number, string>();
  push(tick: number, idx: number, i: Input) {
    const k = `${i.mx},${i.my},${i.aim},${i.fire ? 1 : 0}`;
    if (this.last.get(idx) === k) return;
    this.last.set(idx, k);
    this.inputs.push([tick, idx, i.mx, i.my, i.aim, i.fire ? 1 : 0]);
  }
}

export function replayRecord(cfg: MatchConfig, inputs: MatchRecord["inputs"]): { hash: string; winner: number | null; placements: number[] } {
  const m = createMatch(cfg);
  void inputs;
  return { hash: m.hash(), winner: m.state.winner, placements: m.state.fighters.map((f) => f.placement) };
}
