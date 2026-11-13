// Re-runs a stored match from its input log and checks the result.
//   npm run verify-match <file-or-id>      (id → matches/<id>.json)
// Exit 0 = PASS, 1 = mismatch, 2 = usage / unreadable record.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MatchRecord } from "../src/sim/types.ts";
import { loadSim } from "./load-sim.ts";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: npm run verify-match <path/to/record.json | match-id>");
  process.exit(2);
}
const candidates = [arg, join("matches", `${arg}.json`), join("matches", arg)];
const file = candidates.find((p) => existsSync(p));
if (!file) {
  console.error(`no match record found (tried ${candidates.join(", ")})`);
  process.exit(2);
}

let rec: MatchRecord;
try {
  rec = JSON.parse(readFileSync(file, "utf8")) as MatchRecord;
} catch (e) {
  console.error(`cannot parse ${file}: ${(e as Error).message}`);
  process.exit(2);
}
if (rec.version !== 1 || !rec.cfg || !Array.isArray(rec.inputs) || typeof rec.hash !== "string") {
  console.error(`${file} is not a MatchRecord v1`);
  process.exit(2);
}

const { replayRecord } = await loadSim();
const t0 = performance.now();
const got = replayRecord(rec.cfg, rec.inputs);
const ms = performance.now() - t0;

const checks: [string, unknown, unknown][] = [
  ["hash", rec.hash, got.hash],
  ["winner", rec.winner, got.winner],
  ["placements", JSON.stringify(rec.placements), JSON.stringify(got.placements)],
];
console.log(`match ${file}: seed ${rec.cfg.seed}, ${rec.inputs.length} input changes, replayed in ${ms.toFixed(0)} ms`);
let ok = true;
for (const [name, want, have] of checks) {
  const same = want === have;
  ok &&= same;
  console.log(`  ${same ? "ok  " : "DIFF"} ${name.padEnd(10)} stored ${String(want)}${same ? "" : `  recomputed ${String(have)}`}`);
}
console.log(ok ? "PASS result reproduced from the input log" : "FAIL replay does not match the stored result");
process.exitCode = ok ? 0 : 1;
