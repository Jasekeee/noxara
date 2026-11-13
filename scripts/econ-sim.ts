// Simulates the royale contract's bot economy (mirrors contracts/royale/src/lib.rs) over N matches with
// the real win distribution from docs/balance.json, to tune the constants.
//
//   node scripts/econ-sim.ts [--matches 200] [--runs 400] [--entry 5] [--topup 15] ... [--curve]
//
// Outcome model [assumed]: winner drawn by per-fighter win rate of its personality (balance.json),
// multiplied by (1 + UPGRADE_EDGE * (weaponTier + armor)); the human is a guest with HUMAN_WIN %.
// The bounty carrier, if it didn't win, is killed by another fighter with BOUNTY_KILL_P (else the storm).
import fs from "node:fs";
import path from "node:path";

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};

// ---- contract constants (keep in sync with lib.rs) -------------------------------------------
export const C = {
  ENTRY: arg("entry", 5),
  TOP_UP: arg("topup", 15),
  BURN_BPS: 200,
  HOUSE_BPS: 500,
  BOUNTY_BPS: arg("bounty-bps", 1500),
  STARTER: arg("starter", 100),
  HOUSE_GENESIS: 2000,
  RESERVE: arg("reserve", 50),
  WEAPON: [arg("w1", 60), arg("w2", 120)],
  ARMOR: [arg("a1", 90), arg("a2", 180)],
  SKIN: arg("skin", 150),
};
const N = arg("matches", 200);
const RUNS = arg("runs", 400);
const HUMAN_WIN = arg("human-win", 8) / 100;
const UPGRADE_EDGE = arg("edge", 0.12);
const BOUNTY_KILL_P = 0.75;

const balance = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../docs/balance.json"), "utf8")) as {
  perPersonality: { personality: string; winRatePerFighter: number }[];
};
const RATE: Record<string, number> = Object.fromEntries(balance.perPersonality.map((p) => [p.personality, p.winRatePerFighter]));
const GENESIS = ["aggressive", "camper", "sniper", "looter", "coward", "balanced", "aggressive", "camper", "balanced"];
const PERS = ["aggressive", "camper", "sniper", "looter", "coward", "balanced"];

type Bot = { p: string; bal: number; w: number; a: number; matches: number; gen: number };

