// NOXARA economy v2 simulator: mirrors the contract's v2 rules (scripts/econ-params.json, the same numbers the
// contract asserts in its tests) over many matches, writes SVG charts + a summary, and exits non-zero unless
// every PASS criterion from docs/ECONOMY.md holds.
//
//   node scripts/econ-sim-v2.ts [--matches 10000] [--runs 20] [--seed 1] [--out docs/econ] [--quiet]
//
// Outcome model [assumed, same as scripts/econ-sim.ts]: the winner is drawn by its personality's measured win
// rate (docs/balance.json) x (1 + EDGE*(weapon+armor)); the human slot wins HUMAN_WIN of matches; a bounty
// carrier that didn't win is killed by another fighter with BOUNTY_KILL_P. Players: GUEST_P of human slots are
// guests (earn 0); the rest are signed-in players from a pool of PLAYERS (welcome credit first, then own NOX).
import fs from "node:fs";
import path from "node:path";

const argv = process.argv;
const arg = (k: string, d: number) => {
  const i = argv.indexOf(`--${k}`);
  return i > 0 ? Number(argv[i + 1]) : d;
};
const sarg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i > 0 ? argv[i + 1] : d;
};
const repo = path.join(import.meta.dirname, "..");
export const P = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "econ-params.json"), "utf8"));

const N = arg("matches", 10_000);
const RUNS = arg("runs", 20);
const SEED0 = arg("seed", 1);
const OUT = path.resolve(repo, sarg("out", "docs/econ"));
const QUIET = argv.includes("--quiet");
const HUMAN_WIN = arg("human-win", 8) / 100;
const EDGE = arg("edge", 0.12);
const BOUNTY_KILL_P = 0.75;
const GUEST_P = arg("guest-p", 70) / 100;
const PLAYERS = arg("players", 60);
const MATCHES_PER_DAY = arg("per-day", 300);
const IPO_BUY_P = arg("ipo-buy-p", 0.6); // chance players buy a rookie's IPO block (if they can afford it)
const TRADE_P = arg("trade-p", 0.05); // chance per match of one secondary share trade
const COSMETIC_P = arg("cosmetic-p", 0.02); // chance per match a rich player buys a cosmetic
const BOT_SKIN_P = 0.3; // chance a bot with maxed upgrades and spare cash buys a skin at a settle

const balance = JSON.parse(fs.readFileSync(path.join(repo, "docs/balance.json"), "utf8")) as {
  perPersonality: { personality: string; winRatePerFighter: number }[];
};
const RATE: Record<string, number> = Object.fromEntries(balance.perPersonality.map((p) => [p.personality, p.winRatePerFighter]));
const GENESIS = ["aggressive", "camper", "sniper", "looter", "coward", "balanced", "aggressive", "camper", "balanced"];
const PERS = ["aggressive", "camper", "sniper", "looter", "coward", "balanced"];

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the v2 rules (pure functions, mirrored in econ.rs)
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
/** House rule: r = house/target; m = reward multiplier; house and burn shares of the pot rise below target. */
export function houseRule(house: number) {
  // `house` here is the treasury's moving average (EMA_DIV), so a single big retirement doesn't jolt rewards
  // r = how full the treasury is between its floor (0) and its target (1); m = reward multiplier (0 at the floor,
  // 1 at target, capped at M_MAX). Below target the house keeps a bigger share of every pot and burns a bit more.
  const r = (house - P.HOUSE_FLOOR) / (P.HOUSE_TARGET - P.HOUSE_FLOOR);
  const m = clamp(r, 0, P.M_MAX_BPS / 1e4);
  const below = clamp(1 - r, 0, 1);
  const houseBps = Math.min(P.MAX_HOUSE_BPS, P.BASE_HOUSE_BPS + (P.MAX_HOUSE_BPS - P.BASE_HOUSE_BPS) * below);
  const burnBps = Math.min(P.MAX_BURN_BPS, P.BASE_BURN_BPS + (P.MAX_BURN_BPS - P.BASE_BURN_BPS) * below);
  return { r, m, houseBps, burnBps };
}
/** Deflation brake: share of every burn that really burns (the rest goes to the house). */
export const brake = (supply: number) => clamp((supply - P.S_MIN) / (P.S_TARGET - P.S_MIN), 0, 1);
export const entryFee = (bal: number) => Math.min(P.MAX_ENTRY, P.ENTRY + Math.max(0, bal - P.RESERVE) * P.WEALTH_BPS / 1e4);
/** Progressive upkeep on a bot's wallet: [threshold, bps] brackets, marginal like income tax. */
export function upkeep(bal: number) {
  let u = 0;
  const b = P.UPKEEP as [number, number][];
  for (let i = 0; i < b.length; i++) {
    const lo = b[i][0], hi = i + 1 < b.length ? b[i + 1][0] : Infinity;
    if (bal > lo) u += (Math.min(bal, hi) - lo) * b[i][1] / 1e4;
  }
  return u;
}
/** Diminishing daily rewards for a player's paid wins (index = wins already today). */
export const dailyFactor = (winsToday: number) => (winsToday < P.DAILY_FULL_WINS ? 1 : winsToday < P.DAILY_FULL_WINS + P.DAILY_HALF_WINS ? 0.5 : 0.25);

