import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDelegate, isGuestAccount, isGuestId, RateLimiter, GAME_METHODS_DEFAULT, METHOD_GAS_DEFAULT, type RelayPolicy } from "../src/policy.ts";

const p: RelayPolicy = { gameContractId: "game.t", guestParentId: "relay.t", allowedMethods: ["start_match", "draw", "leave"], maxGasPerAction: 30n * 10n ** 12n, maxActions: 1 };
const fc = (methodName: string, deposit = 0n, gas = 15n * 10n ** 12n) => ({ functionCall: { methodName, args: new Uint8Array(), gas, deposit } });
const d = (o: Partial<Parameters<typeof checkDelegate>[0]> = {}) => ({ senderId: "g-ab.relay.t", receiverId: "game.t", actions: [fc("draw")], maxBlockHeight: 1000n, ...o });

test("accepts a zero-deposit allow-listed call to the game", () => assert.deepEqual(checkDelegate(d(), p, 10n), { ok: true, methods: ["draw"], gas: 15n * 10n ** 12n }));
test("rejects other receivers", () => assert.equal(checkDelegate(d({ receiverId: "evil.t" }), p).ok, false));
test("rejects deposits", () => assert.equal(checkDelegate(d({ actions: [fc("draw", 1n)] }), p).ok, false));
test("rejects non allow-listed methods", () => assert.equal(checkDelegate(d({ actions: [fc("sell_to_fence")] }), p).ok, false));
test("rejects non function-call actions", () => assert.equal(checkDelegate(d({ actions: [{ transfer: { deposit: 1n } }] }), p).ok, false));
test("rejects batches", () => assert.equal(checkDelegate(d({ actions: [fc("draw"), fc("draw")] }), p).ok, false));
test("rejects too much gas", () => assert.equal(checkDelegate(d({ actions: [fc("draw", 0n, 300n * 10n ** 12n)] }), p).ok, false));
test("rejects expired delegates", () => assert.equal(checkDelegate(d({ maxBlockHeight: 5n }), p, 10n).ok, false));
test("rejects the relayer itself as sender", () => assert.equal(checkDelegate(d({ senderId: "relay.t" }), p).ok, false));
test("guest account detection", () => {
  assert.equal(isGuestAccount("g-ab12.relay.t", "relay.t"), true);
  assert.equal(isGuestAccount("alice.t", "relay.t"), false);
  assert.equal(isGuestAccount("x.g-ab.relay.t", "relay.t"), false);
  assert.equal(isGuestAccount("g-ab.relay.tt", "relay.t"), false);
});
test("rate limiter", () => {
  const r = new RateLimiter(2, 1000);
  assert.equal(r.take("a", 0), true);
  assert.equal(r.take("a", 1), true);
  assert.equal(r.take("a", 2), false);
  assert.equal(r.take("a", 1001), true);
});