// small deterministic PRNG (mulberry32)
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(seed: number) {
  const r = rng(seed);
  const pick = (w: number[]) => {
    let x = r() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < w.length; i++) if ((x -= w[i]) < 0) return i;
    return w.length - 1;
  };
  let house = C.HOUSE_GENESIS;
  const bots: Bot[] = GENESIS.map((p) => ({ p, bal: C.STARTER, w: 0, a: 0, matches: 0, gen: 0 }));
  let retirements = 0;
  let firstTier2: number | null = null;
  let firstUpgrade: number | null = null;
  let upgrades = 0;
  const curve: { m: number; house: number; total: number; maxBal: number; retired: number; upgrades: number }[] = [];
  const rookie = (s: number) => {
    retirements++;
    const g = Math.min(C.STARTER, house);
    house -= g;
    bots[s] = { p: PERS[Math.floor(r() * 6)], bal: g, w: 0, a: 0, matches: 0, gen: bots[s].gen + 1 };
  };
  for (let m = 1; m <= N; m++) {
    // start
    let pot = 0;
    for (let s = 0; s < 9; s++) {
      if (bots[s].bal < C.ENTRY && bots[s].matches > 0) rookie(s);
      const paid = Math.min(C.ENTRY, bots[s].bal);
      bots[s].bal -= paid;
      pot += paid;
    }
    let carrier = 0;
    for (let s = 1; s < 9; s++) if (bots[s].bal > bots[carrier].bal) carrier = s;
    // outcome: idx 0 = guest human, 1..9 = slots
    const botW = bots.map((b) => (RATE[b.p] ?? 10) * (1 + UPGRADE_EDGE * (b.w + b.a)));
    const sum = botW.reduce((a, b) => a + b, 0);
    const weights = [HUMAN_WIN * sum / (1 - HUMAN_WIN), ...botW];
    const winner = pick(weights);
    // settle
    pot += C.TOP_UP;
    const burn = (pot * C.BURN_BPS) / 10_000;
    const cut = (pot * C.HOUSE_BPS) / 10_000;
    const prize = pot - burn - cut;
    house += cut;
    if (winner === 0) house += prize;
    else bots[winner - 1].bal += prize;
    if (winner !== carrier + 1 && r() < BOUNTY_KILL_P) {
      const others = weights.map((w, i) => (i === carrier + 1 ? 0 : w));
      const killer = pick(others);
      const amt = (bots[carrier].bal * C.BOUNTY_BPS) / 10_000;
      bots[carrier].bal -= amt;
      if (killer === 0) house += amt;
      else bots[killer - 1].bal += amt;
    }
    for (const b of bots) b.matches++;
    // economy
    for (let s = 0; s < 9; s++) {
      const b = bots[s];
      const price = b.w < 2 ? C.WEAPON[b.w] : b.a < 2 ? C.ARMOR[b.a] : C.SKIN;
      if (b.bal >= price + C.RESERVE) {
        b.bal -= price;
        house += price;
        upgrades++;
        firstUpgrade ??= m;
        if (b.w < 2) b.w++;
        else if (b.a < 2) b.a++;
        if (b.w === 2 && firstTier2 === null) firstTier2 = m;
      }
      if (b.bal < C.ENTRY) rookie(s);
    }
    curve.push({ m, house, total: house + bots.reduce((a, b) => a + b.bal, 0), maxBal: Math.max(...bots.map((b) => b.bal)), retired: retirements, upgrades });
  }
  return { retirements, firstTier2, firstUpgrade, upgrades, house, curve, bots };
}

const results = Array.from({ length: RUNS }, (_, i) => run(i + 1));
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const ret = results.map((x) => x.retirements);
const t2 = results.map((x) => x.firstTier2 ?? Infinity);
console.log(JSON.stringify(C));
console.log(`${RUNS} runs x ${N} matches (human = guest winning ${HUMAN_WIN * 100}%, upgrade edge ${UPGRADE_EDGE}/tier)`);
console.log(`retirements: median ${med(ret)} (= 1 per ${(N / Math.max(1, med(ret))).toFixed(1)} matches), p10 ${med(ret.slice().sort((a, b) => a - b).slice(0, RUNS / 5))}, max ${Math.max(...ret)}`);
console.log(`first upgrade: median match ${med(results.map((x) => x.firstUpgrade ?? Infinity))}; first weapon tier 2: median match ${med(t2)}, by match 20 in ${((t2.filter((x) => x <= 20).length / RUNS) * 100).toFixed(0)}% of runs`);
console.log(`upgrades bought: median ${med(results.map((x) => x.upgrades))}; house at end: median ${med(results.map((x) => x.house)).toFixed(0)}, min ${Math.min(...results.map((x) => x.house)).toFixed(0)}`);
if (process.argv.includes("--curve")) {
  const c = results[0].curve;
  console.log("run 1 curve (every 20 matches): match, house, total supply, richest bot, retirements, upgrades");
  for (const p of c.filter((p) => p.m % 20 === 0)) console.log(`${String(p.m).padStart(4)} ${p.house.toFixed(0).padStart(6)} ${p.total.toFixed(0).padStart(6)} ${p.maxBal.toFixed(0).padStart(6)} ${String(p.retired).padStart(4)} ${String(p.upgrades).padStart(4)}`);
  console.log("final bots:", results[0].bots.map((b) => `${b.p}:${b.bal.toFixed(0)} w${b.w}a${b.a} g${b.gen}`).join("  "));
}