type Bot = { p: string; bal: number; w: number; a: number; skins: number; matches: number; born: number; id: number; sold: number; ipoCost: number; divs: number; hwm: number };
type RunOut = {
  portCost: number; portBack: number;
  supply: number[]; burned: number[]; house: number[]; m: number[]; gini: number[];
  lifespans: number[]; richFell: number; richN: number; rookieRose: number; rookieN: number; shareRoi: number[];
  minted: number; floorStreakMax: number; retired: number;
};

function gini(xs: number[]) {
  const v = [...xs].sort((a, b) => a - b), n = v.length, s = v.reduce((a, b) => a + b, 0);
  if (s <= 0) return 0;
  let acc = 0;
  v.forEach((x, i) => (acc += (2 * (i + 1) - n - 1) * x));
  return acc / (n * s);
}

function run(seed: number): RunOut {
  const R = rng(seed);
  let nextId = 0;
  const mk = (p: string, born: number): Bot => ({ p, bal: P.STARTER, w: 0, a: 0, skins: 0, matches: 0, born, id: nextId++, sold: 0, ipoCost: 0, divs: 0, hwm: P.STARTER });
  const bots = GENESIS.map((p) => mk(p, 0));
  let house = P.HOUSE_GENESIS;
  let burned = 0;
  const minted = 0; // v2: nothing is minted after genesis (the contract test asserts the same)
  const players = Array.from({ length: PLAYERS }, () => ({ bal: 0, credit: P.WELCOME_CREDIT, winsDay: -1, wins: 0, statDay: -1, paid: 0, top3: 0, bounty: 0, streak: 0, lastCheck: -2 }));
  /** House-paid daily rewards (check-in + quests): m-scaled, never below the floor (econ v3, daily.rs) */
  const houseReward = (pl: { bal: number }, base: number, m: number) => {
    const amt = Math.min(base * Math.min(m, 1), Math.max(0, house - P.HOUSE_FLOOR)); // m capped at 1 for dailies (audit #6)
    house -= amt;
    pl.bal += amt;
    return amt;
  };
  let dailyPaid = 0;
  const supplyOf = () => house + bots.reduce((s, b) => s + b.bal, 0) + players.reduce((s, p) => s + p.bal, 0);
  const genesis = supplyOf();
  const out: RunOut = { portCost: 0, portBack: 0, supply: [], burned: [], house: [], m: [], gini: [], lifespans: [], richFell: 0, richN: 0, rookieRose: 0, rookieN: 0, shareRoi: [], minted, floorStreakMax: 0, retired: 0 };
  let floorStreak = 0;
  let richAt2k: number[] = [];
  const rookieWatch: { id: number; until: number; rose: boolean }[] = [];
  const ipoCohorts: { bot: Bot; at: number; cost: number }[] = [];

  /** burn `x` subject to the brake; the unburnt part goes to the house */
  const burn = (x: number) => {
    const s = brake(supplyOf());
    burned += x * s;
    house += x * (1 - s);
  };
  const payBot = (b: Bot, amt: number) => { b.bal += amt; };
  /** Dividends come only from PROFIT: when the bot's wallet ends a settle above its high-water mark, holders
   *  of sold shares get DIVIDEND_BPS of the gain, pro rata to the shares they own out of SHARES_PER_BOT. */
  const dividends = (b: Bot) => {
    if (b.bal <= b.hwm) return;
    const div = (b.bal - b.hwm) * P.DIVIDEND_BPS / 1e4 * (b.sold / P.SHARES_PER_BOT);
    b.bal -= div;
    b.divs += div;
    if (div > 0) players[Math.floor(R() * PLAYERS)].bal += div;
    b.hwm = b.bal;
  };
  const ipo = (b: Bot, t: number) => {
    const cost = P.IPO_SHARES * P.IPO_PRICE_PER_SHARE_MILLI / 1000; // 30 NOX for the block
    const rich = players.filter((p) => p.bal >= cost);
    if (rich.length && R() < IPO_BUY_P) {
      const buyer = rich[Math.floor(R() * rich.length)];
      buyer.bal -= cost;
      b.bal += cost; // IPO money funds the bot's bankroll
      b.sold = P.IPO_SHARES;
      b.ipoCost = cost;
      ipoCohorts.push({ bot: b, at: t, cost });
    }
  };
  bots.forEach((b) => ipo(b, 0));

  let ema = house;
  for (let t = 0; t < N; t++) {
    const day = Math.floor(t / MATCHES_PER_DAY);
    ema += (house - ema) / P.EMA_DIV;
    const { m, houseBps, burnBps } = houseRule(ema);
    // ---- start: entries (10% of each entry burns), retirement of bots that can't pay
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      if (b.bal < entryFee(b.bal) && b.matches > 0 && house >= P.HOUSE_FLOOR + P.STARTER) {
        out.lifespans.push(b.matches);
        out.retired++;
        house += b.bal; // residual to the house; shares go to zero
        const nb = mk(PERS[Math.floor(R() * PERS.length)], t);
        house -= P.STARTER;
        bots[i] = nb;
        rookieWatch.push({ id: nb.id, until: t + 300, rose: false });
        ipo(nb, t);
      }
    }
    let pot = 0;
    for (const b of bots) {
      const prot = b.born > 0 && b.matches < P.ROOKIE_PROTECTED_MATCHES;
      const e = Math.min(b.bal, prot ? P.ENTRY : entryFee(b.bal));
      b.bal -= e;
      b.matches++;
      const eb = e * P.ENTRY_BURN_BPS / 1e4;
      burn(eb);
      pot += e - eb;
    }
    // human slot
    const guest = R() < GUEST_P;
    const pl = guest ? null : players[Math.floor(R() * PLAYERS)];
    let humanPaid = false;
    let byCredit = false;
    if (pl) {
      if (pl.credit >= P.ENTRY && house >= P.HOUSE_FLOOR + P.ENTRY) { pl.credit -= P.ENTRY; house -= P.ENTRY; humanPaid = true; byCredit = true; }
      let fee = P.ENTRY;
      if (!humanPaid) { fee = entryFee(pl.bal); if (pl.bal >= fee) { pl.bal -= fee; humanPaid = true; } }
      if (humanPaid) { const eb = fee * P.ENTRY_BURN_BPS / 1e4; burn(eb); pot += fee - eb; }
    }
    const topUp = Math.min(P.BASE_TOP_UP * m, Math.max(0, house - P.HOUSE_FLOOR));
    house -= topUp;
    pot += topUp;
    const walletPaid = !!pl && humanPaid && !byCredit;
    // ---- outcome
    const weights = bots.map((b) => (RATE[b.p] ?? 10) * (1 + EDGE * (b.w + b.a)));
    const wsum = weights.reduce((a, b) => a + b, 0);
    let winner = -1; // -1 = human
    if (R() >= HUMAN_WIN) {
      let x = R() * wsum;
      winner = 0;
      while (x > weights[winner]) x -= weights[winner++];
      winner = Math.min(winner, bots.length - 1);
    }
    // ---- settle: pot split
    const toBurn = pot * burnBps / 1e4, toHouse = pot * houseBps / 1e4, prize = pot - toBurn - toHouse;
    burn(toBurn);
    house += toHouse;
    if (winner >= 0) payBot(bots[winner], prize);
    else if (pl && humanPaid) {
      if (pl.winsDay !== day) { pl.winsDay = day; pl.wins = 0; }
      const f = dailyFactor(pl.wins++);
      pl.bal += prize * f;
      house += prize * (1 - f);
    } else house += prize; // guests earn 0
    // ---- bounty: richest bot carries it
    let carrier = -1;
    bots.forEach((b, i) => { if (!(b.born > 0 && b.matches < P.ROOKIE_PROTECTED_MATCHES) && (carrier < 0 || b.bal > bots[carrier].bal)) carrier = i; });
    if (carrier < 0) carrier = 0;
    if (winner !== carrier && R() < BOUNTY_KILL_P) {
      const amt = bots[carrier].bal * P.BOUNTY_BPS / 1e4;
      bots[carrier].bal -= amt;
      const bonus = Math.min(P.BOUNTY_BONUS * m, Math.max(0, house - P.HOUSE_FLOOR - topUp));
      house -= bonus;
      let k = Math.floor(R() * bots.length);
      if (k === carrier) k = (k + 1) % bots.length;
      if (R() < 0.1 && pl && humanPaid) pl.bal += amt + bonus; // the human took it
      else payBot(bots[k], amt + bonus);
    }
    // ---- dividends from profit, then upkeep + upgrades (one purchase per settle)
    for (const b of bots) dividends(b);
    for (const b of bots) {
      const u = b.born > 0 && b.matches < P.ROOKIE_PROTECTED_MATCHES ? 0 : upkeep(b.bal);
      if (u > 0) { b.bal -= u; house += u * P.UPKEEP_HOUSE_BPS / 1e4; burn(u * (1 - P.UPKEEP_HOUSE_BPS / 1e4)); }
      const buy = (price: number, burnBps: number) => {
        if (b.bal - price < P.RESERVE) return false;
        b.bal -= price;
        burn(price * burnBps / 1e4);
        house += price * (1 - burnBps / 1e4);
        return true;
      };
      if (b.w < 2 && b.w <= b.a) { if (buy(P.WEAPON[b.w], P.UPGRADE_BURN_BPS)) b.w++; }
      else if (b.a < 2) { if (buy(P.ARMOR[b.a], P.UPGRADE_BURN_BPS)) b.a++; }
      else if (R() < BOT_SKIN_P && buy(P.SKIN, 10_000)) b.skins++;
      b.hwm = Math.min(b.hwm, b.bal); // spending/losses lower the mark (dividends only on new profit)
    }
    // ---- players: secondary share trades (2% tax) and cosmetics
    if (R() < TRADE_P) {
      const b = bots[Math.floor(R() * bots.length)];
      const value = 20 * Math.max(0.01, b.bal / P.SHARES_PER_BOT) * (0.8 + 0.4 * R());
      const buyer = players[Math.floor(R() * PLAYERS)], seller = players[Math.floor(R() * PLAYERS)];
      if (buyer.bal >= value) { buyer.bal -= value; const tax = value * P.TRADE_TAX_BPS / 1e4; burn(tax); seller.bal += value - tax; }
    }
    // players with spare NOX buy cosmetics (status, no power): chance grows with wealth
    for (const p of players) if (p.bal >= 150 && R() < COSMETIC_P * (p.bal / 150)) { const price = p.bal >= 400 ? 200 : p.bal >= 250 ? 100 : 50; p.bal -= price; burn(price); }
    // ---- daily check-in + quests (only matches paid from the player's own wallet count)
    if (pl && walletPaid) {
      if (pl.statDay !== day) { pl.statDay = day; pl.paid = 0; pl.top3 = 0; pl.bounty = 0; }
      pl.paid++;
      if (winner === -1 || R() < 0.2) pl.top3++;
      const m0 = houseRule(ema).m;
      if (pl.lastCheck !== day) { pl.streak = pl.lastCheck === day - 1 ? pl.streak + 1 : 1; pl.lastCheck = day; dailyPaid += houseReward(pl, P.CHECKIN_REWARDS[Math.min(pl.streak, 7) - 1], m0); }
      if (pl.paid === P.QUEST_GOALS[0]) dailyPaid += houseReward(pl, P.QUEST_REWARDS[0], m0);
      if (pl.top3 === 1 && (winner === -1 || pl.paid === 1)) dailyPaid += houseReward(pl, P.QUEST_REWARDS[1], m0);
    }
    // ---- metrics
    const sup = supplyOf();
    out.supply.push(sup); out.burned.push(burned); out.house.push(house); out.m.push(m); out.gini.push(gini(bots.map((b) => b.bal)));
    floorStreak = house < P.HOUSE_FLOOR ? floorStreak + 1 : 0;
    out.floorStreakMax = Math.max(out.floorStreakMax, floorStreak);
    const ranked = [...bots].sort((a, b) => b.bal - a.bal).map((b) => b.id);
    for (const w of rookieWatch) if (!w.rose && t <= w.until && ranked.slice(0, 3).includes(w.id)) w.rose = true;
    if (t === Math.floor(N * 0.2)) richAt2k = ranked.slice(0, 3);
    if (t === Math.floor(N * 0.4)) { out.richN += richAt2k.length; out.richFell += richAt2k.filter((id) => !ranked.slice(0, 3).includes(id)).length; }
    if (Math.abs(sup + burned - genesis) > 1e-6 * genesis) throw new Error(`conservation broken at match ${t}: supply ${sup} + burned ${burned} != genesis ${genesis}`);
  }
  if (argv.includes("--diag")) {
    const bb = bots.map((b) => b.bal).sort((a, b) => b - a);
    console.log(`seed ${seed}: house ${house.toFixed(0)} bots ${bb.reduce((a, b) => a + b, 0).toFixed(0)} [${bb.map((x) => x.toFixed(0)).join(",")}] players ${players.reduce((s, p) => s + p.bal, 0).toFixed(0)} burned ${burned.toFixed(0)} retired ${out.retired}`);
  }
  for (const w of rookieWatch) if (w.until < N) { out.rookieN++; if (w.rose) out.rookieRose++; }
  for (const c of ipoCohorts) if (c.at < N - 1000) {
    const alive = bots.includes(c.bot);
    const value = alive ? c.bot.sold * c.bot.bal / P.SHARES_PER_BOT : 0;
    out.shareRoi.push((c.bot.divs + value - c.cost) / c.cost);
    out.portCost += c.cost;
    out.portBack += c.bot.divs + value;
  }
  return out;
}

