// The relayer's NEAR budget ("guest budget mode"): everything the relayer spends on players — new
// guest accounts, their storage, registrations, and the gas of relayed calls — comes out of a fixed
// total (default 1 NEAR) plus a daily cap on new guests. When either runs out the relayer closes
// cleanly: /api/health says `guests: "closed"` with a reason, guests play offline, and signed-in
// real accounts keep playing by signing their own transactions (their key's allowance pays the gas).
// Match settlement is not counted (it is the match server's job, paid from the same account).
// Persisted so a restart doesn't reset it.
import fs from "node:fs";
import path from "node:path";

const YOCTO = 10n ** 24n;
export const near = (s: string) => {
  const [i, f = ""] = s.trim().split(".");
  return BigInt(i || "0") * YOCTO + BigInt((f + "0".repeat(24)).slice(0, 24));
};
export const fmtNear = (y: bigint) => `${y / YOCTO}.${(y % YOCTO).toString().padStart(24, "0").slice(0, 4)}`;

type State = { spent: string; day: number; guestsToday: number };

export class SpendBudget {
  readonly total: bigint;
  readonly dailyGuests: number;
  private s: State;
  private file: string;

  constructor(file: string, totalNear: string, dailyGuests: number, now = Date.now()) {
    this.file = file;
    this.total = near(totalNear);
    this.dailyGuests = dailyGuests;
    this.s = { spent: "0", day: Math.floor(now / 86_400_000), guestsToday: 0 };
    try {
      this.s = { ...this.s, ...(JSON.parse(fs.readFileSync(file, "utf8")) as State) };
    } catch {
      // first run
    }
  }

  get spent(): bigint {
    return BigInt(this.s.spent);
  }
  get remaining(): bigint {
    return this.total > this.spent ? this.total - this.spent : 0n;
  }

  private roll(now: number) {
    const day = Math.floor(now / 86_400_000);
    if (day !== this.s.day) this.s = { ...this.s, day, guestsToday: 0 };
  }

  /** null if open, else why it's closed for this kind of spending. */
  closed(kind: "guest" | "relay" | "register", reserve: bigint, now = Date.now()): null | "budget" | "daily_cap" {
    this.roll(now);
    if (this.remaining < reserve) return "budget";
    if (kind === "guest" && this.s.guestsToday >= this.dailyGuests) return "daily_cap";
    return null;
  }

  /** Overall status for /api/health (closed when not even a relayed call fits). */
  status(now = Date.now()): { guests: "open" | "closed"; reason?: string; remaining: string; guestsToday: number } {
    const r = this.closed("guest", RESERVE.guest, now);
    return { guests: r ? "closed" : "open", ...(r ? { reason: r } : {}), remaining: fmtNear(this.remaining), guestsToday: this.s.guestsToday };
  }

  spend(yocto: bigint, kind?: "guest") {
    this.s.spent = (this.spent + (yocto > 0n ? yocto : 0n)).toString();
    if (kind === "guest") this.s.guestsToday++;
    this.persist();
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.s));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}

/** What we keep in hand before starting each kind of spending (upper-bound estimates). */
export const RESERVE = {
  guest: near("0.025"), // account funding + guest storage + 2 txs of gas
  relay: near("0.012"), // a relayed call: <= 100 Tgas attached at the max gas price, refunds come back
  register: near("0.025"), // a real account's storage subsidy + gas
};

/** NEAR actually burnt by a transaction (all receipts). */
export function tokensBurnt(o: { transaction_outcome: { outcome: { tokens_burnt: string } }; receipts_outcome: { outcome: { tokens_burnt: string } }[] }): bigint {
  return BigInt(o.transaction_outcome.outcome.tokens_burnt) + o.receipts_outcome.reduce((a, r) => a + BigInt(r.outcome.tokens_burnt), 0n);
}
