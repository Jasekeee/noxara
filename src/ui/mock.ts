// DEV ONLY (?mock): fills in the T3 client API (sign-in, market, sponsorships, leaderboards, history) with
// believable local data so the screens can be built before the chain side lands. Never used without ?mock.
import type { BotMarket, EconomyInfo, FighterEvent, FighterInfo, GameClient, GameClientEcon, GameClientT3, Holding, LeaderRow, Listing, Progress, SeasonRow, ShareMarketRow, Sponsorship } from "../net/api";
import { levelProgress, unlocksForLevel, upgradesForLevel } from "../sim/progression";
import { localXp } from "./progress";

export function withMock(base: GameClient): GameClientT3 & GameClientEcon {
  let signedIn: string | null = null;
  let bal = 250;
  const spons = new Map<string, Sponsorship>();
  let fightersCache: FighterInfo[] = [];
  const getFighters = async () => (fightersCache = await base.fighters());
  const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

  const extra: Omit<GameClientT3, keyof GameClient> = {
    async signIn() {
      await new Promise((r) => setTimeout(r, 600));
      signedIn = "you.testnet";
      return signedIn;
    },
    async signOut() {
      signedIn = null;
    },
    async balance() {
      return signedIn ? bal : 0;
    },
    async progress(): Promise<Progress> {
      const xp = localXp();
      const p = levelProgress(xp);
      const unlocks: string[] = [];
      for (let l = 2; l <= p.level; l++) unlocks.push(...unlocksForLevel(l));
      return { xp, level: p.level, nextLevelXp: p.nextAt ?? p.xp, upgrades: upgradesForLevel(p.level), unlocks };
    },
    async market(): Promise<BotMarket[]> {
      const fs = fightersCache.length ? fightersCache : await getFighters();
      return fs.map((f) => {
        const h = hash(f.name);
        const mine = spons.get(f.account)?.stake ?? 0;
        return { bot: f.account, totalStake: (h % 9) * 15 + mine, sponsors: (h % 5) + (mine ? 1 : 0), sponsorCut: 0.3 };
      });
    },
    async mySponsorships() {
      return [...spons.values()];
    },
    async sponsor(bot: string, amount: number) {
      if (!signedIn) throw new Error("sign in first");
      const f = fightersCache.find((x) => x.account === bot);
      const cur = spons.get(bot);
      const stake = (cur?.stake ?? 0) + amount;
      const total = (hash(f?.name ?? bot) % 9) * 15 + stake;
      spons.set(bot, { bot, botName: f?.name ?? bot, stake, share: stake / total, earned: cur?.earned ?? 0 });
      bal -= amount;
      return { tx: null };
    },
    async unsponsor(bot: string) {
      const cur = spons.get(bot);
      spons.delete(bot);
      bal += cur?.stake ?? 0;
      return { tx: null, returned: cur?.stake ?? 0 };
    },
    async leaderboard(kind: "bots" | "players"): Promise<LeaderRow[]> {
      if (kind === "bots") {
        const fs = fightersCache.length ? fightersCache : await getFighters();
        return fs.map((f) => ({ account: f.account, name: f.name, bot: true, wins: f.record.wins, kills: f.record.kills, earnings: f.record.earnings, matches: f.record.matches })).sort((a, b) => b.earnings - a.earnings || b.wins - a.wins);
      }
      const names = ["marlo.testnet", "quinn.testnet", "g-4f2a1c", "ash.testnet", "g-9b77e0", "you.testnet"];
      return names.map((n, i) => ({ account: n, name: n === "you.testnet" ? "You" : n, bot: false, wins: 6 - i, kills: 30 - i * 4, earnings: n.startsWith("g-") ? 0 : 120 - i * 18, matches: 20 - i })).sort((a, b) => b.earnings - a.earnings);
    },
    async welcomeCredit(): Promise<number> {
      return 30;
    },
    async claimWelcome(): Promise<number> {
      return 0;
    },
    async history(account: string): Promise<FighterEvent[]> {
      const f = fightersCache.find((x) => x.account === account);
      const name = f?.name ?? account.split(".")[0];
      const h = hash(name);
      const now = Date.now();
      const others = fightersCache.filter((x) => x.account !== account).map((x) => x.name);
      const o = (k: number) => others[(h + k) % Math.max(1, others.length)] ?? "Vex";
      const ev: FighterEvent[] = [
        { match: "m1", at: now - 3600e3 * 30, kind: "rookie", text: `${name} washed up on the island with 100 NOX` },
        { match: "m3", at: now - 3600e3 * 26, kind: "kill", text: `First elimination: ${o(1)}` },
        { match: "m5", at: now - 3600e3 * 20, kind: "win", text: `Won match #5 and the ${40 + (h % 30)} NOX pot` },
        { match: "m6", at: now - 3600e3 * 19, kind: "upgrade", text: `Bought weapon tier 1 for 60 NOX` },
        { match: "m9", at: now - 3600e3 * 12, kind: "bounty", text: `Claimed the ${12 + (h % 20)} NOX bounty on ${o(2)}` },
        { match: "m11", at: now - 3600e3 * 6, kind: "death", text: `Taken out by ${o(3)} in the final circle` },
        { match: "m12", at: now - 3600e3 * 2, kind: "sponsored", text: `Picked up a new sponsor (+25 NOX stake)` },
      ];
      if (f?.status === "retired") ev.push({ match: "m14", at: now - 3600e3, kind: "retired", text: `Went broke and retired after ${f.record.matches} matches` });
      return ev.reverse();
    },
  };
  // ---- Economy v2 mock (deterministic-looking, local only)
  const owned = new Map<string, number>(); // bot -> my shares
  const listed: Listing[] = [];
  let nextListing = 3;
  const names = async () => (fightersCache.length ? fightersCache : await getFighters());
  const botRows = async (): Promise<ShareMarketRow[]> =>
    (await names()).map((f, i) => {
      const hh = hash(f.name);
      const wallet = f.status === "retired" ? 0 : Math.max(20, f.balance || 40 + (hh % 220));
      const sold = f.status === "retired" ? 0 : 60 + (hh % 5) * 40 + (owned.get(f.account) ?? 0);
      return {
        bot: f.account, name: f.name, status: f.status, sharesSold: Math.min(1000, sold), ipoLeft: f.status === "retired" ? 0 : i % 3 === 0 ? 300 - (sold % 300) : 0, ipoPrice: 0.1,
        lastPrice: f.status === "retired" ? null : i % 4 === 3 ? null : Math.round((wallet / 1000) * (0.8 + (hh % 7) / 10) * 1000) / 1000,
        dividendsPaid: Math.round((hh % 400) / 10) / 1, holders: 1 + (hh % 7), wallet, seasonPnl: ((hh % 90) - 35) + i / 10,
      };
    });
  const econ: Pick<GameClientEcon, keyof GameClientEcon> = {
    async economy(): Promise<EconomyInfo> {
      const now = Date.now();
      const snaps = Array.from({ length: 64 }, (_, i) => {
        const t = i / 63;
        const house = 760 + 300 * Math.sin(i / 7) * (1 - t * 0.4) - 60 * t;
        return { match: String(100 + i), at: now - (63 - i) * 1200e3, supply: Math.round(2900 - 520 * (1 - Math.exp(-3 * t))), burned: Math.round(520 * (1 - Math.exp(-3 * t))), house: Math.round(house), m: Math.max(0, Math.min(1.5, (house - 500) / 500)) };
      });
      const last = snaps[snaps.length - 1];
      return { supply: last.supply, genesis: 2900, minted: 2900, burned: last.burned, house: last.house, houseEma: last.house - 8, floor: 500, target: 1000, m: last.m, houseShare: 0.05 + 0.1 * Math.max(0, 1 - last.m), burnShare: 0.01 + 0.03 * Math.max(0, 1 - last.m), brake: Math.max(0, Math.min(1, (last.supply - 2300) / 600)), topUp: 25 * last.m, season: 3, seasonEndsAt: now + 19 * 3600e3 + 12 * 60e3, seasonBurned: 141, seasonRewards: 388, snapshots: snaps };
    },
    sharesMarket: botRows,
    async myShares(): Promise<Holding[]> {
      if (!signedIn) return [];
      const rows = await botRows();
      return [...owned].filter(([, n]) => n > 0).map(([bot, n]) => { const r = rows.find((x) => x.bot === bot); return { bot, name: r?.name ?? bot, shares: n, claimable: Math.round(n * 0.013 * 100) / 100, value: n * ((r?.wallet ?? 0) / 1000) }; });
    },
    async listings(bot?: string): Promise<Listing[]> {
      const fs = await names();
      const base: Listing[] = fs.slice(0, 2).map((f, i) => ({ id: String(i + 1), seller: i ? "marlo.testnet" : "quinn.testnet", bot: f.account, name: f.name, shares: 20 + i * 15, pricePerShare: 0.14 + i * 0.03, expiresAt: Date.now() + (30 + i * 9) * 3600e3 }));
      return [...base, ...listed].filter((l) => !bot || l.bot === bot);
    },
    async seasonStandings(): Promise<SeasonRow[]> {
      return (await names()).filter((f) => f.status === "active").map((f) => { const hh = hash(f.name); const wins = hh % 6, kills = (hh >> 3) % 24, income = wins * 38 + (hh % 40), costs = 30 + (hh % 70); return { bot: f.account, name: f.name, points: wins * 10 + kills * 2, wins, kills, income, costs, pnl: income - costs }; }).sort((a, b) => b.points - a.points);
    },
    async buyIpo(bot: string, shares: number) {
      if (!signedIn) throw new Error("Sign in with a NEAR account: guests can't hold shares.");
      owned.set(bot, (owned.get(bot) ?? 0) + shares);
      bal -= shares * 0.1;
      return { tx: null };
    },
    async claimDividends(bot: string) {
      const n = owned.get(bot) ?? 0;
      const claimed = Math.round(n * 0.013 * 100) / 100;
      bal += claimed;
      return { tx: null, claimed };
    },
    async listShares(bot: string, shares: number, pricePerShare: number) {
      if (!signedIn) throw new Error("Sign in with a NEAR account: guests can't hold shares.");
      const id = String(nextListing++);
      owned.set(bot, Math.max(0, (owned.get(bot) ?? 0) - shares));
      const f = (await names()).find((x) => x.account === bot);
      listed.push({ id, seller: signedIn, bot, name: f?.name ?? bot, shares, pricePerShare, expiresAt: Date.now() + 48 * 3600e3 });
      return { tx: null, id };
    },
    async cancelListing(id: string) {
      const i = listed.findIndex((l) => l.id === id);
      if (i >= 0) { owned.set(listed[i].bot, (owned.get(listed[i].bot) ?? 0) + listed[i].shares); listed.splice(i, 1); }
      return { tx: null };
    },
    async buyListing(id: string) {
      if (!signedIn) throw new Error("Sign in with a NEAR account: guests can't hold shares.");
      const i = listed.findIndex((l) => l.id === id);
      const l = i >= 0 ? listed.splice(i, 1)[0] : (await econ.listings()).find((x) => x.id === id);
      if (l) { owned.set(l.bot, (owned.get(l.bot) ?? 0) + l.shares); bal -= l.shares * l.pricePerShare * 1.02; }
      return { tx: null };
    },
    async buyCosmetic() {
      return { tx: null };
    },
  };
  const dailyMock: Pick<import("../net/api").GameClientDaily, keyof import("../net/api").GameClientDaily> = {
    async daily() {
      return { streak: 3, checkedInToday: false, canCheckIn: true, whyNot: null, nextReward: 1.5, quests: [
        { id: 0, title: "play 3 matches", progress: 2, goal: 3, done: false, claimed: false, reward: 0.75 },
        { id: 1, title: "finish in the top 3", progress: 1, goal: 1, done: true, claimed: false, reward: 0.75 },
        { id: 2, title: "take down the bounty carrier", progress: 0, goal: 1, done: false, claimed: false, reward: 1.5 },
      ] };
    },
    async checkIn() {
      return { tx: null, paid: 1.5 };
    },
    async claimQuest() {
      return { tx: null, paid: 0.75 };
    },
  };
  Object.assign(extra, econ, dailyMock);
  // keep the base object's prototype (mode/getters) and just add the T3 methods
  const t3 = Object.assign(base, extra) as GameClientT3 & GameClientEcon;
  const baseGuest = base.isGuest.bind(base);
  t3.isGuest = () => (signedIn ? false : baseGuest());
  const baseAccount = base.account.bind(base);
  t3.account = async () => signedIn ?? baseAccount();
  return t3;
}
