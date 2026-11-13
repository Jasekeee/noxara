// "Challenge a friend" (docs/DECISIONS.md row 7): a finished match is posted, the server replays it and
// keeps {config, result}; a friend plays the SAME seed + roster and posts an answer, which is replayed
// and real-time checked too. No stakes, no NOX, no chain.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MatchConfig, MatchRecord } from "../../src/sim/types.ts";
import { FIGHTERS, SIM_VERSION } from "../../src/sim/types.ts";
import { checkInputs, checkSimVersion } from "./settle.ts";
import { RateLimiter } from "./policy.ts";
import { analyze, cleanName, compareScores, err, readJson, sanitizeCfg, tooFast, writeJson, type Analysis, type Reply, type Tokens } from "./social.ts";

export const MAX_ANSWERS = 20;
/** how long a challenge token (the real-time anchor of an answer) stays valid */
export const TOKEN_MAX_AGE_MS = 2 * 3_600_000;
const ID_RE = /^[a-z2-7]{8}$/;

export type RunResult = {
  name: string;
  placement: number;
  kills: number;
  ticksSurvived: number;
  ticksTotal: number;
  bountyKilled: boolean;
  /** the human won the match */
  won: boolean;
};
export type StoredChallenge = {
  id: string;
  createdAt: number;
  simVersion: string;
  /** what everyone plays: fighters[0] is always "You" */
  cfg: MatchConfig;
  inputLogHash: string;
  bountyCarrier: string | null;
  result: RunResult;
  gameUrl: string | null;
  answers: (RunResult & { at: number })[];
  usedTokens: string[];
};

export type ChallengeOpts = {
  dir: string;
  tokens: Tokens;
  /** 0.9 = the run must have taken >= 90% of real time; 0 disables (tests / fast e2e) */
  realtimeFactor: () => number;
  /** may a client-supplied `game` URL be used for the redirect? (allow-list of origins) */
  gameOriginOk: (origin: string) => boolean;
  defaultGameUrl?: string;
  now?: () => number;
  createPerIpPerHour?: number;
  answerPerIpPerHour?: number;
};

const toRun = (name: string, a: Analysis): RunResult => ({ name, placement: a.placement, kills: a.kills, ticksSurvived: a.ticksSurvived, ticksTotal: a.ticksTotal, bountyKilled: a.bountyKilled, won: a.winner === 0 });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function ordinal(n: number): string {
  const v = n % 100;
  return `${n}${["th", "st", "nd", "rd"][(v - 20) % 10] ?? ["th", "st", "nd", "rd"][v] ?? "th"}`;
}

export class Challenges {
  private o: ChallengeOpts;
  private createLimit: RateLimiter;
  private answerLimit: RateLimiter;
  constructor(o: ChallengeOpts) {
    this.o = o;
    fs.mkdirSync(o.dir, { recursive: true });
    this.createLimit = new RateLimiter(o.createPerIpPerHour ?? 20, 3_600_000);
    this.answerLimit = new RateLimiter(o.answerPerIpPerHour ?? 40, 3_600_000);
  }
  private now = () => (this.o.now ?? Date.now)();
  private file = (id: string) => path.join(this.o.dir, `${id}.json`);
  private load(id: string): StoredChallenge | null {
    return ID_RE.test(id) ? readJson<StoredChallenge>(this.file(id)) : null;
  }
  private newId(): string {
    const A = "abcdefghijklmnopqrstuvwxyz234567";
    for (;;) {
      const b = crypto.randomBytes(8);
      const id = Array.from(b, (x) => A[x & 31]).join("");
      if (!fs.existsSync(this.file(id))) return id;
    }
  }

