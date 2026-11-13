// Simulates the royale contract's bot economy (mirrors contracts/royale/src/lib.rs) over N matches with
// the real win distribution from docs/balance.json, to tune the constants.
//
//   node scripts/econ-sim.ts [--matches 200] [--runs 400] [--entry 4] [--topup 30] ... [--curve]  (defaults = lib.rs)
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
  ENTRY: arg("entry", 4),
  WEALTH_BPS: arg("wealth-bps", 200),
  MAX_ENTRY: arg("max-entry", 16),
  TOP_UP: arg("topup", 30),
  BURN_BPS: 200,
  HOUSE_BPS: 500,
  BOUNTY_BPS: arg("bounty-bps", 1500),
  SPONSOR_CUT: arg("sponsor-cut", 0.1),
  STARTER: arg("starter", 100),
  HOUSE_GENESIS: 2000,
  HOUSE_FLOOR: arg("house-floor", 1000),
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
const SPONSORS = !process.argv.includes("--no-sponsors");
const TAX_TO_HOUSE = process.argv.includes("--tax-to-house"); // contract: everything goes to the pot
const SPONSOR_EVERY = arg("sponsor-every", 4);

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

type Stake = { who: number; shares: number; staked: number; earned: number; since: number; holdUntil: number };
type Pool = { t: number; stakes: Stake[] };
type Closed = { staked: number; back: number; lost: boolean };

const entryFor = (bal: number) => Math.min(C.MAX_ENTRY, C.ENTRY + (Math.max(0, bal - C.RESERVE) * C.WEALTH_BPS) / 10_000);

