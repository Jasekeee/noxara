// DEV ONLY (?mock): fills in the T3 client API (sign-in, market, sponsorships, leaderboards, history) with
// believable local data so the screens can be built before the chain side lands. Never used without ?mock.
import type { BotMarket, FighterEvent, FighterInfo, GameClient, GameClientT3, LeaderRow, Progress, Sponsorship } from "../net/api";
import { levelProgress, unlocksForLevel, upgradesForLevel } from "../sim/progression";
import { localXp } from "./progress";

export function withMock(base: GameClient): GameClientT3 {
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
    async history(account: string): Promise<FighterEvent[]> {
      const f = fightersCache.find((x) => x.account === account);
      const name = f?.name ?? account.split(".")[0];
      const h = hash(name);
      const now = Date.now();
      const others = fightersCache.filter((x) => x.account !== account).map((x) => x.name);
      const o = (k: number) => others[(h + k) % Math.max(1, others.length)] ?? "Vex";
      const ev: FighterEvent[] = [
        { match: "m1", at: now - 3600e3 * 30, kind: "rookie", text: `${name} washed up on the island with 100 $BOUNTY` },
        { match: "m3", at: now - 3600e3 * 26, kind: "kill", text: `First elimination: ${o(1)}` },
        { match: "m5", at: now - 3600e3 * 20, kind: "win", text: `Won match #5 and the ${40 + (h % 30)} $BOUNTY pot` },
        { match: "m6", at: now - 3600e3 * 19, kind: "upgrade", text: `Bought weapon tier 1 for 60 $BOUNTY` },
        { match: "m9", at: now - 3600e3 * 12, kind: "bounty", text: `Claimed the ${12 + (h % 20)} $BOUNTY bounty on ${o(2)}` },
        { match: "m11", at: now - 3600e3 * 6, kind: "death", text: `Taken out by ${o(3)} in the final circle` },
        { match: "m12", at: now - 3600e3 * 2, kind: "sponsored", text: `Picked up a new sponsor (+25 $BOUNTY stake)` },
      ];
      if (f?.status === "retired") ev.push({ match: "m14", at: now - 3600e3, kind: "retired", text: `Went broke and retired after ${f.record.matches} matches` });
      return ev.reverse();
    },
  };
  // keep the base object's prototype (mode/getters) and just add the T3 methods
  const t3 = Object.assign(base, extra) as GameClientT3;
  const baseGuest = base.isGuest.bind(base);
  t3.isGuest = () => (signedIn ? false : baseGuest());
  const baseAccount = base.account.bind(base);
  t3.account = async () => signedIn ?? baseAccount();
  return t3;
}
