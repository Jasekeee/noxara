// Plays one recorded match with a deterministic scripted human (idx 0) and writes a MatchRecord.
//   node tools/make-record.ts [out=matches/demo-1.json] [--seed 1] [--autoplay] [--big]
// --autoplay drives the human with botInput (like the client's ?autoplay) instead of the script.
// --big plays it on Big Island (cfg.map = "big").
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MatchConfig } from "../src/sim/types.ts";
import { loadSim } from "./load-sim.ts";
import { runMatch, scriptedInput, toRecord } from "./simlib.ts";

const args = process.argv.slice(2);
const si = args.indexOf("--seed");
const seed = si >= 0 ? Number(args[si + 1]) : 1;
const autoplay = args.includes("--autoplay");
const out = args.find((a, i) => !a.startsWith("--") && (si < 0 || i !== si + 1)) ?? "matches/demo-1.json";

const sim = await loadSim();
const cfg: MatchConfig = { seed, fighters: sim.t1Roster(), ...(args.includes("--big") ? { map: "big" as const } : {}) };
const rec = new sim.Recorder();
const run = runMatch(sim.createMatch(cfg), { recorder: rec, human: autoplay ? sim.botInput : scriptedInput });
const record = toRecord(cfg, rec.inputs, run);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(record) + "\n");
console.log(
  `wrote ${out}: seed ${seed}, ${run.ticks} ticks, over=${run.over}, winner=${run.winner}, ` +
    `you placed ${run.placements[0] || "-"}, ${rec.inputs.length} input changes, hash ${run.hash}`,
);
if (!run.over) console.log("NOTE: match did not finish within MATCH_TICKS (stub sim?) — record written anyway.");

const replay = sim.replayRecord(cfg, rec.inputs);
const same = replay.hash === run.hash;
console.log(same ? "self-check: replay hash matches" : `self-check: replay hash DIFFERS (${replay.hash}) — verify-match will FAIL`);
process.exitCode = same ? 0 : 1;
