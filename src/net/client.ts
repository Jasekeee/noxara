// The game's chain glue (implements GameClientT3 in src/net/api.ts). The player never sees a wallet: a
// guest key is made in the browser (WebCrypto ed25519), the relayer creates the account and pays all
// gas, and every call is a signed NEP-366 delegate action. Signing in with a real NEAR account is ONE
// wallet redirect (MyNearWallet's login adds our function-call key for the game contract); after that
// it is gasless exactly like a guest. If anything chain-side is unreachable the client drops to mode
// "offline": local seed + t1Roster(), local XP, the game stays fully playable.
import type { BotMarket, CreateGameClient, FighterEvent, FighterInfo, GameClientT3, LeaderRow, Payout, Progress, SettleResult, Sponsorship, StartResult } from "./api";
import { levelProgress, unlocksForLevel, upgradesForLevel, xpForMatch } from "../sim/progression";
import { SIM_VERSION, type MatchConfig, type MatchRecord, type Personality } from "../sim/types";
import { t1Roster } from "../sim/roster";
import { matchConfigFromChain, type ChainMatch, type ChainRosterEntry } from "./roster";
import { ed25519Supported, generateKey, inputLogHash, rpc, settleMessage, sha256, signDelegate, Signer, toBase64, viewCall, type StoredKey } from "./near";

const env = ((import.meta as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;
const DEFAULTS = {
  relayer: env.VITE_RELAYER_URL ?? "http://127.0.0.1:8788",
  rpc: env.VITE_NEAR_RPC ?? "https://test.rpc.fastnear.com",
  contract: env.VITE_CONTRACT_ID ?? "royale.br-7e8492.testnet",
  explorer: env.VITE_EXPLORER ?? "https://testnet.nearblocks.io",
  wallet: env.VITE_WALLET_URL ?? "https://testnet.mynearwallet.com",
};
const STORE = "bountyroyale.guest.v1";
const STORE_REAL = "bountyroyale.account.v1";
const STORE_PENDING = "bountyroyale.signin.v1";
const STORE_XP = "bountyroyale.localxp.v1";
/** methods the signed-in account's function-call key may call (the relayer allow-lists the same) */
const REAL_METHODS = ["start_match", "sweep_match", "sponsor", "unsponsor"];
const ONE = 10n ** 18n;
const YOCTO_PER_CENT = 10n ** 16n; // display with 2 decimals
const START_GAS = 100n * 10n ** 12n;

/** yocto-$BOUNTY string -> display number with 2 decimals. */
export const toBounty = (y: string | bigint | undefined | null): number => (y === undefined || y === null ? 0 : Number(BigInt(y) / YOCTO_PER_CENT) / 100);

type Saved = { accountId: string; key: StoredKey; contract: string };
type ChainFighter = {
  account: string;
  name: string;
  personality: string;
  slot: number;
  upgrades: { weaponTier: number; armor: number; skin: number };
  record: { matches: number; wins: number; kills: number; deaths: number; earnings: string };
  generation: number;
  status: "active" | "retired";
  balance: string;
  bounty: boolean;
};
type ChainConfig = { bounty_bps: number; pot_top_up: string; house: string };
type ChainEvent = { event: string; data: Record<string, unknown> };
type MatchResultJson = {
  winner: number | null;
  prize_to: string;
  prize: string;
  burned: string;
  house_cut: string;
  bounty_to: string | null;
  bounty_amount: string;
};

const PERSONALITIES: Personality[] = ["aggressive", "camper", "sniper", "looter", "coward", "balanced"];
const asPersonality = (p: string): Personality => (PERSONALITIES.includes(p as Personality) ? (p as Personality) : "balanced");

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* still playable this session */
  }
}

/** "12.5" $BOUNTY -> yocto string (2 decimals are enough for the UI). */
const toYocto = (amount: number) => ((BigInt(Math.round(amount * 100)) * ONE) / 100n).toString();