function run(seed: number) {
  const r = rng(seed);
  const pick = (w: number[]) => {
    let x = r() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < w.length; i++) if ((x -= w[i]) < 0) return i;
    return w.length - 1;
  };
  let house = C.HOUSE_GENESIS;
  const bots: Bot[] = GENESIS.map((p) => ({ p, bal: C.STARTER, w: 0, a: 0, matches: 0, gen: 0 }));
  const pools: Pool[] = bots.map(() => ({ t: 0, stakes: [] }));
  const closed: Closed[] = [];
  let retirements = 0;
  let firstTier2: number | null = null;
  let firstUpgrade: number | null = null;
  let upgrades = 0;
  const curve: { m: number; house: number; total: number; maxBal: number; retired: number; upgrades: number }[] = [];
  const closePool = (s: number, lost: boolean) => {
    const p = pools[s];
    for (const st of p.stakes) {
      const back = p.t > 0 ? (st.shares * bots[s].bal) / p.t : 0;
      bots[s].bal -= back;
      closed.push({ staked: st.staked, back: back + st.earned, lost });
    }
    pools[s] = { t: 0, stakes: [] };
  };
  const rookie = (s: number) => {
    retirements++;
    closePool(s, true);
    const g = Math.min(C.STARTER, Math.max(0, house - C.HOUSE_FLOOR));
    house -= g;
    bots[s] = { p: PERS[Math.floor(r() * 6)], bal: g, w: 0, a: 0, matches: 0, gen: bots[s].gen + 1 };
  };
  // the contract: 30% of every prize/bounty a sponsored bot collects goes to its sponsors, by shares
  const dividends = (s: number, amount: number) => {
    const p = pools[s];
    const sp = p.stakes.reduce((a, x) => a + x.shares, 0);
    if (!sp) return;
    const total = Math.min(bots[s].bal, amount * C.SPONSOR_CUT);
    for (const st of p.stakes) st.earned += (total * st.shares) / sp;
    bots[s].bal -= total;
  };
  for (let m = 1; m <= N; m++) {
    // sponsors [assumed]: every SPONSOR_EVERY matches a player backs the bot with the most wins so far
    // (or a random one), up to the 30% cap; they hold 5-30 matches then withdraw
    if (SPONSORS && m % SPONSOR_EVERY === 0) {
      const s = r() < 0.6 ? bots.reduce((best, b, i) => (b.matches > 0 && b.bal > bots[best].bal ? i : best), 0) : Math.floor(r() * 9);
      const p = pools[s];
      if (p.t === 0) p.t = bots[s].bal;
      const sp = p.stakes.reduce((a, x) => a + x.shares, 0);
      const amt = 20;
      const shares = (amt * p.t) / bots[s].bal;
      if ((sp + shares) / (p.t + shares) <= 0.3) {
        p.stakes.push({ who: m, shares, staked: amt, earned: 0, since: bots[s].matches, holdUntil: bots[s].matches + 5 + Math.floor(r() * 25) });
        p.t += shares;
        bots[s].bal += amt;
      }
    }
    // start
    let pot = 0;
    for (let s = 0; s < 9; s++) {
      // retire only when the house can fund the successor (else the broke bot keeps its slot)
      if (bots[s].bal < C.ENTRY && bots[s].matches > 0 && house >= C.HOUSE_FLOOR + C.STARTER) rookie(s);
      const paid = Math.min(entryFor(bots[s].bal), bots[s].bal);
      bots[s].bal -= paid;
      // the wealth part of the entry goes to the house (a tax), the base part into the pot
      const base = Math.min(paid, C.ENTRY);
      pot += TAX_TO_HOUSE ? base : paid;
      if (TAX_TO_HOUSE) house += paid - base;
    }
    let carrier = 0;
    for (let s = 1; s < 9; s++) if (bots[s].bal > bots[carrier].bal) carrier = s;
    // outcome: idx 0 = guest human, 1..9 = slots
    const botW = bots.map((b) => (RATE[b.p] ?? 10) * (1 + UPGRADE_EDGE * (b.w + b.a)));
    const sum = botW.reduce((a, b) => a + b, 0);
    const weights = [HUMAN_WIN * sum / (1 - HUMAN_WIN), ...botW];
    const winner = pick(weights);
    // settle: the house pays the top-up while it's above its floor, else it is minted
    if (house >= C.HOUSE_FLOOR + C.TOP_UP) house -= C.TOP_UP;
    pot += C.TOP_UP;
    const burn = (pot * C.BURN_BPS) / 10_000;
    const cut = (pot * C.HOUSE_BPS) / 10_000;
    const prize = pot - burn - cut;
    house += cut;
    if (winner === 0) house += prize;
    else {
      bots[winner - 1].bal += prize;
      // the human is a guest: a free match, so sponsors only share the bots' entries part of the prize
      dividends(winner - 1, (prize * (pot - C.TOP_UP)) / pot);
    }
    if (winner !== carrier + 1 && r() < BOUNTY_KILL_P) {
      const others = weights.map((w, i) => (i === carrier + 1 ? 0 : w));
      const killer = pick(others);
      const amt = (bots[carrier].bal * C.BOUNTY_BPS) / 10_000;
      bots[carrier].bal -= amt;
      if (killer === 0) house += amt;
      else {
        bots[killer - 1].bal += amt;
        dividends(killer - 1, amt);
      }
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
      if (b.bal < C.ENTRY && b.matches > 0 && house >= C.HOUSE_FLOOR + C.STARTER) rookie(s);
      // sponsors whose holding time is up withdraw the stake's current value
      const p = pools[s];
      for (const st of [...p.stakes]) {
        if (b.matches >= st.holdUntil) {
          const back = (st.shares * b.bal) / p.t;
          b.bal -= back;
          p.t -= st.shares;
          p.stakes.splice(p.stakes.indexOf(st), 1);
          closed.push({ staked: st.staked, back: back + st.earned, lost: false });
        }
      }
    }
    curve.push({ m, house, total: house + bots.reduce((a, b) => a + b.bal, 0), maxBal: Math.max(...bots.map((b) => b.bal)), retired: retirements, upgrades });
  }
  return { retirements, firstTier2, firstUpgrade, upgrades, house, curve, bots, closed };
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
const topShare = results.map((x) => Math.max(...x.bots.map((b) => b.bal)) / x.bots.reduce((a, b) => a + b.bal, 0));
console.log(`richest bot's share of all bot wealth at the end: median ${(med(topShare) * 100).toFixed(0)}% (equal = 11%)`);
console.log(`upgrades bought: median ${med(results.map((x) => x.upgrades))}; house at end: median ${med(results.map((x) => x.house)).toFixed(0)}, min ${Math.min(...results.map((x) => x.house)).toFixed(0)}`);
if (SPONSORS) {
  const all = results.flatMap((x) => x.closed);
  const roi = all.map((c) => (c.back - c.staked) / c.staked);
  const lost = all.filter((c) => c.lost);
  console.log(
    `sponsorships (a 20-$BOUNTY stake every ${SPONSOR_EVERY} matches): ${all.length} closed, profitable ${((all.filter((c) => c.back > c.staked).length / all.length) * 100).toFixed(0)}%, median ROI ${(med(roi) * 100).toFixed(0)}%, lost to retirement ${((lost.length / all.length) * 100).toFixed(0)}% (median ROI there ${(med(lost.map((c) => (c.back - c.staked) / c.staked)) * 100).toFixed(0)}%)`,
  );
}
if (process.argv.includes("--curve")) {
  const c = results[0].curve;
  console.log("run 1 curve (every 20 matches): match, house, total supply, richest bot, retirements, upgrades");
  for (const p of c.filter((p) => p.m % 20 === 0)) console.log(`${String(p.m).padStart(4)} ${p.house.toFixed(0).padStart(6)} ${p.total.toFixed(0).padStart(6)} ${p.maxBal.toFixed(0).padStart(6)} ${String(p.retired).padStart(4)} ${String(p.upgrades).padStart(4)}`);
  console.log("final bots:", results[0].bots.map((b) => `${b.p}:${b.bal.toFixed(0)} w${b.w}a${b.a} g${b.gen}`).join("  "));
}
