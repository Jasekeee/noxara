// Daily tournament (docs/DECISIONS.md row 8): one seed per UTC day, free, server-verified leaderboard.
//  seed   = first 4 bytes (big endian) of sha256("noxara-daily-" + YYYY-MM-DD), 1 if that is 0
//  roster = t1Roster() with every upgrade at base: the same match for everyone, at any level, offline
//           reproducible from the date alone (a chain roster snapshot would add a chain dependency and a
//           stored file for no gain: the bots' stats would differ from what an offline tester can rebuild)
//  score  = placement first, then kills, then ticks survived; best run per player is kept
// Prizes are never automatic: scripts/daily-prizes.ts prints owner commands (dry run only).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SIM_VERSION, type MatchConfig, type MatchRecord } from "../../src/sim/types.ts";
import { t1Roster } from "../../src/sim/roster.ts";
import { checkInputs, checkSimVersion, inputLogHash } from "./settle.ts";
import { RateLimiter } from "./policy.ts";
import { settleSignatureOk } from "./verify.ts";
import { analyze, cleanName, compareScores, err, readJson, tooFast, writeJson, type Analysis, type Reply, type Score, type Tokens } from "./social.ts";

export const DAILY_TOKEN_MAX_AGE_MS = 45 * 60_000;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const dayEnd = (day: string) => Date.parse(`${day}T00:00:00Z`) + DAY_MS;

export function dailySeed(day: string): number {
  const n = crypto.createHash("sha256").update(`noxara-daily-${day}`).digest().readUInt32BE(0);
  return n === 0 ? 1 : n;
}
export function dailyConfig(day: string): MatchConfig {
  return { seed: dailySeed(day), fighters: t1Roster() };
}

/** What a signed-in client signs (raw ed25519, sha256 of this string) to claim its daily entry. */
export function dailyMessage(day: string, logHash: string): Uint8Array {
  return new Uint8Array(crypto.createHash("sha256").update(`noxara:daily:${day}:${logHash}`).digest());
}

export type EntryKind = "real" | "guest" | "unverified";
export type Entry = Score & {
  key: string;
  name: string;
  kind: EntryKind;
  /** verified real NEAR account (never for guests / unverified) */
  account?: string;
  /** 0 = guests and unverified entries earn nothing; null = a verified real account (prizes are decided by the owner script) */
  earns: 0 | null;
  kills: number;
  bountyKilled: boolean;
  at: number;
};
type DayFile = { day: string; seed: number; entries: Record<string, Entry>; usedTokens: string[] };

export type DailyOpts = {
  dir: string;
  tokens: Tokens;
  realtimeFactor: () => number;
  /** is this key an access key of this NEAR account? (RPC lookup in the server; stubbed in tests) */
  verifyOwner: (account: string, publicKey: string) => Promise<boolean>;
  /** the relayer account that parents guest accounts (g-xxx.<parent>) */
  guestParent?: string;
  now?: () => number;
  submitPerIpPerHour?: number;
};

const GUEST_ID = /^[a-z0-9]{8,32}$/;

export class Daily {
  private o: DailyOpts;
  private limit: RateLimiter;
  private cache = new Map<string, DayFile>();
  constructor(o: DailyOpts) {
    this.o = o;
    fs.mkdirSync(o.dir, { recursive: true });
    this.limit = new RateLimiter(o.submitPerIpPerHour ?? 30, 3_600_000);
  }
  private now = () => (this.o.now ?? Date.now)();
  private file = (day: string) => path.join(this.o.dir, `${day}.json`);
  private day(day: string): DayFile {
    let d = this.cache.get(day);
    if (!d) {
      d = readJson<DayFile>(this.file(day)) ?? { day, seed: dailySeed(day), entries: {}, usedTokens: [] };
      // evict only old days: today's file (the one being written) is never dropped from the cache
      if (this.cache.size > 8) for (const k of this.cache.keys()) if (k !== utcDay(this.now())) this.cache.delete(k);
      this.cache.set(day, d);
    }
    return d;
  }

  /** GET /api/daily */
  today(): Reply {
    const t = this.now();
    const day = utcDay(t);
    const tok = this.o.tokens.issue(day, t);
    return { code: 200, json: { day, seed: dailySeed(day), roster: t1Roster(), endsAt: dayEnd(day), token: tok.token, simVersion: SIM_VERSION, players: Object.keys(this.day(day).entries).length } };
  }