  /** POST /api/challenge {record, simVersion, name, game?} */
  create(body: Record<string, unknown>, ip: string): Reply {
    if (!this.createLimit.take(ip, this.now())) return err(429, "slow down: too many challenges from this address", "rate_limited");
    const ver = checkSimVersion(body.simVersion);
    if (!ver.ok) return { code: ver.status, json: { error: ver.reason, code: ver.code, simVersion: SIM_VERSION } };
    const record = body.record as MatchRecord | undefined;
    if (!record || record.version !== 1 || !Array.isArray(record.inputs) || typeof record.hash !== "string") return err(400, "missing record", "bad_request");
    const bad = checkInputs(record.inputs);
    if (bad) return err(400, bad, "bad_record");
    const cfg = sanitizeCfg(record.cfg);
    if (!cfg) return err(400, "this roster is not a valid match", "bad_config");
    let a: Analysis;
    try {
      a = analyze(cfg, record.inputs);
    } catch (e) {
      return err(400, `could not replay: ${(e as Error).message}`, "bad_record");
    }
    if (a.hash !== record.hash) return err(409, "replay mismatch: the server's simulation disagrees with this record", "replay_mismatch");
    const name = cleanName(body.name) || "A friend";
    const norm: MatchConfig = { seed: cfg.seed, fighters: cfg.fighters.map((f, i) => (i === 0 ? { ...f, id: "you", name: "You" } : f)) };
    let gameUrl: string | null = null;
    try {
      if (typeof body.game === "string") {
        const u = new URL(body.game);
        if ((u.protocol === "http:" || u.protocol === "https:") && this.o.gameOriginOk(u.origin)) gameUrl = u.origin + u.pathname;
      }
    } catch {
      /* ignore a bad game url */
    }
    const id = this.newId();
    const st: StoredChallenge = {
      id,
      createdAt: this.now(),
      simVersion: SIM_VERSION,
      cfg: norm,
      inputLogHash: crypto.createHash("sha256").update(JSON.stringify(record.inputs)).digest("hex"),
      bountyCarrier: norm.fighters.find((f) => f.bounty)?.name ?? null,
      result: toRun(name, a),
      gameUrl,
      answers: [],
      usedTokens: [],
    };
    writeJson(this.file(id), st);
    return { code: 200, json: { id, path: `/c/${id}`, result: st.result } };
  }

  private publicView(st: StoredChallenge) {
    return { id: st.id, simVersion: st.simVersion, result: st.result, bountyCarrier: st.bountyCarrier, answers: st.answers.map((x) => ({ name: x.name, placement: x.placement, kills: x.kills, ticksSurvived: x.ticksSurvived, bountyKilled: x.bountyKilled, won: x.won })), maxAnswers: MAX_ANSWERS };
  }

  /** GET /api/challenge/<id>: the exact config to play + a token that anchors the real-time check */
  get(id: string): Reply {
    const st = this.load(id);
    if (!st) return err(404, "no such challenge", "not_found");
    const t = this.o.tokens.issue(id, this.now());
    return { code: 200, json: { ...this.publicView(st), cfg: st.cfg, token: t.token, issuedAt: t.issuedAt } };
  }

  /** GET /api/challenge/<id>/results: no token, nothing to play */
  results(id: string): Reply {
    const st = this.load(id);
    return st ? { code: 200, json: this.publicView(st) } : err(404, "no such challenge", "not_found");
  }