/** Contract panics -> sentences a player understands. */
function friendly(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("not enough $bounty")) return "You don't have enough $BOUNTY for that.";
  if (m.includes("must play 5 matches")) return "Your stake is locked until this bot plays 5 more matches.";
  if (m.includes("guests can't")) return "Sign in with a NEAR account to sponsor bots.";
  if (m.includes("not an active fighter") || m.includes("broke")) return "This bot has retired.";
  if (m.includes("30%")) return "Sponsors can own at most 30% of a bot: try a smaller stake.";
  if (m.includes("at least 10")) return "The minimum stake is 10 $BOUNTY.";
  if (m.includes("at most 3 bots")) return "You can back at most 3 bots at once.";
  if (m.includes("all the sponsors")) return "This bot already has as many sponsors as it can take.";
  if (m.includes("don't sponsor")) return "You don't sponsor this bot.";
  if (m.includes("register first")) return "Your account isn't registered with the game yet: sign in again.";
  return msg;
}

type ChainHist = { match_id: string; at_ms: string; kind: string; amount: string; detail: string };
type ChainMarket = { bot: string; name: string; total_stake: string; sponsors: number; sponsor_cut_bps: number };
type ChainSponsorship = { bot: string; bot_name: string; staked: string; value: string; earned: string; pool_bps: number; cooldown_left: number; bot_active: boolean };
type ChainTop = { account: string; name: string; bot: boolean; wins: number; kills: number; matches: number; earnings: string };
type ChainProgress = { xp: number; level: number; level_xp: number; next_level_xp: number | null };

async function postJson<T>(url: string, body: unknown, timeoutMs = 30_000): Promise<{ ok: boolean; status: number; json: T & { error?: string } }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const json = (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as T & { error?: string };
  return { ok: r.ok, status: r.status, json };
}

function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] || 1;
}

/** Why the client is offline (GameClient.offlineReason). */
export type OfflineReason =
  | "relayer_unreachable" // no answer from /api/health
  | "wrong_contract" // the relayer serves another contract
  | "sim_version_mismatch" // the match server runs another simulation version (it would refuse our records)
  | "no_webcrypto" // the browser can't make ed25519 keys
  | "chain_error"; // something failed mid-session (guest creation, relay, views)

class Client implements GameClientT3 {
  private _mode: "chain" | "offline";
  private _offlineReason: OfflineReason | undefined;
  /** last chain-side error message (for debugging; never logged) */
  lastError: string | null = null;
  private relayer: string;
  private rpcUrl: string;
  private contract: string;
  private explorer: string;
  /** the active session: the signed-in real account if any, else the guest */
  private saved: Saved | null = null;
  private guestSaved: Saved | null = null;
  private realSaved: Saved | null = null;
  private signer: Signer | null = null;
  private nonce = 0n;
  private maxBlockHeight = 0n;
  private synced = false;
  private cfgCache: ChainConfig | null = null;
  private rosters = new Map<string, ChainRosterEntry[]>();
  private localMatches = 0;

  constructor(mode: "chain" | "offline", o: { relayer: string; rpc: string; contract: string }, reason?: OfflineReason, detail?: string) {
    this._mode = mode;
    this._offlineReason = mode === "offline" ? reason : undefined;
    this.lastError = detail ?? null;
    this.relayer = o.relayer.replace(/\/$/, "");
    this.rpcUrl = o.rpc;
    this.contract = o.contract;
    this.explorer = DEFAULTS.explorer;
    const g = load<Saved>(STORE);
    if (g && g.contract === this.contract) this.guestSaved = g;
    const r = load<Saved>(STORE_REAL);
    if (r && r.contract === this.contract) this.realSaved = r;
    this.saved = this.realSaved ?? this.guestSaved;
  }

  private use(s: Saved | null) {
    this.saved = s;
    this.signer = null;
    this.synced = false;
  }

  get mode() {
    return this._mode;
  }

  get offlineReason(): string | undefined {
    return this._offlineReason;
  }

  /** Silent by design (quality gate: 0 console warnings); the UI reads `offlineReason`. */
  private goOffline(why: unknown, reason: OfflineReason = "chain_error") {
    this.lastError = why instanceof Error ? why.message : String(why);
    if (this._mode === "chain") this._offlineReason = reason;
    this._mode = "offline";
  }

  // ------------------------------------------------------------ account

  async account(): Promise<string> {
    if (this._mode === "offline") return this.saved?.accountId ?? "you";
    try {
      return (await this.session()).accountId;
    } catch (e) {
      this.goOffline(e);
      return "you";
    }
  }

  isGuest(): boolean {
    return !this.realSaved;
  }

