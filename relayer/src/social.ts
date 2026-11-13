// Shared plumbing of "Challenge a friend" and the "Daily tournament" (docs/SOCIAL.md): config
// validation, an own replay that also reports how long the human survived, HMAC tokens, atomic JSON
// files. Pure (no chain, no network): unit-tested in test/social.test.ts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FIGHTERS, MATCH_TICKS, type FighterSpec, type Input, type MatchConfig, type MatchRecord, type Personality } from "../../src/sim/types.ts";
import { createMatch } from "../../src/sim/match.ts";
import { replayRecord } from "../../src/sim/record.ts";

export const TICK_MS = 50;
const PERSONALITIES: readonly Personality[] = ["aggressive", "camper", "sniper", "looter", "coward", "balanced"];

/** Strip control characters / markup, collapse spaces, cap the length. Never trust a display name. */
export function cleanName(v: unknown, max = 18): string {
  const s = String(v ?? "").normalize("NFKC").replace(/[^\p{L}\p{N} ._'-]/gu, "").replace(/\s+/g, " ").trim();
  return s.slice(0, max);
}

const int = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * A MatchConfig that arrives from a client is rebuilt field by field (extra properties dropped), so the
 * server never stores or replays anything it didn't look at. Returns null when it isn't a valid roster.
 */
export function sanitizeCfg(raw: unknown): MatchConfig | null {
  const c = raw as MatchConfig | null;
  if (!c || typeof c !== "object" || !int(c.seed, 0, 0xffffffff) || !Array.isArray(c.fighters) || c.fighters.length !== FIGHTERS) return null;
  const out: FighterSpec[] = [];
  let bounties = 0;
  for (let i = 0; i < FIGHTERS; i++) {
    const f = c.fighters[i] as FighterSpec | undefined;
    if (!f || typeof f !== "object") return null;
    if (typeof f.id !== "string" || f.id.length < 1 || f.id.length > 64) return null;
    if (typeof f.name !== "string" || f.name.length < 1 || f.name.length > 24) return null;
    if (!PERSONALITIES.includes(f.personality)) return null;
    if (f.human !== (i === 0)) return null; // exactly one human, at idx 0
    const u = f.upgrades;
    if (!u || !int(u.weaponTier, 0, 2) || !int(u.armor, 0, 2) || !int(u.skin, 0, 15)) return null;
    if (typeof f.bounty !== "boolean") return null;
    if (f.bounty) bounties++;
    out.push({ id: f.id, name: cleanName(f.name, 24) || "Fighter", personality: f.personality, human: f.human, upgrades: { weaponTier: u.weaponTier, armor: u.armor, skin: u.skin }, bounty: f.bounty });
  }
  if (bounties > 1 || out[0].bounty) return null;
  return { seed: c.seed, fighters: out };
}

export type Analysis = {
  hash: string;
  placement: number;
  kills: number;
  /** ticks the human fighter was alive */
  ticksSurvived: number;
  /** ticks the whole match lasted */
  ticksTotal: number;
  winner: number | null;
  /** the human killed the bounty carrier */
  bountyKilled: boolean;
  placements: number[];
};

/**
 * Replays a record with the shared simulation. `hash` is the result of `replayRecord` (the same call
 * the settlement path uses); our own loop only adds what it doesn't report (when the human died) and
 * must produce the identical hash, otherwise we refuse.
 */
export function analyze(cfg: MatchConfig, inputs: MatchRecord["inputs"]): Analysis {
  const ref = replayRecord(cfg, inputs);
  const m = createMatch(cfg);
  const rows = [...inputs].sort((a, b) => a[0] - b[0]);
  const cur = new Map<number, Input>([[0, { mx: 0, my: 0, aim: 0, fire: false }]]);
  let k = 0;
  let died = -1;
  let bountyKiller: number | null = null;
  while (!m.state.over && m.state.tick < MATCH_TICKS) {
    while (k < rows.length && rows[k][0] <= m.state.tick) {
      const [, idx, mx, my, packed, fire] = rows[k++];
      const q = Math.floor(packed / 4096);
      const inp: Input = { mx, my, aim: packed - q * 4096, fire: fire === 1 };
      if (q > 0) inp.aimDist = (q - 1) * 100;
      cur.set(idx, inp);
    }
    for (const e of m.step(cur)) if (e.t === "bounty") bountyKiller = e.by;
    if (died < 0 && !m.state.fighters[0].alive) died = m.state.tick;
  }
  const hash = m.hash();
  if (hash !== ref.hash) throw new Error("internal: the two replays disagree");
  const me = m.state.fighters[0];
  return {
    hash,
    placement: me.placement || (me.alive ? 1 : FIGHTERS),
    kills: me.kills,
    ticksSurvived: died >= 0 ? died : m.state.tick,
    ticksTotal: m.state.tick,
    winner: m.state.winner,
    bountyKilled: bountyKiller === 0,
    placements: m.state.fighters.map((f) => f.placement),
  };
}

export type Score = { placement: number; kills: number; ticksSurvived: number };
/** Negative when `a` is the better run: placement first, then kills, then time alive. */
export function compareScores(a: Score, b: Score): number {
  return a.placement - b.placement || b.kills - a.kills || b.ticksSurvived - a.ticksSurvived;
}

/** A match can't be played faster than real time (minus `factor` of slack for clocks / pauses). */
export function tooFast(ticksTotal: number, sinceMs: number, factor: number): boolean {
  return sinceMs < ticksTotal * TICK_MS * factor;
}

// ------------------------------------------------------------------ tokens
export class Tokens {
  private secret: Buffer;
  constructor(secret: Buffer) {
    this.secret = secret;
  }
  /** SOCIAL_SECRET from the environment, else a generated file (mode 600) next to the data. */
  static load(dataDir: string, envSecret = process.env.SOCIAL_SECRET): Tokens {
    if (envSecret && envSecret.length >= 16) return new Tokens(Buffer.from(envSecret));
    const file = path.join(dataDir, "social.secret");
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    return new Tokens(Buffer.from(fs.readFileSync(file, "utf8").trim()));
  }
  private mac(s: string) {
    return crypto.createHmac("sha256", this.secret).update(s).digest("hex").slice(0, 32);
  }
  /** `<scope>.<issuedAt>.<nonce>.<mac>`; scope = challenge id or UTC day */
  issue(scope: string, now = Date.now()): { token: string; issuedAt: number; nonce: string } {
    const nonce = crypto.randomBytes(8).toString("hex");
    const body = `${scope}.${now}.${nonce}`;
    return { token: `${body}.${this.mac(body)}`, issuedAt: now, nonce };
  }
  check(token: unknown, scope: string): { issuedAt: number; nonce: string } | null {
    if (typeof token !== "string" || token.length > 200) return null;
    const p = token.split(".");
    if (p.length !== 4 || p[0] !== scope) return null;
    const body = p.slice(0, 3).join(".");
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(p[3]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const issuedAt = Number(p[1]);
    return Number.isFinite(issuedAt) ? { issuedAt, nonce: p[2] } : null;
  }
}

// ------------------------------------------------------------------ files
export function writeJson(file: string, v: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, file);
}
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export type Reply = { code: number; json?: unknown; html?: string; headers?: Record<string, string> };
export const err = (code: number, error: string, c?: string): Reply => ({ code, json: { error, code: c ?? "refused" } });
