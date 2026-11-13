// Chain access for the relayer, tuned for latency:
//  - the final block hash is cached and refreshed in the background (a tx stays valid for ~86,400 blocks),
//  - the relayer nonce is cached by near-kit's nonce manager after the first fetch,
//  => one RPC round-trip per relayed click: `send_tx` with wait_until=EXECUTED_OPTIMISTIC.
import { Near, InMemoryKeyStore, decodeSignedDelegateAction } from "near-kit";

export type ChainConfig = {
  network: "testnet" | "mainnet";
  rpcUrl: string;
  relayerId: string;
  relayerKey: string;
  gameContractId: string;
  /** the match-server account (the only one the contract lets settle) */
  serverId?: string;
  serverKey?: string;
};

type Block = { header: { hash: string; height: number } };

export class Chain {
  readonly near: Near;
  private block: Block | null = null;
  private refreshing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly cfg: ChainConfig;

  constructor(cfg: ChainConfig) {
    this.cfg = cfg;
    this.near = new Near({
      network: cfg.network,
      rpcUrl: cfg.rpcUrl,
      keyStore: new InMemoryKeyStore({
        [cfg.relayerId]: cfg.relayerKey,
        ...(cfg.serverId && cfg.serverKey ? { [cfg.serverId]: cfg.serverKey } : {}),
      }),
    });
    // near-kit fetches the final block on every sign; serve it from the cache instead.
    const rpc = (this.near as unknown as { _rpc: { getBlock: (o: unknown) => Promise<Block> } })._rpc;
    const original = rpc.getBlock.bind(rpc);
    rpc.getBlock = async (opts: unknown) => {
      const o = opts as { finality?: string } | undefined;
      if (o?.finality === "final" && this.block) return this.block;
      const b = await original(opts);
      if (o?.finality === "final") this.block = b;
      return b;
    };
    this.getRawBlock = original;
  }

  private getRawBlock: (o: unknown) => Promise<Block>;

  async start(refreshMs = 15_000) {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), refreshMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  get height(): bigint | undefined {
    return this.block ? BigInt(this.block.header.height) : undefined;
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.getRawBlock({ finality: "final" })
      .then((b) => {
        this.block = b;
      })
      .catch(() => {})
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /** Warm the nonce cache so the first player click doesn't pay for it. */
  async warm() {
    await this.near.getBalance(this.cfg.relayerId).catch(() => {});
  }

  decode(payload: string) {
    return decodeSignedDelegateAction(payload);
  }

  async relay(payload: string) {
    const sd = decodeSignedDelegateAction(payload);
    const o = await this.near
      .transaction(this.cfg.relayerId)
      .signedDelegateAction(sd)
      .send({ waitUntil: "EXECUTED_OPTIMISTIC" });
    return { tx: o.transaction.hash as string, value: gameValue(o, this.cfg.gameContractId), failure: gameFailure(o), outcome: o };
  }

  /** NEP-145: the relayer prepays a guest's storage (guests' function-call keys can't attach deposits). */
  async storageDeposit(accountId: string, amount: string) {
    const o = await this.near
      .transaction(this.cfg.relayerId)
      .functionCall(this.cfg.gameContractId, "storage_deposit", { account_id: accountId }, { gas: "10 Tgas", attachedDeposit: amount })
      .send({ waitUntil: "EXECUTED_OPTIMISTIC" });
    return { tx: o.transaction.hash as string, failure: gameFailure(o) };
  }

  /** settle_match, signed by the match-server key. */
  async settle(args: Record<string, unknown>, gas = "150 Tgas") {
    if (!this.cfg.serverId) throw new Error("no match-server key configured");
    const o = await this.near
      .transaction(this.cfg.serverId)
      .functionCall(this.cfg.gameContractId, "settle_match", args, { gas })
      .send({ waitUntil: "EXECUTED_OPTIMISTIC" });
    const burnt = o.receipts_outcome.reduce((a: bigint, r: { outcome: { gas_burnt: number } }) => a + BigInt(r.outcome.gas_burnt), BigInt(o.transaction_outcome.outcome.gas_burnt));
    return { tx: o.transaction.hash as string, value: gameValue(o, this.cfg.gameContractId), failure: gameFailure(o), events: gameEvents(o, this.cfg.gameContractId), tgas: Number(burnt / 1_000_000_000n) / 1000 };
  }

  view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    // optimistic: a match started a second ago must already be visible to the settle request
    return this.near.view(this.cfg.gameContractId, method, args, { finality: "optimistic" }) as Promise<T>;
  }

  async createGuest(accountId: string, publicKey: string, methods: readonly string[], funding: string, allowance: string) {
    const o = await this.near
      .transaction(this.cfg.relayerId)
      .createAccount(accountId)
      .transfer(accountId, funding)
      .addKey(publicKey, { type: "functionCall", receiverId: this.cfg.gameContractId, methodNames: [...methods], allowance })
      .send({ waitUntil: "EXECUTED_OPTIMISTIC" });
    return { tx: o.transaction.hash as string };
  }
}

type Outcome = {
  receipts_outcome: Array<{ outcome: { executor_id: string; status: Record<string, unknown> } }>;
};

/** The last value returned by the game contract in this tx (e.g. the drawn token from `resolve_draw`). */
export function gameValue(o: Outcome, gameId: string): unknown {
  let value: unknown = null;
  for (const r of o.receipts_outcome) {
    if (r.outcome.executor_id !== gameId) continue;
    const v = r.outcome.status.SuccessValue;
    if (typeof v === "string" && v.length > 0) {
      const s = Buffer.from(v, "base64").toString();
      try {
        value = JSON.parse(s);
      } catch {
        value = s;
      }
    }
  }
  return value;
}

/** The game's NEP-297 events (`standard: "bountyroyale"`) emitted in this tx, in order. */
export function gameEvents(o: { receipts_outcome: Array<{ outcome: { executor_id: string; logs?: string[] } }> }, gameId: string): Array<{ event: string; data: Record<string, unknown> }> {
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const r of o.receipts_outcome) {
    if (r.outcome.executor_id !== gameId) continue;
    for (const l of r.outcome.logs ?? []) {
      if (!l.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(l.slice("EVENT_JSON:".length));
        if (e.standard === "bountyroyale") for (const d of e.data ?? []) out.push({ event: e.event, data: d });
      } catch {
        // not ours
      }
    }
  }
  return out;
}

/** First failure inside the receipts (e.g. a contract panic in the relayed call), as a readable message. */
export function gameFailure(o: Outcome): string | null {
  for (const r of o.receipts_outcome) {
    const f = r.outcome.status.Failure as unknown;
    if (!f) continue;
    const s = JSON.stringify(f);
    const m = s.match(/Smart contract panicked: (?:panicked at [^\\]*?:\\n)?([^"]+)/);
    return m ? m[1].replace(/\\n/g, " ").trim() : s;
  }
  return null;
}