  /** POST /api/daily/submit {record, token, simVersion, name?, guestId?, account?, publicKey?, signature?} */
  async submit(body: Record<string, unknown>, ip: string): Promise<Reply> {
    const now = this.now();
    if (!this.limit.take(ip, now)) return err(429, "slow down: too many submissions from this address", "rate_limited");
    const ver = checkSimVersion(body.simVersion);
    if (!ver.ok) return { code: ver.status, json: { error: ver.reason, code: ver.code, simVersion: SIM_VERSION } };
    const tokenStr = String(body.token ?? "");
    const day = tokenStr.split(".")[0] ?? "";
    if (!DAY_RE.test(day)) return err(401, "bad or missing daily token: open DAILY again", "bad_token");
    const tok = this.o.tokens.check(tokenStr, day);
    if (!tok) return err(401, "bad or missing daily token: open DAILY again", "bad_token");
    if (now - tok.issuedAt > DAILY_TOKEN_MAX_AGE_MS || tok.issuedAt > now + 60_000) return err(409, "this attempt expired: start it again from DAILY", "token_expired");
    // a closed day is final: no grace after midnight UTC, and the token must have been issued on that day
    if (now >= dayEnd(day) || utcDay(tok.issuedAt) !== day) return err(409, "this daily is closed", "day_closed");
    const record = body.record as MatchRecord | undefined;
    if (!record || !Array.isArray(record.inputs) || typeof record.hash !== "string") return err(400, "missing record", "bad_request");
    const bad = checkInputs(record.inputs);
    if (bad) return err(400, bad, "bad_record");
    const d = this.day(day);
    if (d.usedTokens.includes(tok.nonce)) return err(409, "this attempt was already submitted: start a new one from DAILY", "token_used");
    // spend the token and persist it BEFORE any await (owner lookup), so a concurrent second submit sees it
    d.usedTokens.push(tok.nonce);
    if (d.usedTokens.length > 20_000) d.usedTokens.splice(0, 5_000);
    this.save(d);

    let a: Analysis;
    try {
      a = analyze(dailyConfig(day), record.inputs);
    } catch (e) {
      this.save(d);
      return err(400, `could not replay: ${(e as Error).message}`, "bad_record");
    }
    if (a.hash !== record.hash) {
      this.save(d);
      return err(409, "replay mismatch: the server's simulation disagrees with this record", "replay_mismatch");
    }
    const f = this.o.realtimeFactor();
    if (f > 0 && tooFast(a.ticksTotal, now - tok.issuedAt, f)) {
      this.save(d);
      return err(409, `this match lasts ${Math.round((a.ticksTotal * 50) / 1000)} s but was submitted ${Math.round((now - tok.issuedAt) / 1000)} s after it started`, "too_fast");
    }

    // ---- who is it? Only an ed25519 signature by a key of the claimed NEAR account counts as a real
    // account; guest accounts (g-*.<relayer>) verify the same way but never earn.
    const guestId = String(body.guestId ?? "");
    const account = typeof body.account === "string" ? body.account : "";
    const logHash = inputLogHash(record.inputs);
    let kind: EntryKind = "guest";
    let key: string;
    let name: string;
    let realAccount: string | undefined;
    let reason: string | undefined;
    if (account) {
      let ok = false;
      try {
        ok = settleSignatureOk(dailyMessage(day, logHash), String(body.publicKey ?? ""), String(body.signature ?? "")) && (await this.o.verifyOwner(account, String(body.publicKey)));
      } catch {
        ok = false;
      }
      const isGuestAcct = !!this.o.guestParent && account.endsWith(`.${this.o.guestParent}`) && account.startsWith("g-");
      if (ok && isGuestAcct) {
        kind = "guest";
        key = `acct:${account}`;
        name = `Guest ${account.slice(2, 6)}`;
      } else if (ok) {
        kind = "real";
        key = `acct:${account}`;
        realAccount = account;
        name = account;
      } else {
        // claimed an account but could not prove it: listed, flagged, never paid
        kind = "unverified";
        if (!GUEST_ID.test(guestId)) return err(401, "could not verify this account", "bad_signature");
        key = `unv:${guestId}`;
        name = `${cleanName(account, 24)} (unverified)`;
        reason = "the signature or key did not check out";
      }
    } else {
      if (!GUEST_ID.test(guestId)) return err(400, "missing guestId", "bad_request");
      key = `guest:${guestId}`;
      name = `Guest ${guestId.slice(0, 4)}`;
    }
    const entry: Entry = { key, name, kind, account: realAccount, earns: kind === "real" ? null : 0, placement: a.placement, kills: a.kills, ticksSurvived: a.ticksSurvived, bountyKilled: a.bountyKilled, at: now };
    // re-read after the awaits and merge into the live DayFile (never write a stale copy back)
    const live = this.day(day);
    for (const n of d.usedTokens) if (!live.usedTokens.includes(n)) live.usedTokens.push(n);
    if (now >= dayEnd(day) || this.now() >= dayEnd(day)) return err(409, "this daily is closed", "day_closed");
    const prev = live.entries[key];
    const improved = !prev || compareScores(entry, prev) < 0;
    if (improved) live.entries[key] = entry;
    this.save(live);
    const best = live.entries[key];
    const dd = live;
    return { code: 200, json: { ok: true, day, kind, name: best.name, earns: best.earns, improved, run: { placement: a.placement, kills: a.kills, ticksSurvived: a.ticksSurvived, bountyKilled: a.bountyKilled }, best: { placement: best.placement, kills: best.kills, ticksSurvived: best.ticksSurvived }, rank: this.rows(dd).findIndex((e) => e.key === key) + 1, ...(reason ? { reason } : {}) } };
  }

  private save(d: DayFile) {
    writeJson(this.file(d.day), d);
  }
  private rows(d: DayFile): Entry[] {
    return Object.values(d.entries).sort((x, y) => compareScores(x, y) || x.at - y.at);
  }

  /** GET /api/daily/leaderboard?day= : top 50 */
  leaderboard(dayParam: string | null): Reply {
    const day = dayParam ?? utcDay(this.now());
    if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return err(400, "bad day (YYYY-MM-DD)", "bad_request");
    const d = this.day(day);
    const rows = this.rows(d).slice(0, 50).map((e, i) => ({ rank: i + 1, name: e.name, kind: e.kind, account: e.account ?? null, placement: e.placement, kills: e.kills, ticksSurvived: e.ticksSurvived, bountyKilled: e.bountyKilled, earns: e.earns, at: e.at }));
    return { code: 200, json: { day, seed: dailySeed(day), endsAt: dayEnd(day), total: Object.keys(d.entries).length, rows } };
  }
}
