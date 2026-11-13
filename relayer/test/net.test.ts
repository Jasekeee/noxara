// The browser client's hand-rolled NEAR primitives (src/net/near.ts) against the relayer's own
// decoding/verification (near-kit + @noble), and the offline fallback of src/net/client.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSignedDelegateAction } from "near-kit";
import { base58Decode, base58Encode, generateKey, inputLogHash, settleMessage, signDelegate, Signer, toBase64 } from "../../src/net/near.ts";
import { inputLogHash as srvLogHash, settleMessage as srvSettleMessage } from "../src/protocol.ts";
import { settleSignatureOk, signatureOk } from "../src/verify.ts";
import { checkDelegate } from "../src/policy.ts";
import { createGameClient } from "../../src/net/client.ts";

test("base58 round trip (incl. leading zeros)", () => {
  for (const b of [new Uint8Array([0, 0, 1, 2, 255]), crypto.getRandomValues(new Uint8Array(32)), new Uint8Array([])]) {
    assert.deepEqual(base58Decode(base58Encode(b)), b);
  }
});

test("a browser-signed delegate action is decoded and verified by the relayer", async () => {
  const k = await generateKey();
  const s = await Signer.load(k);
  const payload = await signDelegate(s, {
    senderId: "g-ab12.relay.t",
    receiverId: "royale.t",
    actions: [{ methodName: "start_match", args: {}, gas: 100n * 10n ** 12n }],
    nonce: 42n,
    maxBlockHeight: 123_456n,
  });
  const sig = signatureOk(payload);
  assert.equal(sig.ok, true);
  assert.equal(sig.publicKey, k.publicKey);
  const d = decodeSignedDelegateAction(payload).signedDelegate.delegateAction;
  assert.equal(d.senderId, "g-ab12.relay.t");
  assert.equal(d.receiverId, "royale.t");
  assert.equal(BigInt(d.nonce), 42n);
  assert.equal(BigInt(d.maxBlockHeight), 123_456n);
  const check = checkDelegate(
    { senderId: d.senderId, receiverId: d.receiverId, actions: d.actions as Array<Record<string, unknown>>, maxBlockHeight: BigInt(d.maxBlockHeight) },
    { gameContractId: "royale.t", guestParentId: "relay.t", allowedMethods: ["start_match"], maxGasPerAction: 100n * 10n ** 12n, maxActions: 1 },
    1000n,
  );
  assert.deepEqual(check, { ok: true, methods: ["start_match"], gas: 100n * 10n ** 12n });
  // tampering breaks it
  const bad = Buffer.from(payload, "base64");
  bad[5] ^= 1;
  assert.equal(signatureOk(bad.toString("base64")).ok, false);
});

test("settle signing matches the server's protocol", async () => {
  const inputs: [number, number, number, number, number, number][] = [[0, 0, 1000, 0, 4096 * 3 + 7, 1]];
  assert.equal(await inputLogHash(inputs), srvLogHash(inputs));
  const msg = await settleMessage("12", srvLogHash(inputs));
  assert.deepEqual(msg, srvSettleMessage("12", srvLogHash(inputs)));
  const k = await generateKey();
  const sig = toBase64(await (await Signer.load(k)).sign(msg));
  assert.equal(settleSignatureOk(srvSettleMessage("12", srvLogHash(inputs)), k.publicKey, sig), true);
});

import http from "node:http";
import { SIM_VERSION } from "../../src/sim/types.ts";

/** A fake relayer that only answers /api/health. */
async function fakeHealth(body: Record<string, unknown>): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

/** Run `f` and fail if it writes anything to console.warn / console.error / console.log. */
async function silently<T>(f: () => Promise<T>): Promise<T> {
  const calls: unknown[] = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  console.warn = console.error = console.log = (...a: unknown[]) => void calls.push(a);
  try {
    return await f();
  } finally {
    Object.assign(console, orig);
    assert.deepEqual(calls, [], "no console output");
  }
}

test("version guard: a server with another sim version -> offline with a reason", async () => {
  const h = await fakeHealth({ ok: true, game: "royale.t", simVersion: "r0-old" });
  try {
    const c = await silently(() => createGameClient({ relayer: h.url, contract: "royale.t" }));
    assert.equal(c.mode, "offline");
    assert.equal(c.offlineReason, "sim_version_mismatch");
  } finally {
    h.close();
  }
});

test("version guard: an old server without simVersion is a mismatch too; wrong contract has its own reason", async () => {
  const a = await fakeHealth({ ok: true, game: "royale.t" });
  const b = await fakeHealth({ ok: true, game: "other.t", simVersion: SIM_VERSION });
  try {
    assert.equal((await createGameClient({ relayer: a.url, contract: "royale.t" })).offlineReason, "sim_version_mismatch");
    assert.equal((await createGameClient({ relayer: b.url, contract: "royale.t" })).offlineReason, "wrong_contract");
  } finally {
    a.close();
    b.close();
  }
});

test("a matching server -> chain mode, no offline reason", async () => {
  const h = await fakeHealth({ ok: true, game: "royale.t", simVersion: SIM_VERSION });
  try {
    const c = await silently(() => createGameClient({ relayer: h.url, contract: "royale.t" }));
    assert.equal(c.mode, "chain");
    assert.equal(c.offlineReason, undefined);
  } finally {
    h.close();
  }
});

