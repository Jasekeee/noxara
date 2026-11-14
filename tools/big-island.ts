// Big Island QA: N bot-only matches on cfg.map = "big" — pacing (length, kills, first contact, quiet
// stretches) and the stuck check (a bot that stays within 2 u for > 10 s while trying to move).
//   node tools/big-island.ts [matches=50] [--from 1] [--std]   (--std: the same report for the standard island)
// Exit 1 if any bot got stuck, a match had no winner, or a match hit the clock.
import "./ts-resolve.ts";

const args = process.argv.slice(2);
const N = Number(args.find((a) => !a.startsWith("--")) ?? 50);
const fi = args.indexOf("--from");
const from = fi >= 0 ? Number(args[fi + 1]) : 1;
const { pacingReport } = await import("../src/sim/headless.ts");
const { botOnlyRoster } = await import("../src/sim/roster.ts");
const { BIG_MATCH_TICKS } = await import("../src/sim/rules.ts");

const s = (t: number) => t / 20;
const rows: ReturnType<typeof pacingReport>[] = [];
let ms = 0;
for (let k = 0; k < N; k++) {
  const t0 = performance.now();
  rows.push(pacingReport(args.includes("--std") ? { seed: from + k, fighters: botOnlyRoster() } : { seed: from + k, fighters: botOnlyRoster(), map: "big" }));
  ms += performance.now() - t0;
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const med = (xs: number[]) => sorted(xs)[Math.floor(xs.length / 2)];
const len = rows.map((r) => s(r.ticks));
const stuck = rows.flatMap((r) => r.stuck.map((x) => ({ seed: r.seed, ...x })));
const clock = rows.filter((r) => r.ticks >= BIG_MATCH_TICKS).length;
const noWin = rows.filter((r) => r.winner === null).length;
// kill timeline: deaths per minute bucket
const perMin = new Array(11).fill(0);
for (const r of rows) for (const t of r.deathTicks) perMin[Math.min(10, Math.floor(s(t) / 60))]++;
console.log(`Big Island: ${N} bot-only matches (seeds ${from}..${from + N - 1}), ${(ms / N).toFixed(0)} ms/match`);
console.log(`  length   mean ${avg(len).toFixed(0)} s, median ${med(len).toFixed(0)} s, min ${sorted(len)[0].toFixed(0)} s, max ${sorted(len)[len.length - 1].toFixed(0)} s`);
console.log(`  kills    mean ${avg(rows.map((r) => r.kills)).toFixed(1)} by fighters, ${avg(rows.map((r) => r.stormDeaths)).toFixed(1)} storm deaths`);
const fc = rows.map((r) => s(r.firstContact)).filter((x) => x >= 0);
console.log(`  first contact (first damage between fighters) mean ${avg(fc).toFixed(0)} s, median ${med(fc).toFixed(0)} s`);
console.log(`  longest quiet stretch (no fighter damage) mean ${avg(rows.map((r) => s(r.longestQuiet))).toFixed(0)} s, max ${Math.max(...rows.map((r) => s(r.longestQuiet))).toFixed(0)} s`);
const ff = rows.flatMap((r) => r.firstFight.filter((x) => x >= 0).map(s));
const qa = rows.flatMap((r) => r.quietAlive.map(s));
console.log(`  per fighter: first fight mean ${avg(ff).toFixed(0)} s, median ${med(ff).toFixed(0)} s; longest quiet stretch while alive mean ${avg(qa).toFixed(0)} s, median ${med(qa).toFixed(0)} s, 90th pct ${sorted(qa)[Math.floor(qa.length * 0.9)].toFixed(0)} s`);
const lifeMin = rows.flatMap((r) => r.deathTicks.map(s));
console.log(`  time alive of the fallen: median ${med(lifeMin).toFixed(0)} s`);
console.log(`  deaths per minute (avg per match): ${perMin.map((v, i) => `${i}-${i + 1}m ${(v / N).toFixed(1)}`).join(" · ")}`);
console.log(`  finished by clock ${clock}, no winner ${noWin}`);
console.log(`  stuck bots: ${stuck.length}${stuck.length ? " — " + stuck.slice(0, 10).map((x) => `seed ${x.seed} #${x.idx} @${s(x.tick)}s (${(x.x / 1000).toFixed(1)},${(x.y / 1000).toFixed(1)}) ${x.mode}`).join("; ") : ""}`);
const ok = stuck.length === 0 && clock === 0 && noWin === 0;
console.log(ok ? "PASS" : "FAIL");
process.exitCode = ok ? 0 : 1;
