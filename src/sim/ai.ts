// STUB — agent B replaces. Deterministic bot brain: same match state -> same Input.
import type { Input, Match } from "./types";
export function botInput(match: Match, idx: number): Input {
  const f = match.state.fighters[idx];
  return { mx: 0, my: 0, aim: f.aim, fire: false };
}