// ---------------------------------------------------------------- run all, aggregate, check, chart
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const runs = Array.from({ length: RUNS }, (_, i) => run(SEED0 + i));
const meanSeries = (k: "supply" | "burned" | "house" | "m" | "gini") => Array.from({ length: N }, (_, t) => runs.reduce((s, r) => s + r[k][t], 0) / RUNS);
const S = { supply: meanSeries("supply"), burned: meanSeries("burned"), house: meanSeries("house"), m: meanSeries("m"), gini: meanSeries("gini") };
const genesis = runs[0].supply[0] + runs[0].burned[0];
const lifespans = runs.flatMap((r) => r.lifespans);
const half = Math.floor(N / 2);
const minSupplyRatio = Math.min(...runs.map((r) => Math.min(...r.supply) / genesis));
const supplyLast = S.supply.slice(-Math.floor(N / 10));
const plateauDrift = (supplyLast[supplyLast.length - 1] - supplyLast[0]) / genesis;
const houseMedian = median(runs.flatMap((r) => r.house.slice(half)));
const mSeries = runs.map((r) => r.m.slice(half));
const mAll = mSeries.flat();
const mStepMax = Math.max(...mSeries.map((v) => Math.max(...v.slice(1).map((x, i) => Math.abs(x - v[i])))));
const giniHalf = S.gini.slice(half).reduce((a, b) => a + b, 0) / (N - half);
const richFell = runs.reduce((s, r) => s + r.richFell, 0) / Math.max(1, runs.reduce((s, r) => s + r.richN, 0));
const rookieRose = runs.reduce((s, r) => s + r.rookieRose, 0) / Math.max(1, runs.reduce((s, r) => s + r.rookieN, 0));
const roi = median(runs.flatMap((r) => r.shareRoi));
const allRoi = runs.flatMap((r) => r.shareRoi).sort((a, b) => a - b);
const top10 = allRoi.length ? allRoi[Math.floor(allRoi.length * 0.9)] : NaN;
const winners = allRoi.filter((x) => x > 0).length / Math.max(1, allRoi.length);
const portRoi = runs.reduce((s, r) => s + r.portBack, 0) / Math.max(1e-9, runs.reduce((s, r) => s + r.portCost, 0)) - 1;

