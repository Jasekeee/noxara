// Read-only view proxy (audit F-6): the browser asks the match server for the game contract's views instead of
// hammering the free public RPC from every tab. Strictly: one contract (the game), `call_function` only, an
// allow-list of view method names, small JSON-object args. A TTL cache keyed by method+args, in-flight
// coalescing, stale-on-error (RPC 429/5xx/timeouts serve the last good answer), a global upstream budget and
// simple failover across several RPC URLs. No keys are involved; nothing here can write to the chain.

/** Views the browser client actually calls (src/net/client.ts) -> cache TTL in ms. */
export const VIEW_TTL_MS: Readonly<Record<string, number>> = {
  // contract constants
  get_config: 60_000,
  // global live state, shared by every visitor
  get_fighters: 5_000,
  get_retired: 30_000,
  get_economy: 5_000,
  get_shares_market: 5_000,
  get_market: 5_000,
  get_listings: 5_000,
  get_top: 10_000,
  get_season_standings: 10_000,
  // per-fighter history (title sparklines, profiles): changes only at settle
  get_history: 30_000,
  // per-account state: coalescing more than caching (the player just acted)
  ft_balance_of: 2_000,
  storage_balance_of: 2_000,
  get_welcome_credit: 2_000,
  get_progress: 2_000,
  get_sponsorships: 2_000,
  get_holdings: 2_000,
  get_daily: 2_000,
  get_login: 2_000,
};

export const MAX_ARGS_BYTES = 512;
const MAX_ENTRIES = 5_000;

export type ViewReply = { status: number; body: Record<string, unknown> };

/** One JSON-RPC POST (injectable for tests). Resolves with the HTTP status and parsed JSON (or null). */
export type RpcPost = (url: string, body: unknown, timeoutMs: number) => Promise<{ status: number; json: unknown }>;

export const fetchRpc: RpcPost = async (url, body, timeoutMs) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
};

/** Deterministic JSON (sorted keys) so `{a,b}` and `{b,a}` share one cache entry. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** Validate a request: an allow-listed method and a small plain-object args. */
export function checkViewRequest(method: unknown, args: unknown): { ok: true; method: string; args: Record<string, unknown>; key: string } | { ok: false; reason: string } {
  if (typeof method !== "string" || !Object.hasOwn(VIEW_TTL_MS, method)) return { ok: false, reason: "view not allowed" };
  const a = args === undefined || args === null ? {} : args;
  if (typeof a !== "object" || Array.isArray(a)) return { ok: false, reason: "args must be a JSON object" };
  const s = stableJson(a);
  if (s.length > MAX_ARGS_BYTES) return { ok: false, reason: "args too large" };
  return { ok: true, method, args: a as Record<string, unknown>, key: `${method}:${s}` };
}

type Entry = { at: number; status: number; body: Record<string, unknown> };
type Upstream = { kind: "ok"; value: unknown } | { kind: "contract"; status: number; code: string; error: string } | { kind: "busy"; error: string };

export type ViewProxyOptions = {
  contract: string;
  rpcUrls: string[];
  post?: RpcPost;
  now?: () => number;
  /** upstream RPC calls per minute for everyone (misses beyond this get stale data or 503) */
  upstreamPerMin?: number;
  timeoutMs?: number;
};

export class ViewProxy {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Entry>>();
  private upstreamHits: { n: number; reset: number } = { n: 0, reset: 0 };
  readonly stats = { hits: 0, misses: 0, stale: 0, busy: 0 };

