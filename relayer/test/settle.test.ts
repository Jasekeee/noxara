import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { checkInputs, checkSimVersion, inputLogHash, judge, settleMessage, SIM_VERSION, type ReplayResult } from "../src/settle.ts";
import { configDiff, matchConfigFromChain, type ChainMatch } from "../src/roster.ts";
import { settleSignatureOk } from "../src/verify.ts";
import type { MatchRecord } from "../../src/sim/types.ts";

const roster = Array.from({ length: 9 }, (_, i) => ({
  idx: i + 1,
  account: `bot${i}.royale.t`,
  name: `Bot${i}`,
  personality: i === 0 ? "sniper" : "balanced",
  upgrades: { weaponTier: i % 3, armor: 0, skin: i },
  bounty: i === 4,
  paid: "10",
}));
const chainMatch: ChainMatch = { match_id: "7", seed: 12345, player: "g-ab.relay.t", guest: true, bounty_idx: 5, roster, status: "Pending" };

function record(over: Partial<MatchRecord> = {}): MatchRecord {
  return {
    version: 1,
    cfg: matchConfigFromChain(chainMatch, { name: "Zhas", skin: 3 }),
    inputs: [[0, 0, 1000, 0, 0, 0], [5, 0, 0, 1000, 1024, 1]],
    hash: "H",
    winner: 3,
    placements: [4, 2, 5, 1, 6, 7, 8, 9, 10, 3],
    ...over,
  };
}
const fake = (r: Partial<ReplayResult> = {}) => () => ({ hash: "H", winner: 3, placements: [4, 2, 5, 1, 6, 7, 8, 9, 10, 3], ...r });

test("matchConfigFromChain: human at idx 0, bots by roster idx, bounty and upgrades from chain", () => {
  const cfg = matchConfigFromChain(chainMatch, { name: "Zhas", skin: 3 });
  assert.equal(cfg.seed, 12345);
  assert.equal(cfg.fighters.length, 10);
  assert.deepEqual(cfg.fighters[0], { id: "g-ab.relay.t", name: "Zhas", personality: "balanced", human: true, upgrades: { weaponTier: 0, armor: 0, skin: 3 }, bounty: false });
  assert.equal(cfg.fighters[1].personality, "sniper");
  assert.equal(cfg.fighters[5].bounty, true);
  assert.equal(cfg.fighters[3].upgrades.weaponTier, 2);
  assert.throws(() => matchConfigFromChain({ ...chainMatch, seed: 0 }));
});

test("configDiff finds tampering", () => {
  const a = matchConfigFromChain(chainMatch);
  const b = structuredClone(a);
  assert.equal(configDiff(a, b), null);
  b.fighters[2].upgrades.armor = 2;
  assert.equal(configDiff(a, b), "fighters[2].upgrades.armor");
  const c = structuredClone(a);
  c.fighters[0].upgrades.weaponTier = 2; // a human can't give themselves a better gun
  assert.equal(configDiff(a, c), "fighters[0].upgrades.weaponTier");
});

test("checkInputs", () => {
  assert.equal(checkInputs([[0, 0, 0, 0, 0, 0]]), null);
  assert.match(checkInputs([[0, 1, 0, 0, 0, 0]])!, /human/);
  assert.match(checkInputs([[5, 0, 0, 0, 0, 0], [4, 0, 0, 0, 0, 0]])!, /order/);
  assert.match(checkInputs([[0, 0, 2000, 0, 0, 0]])!, /range/);
  assert.match(checkInputs([[0, 0, 0, 0, 0]])!, /bad/);
  assert.match(checkInputs("x")!, /array/);
});

test("inputLogHash is stable sha256 hex", () => {
  const h = inputLogHash([[0, 0, 1, 2, 3, 1]]);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, inputLogHash([[0, 0, 1, 2, 3, 1]]));
  assert.notEqual(h, inputLogHash([[0, 0, 1, 2, 3, 0]]));
});

test("judge: a faithful record becomes settle_match args", () => {
  const v = judge(chainMatch, record(), fake({ kills: [1, 0, 0, 3, 0, 0, 0, 0, 0, 2], bountyKiller: 3 }));
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(v.args.placements, [4, 2, 5, 1, 6, 7, 8, 9, 10, 3]);
  assert.deepEqual(v.args.kills, [1, 0, 0, 3, 0, 0, 0, 0, 0, 2]);
  assert.equal(v.args.bounty_killer, 3);
  assert.equal(v.args.match_id, "7");
  assert.equal(v.args.input_log_hash, inputLogHash(record().inputs));
  assert.equal(v.args.result_hash, "H");
  assert.equal(v.killsFrom, "replay");
});

test("judge: rejects a replay mismatch, a tampered roster, a settled match, bad inputs", () => {
  assert.equal(judge(chainMatch, record(), fake({ hash: "OTHER" })).ok, false);
  const r = record();
  r.cfg.fighters[4].upgrades.weaponTier = 2;
  const v = judge(chainMatch, r, fake());
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /on-chain/);
  assert.equal(judge({ ...chainMatch, status: "Settled" }, record(), fake()).ok, false);
  assert.equal(judge(chainMatch, record({ inputs: [[0, 3, 0, 0, 0, 0]] }), fake()).ok, false);
  assert.equal(judge({ ...chainMatch, seed: 0 }, record(), fake()).ok, false);
});

test("judge: keeps kill totals within the contract's rules", () => {
  const v = judge(chainMatch, record(), fake({ kills: [9, 9, 0, 0, 0, 0, 0, 0, 0, 0], bountyKiller: 42 }));
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.ok(v.args.kills.reduce((a, b) => a + b, 0) < 10);
  assert.equal(v.args.bounty_killer, null);
});

test("settle signatures: only the signed (match, log) pair verifies", () => {
  const sk = ed25519.utils.randomSecretKey();
  const pk = `ed25519:${base58.encode(ed25519.getPublicKey(sk))}`;
  const msg = settleMessage("7", "abc");
  const sig = Buffer.from(ed25519.sign(msg, sk)).toString("base64");
  assert.equal(settleSignatureOk(msg, pk, sig), true);
  assert.equal(settleSignatureOk(settleMessage("8", "abc"), pk, sig), false);
  assert.equal(settleSignatureOk(settleMessage("7", "abd"), pk, sig), false);
  assert.equal(settleSignatureOk(msg, "ed25519:xyz", sig), false);
  assert.equal(settleSignatureOk(msg, pk, "!!"), false);
});

test("sim version guard: only the server's own version is accepted", () => {
  assert.deepEqual(checkSimVersion(SIM_VERSION), { ok: true });
  for (const v of ["r0", undefined, null, 4]) {
    const r = checkSimVersion(v);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "sim_version_mismatch");
      assert.equal(r.status, 409);
    }
  }
});

test("judge: replay mismatch carries a machine-readable code", () => {
  const v = judge(chainMatch, record(), fake({ hash: "OTHER" }));
  assert.equal(v.ok, false);
  assert.equal((v as { code?: string }).code, "replay_mismatch");
});
