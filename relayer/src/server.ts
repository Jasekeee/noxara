// NOXARA relayer + match server.
//  POST /api/guest   {publicKey}            -> walletless guest account g-*.<relayer> (function-call key
//                                               for the game) + its NEP-145 storage prepaid by the relayer;
//                                               with GUEST_VIA_CONTRACT=1 (mainnet): g-*.<game contract>, made
//                                               by the contract's `create_guest` in the same tx as the storage
//  POST /api/relay   {payload}              -> pays gas for a NEP-366 delegate action calling the game
//                                               (allow-listed methods, zero deposit, signature + key owner
//                                               checked before any budget is spent)
//  POST /api/settle  {match_id, record, publicKey, signature}
//                                            -> re-runs the recorded match with the shared simulation, then
//                                               calls settle_match signed by the match-server key
//  GET  /api/match/<id>/record              -> the stored record, so anyone can re-verify offline
//  GET  /api/view?method=<view>&args=<json> (or POST {method, args})
//                                            -> read-only views of the game contract, allow-listed, cached and
//                                               coalesced (relayer/src/views.ts), so browsers don't hit the
//                                               free public RPC directly (audit F-6)
//  GET  /api/health
// Keys come only from environment variables (.env locally, hosted env vars in production).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Chain } from "./chain.ts";
import { signatureOk, settleSignatureOk, KeyOwners } from "./verify.ts";
import { checkDelegate, normalizeIp, preflight, isGuestAccount, isGuestId, RateLimiter, Budget, GUEST_PREFIX, GAME_METHODS_DEFAULT, METHOD_GAS_DEFAULT, type RelayPolicy } from "./policy.ts";
import { judge, inputLogHash, settleMessage, checkSimVersion, SIM_VERSION } from "./settle.ts";
import { registerMessage } from "./protocol.ts";
import { Subsidies } from "./subsidies.ts";
import { SpendBudget, IpDailyCap, RESERVE, near as nearToYocto, fmtNear } from "./budget.ts";
import { ViewProxy } from "./views.ts";
import type { ChainMatch } from "./roster.ts";
import { createSocial, writeReply } from "./social-http.ts";
import type { MatchRecord } from "../../src/sim/types.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const network = env("NEAR_NETWORK", "testnet") as "testnet" | "mainnet";
if (network === "mainnet" && process.env.BR_MAINNET_YES !== "yes") throw new Error("mainnet needs BR_MAINNET_YES=yes (the owner's explicit approval)");
const relayerId = env("RELAYER_ACCOUNT_ID");
const gameId = env("GAME_CONTRACT_ID");
const serverId = process.env.SERVER_ACCOUNT_ID;
const serverKey = process.env.SERVER_PRIVATE_KEY;
// NEAR_RPC may be a comma-separated list: the first one signs/sends; views fail over along the list
const rpcUrls = env("NEAR_RPC", network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com").split(",").map((s) => s.trim()).filter(Boolean);
const rpcUrl = rpcUrls[0];
// methods anyone may have relayed / that a guest's function-call key may call
const GAME_METHODS = env("RELAY_METHODS", GAME_METHODS_DEFAULT.join(",")).split(",");
const GUEST_METHODS = env("GUEST_METHODS", "start_match,sweep_match").split(",");
const TGAS = 1_000_000_000_000n;
const policy: RelayPolicy = {
  gameContractId: gameId,
  guestParentId: relayerId,
  allowedMethods: GAME_METHODS,
  maxGasPerAction: 150n * TGAS,
  maxActions: 1,
  methodGas: METHOD_GAS_DEFAULT,
};
// mainnet: guests are made by the game contract (`create_guest`, g-*.<contract>), so the hosted relayer needs no
// key of the contract account. Off by default: the live testnet contract predates `create_guest`.
const GUEST_VIA_CONTRACT = env("GUEST_VIA_CONTRACT", "0") === "1";
const isGuest = (a: string) => isGuestAccount(a, relayerId, gameId);
// Gas budgets (attached gas, an upper bound on what we pay): per sender and for everyone, per hour.
const senderGas = new Budget(BigInt(env("GAS_PER_SENDER_PER_HOUR_TGAS", "3000")) * TGAS, 3_600_000);
const globalGas = new Budget(BigInt(env("GAS_GLOBAL_PER_HOUR_TGAS", "200000")) * TGAS, 3_600_000);
const GUEST_FUNDING = env("GUEST_FUNDING", "0.003 NEAR");
const GUEST_ALLOWANCE = env("GUEST_ALLOWANCE", "0.05 NEAR");
// storage deposits: read from the contract at start (guests: the measured size), env overrides
let GUEST_STORAGE = process.env.GUEST_STORAGE ?? "";
let REAL_STORAGE = process.env.REAL_STORAGE ?? "";
const PORT = Number(env("PORT", "8788"));
const DEV_PORTS = [5173, 5180, 5181, 5184, 5192];
const ORIGINS = env("CORS_ORIGINS", DEV_PORTS.flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(",")).split(",");
const DATA_DIR = env("RECORDS_DIR", path.join(import.meta.dirname, "../data/records"));
fs.mkdirSync(DATA_DIR, { recursive: true });

const chain = new Chain({ network, rpcUrl, relayerId, relayerKey: env("RELAYER_PRIVATE_KEY"), gameContractId: gameId, serverId, serverKey });
const owners = new KeyOwners(rpcUrl);
const guestPerIp = new RateLimiter(Number(env("GUEST_PER_IP_PER_HOUR", "10")), 3_600_000);
const guestGlobal = new RateLimiter(Number(env("GUEST_GLOBAL_PER_HOUR", "200")), 3_600_000);
const relayPerSender = new RateLimiter(Number(env("RELAY_PER_SENDER_PER_MIN", "20")), 60_000);
const relayPerIp = new RateLimiter(Number(env("RELAY_PER_IP_PER_MIN", "60")), 60_000);
const viewPerIp = new RateLimiter(Number(env("VIEW_PER_IP_PER_MIN", "180")), 60_000);
// cache misses (upstream RPC calls) one address may cause: well below the global upstream budget
const viewMissPerIp = new RateLimiter(Number(env("VIEW_MISS_PER_IP_PER_MIN", "40")), 60_000);
const views = new ViewProxy({ contract: gameId, rpcUrls, upstreamPerMin: Number(env("VIEW_UPSTREAM_PER_MIN", "600")) });
const registerPerIp = new RateLimiter(Number(env("REGISTER_PER_IP_PER_HOUR", "10")), 3_600_000);
// storage subsidies for signed-in real accounts: once per account ever, at most N per hour (N x 0.02 NEAR)
// guest budget mode: 1 NEAR total for everything the relayer spends on players, N new guests a day
// Two separate NEAR budgets so guests can never starve real accounts:
//  - guests: new guest accounts (funding + storage + gas) and their relayed calls; small on purpose (mainnet:
//    0.5 NEAR ≈ 18 new guests) with a daily cap on new guests. When it runs out guests play the free offline Training Island.
//  - real accounts: storage registrations and relayed calls of signed-in NEAR accounts (unchanged).
const guestBudget = new SpendBudget(path.join(DATA_DIR, "../budget-guest.json"), env("GUEST_BUDGET_NEAR", "0.5"), Number(env("DAILY_GUEST_CAP", "18")));
const budget = new SpendBudget(path.join(DATA_DIR, "../budget.json"), env("RELAYER_BUDGET_NEAR", "1"), Number.MAX_SAFE_INTEGER);
// new guests per network address per UTC day, persisted (a restart must not reopen it)
const guestIpDaily = new IpDailyCap(path.join(DATA_DIR, "../guest-ip-daily.json"), Number(env("GUEST_PER_IP_PER_DAY", "3")));
const budgetFor = (senderId: string) => (isGuest(senderId) ? guestBudget : budget);
const closedReply = (why: string) => ({ error: why === "daily_cap" ? "today's free guest spots are taken: sign in with NEAR or play offline" : "the free relayer budget is used up: sign in with NEAR or play offline", code: "guests_closed", reason: why });
const subsidies = new Subsidies(path.join(DATA_DIR, "../subsidised.json"), Number(env("REGISTER_GLOBAL_PER_HOUR", "30")));
const settlePerIp = new RateLimiter(Number(env("SETTLE_PER_IP_PER_MIN", "20")), 60_000);
const settling = new Set<string>();
// challenge a friend + daily tournament (docs/SOCIAL.md): replay-verified, no chain, no tokens
const social = createSocial({
  dataDir: path.join(DATA_DIR, ".."),
  allowedOrigins: ORIGINS,
  publicUrl: process.env.PUBLIC_URL,
  gameUrl: process.env.GAME_URL,
  guestParent: relayerId,
  gameContract: gameId,
  verifyOwner: (a, k) => owners.owns(a, k),
});

function send(res: http.ServerResponse, code: number, body: unknown, origin?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (origin && ORIGINS.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "origin";
  }
  res.writeHead(code, headers);
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage, max = 8_192): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

// Only trust X-Forwarded-For behind a known proxy (TRUST_PROXY=1), and then take the right-most
// entry (the one our proxy appended), never the client-controlled left-most one.
const TRUST_PROXY = env("TRUST_PROXY", "0") === "1";
// Every per-IP limit keys on normalizeIp(): IPv4-mapped IPv6 -> IPv4, IPv6 -> its /64.
const ipOf = (req: http.IncomingMessage) => {
  if (TRUST_PROXY) {
    const parts = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return normalizeIp(parts[parts.length - 1]);
  }
  return normalizeIp(req.socket.remoteAddress ?? "?");
};

const panicMessage = (e: unknown) => {
  const err = e as { panic?: string; message?: string };
  const m = err.panic ?? err.message ?? String(e);
  const i = m.indexOf("panicked at");
  return i >= 0 ? m.slice(m.indexOf("\n", i) + 1).trim() || m : m;
};

const recordPath = (id: string) => path.join(DATA_DIR, `${id}.json`);

async function handleSettle(body: Record<string, unknown>) {
  const matchId = String(body.match_id ?? "");
  if (!/^[0-9]{1,18}$/.test(matchId)) return { code: 400, body: { error: "bad match_id", code: "bad_request" } };
  const record = body.record as MatchRecord;
  if (!record || !Array.isArray(record.inputs)) return { code: 400, body: { error: "missing record", code: "bad_request" } };
  const ver = checkSimVersion(body.simVersion);
  if (!ver.ok) return { code: ver.status, body: { error: ver.reason, code: ver.code, simVersion: SIM_VERSION } };
  const m = await chain.view<ChainMatch | null>("get_match", { match_id: matchId });
  if (!m) return { code: 404, body: { error: "no such match", code: "no_match" } };
  // only the match's player may submit its record (else anyone could submit a losing log for them)
  const logHash = inputLogHash(record.inputs);
  const publicKey = String(body.publicKey ?? "");
  if (!settleSignatureOk(settleMessage(matchId, logHash), publicKey, String(body.signature ?? ""))) return { code: 401, body: { error: "bad signature", code: "bad_signature" } };
  if (!(await owners.owns(m.player, publicKey))) return { code: 401, body: { error: "unknown key for this player", code: "unknown_key" } };
  if (settling.has(matchId)) return { code: 409, body: { error: "already settling", code: "busy" } };
  settling.add(matchId);
  try {
    const v = judge({ ...m, match_id: matchId }, record, undefined, Date.now());
    if (!v.ok) return { code: v.status, body: { error: v.reason, code: v.code ?? "refused" } };
    fs.writeFileSync(recordPath(matchId), JSON.stringify({ match_id: matchId, input_log_hash: logHash, record }));
    const r = await chain.settle(v.args);
    views.invalidate(true);
    if (r.failure) return { code: 409, body: { tx: r.tx, error: r.failure, code: "chain_refused" } };
    console.log(`settled #${matchId}: winner ${v.winner} (replay ${v.ms} ms, kills ${v.killsFrom}), ${r.tgas} Tgas, tx ${r.tx}`);
    return { code: 200, body: { tx: r.tx, result: r.value, events: r.events, verified: true, replay_ms: v.ms, tgas: r.tgas } };
  } finally {
    settling.delete(matchId);
  }
}

/** Make a walletless guest account for this browser key (the caps and budget were checked by the caller). */
async function createGuestAccount(publicKey: string): Promise<{ code: number; body: Record<string, unknown> }> {
  if (GUEST_VIA_CONTRACT) {
    const hex = crypto.randomBytes(5).toString("hex");
    if (!isGuestId(hex)) throw new Error("guest id");
    const g = await chain.createGuestViaContract(hex, publicKey, GUEST_FUNDING, GUEST_STORAGE);
    // the funding comes back if the account couldn't be created (the contract refunds it); the storage doesn't
    guestBudget.spend(g.burnt + yoctoOf(GUEST_STORAGE) + (g.created ? nearToYocto(GUEST_FUNDING.replace(/\s*NEAR$/i, "")) : 0n), "guest");
    if (!g.created || g.failure) return { code: 500, body: { error: `guest: ${g.failure ?? "not created"}` } };
    owners.add(g.accountId, publicKey);
    return { code: 200, body: { accountId: g.accountId, tx: g.tx, storageTx: g.tx } };
  }
  const id = `${GUEST_PREFIX}${crypto.randomBytes(5).toString("hex")}.${relayerId}`;
  const r = await chain.createGuest(id, publicKey, GUEST_METHODS, GUEST_FUNDING, GUEST_ALLOWANCE);
  owners.add(id, publicKey);
  const s = await chain.storageDeposit(id, GUEST_STORAGE);
  guestBudget.spend(nearToYocto(GUEST_FUNDING.replace(/\s*NEAR$/i, "")) + yoctoOf(GUEST_STORAGE) + r.burnt + s.burnt, "guest");
  if (s.failure) return { code: 500, body: { accountId: id, error: `storage: ${s.failure}` } };
  return { code: 200, body: { accountId: id, tx: r.tx, storageTx: s.tx } };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS") {
    const h: Record<string, string> = { "access-control-allow-methods": "POST, GET", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
    if (origin && ORIGINS.includes(origin)) h["access-control-allow-origin"] = origin;
    res.writeHead(204, h);
    return res.end();
  }
  const t0 = performance.now();
  try {
    const soc = await social.handle(req, ipOf(req));
    if (soc) return writeReply(res, soc, origin, ORIGINS);
    if (req.method === "GET" && req.url === "/api/health") {
      return send(res, 200, { ok: true, network, relayer: relayerId, game: gameId, server: serverId ?? null, simVersion: SIM_VERSION, height: chain.height?.toString() ?? null, ...guestBudget.status(), realRemaining: fmtNear(budget.remaining), views: views.stats }, origin);
    }
    if (req.url === "/api/view" || req.url?.startsWith("/api/view?")) {
      if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "method not allowed" }, origin);
      const vip = ipOf(req);
      // view replies are always HTTP 200 with `status` in the body: a busy RPC is an expected state the page shows
      // ("live data unavailable, try again"), not a failed resource that browsers log as a console error
      if (!viewPerIp.take(vip)) return send(res, 200, { status: 429, error: "slow down", code: "rate_limited" }, origin);
      let method: unknown, args: unknown;
      if (req.method === "GET") {
        const q = new URL(req.url, "http://x").searchParams;
        method = q.get("method");
        const a = q.get("args");
        if (a && a.length > 1024) return send(res, 200, { status: 400, error: "args too large", code: "bad_view" }, origin);
        try {
          args = a ? JSON.parse(a) : {};
        } catch {
          return send(res, 200, { status: 400, error: "args must be JSON", code: "bad_view" }, origin);
        }
      } else {
        const body = await readJson(req, 2_048);
        method = body.method;
        args = body.args;
      }
      const r = await views.view(method, args, () => viewMissPerIp.take(vip));
      return send(res, 200, { status: r.status, ...r.body }, origin);
    }
    const rec = req.method === "GET" ? /^\/api\/match\/([0-9]{1,18})\/record$/.exec(req.url ?? "") : null;
    if (rec) {
      if (!fs.existsSync(recordPath(rec[1]))) return send(res, 404, { error: "no record for this match" }, origin);
      return send(res, 200, JSON.parse(fs.readFileSync(recordPath(rec[1]), "utf8")), origin);
    }
    if (req.method === "POST" && req.url === "/api/guest") {
      if (!guestPerIp.take(ipOf(req))) return send(res, 429, { error: "too many new guests from this address" }, origin);
      if (!guestGlobal.take("all")) return send(res, 503, { error: "the island is full right now, try again soon" }, origin);
      const body = await readJson(req);
      const publicKey = String(body.publicKey ?? "");
      if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(publicKey)) return send(res, 400, { error: "bad public key" }, origin);
      const shut = guestBudget.closed("guest", RESERVE.guest);
      if (shut) return send(res, 503, closedReply(shut), origin);
      const ip = ipOf(req);
      if (!guestIpDaily.take(ip)) return send(res, 429, { error: "this network already made today's free guests: sign in with NEAR or play offline", code: "guest_ip_daily" }, origin);
      try {
        const out = await createGuestAccount(publicKey);
        views.invalidate();
        return send(res, out.code, { ...out.body, ms: Math.round(performance.now() - t0) }, origin);
      } catch (e) {
        guestIpDaily.release(ip);
        throw e;
      }
    }
    if (req.method === "POST" && req.url === "/api/relay") {
      if (!relayPerIp.take(ipOf(req))) return send(res, 429, { error: "slow down" }, origin);
      const body = await readJson(req);
      const payload = String(body.payload ?? "");
      const sd = chain.decode(payload);
      const d = sd.signedDelegate.delegateAction;
      // audit A-16: never skip the expiry check because no block was fetched yet
      const height = chain.height ?? (await chain.ensureHeight());
      if (height === undefined) return send(res, 503, { error: "NEAR is unreachable right now, try again", code: "no_height" }, origin);
      const check = checkDelegate(
        { senderId: d.senderId, receiverId: d.receiverId, actions: d.actions as Array<Record<string, unknown>>, maxBlockHeight: BigInt(d.maxBlockHeight) },
        policy,
        height,
      );
      if (!check.ok) return send(res, 403, { error: check.reason }, origin);
      // authenticate before spending: valid signature by a key the sender actually holds
      const sig = signatureOk(payload);
      if (!sig.ok || !sig.publicKey) return send(res, 401, { error: "bad signature" }, origin);
      if (!(await owners.owns(d.senderId, sig.publicKey))) return send(res, 401, { error: "unknown key for this account" }, origin);
      if (!relayPerSender.take(d.senderId)) return send(res, 429, { error: "slow down" }, origin);
      // no gas for no-ops: e.g. claim_login is relayed only when the contract says it pays (no tx otherwise)
      const pre = await preflight(check.methods, d.senderId, (m, a) => chain.view(m, a));
      if (pre) return send(res, 409, { error: pre, code: "nothing_to_claim" }, origin);
      const shutRelay = budgetFor(d.senderId).closed("relay", RESERVE.relay);
      if (shutRelay) {
        // real accounts keep playing: their client signs the same call itself (its key's allowance pays)
        return send(res, 503, isGuest(d.senderId) ? closedReply(shutRelay) : { error: "relayer closed: sign it yourself", code: "relay_closed", reason: shutRelay }, origin);
      }
      if (!senderGas.take(d.senderId, check.gas)) return send(res, 429, { error: "you've played a lot this hour: rest a little" }, origin);
      if (!globalGas.take("all", check.gas)) return send(res, 503, { error: "the island is crowded: try again soon" }, origin);
      let r;
      try {
        r = await chain.relay(payload);
      } catch (e) {
        senderGas.refund(d.senderId, check.gas);
        globalGas.refund("all", check.gas);
        throw e;
      }
      budgetFor(d.senderId).spend(r.burnt);
      views.invalidate();
      if (r.failure) return send(res, 409, { tx: r.tx, error: r.failure, ms: Math.round(performance.now() - t0) }, origin);
      return send(res, 200, { tx: r.tx, value: r.value, guest: isGuest(d.senderId), ms: Math.round(performance.now() - t0) }, origin);
    }
    if (req.method === "POST" && req.url === "/api/register") {
      // a real NEAR account that signed in (its wallet added our function-call key): the relayer
      // prepays its NEP-145 storage once, after checking the key really belongs to the account
      if (!registerPerIp.take(ipOf(req))) return send(res, 429, { error: "slow down", code: "rate_limited" }, origin);
      const body = await readJson(req);
      const accountId = String(body.accountId ?? "");
      const publicKey = String(body.publicKey ?? "");
      if (!/^[a-z0-9._-]{2,64}$/.test(accountId) || isGuest(accountId)) return send(res, 400, { error: "bad account", code: "bad_request" }, origin);
      if (!settleSignatureOk(registerMessage(accountId), publicKey, String(body.signature ?? ""))) return send(res, 401, { error: "bad signature", code: "bad_signature" }, origin);
      if (!(await owners.owns(accountId, publicKey))) return send(res, 401, { error: "this key is not on the account yet", code: "unknown_key" }, origin);
      const sb = await chain.view<unknown>("storage_balance_of", { account_id: accountId });
      if (sb) return send(res, 200, { accountId, registered: true, tx: null }, origin);
      const shutReg = budget.closed("register", RESERVE.register);
      if (shutReg) return send(res, 503, { error: "the relayer can't sponsor registrations now: register with your wallet (storage_deposit)", code: "relay_closed", reason: shutReg }, origin);
      const sub = subsidies.take(accountId);
      if (!sub.ok) {
        return sub.reason === "already_subsidised"
          ? send(res, 403, { error: "this account already used its free registration: register with your wallet (storage_deposit, 0.02 NEAR)", code: "already_subsidised" }, origin)
          : send(res, 503, { error: "too many new accounts right now, try again later", code: "budget" }, origin);
      }
      let s;
      try {
        s = await chain.storageDeposit(accountId, REAL_STORAGE);
      } catch (e) {
        subsidies.release(accountId);
        throw e;
      }
      budget.spend(yoctoOf(REAL_STORAGE) + s.burnt);
      views.invalidate();
      if (s.failure) {
        subsidies.release(accountId);
        return send(res, 500, { error: `storage: ${s.failure}`, code: "chain_refused" }, origin);
      }
      return send(res, 200, { accountId, registered: true, tx: s.tx, ms: Math.round(performance.now() - t0) }, origin);
    }
    if (req.method === "POST" && req.url === "/api/settle") {
      if (!serverId) return send(res, 503, { error: "settlement is not configured on this server" }, origin);
      if (!settlePerIp.take(ipOf(req))) return send(res, 429, { error: "slow down" }, origin);
      const body = await readJson(req, 512 * 1024);
      const r = await handleSettle(body);
      return send(res, r.code, { ...r.body, ms: Math.round(performance.now() - t0) }, origin);
    }
    send(res, 404, { error: "not found" }, origin);
  } catch (e) {
    send(res, 400, { error: panicMessage(e), ms: Math.round(performance.now() - t0) }, origin);
  }
});

