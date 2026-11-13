// BOUNTY ROYALE relayer + match server.
//  POST /api/guest   {publicKey}            -> walletless guest account g-*.<relayer> (function-call key
//                                               for the game) + its NEP-145 storage prepaid by the relayer
//  POST /api/relay   {payload}              -> pays gas for a NEP-366 delegate action calling the game
//                                               (allow-listed methods, zero deposit, signature + key owner
//                                               checked before any budget is spent)
//  POST /api/settle  {match_id, record, publicKey, signature}
//                                            -> re-runs the recorded match with the shared simulation, then
//                                               calls settle_match signed by the match-server key
//  GET  /api/match/<id>/record              -> the stored record, so anyone can re-verify offline
//  GET  /api/health
// Keys come only from environment variables (.env locally, hosted env vars in production).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Chain } from "./chain.ts";
import { signatureOk, settleSignatureOk, KeyOwners } from "./verify.ts";
import { checkDelegate, isGuestAccount, RateLimiter, Budget, GUEST_PREFIX, type RelayPolicy } from "./policy.ts";
import { judge, inputLogHash, settleMessage } from "./settle.ts";
import type { ChainMatch } from "./roster.ts";
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
const rpcUrl = env("NEAR_RPC", network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com");
// methods anyone may have relayed / that a guest's function-call key may call
const GAME_METHODS = env("RELAY_METHODS", "start_match,sweep_match").split(",");
const GUEST_METHODS = env("GUEST_METHODS", "start_match,sweep_match").split(",");
const TGAS = 1_000_000_000_000n;
const policy: RelayPolicy = {
  gameContractId: gameId,
  guestParentId: relayerId,
  allowedMethods: GAME_METHODS,
  maxGasPerAction: 100n * TGAS,
  maxActions: 1,
  methodGas: { start_match: 100n * TGAS, sweep_match: 30n * TGAS },
};
// Gas budgets (attached gas, an upper bound on what we pay): per sender and for everyone, per hour.
const senderGas = new Budget(BigInt(env("GAS_PER_SENDER_PER_HOUR_TGAS", "3000")) * TGAS, 3_600_000);
const globalGas = new Budget(BigInt(env("GAS_GLOBAL_PER_HOUR_TGAS", "200000")) * TGAS, 3_600_000);
const GUEST_FUNDING = env("GUEST_FUNDING", "0.003 NEAR");
const GUEST_ALLOWANCE = env("GUEST_ALLOWANCE", "0.05 NEAR");
const GUEST_STORAGE = env("GUEST_STORAGE", "0.02 NEAR"); // = the contract's STORAGE_DEPOSIT
const PORT = Number(env("PORT", "8788"));
const ORIGINS = env("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",");
const DATA_DIR = env("RECORDS_DIR", path.join(import.meta.dirname, "../data/records"));
fs.mkdirSync(DATA_DIR, { recursive: true });

const chain = new Chain({ network, rpcUrl, relayerId, relayerKey: env("RELAYER_PRIVATE_KEY"), gameContractId: gameId, serverId, serverKey });
const owners = new KeyOwners(rpcUrl);
const guestPerIp = new RateLimiter(Number(env("GUEST_PER_IP_PER_HOUR", "10")), 3_600_000);
const guestGlobal = new RateLimiter(Number(env("GUEST_GLOBAL_PER_HOUR", "200")), 3_600_000);
const relayPerSender = new RateLimiter(Number(env("RELAY_PER_SENDER_PER_MIN", "20")), 60_000);
const relayPerIp = new RateLimiter(Number(env("RELAY_PER_IP_PER_MIN", "60")), 60_000);
const settlePerIp = new RateLimiter(Number(env("SETTLE_PER_IP_PER_MIN", "20")), 60_000);
const settling = new Set<string>();

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
const ipOf = (req: http.IncomingMessage) => {
  if (TRUST_PROXY) {
    const parts = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress ?? "?";
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
  if (!/^[0-9]{1,18}$/.test(matchId)) return { code: 400, body: { error: "bad match_id" } };
  const record = body.record as MatchRecord;
  if (!record || !Array.isArray(record.inputs)) return { code: 400, body: { error: "missing record" } };
  const m = await chain.view<ChainMatch | null>("get_match", { match_id: matchId });
  if (!m) return { code: 404, body: { error: "no such match" } };
  // only the match's player may submit its record (else anyone could submit a losing log for them)
  const logHash = inputLogHash(record.inputs);
  const publicKey = String(body.publicKey ?? "");
  if (!settleSignatureOk(settleMessage(matchId, logHash), publicKey, String(body.signature ?? ""))) return { code: 401, body: { error: "bad signature" } };
  if (!(await owners.owns(m.player, publicKey))) return { code: 401, body: { error: "unknown key for this player" } };
  if (settling.has(matchId)) return { code: 409, body: { error: "already settling" } };
  settling.add(matchId);
  try {
    const v = judge({ ...m, match_id: matchId }, record);
    if (!v.ok) return { code: v.status, body: { error: v.reason } };
    fs.writeFileSync(recordPath(matchId), JSON.stringify({ match_id: matchId, input_log_hash: logHash, record }));
    const r = await chain.settle(v.args);
    if (r.failure) return { code: 409, body: { tx: r.tx, error: r.failure } };
    console.log(`settled #${matchId}: winner ${v.winner} (replay ${v.ms} ms, kills ${v.killsFrom}), ${r.tgas} Tgas, tx ${r.tx}`);
    return { code: 200, body: { tx: r.tx, result: r.value, replay_ms: v.ms, tgas: r.tgas } };
  } finally {
    settling.delete(matchId);
  }
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
    if (req.method === "GET" && req.url === "/api/health") {
      return send(res, 200, { ok: true, network, relayer: relayerId, game: gameId, server: serverId ?? null, height: chain.height?.toString() ?? null }, origin);
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
      const id = `${GUEST_PREFIX}${crypto.randomBytes(5).toString("hex")}.${relayerId}`;
      const r = await chain.createGuest(id, publicKey, GUEST_METHODS, GUEST_FUNDING, GUEST_ALLOWANCE);
      owners.add(id, publicKey);
      const s = await chain.storageDeposit(id, GUEST_STORAGE);
      if (s.failure) return send(res, 500, { accountId: id, error: `storage: ${s.failure}` }, origin);
      return send(res, 200, { accountId: id, tx: r.tx, storageTx: s.tx, ms: Math.round(performance.now() - t0) }, origin);
    }
    if (req.method === "POST" && req.url === "/api/relay") {
      if (!relayPerIp.take(ipOf(req))) return send(res, 429, { error: "slow down" }, origin);
      const body = await readJson(req);
      const payload = String(body.payload ?? "");
      const sd = chain.decode(payload);
      const d = sd.signedDelegate.delegateAction;
      const check = checkDelegate(
        { senderId: d.senderId, receiverId: d.receiverId, actions: d.actions as Array<Record<string, unknown>>, maxBlockHeight: BigInt(d.maxBlockHeight) },
        policy,
        chain.height,
      );
      if (!check.ok) return send(res, 403, { error: check.reason }, origin);
      // authenticate before spending: valid signature by a key the sender actually holds
      const sig = signatureOk(payload);
      if (!sig.ok || !sig.publicKey) return send(res, 401, { error: "bad signature" }, origin);
      if (!(await owners.owns(d.senderId, sig.publicKey))) return send(res, 401, { error: "unknown key for this account" }, origin);
      if (!relayPerSender.take(d.senderId)) return send(res, 429, { error: "slow down" }, origin);
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
      if (r.failure) return send(res, 409, { tx: r.tx, error: r.failure, ms: Math.round(performance.now() - t0) }, origin);
      return send(res, 200, { tx: r.tx, value: r.value, guest: isGuestAccount(d.senderId, relayerId), ms: Math.round(performance.now() - t0) }, origin);
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

await chain.start();
await chain.warm();
server.listen(PORT, () => console.log(`relayer ${relayerId} + match server ${serverId ?? "(off)"} on :${PORT} (${network}, game ${gameId})`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { chain.stop(); server.close(() => process.exit(0)); });
