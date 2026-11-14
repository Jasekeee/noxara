// Browser client for the chain (the lead wires it into the game; needs near-kit 0.20.2 +
// @noble/hashes 2.4.0 in the root package.json). The player never sees any of this: a guest key is
// made locally, the relayer creates the account and pays gas, `start_match` is a signed NEP-366
// delegate action, and the finished match's record is signed and handed to the match server.
//
//   const s = Session.restore(cfg) ?? await Session.createGuest(cfg);
//   const m = await s.startMatch();                       // ~2-4 s: entries paid, seed from the chain
//   const matchCfg = matchConfigFromChain(m, { name: "You" }); // -> createMatch(matchCfg)
//   ... play, record inputs ...
//   const r = await s.settle(m.match_id, record);         // server re-runs it, then settles on chain
import { Near, InMemoryKeyStore, generateKey, parseKey } from "near-kit";
import type { MatchRecord } from "../../src/sim/types.ts";
import type { ChainMatch } from "./roster.ts";
import { inputLogHash, settleMessage } from "./protocol.ts";

export { matchConfigFromChain } from "./roster.ts";
export type { ChainMatch } from "./roster.ts";

export type ChainConfig = {
  network: "testnet" | "mainnet";
  rpc: string; // e.g. https://test.rpc.fastnear.com
  relayer: string; // e.g. http://127.0.0.1:8788
  game: string; // the royale contract id
};

type Saved = { accountId: string; secretKey: string; publicKey: string; game: string };
const KEY = "bountyroyale.session.v1";

export class RelayError extends Error {
  tx?: string;
  constructor(msg: string, tx?: string) {
    super(msg);
    this.tx = tx;
  }
}

async function rpc<T>(cfg: ChainConfig, method: string, params: unknown): Promise<T> {
  const r = await fetch(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error?.cause?.name ?? j.error?.message ?? "rpc error");
  return j.result as T;
}

/** Read-only contract call (get_fighters, get_leaderboard, get_match, ft_balance_of, ...). */
export async function view<T>(cfg: ChainConfig, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>(cfg, "query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: cfg.game,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}

export class Session {
  readonly accountId: string;
  readonly publicKey: string;
  readonly cfg: ChainConfig;
  private secretKey: string;
  private near: Near;
  private nonce = 0n;
  private maxBlockHeight = 0n;
  private ready: Promise<void> | null = null;
  lastTx: string | null = null;

  private constructor(cfg: ChainConfig, s: Saved) {
    this.cfg = cfg;
    this.accountId = s.accountId;
    this.publicKey = s.publicKey;
    this.secretKey = s.secretKey;
    this.near = new Near({ network: cfg.network, rpcUrl: cfg.rpc, keyStore: new InMemoryKeyStore({ [s.accountId]: s.secretKey }) });
  }

  get guest(): boolean {
    return this.accountId.startsWith("g-");
  }

  static restore(cfg: ChainConfig): Session | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as Saved;
      return s.game === cfg.game ? new Session(cfg, s) : null;
    } catch {
      return null;
    }
  }

  /** Make a key in the browser and ask the relayer for a guest account (no wallet, no gas). */
  static async createGuest(cfg: ChainConfig): Promise<Session> {
    const kp = generateKey();
    const publicKey = kp.publicKey.toString();
    const r = await fetch(`${cfg.relayer}/api/guest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKey }) });
    const j = await r.json().catch(() => ({ error: "relayer unreachable" }));
    if (!r.ok) throw new RelayError(j.error ?? "could not join the island");
    const saved: Saved = { accountId: j.accountId, secretKey: kp.secretKey, publicKey, game: cfg.game };
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      /* still playable this session */
    }
    const s = new Session(cfg, saved);
    s.lastTx = j.tx;
    return s;
  }

  static forget() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }

  /** One RPC call per session: the key's nonce and a block height for expiry. */
  sync(force = false): Promise<void> {
    if (this.ready && !force) return this.ready;
    this.ready = (async () => {
      for (let i = 0; i < 30; i++) {
        try {
          const ak = await rpc<{ nonce: number; block_height: number }>(this.cfg, "query", {
            request_type: "view_access_key",
            finality: "optimistic",
            account_id: this.accountId,
            public_key: this.publicKey,
          });
          this.nonce = BigInt(ak.nonce);
          this.maxBlockHeight = BigInt(ak.block_height) + 20_000n;
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 250)); // the new account may not be visible yet
        }
      }
      throw new RelayError("the island is unreachable (network)");
    })();
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  /** Sign a delegate action locally (no RPC) and hand it to the relayer. */
  async call<T>(method: string, args: Record<string, unknown> = {}, gasTgas = 100, retry = true): Promise<T> {
    await this.sync();
    this.nonce += 1n;
    const { payload } = await this.near
      .transaction(this.accountId)
      .functionCall(this.cfg.game, method, args, { gas: `${gasTgas} Tgas` })
      .delegate({ nonce: this.nonce, maxBlockHeight: this.maxBlockHeight, publicKey: this.publicKey });
    const r = await fetch(`${this.cfg.relayer}/api/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload }) });
    const j = await r.json().catch(() => ({ error: "relayer unreachable" }));
    if (!r.ok) {
      const msg = String(j.error ?? "something went wrong");
      if (retry && /nonce|expired/i.test(msg)) {
        await this.sync(true);
        return this.call<T>(method, args, gasTgas, false);
      }
      throw new RelayError(msg, j.tx);
    }
    this.lastTx = j.tx;
    return j.value as T;
  }

  /** Bots pay their entries; the seed comes from the next block. Returns the on-chain match. */
  startMatch(): Promise<ChainMatch & { match_id: string }> {
    return this.call("start_match", {}, 100);
  }

  /** Hand the finished match's record to the match server (signed with this session's key). */
  async settle(matchId: string, record: MatchRecord): Promise<{ tx: string; result: unknown; replay_ms: number }> {
    const sig = parseKey(this.secretKey).sign(settleMessage(matchId, inputLogHash(record.inputs)));
    const signature = btoa(String.fromCharCode(...sig.data));
    const r = await fetch(`${this.cfg.relayer}/api/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ match_id: matchId, record, publicKey: this.publicKey, signature }),
    });
    const j = await r.json().catch(() => ({ error: "match server unreachable" }));
    if (!r.ok) throw new RelayError(String(j.error ?? "settlement failed"), j.tx);
    this.lastTx = j.tx;
    return j;
  }
}

/** Real account id, middle-truncated, always ending in its suffix (guests included). Mirrors src/net/acctname.ts. */
export function shortName(id: string, max = 26): string {
  if (id.length <= max) return id;
  if (/^[0-9a-f]{64}$/.test(id)) return `${id.slice(0, 8)}…${id.slice(-6)}`;
  const labels = id.split(".");
  let tail = labels.length >= 3 ? labels.slice(-2).join(".") : id.slice(-Math.min(id.length - 4, Math.max(8, Math.floor(max / 2))));
  if (tail.length > 18) tail = tail.slice(-18);
  const head = id.slice(0, Math.max(3, max - tail.length - 1));
  return head.length + 1 + tail.length >= id.length ? id : `${head}…${tail}`;
}
