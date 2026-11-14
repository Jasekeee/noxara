// What the relayer is willing to pay gas for. Pure functions: unit-tested in test/policy.test.ts.

export type RelayPolicy = {
  gameContractId: string;
  guestParentId: string;
  allowedMethods: readonly string[];
  maxGasPerAction: bigint;
  maxActions: number;
  /** Optional per-method gas caps (tighter than maxGasPerAction). */
  methodGas?: Record<string, bigint>;
};

const TGAS = 1_000_000_000_000n;
/** Game methods the relayer pays gas for (RELAY_METHODS overrides). Guests' own keys allow only start/sweep. */
export const GAME_METHODS_DEFAULT: readonly string[] = [
  "start_match", "sweep_match", "sponsor", "unsponsor", "claim_welcome", "buy_ipo", "claim_dividends", "cancel_listing",
  "buy_cosmetic", "prune_listings", "check_in", "claim_quest", "claim_login",
];
export const METHOD_GAS_DEFAULT: Record<string, bigint> = {
  start_match: 150n * TGAS, sweep_match: 30n * TGAS, sponsor: 50n * TGAS, unsponsor: 50n * TGAS, claim_welcome: 30n * TGAS, claim_login: 30n * TGAS,
};

export type DelegateLike = {
  senderId: string;
  receiverId: string;
  actions: Array<Record<string, unknown>>;
  maxBlockHeight: bigint;
};

export type PolicyResult = { ok: true; methods: string[]; gas: bigint } | { ok: false; reason: string };

export const GUEST_PREFIX = "g-";

/** A guest is `g-<x>.<parent>` for any of the given parents: the relayer (guests it created itself, testnet) or
 *  the game contract (guests made by its `create_guest`, mainnet). Same rule as the contract's `is_guest`. */
export function isGuestAccount(accountId: string, ...parents: Array<string | undefined>): boolean {
  return parents.some((parent) => {
    if (!parent || !accountId.endsWith(`.${parent}`)) return false;
    const local = accountId.slice(0, -(parent.length + 1));
    return local.startsWith(GUEST_PREFIX) && local.length > GUEST_PREFIX.length && !local.includes(".");
  });
}

/** `create_guest` ids: 8-32 lowercase hex characters (mirrors the contract's `valid_guest_id`). */
export const isGuestId = (id: string) => /^[0-9a-f]{8,32}$/.test(id);

export function checkDelegate(d: DelegateLike, p: RelayPolicy, currentHeight?: bigint): PolicyResult {
  if (d.receiverId !== p.gameContractId) return { ok: false, reason: "receiver is not the game contract" };
  if (d.senderId === p.gameContractId || d.senderId === p.guestParentId) return { ok: false, reason: "sender not allowed" };
  if (!Array.isArray(d.actions) || d.actions.length === 0) return { ok: false, reason: "no actions" };
  if (d.actions.length > p.maxActions) return { ok: false, reason: "too many actions" };
  const methods: string[] = [];
  for (const a of d.actions) {
    const keys = Object.keys(a);
    if (keys.length !== 1 || keys[0] !== "functionCall") return { ok: false, reason: "only function calls are relayed" };
    const fc = a.functionCall as { methodName: string; gas: bigint; deposit: bigint };
    if (!p.allowedMethods.includes(fc.methodName)) return { ok: false, reason: `method not allowed: ${fc.methodName}` };
    if (BigInt(fc.deposit) !== 0n) return { ok: false, reason: "deposit must be zero" };
    if (BigInt(fc.gas) > p.maxGasPerAction) return { ok: false, reason: "too much gas" };
    const cap = p.methodGas?.[fc.methodName];
    if (cap !== undefined && BigInt(fc.gas) > cap) return { ok: false, reason: `too much gas for ${fc.methodName}` };
    methods.push(fc.methodName);
  }
  if (currentHeight !== undefined && d.maxBlockHeight <= currentHeight) return { ok: false, reason: "delegate action expired" };
  return { ok: true, methods, gas: d.actions.reduce((a, x) => a + BigInt((x.functionCall as { gas: bigint }).gas), 0n) };
}

/** Fixed-window counter, in memory (one relayer instance). */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private limit: number;
  private windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  take(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now >= h.reset) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 50_000) this.sweep(now);
      return true;
    }
    if (h.n >= this.limit) return false;
    h.n++;
    return true;
  }
  private sweep(now: number) {
    for (const [k, v] of this.hits) if (now >= v.reset) this.hits.delete(k);
  }
}

/** Fixed-window budget of a quantity (e.g. Tgas) per key. */
export class Budget {
  private used = new Map<string, { n: bigint; reset: number }>();
  private cap: bigint;
  private windowMs: number;
  constructor(cap: bigint, windowMs: number) {
    this.cap = cap;
    this.windowMs = windowMs;
  }
  take(key: string, amount: bigint, now = Date.now()): boolean {
    const u = this.used.get(key);
    if (!u || now >= u.reset) {
      if (amount > this.cap) return false;
      this.used.set(key, { n: amount, reset: now + this.windowMs });
      if (this.used.size > 50_000) this.sweep(now);
      return true;
    }
    if (u.n + amount > this.cap) return false;
    u.n += amount;
    return true;
  }
  /** Give back a reservation that was never spent (e.g. the relay failed before sending). */
  refund(key: string, amount: bigint) {
    const u = this.used.get(key);
    if (u) u.n = u.n > amount ? u.n - amount : 0n;
  }
  private sweep(now: number) {
    for (const [k, v] of this.used) if (now >= v.reset) this.used.delete(k);
  }
}