  private o: ViewProxyOptions;
  constructor(o: ViewProxyOptions) {
    this.o = o;
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  /** Drop cached answers after our own tx changed the chain: live state only (a relayed call), or everything
   *  (a settle also writes histories). Stale-on-error then has nothing for those keys, which is fine. */
  invalidate(all = false) {
    if (all) return this.cache.clear();
    for (const k of this.cache.keys()) if (VIEW_TTL_MS[k.slice(0, k.indexOf(":"))] <= 10_000) this.cache.delete(k);
  }

  async view(method: unknown, args: unknown, fresh = false): Promise<ViewReply> {
    const req = checkViewRequest(method, args);
    if (!req.ok) return { status: 400, body: { error: req.reason, code: "bad_view" } };
    const ttl = VIEW_TTL_MS[req.method];
    const hit = this.cache.get(req.key);
    if (hit && !fresh && this.now() - hit.at < ttl) {
      this.stats.hits++;
      return { status: hit.status, body: { ...hit.body, cached: true } };
    }
    let p = this.inflight.get(req.key);
    if (!p) {
      p = this.fetchEntry(req.method, req.args, req.key).finally(() => this.inflight.delete(req.key));
      this.inflight.set(req.key, p);
    }
    const e = await p;
    return { status: e.status, body: e.body };
  }

  private async fetchEntry(method: string, args: Record<string, unknown>, key: string): Promise<Entry> {
    this.stats.misses++;
    const up = this.takeUpstream() ? await this.upstream(method, args) : ({ kind: "busy", error: "too many upstream calls" } as Upstream);
    const now = this.now();
    if (up.kind === "busy") {
      const old = this.cache.get(key);
      if (old && old.status === 200) {
        this.stats.stale++;
        return { ...old, body: { ...old.body, stale: true, age_ms: now - old.at } };
      }
      this.stats.busy++;
      return { at: now, status: 503, body: { error: "live data is unavailable right now", code: "rpc_busy" } };
    }
    const e: Entry = up.kind === "ok" ? { at: now, status: 200, body: { result: up.value } } : { at: now, status: up.status, body: { error: up.error, code: up.code } };
    this.cache.delete(key);
    this.cache.set(key, e);
    if (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return e;
  }

  private takeUpstream(): boolean {
    const cap = this.o.upstreamPerMin ?? 600;
    const now = this.now();
    if (now >= this.upstreamHits.reset) this.upstreamHits = { n: 0, reset: now + 60_000 };
    if (this.upstreamHits.n >= cap) return false;
    this.upstreamHits.n++;
    return true;
  }

  /** Try each RPC URL in order; the first definitive answer (a result or a contract error) wins. */
  private async upstream(method: string, args: Record<string, unknown>): Promise<Upstream> {
    const post = this.o.post ?? fetchRpc;
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: { request_type: "call_function", finality: "optimistic", account_id: this.o.contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    };
    let last = "no rpc";
    for (const url of this.o.rpcUrls) {
      try {
        const r = await post(url, body, this.o.timeoutMs ?? 6_000);
        const j = r.json as { result?: { result?: number[]; error?: string }; error?: unknown } | null;
        if (r.status === 429 || r.status >= 500 || !j) {
          last = `HTTP ${r.status}`;
          continue;
        }
        const err = j.error ?? j.result?.error;
        if (err) {
          const s = typeof err === "string" ? err : JSON.stringify(err);
          if (/MethodNotFound|MethodResolveError/.test(s)) return { kind: "contract", status: 404, code: "method_not_found", error: "this view does not exist on the contract" };
          if (/CONTRACT_EXECUTION_ERROR|FunctionCallError|HostError|panicked|wasm execution/i.test(s)) return { kind: "contract", status: 400, code: "view_failed", error: s.slice(0, 300) };
          last = s.slice(0, 120); // node-side error (unknown block, timeout, rate limit body): try the next RPC
          continue;
        }
        if (!Array.isArray(j.result?.result)) {
          last = "bad rpc reply";
          continue;
        }
        const text = Buffer.from(j.result.result).toString();
        let value: unknown = null;
        try {
          value = text ? JSON.parse(text) : null;
        } catch {
          value = text;
        }
        return { kind: "ok", value };
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    return { kind: "busy", error: last };
  }
}
