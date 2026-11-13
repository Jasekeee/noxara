// Every account gets the relayer's storage subsidy at most ONCE, ever (persisted to disk), within an
// hourly budget. Together with the contract refunding a subsidised deposit to its payer (the relayer),
// register -> storage_unregister -> register can't drain the relayer or pay the attacker.
import fs from "node:fs";
import path from "node:path";

export class Subsidies {
  private done = new Set<string>();
  private file: string;
  private perHour: number;
  private window: { n: number; reset: number } = { n: 0, reset: 0 };

  constructor(file: string, perHour: number) {
    this.file = file;
    this.perHour = perHour;
    try {
      for (const a of JSON.parse(fs.readFileSync(file, "utf8")) as string[]) this.done.add(a);
    } catch {
      // first run
    }
  }

  has(account: string): boolean {
    return this.done.has(account);
  }

  /** Reserve a subsidy for `account`: false if it ever had one or the hourly budget is spent. */
  take(account: string, now = Date.now()): { ok: true } | { ok: false; reason: "already_subsidised" | "budget" } {
    if (this.done.has(account)) return { ok: false, reason: "already_subsidised" };
    if (now >= this.window.reset) this.window = { n: 0, reset: now + 3_600_000 };
    if (this.window.n >= this.perHour) return { ok: false, reason: "budget" };
    this.window.n++;
    this.done.add(account);
    this.persist();
    return { ok: true };
  }

  /** Give back a reservation whose deposit never happened (the tx failed). */
  release(account: string) {
    if (this.done.delete(account)) {
      this.window.n = Math.max(0, this.window.n - 1);
      this.persist();
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.done]));
    fs.renameSync(tmp, this.file);
  }
}