  /** POST /api/challenge/<id>/answer {record, token, simVersion, name} */
  answer(id: string, body: Record<string, unknown>, ip: string): Reply {
    const now = this.now();
    if (!this.answerLimit.take(ip, now)) return err(429, "slow down: too many answers from this address", "rate_limited");
    const st = this.load(id);
    if (!st) return err(404, "no such challenge", "not_found");
    if (st.answers.length >= MAX_ANSWERS) return err(409, `this challenge already has ${MAX_ANSWERS} answers`, "full");
    const ver = checkSimVersion(body.simVersion);
    if (!ver.ok) return { code: ver.status, json: { error: ver.reason, code: ver.code, simVersion: SIM_VERSION } };
    if (st.simVersion !== SIM_VERSION) return err(409, "this challenge was made with another version of the game", "sim_version_mismatch");
    const tok = this.o.tokens.check(body.token, id);
    if (!tok) return err(401, "bad or missing challenge token: open the challenge link again", "bad_token");
    if (now - tok.issuedAt > TOKEN_MAX_AGE_MS || tok.issuedAt > now + 60_000) return err(409, "this challenge link expired: open it again", "token_expired");
    if (st.usedTokens.includes(tok.nonce)) return err(409, "this attempt was already submitted: open the link again to play again", "token_used");
    const record = body.record as MatchRecord | undefined;
    if (!record || !Array.isArray(record.inputs) || typeof record.hash !== "string") return err(400, "missing record", "bad_request");
    const bad = checkInputs(record.inputs);
    if (bad) return err(400, bad, "bad_record");
    // a token buys one attempt, whether it is accepted or not
    st.usedTokens.push(tok.nonce);
    let a: Analysis;
    try {
      a = analyze(st.cfg, record.inputs);
    } catch (e) {
      writeJson(this.file(id), st);
      return err(400, `could not replay: ${(e as Error).message}`, "bad_record");
    }
    if (a.hash !== record.hash) {
      writeJson(this.file(id), st);
      return err(409, "replay mismatch: the server's simulation disagrees with this record", "replay_mismatch");
    }
    const f = this.o.realtimeFactor();
    if (f > 0 && tooFast(a.ticksTotal, now - tok.issuedAt, f)) {
      writeJson(this.file(id), st);
      return { code: 409, json: { error: `this match lasts ${Math.round((a.ticksTotal * 50) / 1000)} s but was submitted ${Math.round((now - tok.issuedAt) / 1000)} s after the challenge was opened`, code: "too_fast" } };
    }
    const run = toRun(cleanName(body.name) || "Challenger", a);
    st.answers.push({ ...run, at: now });
    writeJson(this.file(id), st);
    return { code: 200, json: { ok: true, you: run, them: st.result, ...this.verdict(run, st.result), answers: st.answers.length, bountyCarrier: st.bountyCarrier } };
  }

  /** Who won, and on which line */
  verdict(you: RunResult, them: RunResult) {
    const c = compareScores(you, them);
    return { winner: c < 0 ? "you" : c > 0 ? "them" : "tie", lines: { placement: Math.sign(them.placement - you.placement), kills: Math.sign(you.kills - them.kills), time: Math.sign(you.ticksSurvived - them.ticksSurvived) } };
  }

  /** GET /c/<id>: link-preview page (og tags) that sends people on to the game */
  page(id: string, host: string, publicUrl?: string): Reply {
    const st = this.load(id);
    const base = (publicUrl ?? host).replace(/\/$/, "");
    if (!st) return { code: 404, html: `<!doctype html><meta charset="utf-8"><title>NOXARA</title><p>That challenge doesn't exist.</p>` };
    const r = st.result;
    const title = `Placed ${r.placement}/${FIGHTERS} with ${r.kills} kill${r.kills === 1 ? "" : "s"} — can you beat it? NOXARA`;
    const desc = `${r.name} placed ${ordinal(r.placement)} of ${FIGHTERS} with ${r.kills} kill${r.kills === 1 ? "" : "s"}${r.bountyKilled ? " and took the bounty" : ""}. Same island, same fighters. Only one walks out.`;
    const game = st.gameUrl ?? this.o.defaultGameUrl ?? `${base}/`;
    const to = `${game}${game.includes("?") ? "&" : "?"}challenge=${id}`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:type" content="website"><meta property="og:site_name" content="NOXARA">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(base)}/og.png"><meta property="og:url" content="${esc(base)}/c/${id}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(base)}/og.png">
<meta http-equiv="refresh" content="0;url=${esc(to)}"></head>
<body style="background:#0b0e14;color:#fff;font:16px system-ui;padding:2rem"><p>${esc(desc)}</p><p><a style="color:#ffd166" href="${esc(to)}">Play the challenge</a></p>
<script>location.replace(${JSON.stringify(to).replace(/</g, "\\u003c")})</script></body></html>`;
    return { code: 200, html };
  }
}
