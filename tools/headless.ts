// Balance sim: N bot-only matches (seeds from..from+N-1), all 10 fighters driven by the sim's AI.
//   node tools/headless.ts [matches=1000] [--json docs/balance.json] [--from 1] [--p0 balanced]
// Exit code 1 when a FAIL line is printed (a personality wins >40% of matches, or a match does not
// finish within MATCH_TICKS).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Personality } from "../src/sim/types.ts";
import { MATCH_TICKS, TICK_HZ } from "../src/sim/types.ts";
import { loadSim } from "./load-sim.ts";
import { PERSONALITIES, botRoster, runMatch } from "./simlib.ts";

const MAX_WIN_SHARE = 0.4;

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const flagged = new Set<number>();
for (const f of ["--json", "--from", "--p0"]) {
  const i = args.indexOf(f);
  if (i >= 0) flagged.add(i).add(i + 1);
}
const positional = args.filter((_, i) => !flagged.has(i));
const N = Number(positional[0] ?? 1000);
const from = Number(flag("--from") ?? 1);
const p0 = (flag("--p0") ?? "balanced") as Personality;
const jsonPath = flag("--json");
if (!Number.isInteger(N) || N < 1 || !Number.isInteger(from) || !PERSONALITIES.includes(p0)) {
  console.error("usage: node tools/headless.ts [matches=1000] [--json out.json] [--from 1] [--p0 personality]");
  process.exit(2);
}

const sim = await loadSim();
const roster = botRoster(sim, p0);

interface PStat { slots: number; wins: number; kills: number }
const per = new Map<Personality, PStat>();
for (const f of roster) if (!per.has(f.personality)) per.set(f.personality, { slots: 0, wins: 0, kills: 0 });

let finished = 0, byClock = 0, deaths = 0, stormDeaths = 0, lengthTicks = 0, noWinner = 0;
const unfinished: number[] = [];
const t0 = performance.now();
for (let k = 0; k < N; k++) {
  const seed = from + k;
  const cfg = { seed, fighters: botRoster(sim, p0) };
  const run = runMatch(sim.createMatch(cfg), { humans: [] });
  cfg.fighters.forEach((f, i) => {
    const p = per.get(f.personality)!;
    p.slots++;
    p.kills += run.kills[i];
  });
  deaths += run.deaths;
  stormDeaths += run.stormDeaths;
  if (!run.over) {
    unfinished.push(seed);
    continue;
  }
  finished++;
  lengthTicks += run.ticks;
  if (run.endedByClock) byClock++;
  if (run.winner === null) noWinner++;
  else per.get(cfg.fighters[run.winner].personality)!.wins++;
  if (N >= 200 && (k + 1) % Math.floor(N / 10) === 0) console.log(`  … ${k + 1}/${N}`);
}
const secs = (performance.now() - t0) / 1000;

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : 0);
const rows = [...per.entries()].map(([personality, s]) => ({
  personality,
  fighters: s.slots / N, // fighters of this personality per match
  wins: s.wins,
  winShare: pct(s.wins, finished), // % of finished matches won by this personality
  winRatePerFighter: pct(s.wins, s.slots), // fair share is 10 %
  avgKills: s.slots ? s.kills / s.slots : 0, // per fighter per match
}));

const fails: string[] = [];
for (const r of rows)
  if (r.winShare > MAX_WIN_SHARE * 100)
    fails.push(`personality "${r.personality}" wins ${r.winShare.toFixed(1)}% of matches (limit ${MAX_WIN_SHARE * 100}%)`);
if (unfinished.length)
  fails.push(
    `${unfinished.length}/${N} matches did not finish within MATCH_TICKS=${MATCH_TICKS} (seeds ${unfinished.slice(0, 8).join(", ")}${unfinished.length > 8 ? ", …" : ""})`,
  );

const summary = {
  matches: N,
  seeds: [from, from + N - 1],
  p0,
  finished,
  avgMatchSeconds: finished ? lengthTicks / finished / TICK_HZ : null,
  stormDeathsPct: pct(stormDeaths, deaths),
  endedByClockPct: pct(byClock, finished),
  noWinner,
  matchesPerSecond: N / secs,
  perPersonality: rows,
  fails,
};

console.log(`\nBOUNTY ROYALE balance sim — ${N} bot-only matches, seeds ${from}..${from + N - 1}, idx0 = ${p0}`);
console.log("personality   fighters/match  wins  win share  win/fighter  avg kills");
for (const r of rows)
  console.log(
    `${r.personality.padEnd(13)} ${r.fighters.toFixed(1).padStart(14)} ${String(r.wins).padStart(5)} ${r.winShare.toFixed(1).padStart(9)}% ${r.winRatePerFighter.toFixed(1).padStart(10)}% ${r.avgKills.toFixed(2).padStart(10)}`,
  );
console.log(`finished             ${finished}/${N}`);
console.log(`avg match length     ${summary.avgMatchSeconds === null ? "n/a" : summary.avgMatchSeconds.toFixed(1) + " s"}`);
console.log(`storm deaths         ${summary.stormDeathsPct.toFixed(1)}% of ${deaths} deaths`);
console.log(`ended by clock       ${summary.endedByClockPct.toFixed(1)}% of finished matches`);
console.log(`speed                ${summary.matchesPerSecond.toFixed(1)} matches/s (${secs.toFixed(1)} s total)`);
if (finished === 0)
  console.log("NOTE: no match finished — src/sim/match.ts is probably still the stub (it never sets state.over).");
for (const f of fails) console.log(`FAIL ${f}`);
if (!fails.length) console.log("PASS no personality above 40% win share; every match finished in time");

if (jsonPath) {
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...summary }, null, 2) + "\n");
  console.log(`wrote ${jsonPath}`);
}
process.exitCode = fails.length ? 1 : 0;