import { gameFailure, gameValue } from "../src/chain.ts";
test("gameValue / gameFailure read the relayed call's result", () => {
  const ok = { receipts_outcome: [
    { outcome: { executor_id: "g-1.relay.t", status: { SuccessValue: "" } } },
    { outcome: { executor_id: "game.t", status: { SuccessReceiptId: "x" } } },
    { outcome: { executor_id: "game.t", status: { SuccessValue: Buffer.from(JSON.stringify({ token: "coin" })).toString("base64") } } },
  ] };
  assert.deepEqual(gameValue(ok, "game.t"), { token: "coin" });
  assert.equal(gameFailure(ok), null);
  const bad = { receipts_outcome: [{ outcome: { executor_id: "game.t", status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: panicked at src/lib.rs:180:9:\nthis room is empty: go deeper or leave" } } } } } } }] };
  assert.equal(gameFailure(bad), "this room is empty: go deeper or leave");
});

import { Budget } from "../src/policy.ts";
test("per-method gas caps", () => {
  const q = { ...p, methodGas: { draw: 10n * 10n ** 12n } };
  assert.equal(checkDelegate(d(), q).ok, false);
});
test("gas budget", () => {
  const b = new Budget(100n, 1000);
  assert.equal(b.take("a", 60n, 0), true);
  assert.equal(b.take("a", 60n, 1), false);
  assert.equal(b.take("a", 40n, 2), true);
  assert.equal(b.take("a", 60n, 1001), true);
  assert.equal(b.take("b", 101n, 0), false);
});

import { signatureOk } from "../src/verify.ts";
import { Near, InMemoryKeyStore, generateKey } from "near-kit";
test("delegate signatures are verified locally", async () => {
  const kp = generateKey();
  const id = "g-ab.relay.t";
  const near = new Near({ network: "testnet", rpcUrl: "http://127.0.0.1:9", keyStore: new InMemoryKeyStore({ [id]: kp.secretKey }) });
  const { payload } = await near.transaction(id).functionCall("game.t", "draw", {}, { gas: "15 Tgas" })
    .delegate({ nonce: 5n, maxBlockHeight: 1000n, publicKey: kp.publicKey.toString() });
  const ok = signatureOk(payload);
  assert.equal(ok.ok, true);
  assert.equal(ok.publicKey, kp.publicKey.toString());
  const bad = Buffer.from(payload, "base64");
  bad[10] ^= 1; // tamper with the delegate body
  assert.equal(signatureOk(bad.toString("base64")).ok, false);
});

test("both guest forms: g-*.<relayer> (testnet) and g-*.<game contract> (create_guest, mainnet)", () => {
  assert.equal(isGuestAccount("g-ab12.relay.t", "relay.t", "game.t"), true);
  assert.equal(isGuestAccount("g-00aa11bb22.game.t", "relay.t", "game.t"), true);
  assert.equal(isGuestAccount("g-00aa11bb22.game.t", "relay.t"), false, "without the contract only the old form");
  assert.equal(isGuestAccount("g-.game.t", "relay.t", "game.t"), false);
  assert.equal(isGuestAccount("g-ab.x.game.t", "relay.t", "game.t"), false);
  assert.equal(isGuestAccount("house.game.t", "relay.t", "game.t"), false);
  assert.equal(isGuestAccount("alice.t", undefined, "game.t"), false);
  assert.equal(isGuestAccount("g-ab.relay.t", undefined, undefined), false);
});

test("create_guest ids mirror the contract's rule", () => {
  for (const ok of ["00aa11bb", "0123456789", "f".repeat(32)]) assert.equal(isGuestId(ok), true, ok);
  for (const bad of ["", "0123abc", "0123ABCD", "0123abcg", "g-0123abcd", "0123.abcd", "f".repeat(33)]) assert.equal(isGuestId(bad), false, bad);
});

test("claim_login is relayed gaslessly (default allow-list, 30 Tgas cap)", () => {
  assert.ok(GAME_METHODS_DEFAULT.includes("claim_login"));
  const lp: RelayPolicy = { gameContractId: "game.t", guestParentId: "relay.t", allowedMethods: GAME_METHODS_DEFAULT, maxGasPerAction: 150n * 10n ** 12n, maxActions: 1, methodGas: METHOD_GAS_DEFAULT };
  const call = (gas: bigint) => ({ senderId: "alice.t", receiverId: "game.t", actions: [{ functionCall: { methodName: "claim_login", args: new Uint8Array(), gas, deposit: 0n } }], maxBlockHeight: 1000n });
  assert.equal(checkDelegate(call(30n * 10n ** 12n), lp).ok, true);
  assert.equal(checkDelegate(call(31n * 10n ** 12n), lp).ok, false, "gas capped");
  assert.equal(checkDelegate({ ...call(30n * 10n ** 12n), receiverId: "other.t" }, lp).ok, false);
  // guests' own keys never get it (GUEST_METHODS stays start/sweep; the contract fixes create_guest's key too)
  assert.equal(checkDelegate({ ...call(30n * 10n ** 12n), actions: [{ functionCall: { methodName: "create_guest", args: new Uint8Array(), gas: 30n * 10n ** 12n, deposit: 0n } }] }, lp).ok, false, "create_guest is never relayed");
});