  private async session(): Promise<Saved> {
    if (this.saved) {
      this.signer ??= await Signer.load(this.saved.key);
      return this.saved;
    }
    const key = await generateKey();
    const r = await postJson<{ accountId: string }>(`${this.relayer}/api/guest`, { publicKey: key.publicKey });
    if (!r.ok || !r.json.accountId) throw new Error(r.json.error ?? "could not create a guest");
    this.guestSaved = { accountId: r.json.accountId, key, contract: this.contract };
    save(STORE, this.guestSaved);
    this.saved = this.guestSaved;
    this.signer = await Signer.load(key);
    return this.saved;
  }

  /** One RPC per session: the key's nonce and a block height for the delegate's expiry. */
  private async sync(force = false) {
    if (this.synced && !force) return;
    const s = await this.session();
    for (let i = 0; i < 40; i++) {
      try {
        const ak = await rpc<{ nonce: number; block_height: number }>(this.rpcUrl, "query", {
          request_type: "view_access_key",
          finality: "optimistic",
          account_id: s.accountId,
          public_key: s.key.publicKey,
        });
        this.nonce = BigInt(ak.nonce);
        this.maxBlockHeight = BigInt(ak.block_height) + 20_000n;
        this.synced = true;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250)); // a brand-new account may not be visible yet
      }
    }
    throw new Error("guest key not visible on chain");
  }

  private async relay<T>(methodName: string, args: unknown, retry = true, gas = START_GAS): Promise<{ value: T; tx: string }> {
    await this.sync();
    const s = this.saved!;
    this.nonce += 1n;
    const payload = await signDelegate(this.signer!, {
      senderId: s.accountId,
      receiverId: this.contract,
      actions: [{ methodName, args, gas }],
      nonce: this.nonce,
      maxBlockHeight: this.maxBlockHeight,
    });
    const r = await postJson<{ value: T; tx: string }>(`${this.relayer}/api/relay`, { payload }, 45_000);
    if (!r.ok) {
      const msg = String(r.json.error ?? "relay failed");
      if (retry && /nonce|expired/i.test(msg)) {
        await this.sync(true);
        return this.relay<T>(methodName, args, false, gas);
      }
      // a stored GUEST that no longer works (e.g. a new contract): start over with a fresh guest
      if (retry && !this.realSaved && /unknown key|register first/i.test(msg)) {
        this.guestSaved = null;
        save(STORE, null);
        this.use(null);
        return this.relay<T>(methodName, args, false, gas);
      }
      throw new Error(msg);
    }
    return { value: r.json.value, tx: r.json.tx };
  }

  private async config(): Promise<ChainConfig> {
    this.cfgCache ??= await viewCall<ChainConfig>(this.rpcUrl, this.contract, "get_config");
    return this.cfgCache;
  }

  // ------------------------------------------------------------ fighters

  async fighters(): Promise<FighterInfo[]> {
    if (this._mode === "chain") {
      try {
        const [active, retired, cfg] = await Promise.all([
          viewCall<ChainFighter[]>(this.rpcUrl, this.contract, "get_fighters"),
          viewCall<ChainFighter[]>(this.rpcUrl, this.contract, "get_retired").catch(() => [] as ChainFighter[]),
          this.config(),
        ]);
        return [...active, ...retired].map((f) => ({
          slot: f.slot,
          account: f.account,
          name: f.name,
          personality: asPersonality(f.personality),
          balance: toBounty(f.balance),
          upgrades: { ...f.upgrades },
          record: { ...f.record, earnings: toBounty(f.record.earnings) },
          bounty: f.status === "active" && f.bounty,
          bountyValue: f.status === "active" && f.bounty ? toBounty((BigInt(f.balance) * BigInt(cfg.bounty_bps)) / 10_000n) : 0,
          generation: f.generation,
          status: f.status,
        }));
      } catch (e) {
        this.goOffline(e);
      }
    }
    return t1Roster()
      .slice(1)
      .map((f, i) => ({
        slot: i,
        account: f.id,
        name: f.name,
        personality: f.personality,
        balance: 100,
        upgrades: { ...f.upgrades },
        record: { matches: 0, wins: 0, kills: 0, deaths: 0, earnings: 0 },
        bounty: f.bounty,
        bountyValue: f.bounty ? 15 : 0,
        generation: 0,
        status: "active" as const,
      }));
  }

  // ------------------------------------------------------------ matches

  async startMatch(): Promise<StartResult> {
    if (this._mode === "chain") {
      try {
        const { value: m, tx } = await this.relay<ChainMatch & { match_id: string; pot: string; player_paid: string }>("start_match", {});
        if (!m || !m.seed) throw new Error("start_match returned no seed");
        const cfg = matchConfigFromChain(m, { name: "You" });
        this.rosters.set(m.match_id, m.roster);
        const chainCfg = await this.config().catch(() => null);
        let bountyValue = 0;
        if (m.bounty_idx) {
          const carrier = m.roster[m.bounty_idx - 1]?.account;
          const bal = carrier ? await viewCall<string>(this.rpcUrl, this.contract, "ft_balance_of", { account_id: carrier }).catch(() => "0") : "0";
          bountyValue = toBounty((BigInt(bal) * BigInt(chainCfg?.bounty_bps ?? 1500)) / 10_000n);
        }
        return {
          matchId: m.match_id,
          cfg,
          pot: toBounty(BigInt(m.pot ?? "0") + BigInt(chainCfg?.pot_top_up ?? "0")),
          bountyIdx: m.bounty_idx ?? null,
          bountyValue,
          playerPaid: toBounty(m.player_paid),
          tx,
        };
      } catch (e) {
        this.goOffline(e);
      }
    }
    return this.localStart();
  }

  private localStart(): StartResult {
    const cfg: MatchConfig = { seed: randomSeed(), fighters: t1Roster() };
    cfg.fighters[0] = { ...cfg.fighters[0], upgrades: upgradesForLevel(levelProgress(localXp()).level) };
    const b = cfg.fighters.findIndex((f) => f.bounty);
    return { matchId: `local-${++this.localMatches}-${cfg.seed}`, cfg, pot: 0, bountyIdx: b >= 0 ? b : null, bountyValue: 0, playerPaid: 0, tx: null };
  }

  async settle(matchId: string, record: MatchRecord): Promise<SettleResult> {
    const unverified: SettleResult = { tx: null, verified: false, winner: record.winner, payouts: [], retired: [], rookies: [], upgrades: [] };
    if (matchId.startsWith("local-") || !this.saved || !this.signer) {
      addLocalXp(record);
      return unverified;
    }
    try {
      const msg = await settleMessage(matchId, await inputLogHash(record.inputs));
      const signature = toBase64(await this.signer.sign(msg));
      const r = await postJson<{ tx: string; result: MatchResultJson; events: ChainEvent[]; code?: string }>(
        `${this.relayer}/api/settle`,
        { match_id: matchId, record, publicKey: this.saved.key.publicKey, signature, simVersion: SIM_VERSION },
        60_000,
      );
      if (!r.ok) {
        this.lastError = `${r.json.code ?? r.status}: ${r.json.error ?? "settle refused"}`;
        // the server was updated to another simulation mid-session: stop committing matches it can't verify
        if (r.json.code === "sim_version_mismatch") this.goOffline(r.json.error, "sim_version_mismatch");
        return unverified;
      }
      return this.describe(matchId, record, r.json.tx, r.json.result, r.json.events ?? []);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return unverified;
    }
  }

  private describe(matchId: string, record: MatchRecord, tx: string, res: MatchResultJson, events: ChainEvent[]): SettleResult {
    const names = new Map<string, string>();
    for (const r of this.rosters.get(matchId) ?? []) names.set(r.account, r.name);
    for (const e of events) if (e.event === "fighter_born") names.set(String(e.data.account), String(e.data.name));
    const house = this.cfgCache?.house ?? "";
    if (house) names.set(house, "the House");
    if (this.saved) names.set(this.saved.accountId, "You");
    const nameOf = (a: string) => names.get(a) ?? a.split(".")[0];
    const payouts: Payout[] = [];
    const isHouse = (a: string) => a === house || a.startsWith("house.");
    payouts.push({ account: res.prize_to, name: nameOf(res.prize_to), amount: toBounty(res.prize), reason: isHouse(res.prize_to) ? "house" : "prize" });
    if (res.bounty_to && BigInt(res.bounty_amount) > 0n) {
      payouts.push({ account: res.bounty_to, name: nameOf(res.bounty_to), amount: toBounty(res.bounty_amount), reason: isHouse(res.bounty_to) ? "house" : "bounty" });
    }
    payouts.push({ account: house || "house", name: "the House", amount: toBounty(res.house_cut), reason: "house" });
    payouts.push({ account: "burn", name: "burned", amount: toBounty(res.burned), reason: "burn" });
    const upgrades: { name: string; what: string }[] = [];
    const retired: string[] = [];
    const rookies: string[] = [];
    for (const e of events) {
      const acct = String(e.data.account ?? "");
      if (e.event === "upgrade") {
        upgrades.push({ name: nameOf(acct), what: String(e.data.what) });
        payouts.push({ account: acct, name: nameOf(acct), amount: toBounty(e.data.price as string), reason: "upgrade" });
      } else if (e.event === "retire") retired.push(nameOf(acct));
      else if (e.event === "fighter_born") rookies.push(String(e.data.name));
    }
    this.rosters.delete(matchId);
    return { tx, verified: true, winner: res.winner ?? record.winner, payouts, retired, rookies, upgrades };
  }

  // ------------------------------------------------------------ T3: real accounts

  /**
   * Sign in with a NEAR wallet: makes a key here and sends the player to the wallet, which adds it as a
   * function-call key for the game contract (one approval, no deposit, no gas). On return
   * `createGameClient` finishes the sign-in and the relayer prepays the account's storage. The page
   * navigates away, so this promise only settles if navigation is impossible.
   */
  async signIn(): Promise<string> {
    if (this.realSaved) return this.realSaved.accountId;
    if (this._mode !== "chain") throw new Error("The NEAR network is unreachable right now: try again later.");
    if (typeof location === "undefined") throw new Error("Sign-in needs a browser.");
    const key = await generateKey();
    save(STORE_PENDING, { key, contract: this.contract });
    const back = location.href.split("#")[0];
    const u = new URL("/login/", DEFAULTS.wallet);
    u.searchParams.set("success_url", back);
    u.searchParams.set("failure_url", back);
    u.searchParams.set("public_key", key.publicKey);
    u.searchParams.set("contract_id", this.contract);
    for (const m of REAL_METHODS) u.searchParams.append("methodNames", m);
    location.assign(u.toString());
    return new Promise<string>(() => {});
  }

  /** Called by createGameClient when the wallet sent the player back with `account_id`. */
  async finishSignIn(accountId: string, publicKey: string): Promise<void> {
    const pending = load<{ key: StoredKey; contract: string }>(STORE_PENDING);
    save(STORE_PENDING, null);
    if (!pending || pending.key.publicKey !== publicKey || pending.contract !== this.contract) return;
    const real: Saved = { accountId, key: pending.key, contract: this.contract };
    // the relayer prepays storage (checks the key really is on the account first)
    const signer = await Signer.load(real.key);
    const signature = toBase64(await signer.sign(await sha256(`bountyroyale:register:${accountId}`)));
    for (let i = 0; i < 8; i++) {
      const r = await postJson<{ registered?: boolean; code?: string }>(`${this.relayer}/api/register`, { accountId, publicKey, signature }).catch(() => null);
      if (r?.ok) break;
      if (r && r.json.code !== "unknown_key") {
        this.lastError = r.json.error ?? "register failed";
        return;
      }
      await new Promise((res) => setTimeout(res, 750)); // the wallet's AddKey may still be landing
    }
    this.realSaved = real;
    save(STORE_REAL, real);
    this.use(real);
  }

  async signOut(): Promise<void> {
    // the function-call key stays on the account (harmless: game calls only, zero deposit); the player
    // can delete it in their wallet. Locally we forget it and go back to the guest.
    this.realSaved = null;
    save(STORE_REAL, null);
    this.use(this.guestSaved);
  }

  async balance(): Promise<number> {
    if (this._mode !== "chain" || !this.realSaved) return 0;
    const b = await viewCall<string>(this.rpcUrl, this.contract, "ft_balance_of", { account_id: this.realSaved.accountId }).catch(() => "0");
    return toBounty(b);
  }

  async progress(): Promise<Progress> {
    let xp = localXp();
    if (this._mode === "chain" && this.saved) {
      const p = await viewCall<ChainProgress>(this.rpcUrl, this.contract, "get_progress", { account_id: this.saved.accountId }).catch(() => null);
      if (p) xp = p.xp;
    }
    const p = levelProgress(xp);
    const unlocks: string[] = [];
    for (let l = 2; l <= p.level; l++) unlocks.push(...unlocksForLevel(l));
    return { xp, level: p.level, nextLevelXp: p.nextAt ?? p.xp, upgrades: upgradesForLevel(p.level), unlocks };
  }

  async market(): Promise<BotMarket[]> {
    if (this._mode !== "chain") return [];
    const m = await viewCall<ChainMarket[]>(this.rpcUrl, this.contract, "get_market").catch(() => [] as ChainMarket[]);
    const cut = (b: ChainMarket) => (b.sponsor_cut_bps || this.sponsorCutBps) / 10_000;
    return m.map((b) => ({ bot: b.bot, totalStake: toBounty(b.total_stake), sponsors: b.sponsors, sponsorCut: cut(b) }));
  }

  private sponsorCutBps = 1000;

  async mySponsorships(): Promise<Sponsorship[]> {
    if (this._mode !== "chain" || !this.realSaved) return [];
    const v = await viewCall<ChainSponsorship[]>(this.rpcUrl, this.contract, "get_sponsorships", { account_id: this.realSaved.accountId }).catch(() => [] as ChainSponsorship[]);
    return v.map((x) => ({ bot: x.bot, botName: x.bot_name, stake: toBounty(x.staked), share: x.pool_bps / 10_000, earned: toBounty(x.earned) }));
  }

  async sponsor(bot: string, amount: number): Promise<{ tx: string | null }> {
    if (!this.realSaved) throw new Error("Sign in with a NEAR account to sponsor bots.");
    if (this._mode !== "chain") throw new Error("The NEAR network is unreachable right now: try again later.");
    if (!(amount > 0)) throw new Error("Choose how much $BOUNTY to stake.");
    try {
      const r = await this.relay<unknown>("sponsor", { bot, amount: toYocto(amount) }, true, 50n * 10n ** 12n);
      return { tx: r.tx };
    } catch (e) {
      throw new Error(friendly(e instanceof Error ? e.message : String(e)));
    }
  }

  async unsponsor(bot: string): Promise<{ tx: string | null; returned: number }> {
    if (!this.realSaved) throw new Error("Sign in with a NEAR account to sponsor bots.");
    if (this._mode !== "chain") throw new Error("The NEAR network is unreachable right now: try again later.");
    try {
      const r = await this.relay<string>("unsponsor", { bot }, true, 50n * 10n ** 12n);
      return { tx: r.tx, returned: toBounty(r.value) };
    } catch (e) {
      throw new Error(friendly(e instanceof Error ? e.message : String(e)));
    }
  }

  async leaderboard(kind: "bots" | "players"): Promise<LeaderRow[]> {
    if (this._mode !== "chain") {
      if (kind === "players") return [];
      return (await this.fighters()).map((f) => ({ account: f.account, name: f.name, bot: true, wins: f.record.wins, kills: f.record.kills, earnings: f.record.earnings, matches: f.record.matches }));
    }
    const rows = await viewCall<ChainTop[]>(this.rpcUrl, this.contract, "get_top", { kind, by: "earnings", n: 50 }).catch(() => [] as ChainTop[]);
    const me = this.saved?.accountId;
    return rows.map((r) => ({
      account: r.account,
      name: r.account === me ? "You" : r.bot ? r.name : shortName(r.account),
      bot: r.bot,
      wins: r.wins,
      kills: r.kills,
      earnings: toBounty(r.earnings),
      matches: r.matches,
    }));
  }

  async history(account: string): Promise<FighterEvent[]> {
    if (this._mode !== "chain") return [];
    const h = await viewCall<ChainHist[]>(this.rpcUrl, this.contract, "get_history", { account_id: account }).catch(() => [] as ChainHist[]);
    return h.map((e) => histEvent(e));
  }

  explorerTx(hash: string): string {
    return `${this.explorer}/txns/${hash}`;
  }
  explorerAccount(account: string): string {
    return `${this.explorer}/address/${account}`;
  }
}

