// The game's chain glue (implements src/net/api.ts). The player never sees a wallet: a guest key is
// made in the browser (WebCrypto ed25519), the relayer creates the account and pays all gas, and
// `start_match` is a signed NEP-366 delegate action. If anything chain-side is unreachable the client
// drops to mode "offline": local seed + t1Roster(), the game stays fully playable.
import type { CreateGameClient, FighterInfo, GameClient, Payout, SettleResult, StartResult } from "./api";
import type { MatchConfig, MatchRecord, Personality } from "../sim/types";
import { t1Roster } from "../sim/roster";
import { matchConfigFromChain, type ChainMatch, type ChainRosterEntry } from "./roster";
import { ed25519Supported, generateKey, inputLogHash, rpc, settleMessage, signDelegate, Signer, toBase64, viewCall, type StoredKey } from "./near";

const env = ((import.meta as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;
const DEFAULTS = {
  relayer: env.VITE_RELAYER_URL ?? "http://127.0.0.1:8788",
  rpc: env.VITE_NEAR_RPC ?? "https://test.rpc.fastnear.com",
  contract: env.VITE_CONTRACT_ID ?? "royale.br-7e8492.testnet",
  explorer: env.VITE_EXPLORER ?? "https://testnet.nearblocks.io",
};
const STORE = "bountyroyale.guest.v1";
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

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}
function save(s: Saved) {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    /* still playable this session */
  }
}

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

class Client implements GameClient {
  private _mode: "chain" | "offline";
  private relayer: string;
  private rpcUrl: string;
  private contract: string;
  private explorer: string;
  private saved: Saved | null = null;
  private signer: Signer | null = null;
  private nonce = 0n;
  private maxBlockHeight = 0n;
  private synced = false;
  private cfgCache: ChainConfig | null = null;
  private rosters = new Map<string, ChainRosterEntry[]>();
  private localMatches = 0;

  constructor(mode: "chain" | "offline", o: { relayer: string; rpc: string; contract: string }) {
    this._mode = mode;
    this.relayer = o.relayer.replace(/\/$/, "");
    this.rpcUrl = o.rpc;
    this.contract = o.contract;
    this.explorer = DEFAULTS.explorer;
    const s = load();
    if (s && s.contract === this.contract) this.saved = s;
  }

  get mode() {
    return this._mode;
  }

  private goOffline(why: unknown) {
    if (this._mode === "chain") console.warn("[net] chain unavailable, playing offline:", why instanceof Error ? why.message : why);
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
    const id = this.saved?.accountId;
    return !id || id.startsWith("g-");
  }

  private async session(): Promise<Saved> {
    if (this.saved) {
      this.signer ??= await Signer.load(this.saved.key);
      return this.saved;
    }
    const key = await generateKey();
    const r = await postJson<{ accountId: string }>(`${this.relayer}/api/guest`, { publicKey: key.publicKey });
    if (!r.ok || !r.json.accountId) throw new Error(r.json.error ?? "could not create a guest");
    this.saved = { accountId: r.json.accountId, key, contract: this.contract };
    save(this.saved);
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

  private async relay<T>(methodName: string, args: unknown, retry = true): Promise<{ value: T; tx: string }> {
    await this.sync();
    const s = this.saved!;
    this.nonce += 1n;
    const payload = await signDelegate(this.signer!, {
      senderId: s.accountId,
      receiverId: this.contract,
      actions: [{ methodName, args, gas: START_GAS }],
      nonce: this.nonce,
      maxBlockHeight: this.maxBlockHeight,
    });
    const r = await postJson<{ value: T; tx: string }>(`${this.relayer}/api/relay`, { payload }, 45_000);
    if (!r.ok) {
      const msg = String(r.json.error ?? "relay failed");
      if (retry && /nonce|expired/i.test(msg)) {
        await this.sync(true);
        return this.relay<T>(methodName, args, false);
      }
      // the stored guest no longer works (e.g. a new contract): start over with a fresh guest
      if (retry && /unknown key|register first/i.test(msg)) {
        this.saved = null;
        this.signer = null;
        this.synced = false;
        return this.relay<T>(methodName, args, false);
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
        const [fs, cfg] = await Promise.all([viewCall<ChainFighter[]>(this.rpcUrl, this.contract, "get_fighters"), this.config()]);
        return fs.map((f) => ({
          slot: f.slot,
          account: f.account,
          name: f.name,
          personality: asPersonality(f.personality),
          balance: toBounty(f.balance),
          upgrades: { ...f.upgrades },
          record: { ...f.record, earnings: toBounty(f.record.earnings) },
          bounty: f.bounty,
          bountyValue: f.bounty ? toBounty((BigInt(f.balance) * BigInt(cfg.bounty_bps)) / 10_000n) : 0,
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
    const b = cfg.fighters.findIndex((f) => f.bounty);
    return { matchId: `local-${++this.localMatches}-${cfg.seed}`, cfg, pot: 0, bountyIdx: b >= 0 ? b : null, bountyValue: 0, playerPaid: 0, tx: null };
  }

  async settle(matchId: string, record: MatchRecord): Promise<SettleResult> {
    const unverified: SettleResult = { tx: null, verified: false, winner: record.winner, payouts: [], retired: [], rookies: [], upgrades: [] };
    if (matchId.startsWith("local-") || !this.saved || !this.signer) return unverified;
    try {
      const msg = await settleMessage(matchId, await inputLogHash(record.inputs));
      const signature = toBase64(await this.signer.sign(msg));
      const r = await postJson<{ tx: string; result: MatchResultJson; events: ChainEvent[] }>(
        `${this.relayer}/api/settle`,
        { match_id: matchId, record, publicKey: this.saved.key.publicKey, signature },
        60_000,
      );
      if (!r.ok) {
        console.warn("[net] settle refused:", r.json.error);
        return unverified;
      }
      return this.describe(matchId, record, r.json.tx, r.json.result, r.json.events ?? []);
    } catch (e) {
      console.warn("[net] settle failed:", e instanceof Error ? e.message : e);
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

  explorerTx(hash: string): string {
    return `${this.explorer}/txns/${hash}`;
  }
  explorerAccount(account: string): string {
    return `${this.explorer}/address/${account}`;
  }
}

/** Probe the relayer (short timeout) and return a chain client, or an offline one. Never throws. */
export const createGameClient: CreateGameClient = async (opts = {}) => {
  const o = { relayer: opts.relayer ?? DEFAULTS.relayer, rpc: opts.rpc ?? DEFAULTS.rpc, contract: opts.contract ?? DEFAULTS.contract };
  let mode: "chain" | "offline" = "offline";
  try {
    if (typeof crypto?.subtle === "undefined" || !(await ed25519Supported())) throw new Error("no WebCrypto ed25519");
    const r = await fetch(`${o.relayer.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(2500) });
    const h = (await r.json()) as { ok?: boolean; game?: string };
    if (!r.ok || !h.ok || h.game !== o.contract) throw new Error(`relayer serves ${h.game ?? "?"}, not ${o.contract}`);
    mode = "chain";
  } catch (e) {
    console.warn("[net] offline mode:", e instanceof Error ? e.message : e);
  }
  return new Client(mode, o);
};
