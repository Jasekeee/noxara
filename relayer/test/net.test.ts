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

test("offline fallback: unreachable relayer -> local play, unverified settle", async () => {
  const c = await createGameClient({ relayer: "http://127.0.0.1:9", contract: "royale.t" });
  assert.equal(c.mode, "offline");
  assert.equal(await c.account(), "you");
  assert.equal(c.isGuest(), true);
  const fs = await c.fighters();
  assert.equal(fs.length, 9);
  assert.equal(fs.filter((f) => f.bounty).length, 1);
  const s = await c.startMatch();
  assert.match(s.matchId, /^local-/);
  assert.equal(s.cfg.fighters.length, 10);
  assert.ok(s.cfg.seed > 0);
  assert.equal(s.tx, null);
  const r = await c.settle(s.matchId, { version: 1, cfg: s.cfg, inputs: [], hash: "x", winner: 3, placements: [] });
  assert.deepEqual(r, { tx: null, verified: false, winner: 3, payouts: [], retired: [], rookies: [], upgrades: [] });
  assert.match(c.explorerTx("abc"), /txns\/abc$/);
});