const checks: [string, boolean, string][] = [
  ["no minting after genesis", runs.every((r) => r.minted === 0), "0 minted"],
  ["supply falls ≤25% and plateaus", minSupplyRatio >= 0.75 && Math.abs(plateauDrift) <= 0.02, `min ${(minSupplyRatio * 100).toFixed(1)}% of genesis, last-10% drift ${(plateauDrift * 100).toFixed(2)}%`],
  ["house never below floor >200 matches in a row", Math.max(...runs.map((r) => r.floorStreakMax)) <= 200, `worst streak ${Math.max(...runs.map((r) => r.floorStreakMax))}`],
  ["house median within target ±30%", Math.abs(houseMedian / P.HOUSE_TARGET - 1) <= 0.3, `median ${houseMedian.toFixed(0)} vs target ${P.HOUSE_TARGET}`],
  ["reward multiplier within 0–1.5, smooth", Math.min(...mAll) >= 0 && Math.max(...mAll) <= 1.5 && mStepMax <= 0.05, `range ${Math.min(...mAll).toFixed(2)}–${Math.max(...mAll).toFixed(2)}, max step ${mStepMax.toFixed(3)}`],
  ["median bot life 30–150 matches", median(lifespans) >= 30 && median(lifespans) <= 150, `median ${median(lifespans)} (n=${lifespans.length})`],
  ["≥25% of the top-3 at 20% fall out by 40%", richFell >= 0.25, `${(richFell * 100).toFixed(0)}%`],
  ["≥20% of rookies reach the top-3 within 300 matches", rookieRose >= 0.2, `${(rookieRose * 100).toFixed(0)}%`],
  ["Gini of bot wealth 0.20–0.50 (2nd half)", giniHalf >= 0.2 && giniHalf <= 0.5, giniHalf.toFixed(3)],
  ["share portfolio ROI (every IPO bought) −30%…+40%", portRoi >= -0.3 && portRoi <= 0.4, `${(portRoi * 100).toFixed(0)}% (median single IPO ${(roi * 100).toFixed(0)}%: most rookies fail, a few pay off)`],
];