export const shortName = (id: string) => (id.startsWith("g-") ? `Guest ${id.slice(2, 6)}` : id.replace(/\.(testnet|near)$/, ""));

const fmt = (y: string) => {
  const v = toBounty(y);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, "");
};

/** A chain history entry -> a line the UI can show as is. */
export function histEvent(e: ChainHist): FighterEvent {
  const match = e.match_id === "0" ? "" : e.match_id;
  const at = Number(e.at_ms);
  const m = match ? ` #${match}` : "";
  const amt = fmt(e.amount);
  switch (e.kind) {
    case "win": {
      const [, kills] = e.detail.split(":");
      return { match, at, kind: "win", text: `Won match${m} and took ${amt} $BOUNTY${kills && kills !== "0" ? ` (${kills} kills)` : ""}` };
    }
    case "death": {
      const [place, kills] = e.detail.split(":");
      const k = kills && kills !== "0" ? `, ${kills} kill${kills === "1" ? "" : "s"}` : "";
      return { match, at, kind: kills && kills !== "0" ? "kill" : "death", text: `Finished #${place} in match${m}${k}` };
    }
    case "bounty":
      return e.detail === "lost"
        ? { match, at, kind: "bounty", text: `Was hunted down in match${m} and lost a ${amt} $BOUNTY bounty` }
        : { match, at, kind: "bounty", text: `Claimed a ${amt} $BOUNTY bounty in match${m}` };
    case "upgrade":
      return { match, at, kind: "upgrade", text: `Bought ${e.detail.replace("weapon", "weapon tier")} for ${amt} $BOUNTY` };
    case "retired":
      return { match, at, kind: "retired", text: `Went broke and retired${amt !== "0" ? ` with ${amt} $BOUNTY left` : ""}` };
    case "rookie":
      return { match, at, kind: "rookie", text: `Arrived on the island with ${amt} $BOUNTY from the House${e.detail ? `, replacing ${e.detail}` : ""}` };
    case "sponsored":
      return { match, at, kind: "sponsored", text: `${shortName(e.detail)} backed this bot with ${amt} $BOUNTY` };
    case "unsponsored":
      return { match, at, kind: "sponsored", text: `${shortName(e.detail)} withdrew ${amt} $BOUNTY` };
    case "dividend":
      return { match, at, kind: "sponsored", text: `Paid ${amt} $BOUNTY to its sponsors` };
    default:
      return { match, at, kind: "death", text: `${e.kind} ${amt}` };
  }
}

