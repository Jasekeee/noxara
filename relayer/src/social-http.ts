// HTTP front of the social features. `createSocial` is wired into relayer/src/server.ts (one hook) and
// into relayer/src/social-server.ts (a chain-less server for tests / local play).
//  GET  /c/<id>                       link-preview page (og tags) -> redirect to the game
//  POST /api/challenge                {record, simVersion, name, game?}      -> {id, path, result}
//  GET  /api/challenge/<id>           -> {cfg, result, token, ...}
//  GET  /api/challenge/<id>/results   -> {result, answers}
//  POST /api/challenge/<id>/answer    {record, token, simVersion, name}      -> comparison
//  GET  /api/daily                    -> {day, seed, roster, endsAt, token}
//  POST /api/daily/submit             {record, token, ...}                   -> {rank, best, ...}
//  GET  /api/daily/leaderboard?day=   -> top 50
import type http from "node:http";
import path from "node:path";
import { Challenges } from "./challenge.ts";
import { Daily } from "./tournament.ts";
import { Tokens, err, type Reply } from "./social.ts";

export type SocialConfig = {
  dataDir: string;
  /** frontend origin(s) allowed to be redirect targets (the CORS list) */
  allowedOrigins: string[];
  publicUrl?: string;
  gameUrl?: string;
  verifyOwner: (account: string, publicKey: string) => Promise<boolean>;
  guestParent?: string;
  realtimeFactor?: number;
  now?: () => number;
  secret?: string;
};

export function createSocial(c: SocialConfig) {
  const tokens = Tokens.load(path.join(c.dataDir), c.secret);
  const realtimeFactor = () => c.realtimeFactor ?? 0.9;
  const challenges = new Challenges({
    dir: path.join(c.dataDir, "challenges"),
    tokens,
    realtimeFactor,
    gameOriginOk: (o) => c.allowedOrigins.includes(o) || (!!c.gameUrl && new URL(c.gameUrl).origin === o),
    defaultGameUrl: c.gameUrl,
    now: c.now,
  });
  const daily = new Daily({ dir: path.join(c.dataDir, "daily"), tokens, realtimeFactor, verifyOwner: c.verifyOwner, guestParent: c.guestParent, now: c.now });

  async function body(req: http.IncomingMessage, max = 512 * 1024): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const ch of req) {
      size += (ch as Buffer).length;
      if (size > max) throw new Error("body too large");
      chunks.push(ch as Buffer);
    }
    const v = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("body must be a JSON object");
    return v as Record<string, unknown>;
  }

  /** Returns null when the request isn't ours. */
  async function handle(req: http.IncomingMessage, ip: string): Promise<Reply | null> {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const m = req.method;
    const isOurs = p.startsWith("/api/challenge") || p.startsWith("/api/daily") || p.startsWith("/c/");
    if (!isOurs) return null;
    try {
      let x: RegExpExecArray | null;
      if (m === "GET" && (x = /^\/c\/([a-z2-7]{8})$/.exec(p))) {
        const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
        return challenges.page(x[1], `${proto}://${req.headers.host ?? "localhost"}`, c.publicUrl);
      }
      if (m === "POST" && p === "/api/challenge") return challenges.create(await body(req), ip);
      if (m === "GET" && (x = /^\/api\/challenge\/([a-z2-7]{8})$/.exec(p))) return challenges.get(x[1]);
      if (m === "GET" && (x = /^\/api\/challenge\/([a-z2-7]{8})\/results$/.exec(p))) return challenges.results(x[1]);
      if (m === "POST" && (x = /^\/api\/challenge\/([a-z2-7]{8})\/answer$/.exec(p))) return challenges.answer(x[1], await body(req), ip);
      if (m === "GET" && p === "/api/daily") return daily.today();
      if (m === "POST" && p === "/api/daily/submit") return await daily.submit(await body(req), ip);
      if (m === "GET" && p === "/api/daily/leaderboard") return daily.leaderboard(url.searchParams.get("day"));
      return err(404, "not found", "not_found");
    } catch (e) {
      return err(400, (e as Error).message, "bad_request");
    }
  }
  return { handle, challenges, daily, tokens };
}

/** Writes a Reply with the same CORS rule as the relayer's own `send`. */
export function writeReply(res: http.ServerResponse, r: Reply, origin: string | undefined, allowedOrigins: string[]) {
  const h: Record<string, string> = { "cache-control": "no-store", ...(r.headers ?? {}) };
  if (origin && allowedOrigins.includes(origin)) {
    h["access-control-allow-origin"] = origin;
    h["vary"] = "origin";
  }
  if (r.html !== undefined) {
    h["content-type"] = "text/html; charset=utf-8";
    res.writeHead(r.code, h);
    return res.end(r.html);
  }
  h["content-type"] = "application/json";
  res.writeHead(r.code, h);
  res.end(JSON.stringify(r.json ?? {}));
}