function svg(title: string, series: { name: string; v: number[]; color: string }[], yLabel: string, refs: { y: number; label: string }[] = []) {
  const W = 720, H = 300, L = 60, Rr = 20, T = 34, B = 36;
  const all = [...series.flatMap((s) => s.v), ...refs.map((r) => r.y)];
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = (i: number, n: number) => L + (i / Math.max(1, n - 1)) * (W - L - Rr);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const step = Math.max(1, Math.floor(series[0].v.length / 600));
  const lines = series.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${s.v.filter((_, i) => i % step === 0).map((v, j) => `${x(j * step, s.v.length).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`).join("");
  const refl = refs.map((r) => `<line x1="${L}" x2="${W - Rr}" y1="${y(r.y)}" y2="${y(r.y)}" stroke="#888" stroke-dasharray="4 4"/><text x="${W - Rr - 4}" y="${y(r.y) - 4}" text-anchor="end" font-size="11" fill="#666">${r.label}</text>`).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = lo + f * (hi - lo); return `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#555">${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)}</text>`; }).join("");
  const legend = series.map((s, i) => `<rect x="${L + i * 150}" y="${H - 16}" width="10" height="10" fill="${s.color}"/><text x="${L + 14 + i * 150}" y="${H - 7}" font-size="11" fill="#333">${s.name}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui,sans-serif"><rect width="100%" height="100%" fill="#fff"/><text x="${L}" y="20" font-size="14" font-weight="600" fill="#111">${title}</text><text x="12" y="${T + 10}" font-size="11" fill="#555">${yLabel}</text><line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="#ccc"/><line x1="${L}" x2="${W - Rr}" y1="${H - B}" y2="${H - B}" stroke="#ccc"/>${ticks}${refl}${lines}${legend}<text x="${W - Rr}" y="${H - B + 14}" text-anchor="end" font-size="11" fill="#555">match ${N}</text></svg>`;
}