/** Offline progression: XP kept in localStorage with the same rules as the chain. */
export function localXp(): number {
  return Number(load<number>(STORE_XP) ?? 0) || 0;
}
function addLocalXp(record: MatchRecord) {
  const p = record.placements?.[0] ?? 10;
  const kills = (record as MatchRecord & { kills?: number[] }).kills?.[0] ?? 0;
  save(STORE_XP, localXp() + xpForMatch(p, kills, false));
}

/** Probe the relayer (short timeout) and return a chain client, or an offline one. Never throws. */
export const createGameClient: CreateGameClient = async (opts = {}) => {
  const o = { relayer: opts.relayer ?? DEFAULTS.relayer, rpc: opts.rpc ?? DEFAULTS.rpc, contract: opts.contract ?? DEFAULTS.contract };
  const offline = (reason: OfflineReason, detail: string) => new Client("offline", o, reason, detail);
  if (typeof crypto?.subtle === "undefined" || !(await ed25519Supported())) return offline("no_webcrypto", "WebCrypto ed25519 unavailable");
  let h: { ok?: boolean; game?: string; simVersion?: string };
  try {
    const r = await fetch(`${o.relayer.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(2500) });
    h = (await r.json()) as typeof h;
    if (!r.ok || !h.ok) return offline("relayer_unreachable", `health: HTTP ${r.status}`);
  } catch (e) {
    return offline("relayer_unreachable", e instanceof Error ? e.message : String(e));
  }
  if (h.game !== o.contract) return offline("wrong_contract", `relayer serves ${h.game ?? "?"}, not ${o.contract}`);
  if (h.simVersion !== SIM_VERSION) return offline("sim_version_mismatch", `server sim ${h.simVersion ?? "unknown"}, client sim ${SIM_VERSION}`);
  const c = new Client("chain", o);
  // back from the wallet? (?account_id=...&public_key=...&all_keys=...) finish the sign-in, clean the URL
  if (typeof location !== "undefined" && typeof history !== "undefined") {
    const q = new URLSearchParams(location.search);
    const acct = q.get("account_id");
    const pk = q.get("public_key");
    if (acct && pk) {
      await c.finishSignIn(acct, pk).catch((e) => (c.lastError = e instanceof Error ? e.message : String(e)));
      for (const k of ["account_id", "public_key", "all_keys", "errorCode", "errorMessage"]) q.delete(k);
      const rest = q.toString();
      history.replaceState(null, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
    } else if (q.get("errorCode")) {
      save(STORE_PENDING, null);
    }
  }
  return c;
};