test("offline fallback: unreachable relayer -> local play, unverified settle, no console noise", async () => {
  const c = await silently(() => createGameClient({ relayer: "http://127.0.0.1:9", contract: "royale.t" }));
  assert.equal(c.mode, "offline");
  assert.equal(c.offlineReason, "relayer_unreachable");
  assert.equal(await c.account(), "you");
  assert.equal(c.isGuest(), true);
  const fs = await silently(() => c.fighters());
  assert.equal(fs.length, 9);
  assert.equal(fs.filter((f) => f.bounty).length, 1);
  const s = await c.startMatch();
  assert.match(s.matchId, /^local-/);
  assert.equal(s.cfg.fighters.length, 10);
  assert.ok(s.cfg.seed > 0);
  assert.equal(s.tx, null);
  const r = await silently(() => c.settle(s.matchId, { version: 1, cfg: s.cfg, inputs: [], hash: "x", winner: 3, placements: [] }));
  assert.deepEqual(r, { tx: null, verified: false, winner: 3, payouts: [], retired: [], rookies: [], upgrades: [] });
  assert.match(c.explorerTx("abc"), /txns\/abc$/);
});

import { histEvent } from "../../src/net/client.ts";
import { matchConfigFromChain } from "../../src/net/roster.ts";
import { registerMessage } from "../src/protocol.ts";
import { sha256 } from "../../src/net/near.ts";

test("T3: history entries become ready-to-show lines", () => {
  const e = (kind: string, amount: string, detail: string) => histEvent({ match_id: "42", at_ms: "1000", kind, amount, detail });
  assert.equal(e("win", "70420000000000000000", "1:3").text, "Won match #42 and took 70.42 $NOX (3 kills)");
  assert.equal(e("death", "0", "4:1").kind, "kill");
  assert.equal(e("death", "0", "9:0").text, "Finished #9 in match #42");
  assert.equal(e("upgrade", "120000000000000000000", "weapon 2").text, "Bought weapon tier 2 for 120 $NOX");
  assert.equal(e("bounty", "15000000000000000000", "lost").kind, "bounty");
  assert.equal(e("retired", "0", "broke").kind, "retired");
  assert.equal(e("dividend", "7040000000000000000", "").kind, "sponsored");
  assert.equal(e("win", "1", "1:0").at, 1000);
});

test("T3: guests get human-readable refusals, offline T3 calls stay quiet", async () => {
  const c = (await createGameClient({ relayer: "http://127.0.0.1:9", contract: "royale.t" })) as unknown as import("../../src/net/api.ts").GameClientT3;
  await assert.rejects(() => c.sponsor("bot.t", 10), /Sign in with a NEAR account/);
  await assert.rejects(() => c.unsponsor("bot.t"), /Sign in with a NEAR account/);
  assert.equal(await c.balance(), 0);
  assert.deepEqual(await c.market(), []);
  assert.equal((await c.leaderboard("bots")).length, 9);
  const p = await c.progress();
  assert.equal(p.level, 1);
});

test("T3: the player's level upgrades from the chain go into fighter 0", () => {
  const roster = Array.from({ length: 9 }, (_, i) => ({ idx: i + 1, account: `b${i}.t`, name: `B${i}`, personality: "balanced", upgrades: { weaponTier: 0, armor: 0, skin: i }, bounty: false, paid: "0" }));
  const cfg = matchConfigFromChain({ seed: 7, player: "alice.t", guest: false, bounty_idx: null, roster, player_upgrades: { weaponTier: 2, armor: 1, skin: 14 }, player_level: 10 }, { skin: 3 });
  assert.deepEqual(cfg.fighters[0].upgrades, { weaponTier: 2, armor: 1, skin: 14 }, "chain wins over the client's choice");
});

test("T3: register message matches between browser and relayer", async () => {
  assert.deepEqual(await sha256("bountyroyale:register:alice.testnet"), registerMessage("alice.testnet"));
});

test("guest budget mode: closed relayer -> guests offline with a reason, no console noise", async () => {
  const h = await fakeHealth({ ok: true, game: "royale.t", simVersion: SIM_VERSION, guests: "closed", reason: "budget" });
  try {
    const c = await silently(() => createGameClient({ relayer: h.url, contract: "royale.t" }));
    assert.equal(c.mode, "offline");
    assert.equal(c.offlineReason, "guests_closed");
    const s = await c.startMatch();
    assert.match(s.matchId, /^local-/, "guests play locally");
  } finally {
    h.close();
  }
});

import { encodeTransaction } from "../../src/net/near.ts";
test("direct transactions: borsh layout of a FunctionCall tx", () => {
  const tx = encodeTransaction({ signerId: "a.t", publicKey: new Uint8Array(32).fill(7), nonce: 5n, receiverId: "g.t", blockHash: new Uint8Array(32).fill(9), actions: [{ methodName: "m", args: {}, gas: 10n }] });
  // 4+3 signer, 1+32 key, 8 nonce, 4+3 receiver, 32 hash, 4 count, 1 tag, 4+1 method, 4+2 args, 8 gas, 16 deposit
  assert.equal(tx.length, 7 + 33 + 8 + 7 + 32 + 4 + 1 + 5 + 6 + 8 + 16);
  assert.equal(tx[7], 0, "ed25519 key type");
  assert.equal(tx[7 + 33 + 8 + 7 + 32 + 4], 2, "Action::FunctionCall");
});