fs.mkdirSync(OUT, { recursive: true });
const survival = Array.from({ length: 31 }, (_, k) => lifespans.filter((l) => l >= k * 10).length / Math.max(1, lifespans.length));
const charts: Record<string, string> = {
  "supply.svg": svg("NOX supply (mean of runs)", [{ name: "supply", v: S.supply, color: "#5b4bd6" }], "NOX", [{ y: genesis, label: "genesis" }, { y: P.S_MIN, label: "brake floor" }]),
  "burn.svg": svg("Cumulative NOX burned", [{ name: "burned", v: S.burned, color: "#d6452f" }], "NOX"),
  "house.svg": svg("House treasury", [{ name: "house", v: S.house, color: "#c9932b" }], "NOX", [{ y: P.HOUSE_TARGET, label: "target" }, { y: P.HOUSE_FLOOR, label: "floor" }]),
  "reward-rate.svg": svg("Reward multiplier m (House rule)", [{ name: "m", v: S.m, color: "#2f8f5b" }], "×", [{ y: 1, label: "base" }]),
  "survival.svg": svg("Bot survival: share of bots alive after N matches", [{ name: "alive", v: survival, color: "#2b6fc9" }], "share", []),
  "gini.svg": svg("Gini of bot wealth", [{ name: "gini", v: S.gini, color: "#8a3fb0" }], "gini", [{ y: 0.2, label: "0.20" }, { y: 0.5, label: "0.50" }]),
};
for (const [f, c] of Object.entries(charts)) fs.writeFileSync(path.join(OUT, f), c);
const pass = checks.every((c) => c[1]);
const shareReturns = { medianSingleIpo: roi, top10pctSingleIpo: top10, shareOfIposInProfit: winners, portfolio: portRoi };
const summary = { shareReturns, generatedAt: new Date().toISOString(), matches: N, runs: RUNS, seed: SEED0, params: P, assumptions: { HUMAN_WIN, EDGE, BOUNTY_KILL_P, GUEST_P, PLAYERS, MATCHES_PER_DAY, IPO_BUY_P, TRADE_P, COSMETIC_P }, checks: checks.map(([name, ok, value]) => ({ name, ok, value })), pass };
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
if (!QUIET) {
  console.log(`NOXARA economy v2 — ${RUNS} runs × ${N} matches (seed ${SEED0})`);
  for (const [name, ok, value] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${value}`);
  console.log(`share returns: median single IPO ${(roi * 100).toFixed(0)}% · top 10% ${(top10 * 100).toFixed(0)}% · IPOs in profit ${(winners * 100).toFixed(0)}% · portfolio ${(portRoi * 100).toFixed(0)}%`);
  console.log(pass ? "\nPASS — charts in " + path.relative(repo, OUT) : "\nFAIL");
}
process.exit(pass ? 0 : 1);
