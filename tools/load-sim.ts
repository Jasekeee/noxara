// Loads the simulation modules from plain Node (see ts-resolve.ts for why this is dynamic).
import "./ts-resolve.ts";
import type { Sim } from "./simlib.ts";

export async function loadSim(): Promise<Sim> {
  const [match, ai, record, roster] = await Promise.all([
    import("../src/sim/match.ts"),
    import("../src/sim/ai.ts"),
    import("../src/sim/record.ts"),
    import("../src/sim/roster.ts"),
  ]);
  return {
    createMatch: match.createMatch,
    botInput: ai.botInput,
    Recorder: record.Recorder,
    replayRecord: record.replayRecord,
    t1Roster: roster.t1Roster,
  };
}