/** "0.0152 NEAR" | "15140000000000000000000 yocto" -> yocto */
function yoctoOf(amount: string): bigint {
  const m = /^\s*([0-9.]+)\s*(NEAR|yocto)?\s*$/i.exec(amount);
  if (!m) return 0n;
  return (m[2] ?? "").toLowerCase() === "yocto" ? BigInt(m[1]) : nearToYocto(m[1]);
}

await chain.start();
// audit A-16: know the block height before serving relays (retry a few times if the RPC is slow at boot)
for (let i = 0; i < 5 && chain.height === undefined; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  await chain.ensureHeight();
}
await chain.warm();
{
  const cfg = await chain.view<{ storage_deposit: string; guest_storage_deposit?: string }>("get_config").catch(() => null);
  GUEST_STORAGE ||= cfg?.guest_storage_deposit ? `${cfg.guest_storage_deposit} yocto` : "0.02 NEAR";
  REAL_STORAGE ||= cfg?.storage_deposit ? `${cfg.storage_deposit} yocto` : "0.02 NEAR";
  console.log(`storage: guests ${GUEST_STORAGE}, real accounts ${REAL_STORAGE}; guest budget ${fmtNear(guestBudget.remaining)} of ${fmtNear(guestBudget.total)} NEAR (${guestBudget.dailyGuests} new guests/day), real-account budget ${fmtNear(budget.remaining)} of ${fmtNear(budget.total)} NEAR`);
}
server.listen(PORT, () => console.log(`relayer ${relayerId} + match server ${serverId ?? "(off)"} on :${PORT} (${network}, game ${gameId}, sim ${SIM_VERSION})`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { chain.stop(); server.close(() => process.exit(0)); });
