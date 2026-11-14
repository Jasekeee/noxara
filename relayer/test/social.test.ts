// Challenge a friend + Daily tournament against the REAL shared simulation (no chain, fake clock).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { createMatch } from "../../src/sim/match.ts";
import { botInput } from "../../src/sim/ai.ts";
import { Recorder } from "../../src/sim/record.ts";
import { t1Roster } from "../../src/sim/roster.ts";
import { MATCH_TICKS, SIM_VERSION, type Input, type MatchConfig, type MatchRecord } from "../../src/sim/types.ts";
import { createSocial, writeReply } from "../src/social-http.ts";
import { analyze, compareScores, sanitizeCfg } from "../src/social.ts";
import { dailyConfig, dailyMessage, dailySeed, utcDay } from "../src/tournament.ts";
import { inputLogHash } from "../src/settle.ts";

const T0 = Date.parse("2026-11-14T12:00:00Z");
let clock = T0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "noxara-social-"));
const mk = (extra: Partial<Parameters<typeof createSocial>[0]> = {}) =>
  createSocial({ dataDir: tmp(), allowedOrigins: ["http://127.0.0.1:5192"], verifyOwner: async () => true, guestParent: "relay.t", now: () => clock, secret: "test-secret-0123456789", ...extra });

type Policy = "bot" | "idle" | "run";
function play(cfg: MatchConfig, policy: Policy): MatchRecord {
  const m = createMatch(cfg);
  const rec = new Recorder();
  while (!m.state.over && m.state.tick < MATCH_TICKS) {
    const inp: Input = policy === "bot" ? botInput(m, 0) : policy === "run" ? { mx: 1000, my: 0, aim: 0, fire: true } : { mx: 0, my: 0, aim: 0, fire: false };
    rec.push(m.state.tick, 0, inp);
    m.step(new Map([[0, inp]]));
  }
  return { version: 1, cfg, inputs: rec.inputs, hash: m.hash(), winner: m.state.winner, placements: m.state.fighters.map((f) => f.placement) };
}
const cfgA: MatchConfig = { seed: 4242, fighters: t1Roster() };
const recA = play(cfgA, "bot");
const body = (record: MatchRecord, extra: Record<string, unknown> = {}) => ({ record, simVersion: SIM_VERSION, name: "Pip", ...extra });

// ------------------------------------------------------------------ challenge
test("challenge: create replays the record and stores the result; GET returns the exact cfg + token", () => {
  const s = mk();
  const r = s.challenges.create(body(recA), "1.1.1.1");
  assert.equal(r.code, 200, JSON.stringify(r.json));
  const j = r.json as { id: string; result: { name: string; placement: number; kills: number } };
  assert.match(j.id, /^[a-z2-7]{8}$/);
  const a = analyze(cfgA, recA.inputs);
  assert.equal(j.result.placement, a.placement);
  assert.equal(j.result.kills, a.kills);
  assert.equal(j.result.name, "Pip");
  const g = s.challenges.get(j.id).json as { cfg: MatchConfig; token: string };
  assert.equal(g.cfg.seed, 4242);
  assert.equal(g.cfg.fighters.length, 10);
  assert.equal(g.cfg.fighters[0].name, "You");
  assert.deepEqual(g.cfg.fighters.slice(1), cfgA.fighters.slice(1));
  assert.ok(g.token.startsWith(j.id));
});

test("challenge: a tampered record, a wrong version and a bad roster are refused", () => {
  const s = mk();
  const bad = { ...recA, inputs: recA.inputs.slice(0, Math.floor(recA.inputs.length / 2)) };
  assert.equal(s.challenges.create(body(bad), "2.2.2.2").code, 409);
  assert.equal(s.challenges.create({ ...body(recA), simVersion: "r0" }, "2.2.2.2").code, 409);
  assert.equal(s.challenges.create(body({ ...recA, hash: "00" }), "2.2.2.2").code, 409);
  const two = { ...recA, cfg: { ...cfgA, fighters: cfgA.fighters.map((f) => ({ ...f, human: true })) } };
  assert.equal(s.challenges.create(body(two), "2.2.2.2").code, 400);
  assert.equal(sanitizeCfg({ seed: -1, fighters: cfgA.fighters }), null);
  assert.equal(s.challenges.create({ simVersion: SIM_VERSION, name: "x" }, "2.2.2.2").code, 400);
});

test("challenge: answer is replayed, real-time checked, compared; a token is single-use", () => {
  const s = mk();
  const id = (s.challenges.create(body(recA), "3.3.3.3").json as { id: string }).id;
  const friend = play({ seed: 4242, fighters: t1Roster().map((f, i) => (i === 0 ? { ...f, id: "you", name: "You" } : f)) }, "idle");
  const t = (s.challenges.get(id).json as { token: string }).token;
  // too fast: submitted 1 s after opening
  clock += 1000;
  const fast = s.challenges.answer(id, body(friend, { token: t, name: "Sam" }), "4.4.4.4");
  assert.equal(fast.code, 409);
  assert.equal((fast.json as { code: string }).code, "too_fast");
  // the token is spent even by a refused attempt
  assert.equal((s.challenges.answer(id, body(friend, { token: t }), "4.4.4.4").json as { code: string }).code, "token_used");
  // a fresh token + enough real time
  const t2 = (s.challenges.get(id).json as { token: string }).token;
  const a = analyze(s.challenges.get(id).json && (s.challenges.get(id).json as { cfg: MatchConfig }).cfg, friend.inputs);
  clock += a.ticksTotal * 50;
  const ok = s.challenges.answer(id, body(friend, { token: t2, name: "Sam" }), "4.4.4.4");
  assert.equal(ok.code, 200, JSON.stringify(ok.json));
  const j = ok.json as { you: { name: string; placement: number }; them: { name: string }; winner: string };
  assert.equal(j.you.name, "Sam");
  assert.equal(j.them.name, "Pip");
  const want = compareScores(a, analyze(cfgA, recA.inputs));
  assert.equal(j.winner, want < 0 ? "you" : want > 0 ? "them" : "tie");
  // a forged token, another challenge's token
  const other = (s.challenges.create(body(recA), "3.3.3.3").json as { id: string }).id;
  assert.equal((s.challenges.answer(id, body(friend, { token: "x.1.2.3" }), "4.4.4.4").json as { code: string }).code, "bad_token");
  const tOther = (s.challenges.get(other).json as { token: string }).token;
  assert.equal((s.challenges.answer(id, body(friend, { token: tOther }), "4.4.4.4").json as { code: string }).code, "bad_token");
  // the answer shows up in the public results
  assert.equal((s.challenges.results(id).json as { answers: unknown[] }).answers.length, 1);
});

test("challenge: a tampered answer (replay mismatch) and a stale token are refused", () => {
  const s = mk();
  const id = (s.challenges.create(body(recA), "5.5.5.5").json as { id: string }).id;
  const cfg = (s.challenges.get(id).json as { cfg: MatchConfig }).cfg;
  const friend = play(cfg, "run");
  const t = (s.challenges.get(id).json as { token: string }).token;
  clock += 200_000;
  const cheat = { ...friend, inputs: [[0, 0, 0, 0, 0, 0] as MatchRecord["inputs"][0]] }; // says "idle" but claims the "run" result
  assert.equal((s.challenges.answer(id, body(cheat, { token: t }), "6.6.6.6").json as { code: string }).code, "replay_mismatch");
  const t2 = (s.challenges.get(id).json as { token: string }).token;
  clock += 3 * 3_600_000;
  assert.equal((s.challenges.answer(id, body(friend, { token: t2 }), "6.6.6.6").json as { code: string }).code, "token_expired");
});

test("challenge: at most 20 answers per challenge and a per-IP rate limit", () => {
  const s = mk();
  const id = (s.challenges.create(body(recA), "7.7.7.7").json as { id: string }).id;
  const cfg = (s.challenges.get(id).json as { cfg: MatchConfig }).cfg;
  const friend = play(cfg, "idle");
  const ticks = analyze(cfg, friend.inputs).ticksTotal;
  for (let i = 0; i < 20; i++) {
    const t = (s.challenges.get(id).json as { token: string }).token;
    clock += ticks * 50;
    const r = s.challenges.answer(id, body(friend, { token: t }), `9.9.9.${i}`);
    assert.equal(r.code, 200, `answer ${i}: ${JSON.stringify(r.json)}`);
  }
  const t = (s.challenges.get(id).json as { token: string }).token;
  assert.equal((s.challenges.answer(id, body(friend, { token: t }), "9.9.9.99").json as { code: string }).code, "full");
  const lim = mk();
  const codes = Array.from({ length: 22 }, () => lim.challenges.create(body(recA), "8.8.8.8").code);
  assert.equal(codes.filter((c) => c === 200).length, 20);
  assert.equal(codes[21], 429);
});

test("challenge: /c/<id> is an og page with the score and a redirect to the game", async () => {
  const s = mk({ publicUrl: "https://noxara.example", gameUrl: "https://noxara.example/play/" });
  const id = (s.challenges.create(body(recA, { game: "http://127.0.0.1:5192/" }), "1.2.3.4").json as { id: string }).id;
  const a = analyze(cfgA, recA.inputs);
  const page = s.challenges.page(id, "http://h", "https://noxara.example");
  assert.equal(page.code, 200);
  assert.ok(page.html!.includes(`Placed ${a.placement}/10 with ${a.kills} kill${a.kills === 1 ? "" : "s"} — can you beat it? NOXARA`));
  assert.ok(page.html!.includes('og:image" content="https://noxara.example/og.png"'));
  assert.ok(page.html!.includes(`http://127.0.0.1:5192/?challenge=${id}`));
  // a game url from a stranger's origin is ignored (open-redirect guard)
  const id2 = (s.challenges.create(body(recA, { game: "https://evil.example/x" }), "1.2.3.4").json as { id: string }).id;
  assert.ok(!s.challenges.page(id2, "http://h").html!.includes("evil.example"));
  // the name is escaped
  const id3 = (s.challenges.create(body(recA, { name: "<img src=x onerror=1>" }), "1.2.3.5").json as { id: string }).id;
  assert.ok(!s.challenges.page(id3, "http://h").html!.includes("<img"));
});

// ------------------------------------------------------------------ daily
const guestBody = (rec: MatchRecord, token: string, gid: string) => ({ record: rec, token, simVersion: SIM_VERSION, guestId: gid });
const dayCfg = () => dailyConfig(utcDay(clock));
const todayToken = (s: ReturnType<typeof mk>) => (s.daily.today().json as { token: string }).token;

test("daily: seed = first 4 bytes of sha256('noxara-daily-' + day), nonzero; roster is t1Roster; token and end time", () => {
  const s = mk();
  const day = utcDay(clock);
  const want = crypto.createHash("sha256").update(`noxara-daily-${day}`).digest().readUInt32BE(0);
  assert.equal(dailySeed(day), want || 1);
  const j = s.daily.today().json as { day: string; seed: number; roster: unknown; endsAt: number; token: string };
  assert.equal(j.day, "2026-11-14");
  assert.equal(j.seed, dailySeed("2026-11-14"));
  assert.deepEqual(j.roster, t1Roster());
  assert.equal(j.endsAt, Date.parse("2026-11-15T00:00:00Z"));
  assert.ok(j.token.startsWith("2026-11-14."));
  assert.notEqual(dailySeed("2026-11-14"), dailySeed("2026-11-15"));
});

test("daily: guests are listed as 'Guest xxxx' with earns 0; best run is kept; ordering = placement, kills, time", async () => {
  clock = T0;
  const s = mk();
  const runs: { gid: string; rec: MatchRecord }[] = [
    { gid: "aaaa1111", rec: play(dayCfg(), "bot") },
    { gid: "bbbb2222", rec: play(dayCfg(), "idle") },
    { gid: "cccc3333", rec: play(dayCfg(), "run") },
  ];
  const ticks = analyze(dayCfg(), runs[0].rec.inputs).ticksTotal;
  for (const r of runs) {
    const t = todayToken(s);
    clock += ticks * 50;
    const res = await s.daily.submit(guestBody(r.rec, t, r.gid), "1.1.1.1");
    assert.equal(res.code, 200, JSON.stringify(res.json));
    assert.equal((res.json as { earns: number }).earns, 0);
  }
  const rows = (s.daily.leaderboard(null).json as { rows: { name: string; kind: string; earns: number; placement: number; kills: number; ticksSurvived: number }[] }).rows;
  assert.equal(rows.length, 3);
  const expect = runs.map((r) => ({ gid: r.gid, ...analyze(dayCfg(), r.rec.inputs) })).sort((a, b) => compareScores(a, b));
  assert.deepEqual(rows.map((r) => r.name), expect.map((e) => `Guest ${e.gid.slice(0, 4)}`));
  for (const r of rows) {
    assert.equal(r.kind, "guest");
    assert.equal(r.earns, 0);
  }
  // a worse run by the same guest does not replace the best one; a better one does
  const best = expect[0];
  const worst = expect[expect.length - 1];
  const idle = runs.find((r) => r.gid === worst.gid)!;
  const t = todayToken(s);
  clock += ticks * 50;
  const r2 = (await s.daily.submit(guestBody(idle.rec, t, best.gid), "1.1.1.2")).json as { improved: boolean; rank: number };
  assert.equal(r2.improved, false);
  assert.equal(r2.rank, 1);
  assert.equal((s.daily.leaderboard(null).json as { total: number }).total, 3);
});

test("daily: tampered, too fast, replayed token and wrong-day config are refused", async () => {
  clock = T0;
  const s = mk();
  const rec = play(dayCfg(), "bot");
  const ticks = analyze(dayCfg(), rec.inputs).ticksTotal;
  const t = todayToken(s);
  clock += 5_000;
  const fast = await s.daily.submit(guestBody(rec, t, "dddd4444"), "2.2.2.2");
  assert.equal((fast.json as { code: string }).code, "too_fast");
  assert.equal(((await s.daily.submit(guestBody(rec, t, "dddd4444"), "2.2.2.2")).json as { code: string }).code, "token_used");
  const t2 = todayToken(s);
  clock += ticks * 50;
  const tampered = { ...rec, inputs: rec.inputs.slice(0, Math.max(1, rec.inputs.length >> 1)) };
  assert.equal(((await s.daily.submit(guestBody(tampered, t2, "dddd4444"), "2.2.2.2")).json as { code: string }).code, "replay_mismatch");
  // a record from yesterday's seed does not verify against today's
  const old = play({ seed: dailySeed("2026-11-13"), fighters: t1Roster() }, "bot");
  const t3 = todayToken(s);
  clock += ticks * 50;
  assert.equal(((await s.daily.submit(guestBody(old, t3, "dddd4444"), "2.2.2.2")).json as { code: string }).code, "replay_mismatch");
  assert.equal(((await s.daily.submit(guestBody(rec, "2026-11-14.1.2.3", "dddd4444"), "2.2.2.2")).json as { code: string }).code, "bad_token");
  const t4 = todayToken(s);
  clock += ticks * 50;
  assert.equal(((await s.daily.submit({ record: rec, token: t4, simVersion: SIM_VERSION }, "2.2.2.2")).json as { code: string }).code, "bad_request");
  assert.equal((s.daily.leaderboard(null).json as { total: number }).total, 0);
});

function signer() {
  const sk = ed25519.utils.randomSecretKey();
  const pk = `ed25519:${base58.encode(ed25519.getPublicKey(sk))}`;
  return { pk, sign: (m: Uint8Array) => Buffer.from(ed25519.sign(m, sk)).toString("base64") };
}

test("daily: a real account needs a valid signature + key owner; guest accounts never earn; bad proof is 'unverified'", async () => {
  clock = T0;
  const key = signer();
  const s = mk({ verifyOwner: async (a, k) => a === "alice.testnet" && k === key.pk });
  const rec = play(dayCfg(), "bot");
  const ticks = analyze(dayCfg(), rec.inputs).ticksTotal;
  const day = utcDay(clock);
  const sig = (r: MatchRecord) => key.sign(dailyMessage(day, inputLogHash(r.inputs)));
  const submit = async (extra: Record<string, unknown>) => {
    const t = todayToken(s);
    clock += ticks * 50;
    return (await s.daily.submit({ record: rec, token: t, simVersion: SIM_VERSION, ...extra }, "3.3.3.3")).json as { kind: string; earns: number | null; name: string; code?: string };
  };
  const real = await submit({ account: "alice.testnet", publicKey: key.pk, signature: sig(rec) });
  assert.equal(real.kind, "real");
  assert.equal(real.earns, null);
  assert.equal(real.name, "alice.testnet");
  // someone else claims bob.testnet with alice's key: not an owner -> unverified, earns 0
  const bob = await submit({ account: "bob.testnet", publicKey: key.pk, signature: sig(rec), guestId: "eeee5555" });
  assert.equal(bob.kind, "unverified");
  assert.equal(bob.earns, 0);
  assert.ok(bob.name.endsWith("(unverified)"));
  // a forged signature
  const forged = await submit({ account: "alice.testnet", publicKey: key.pk, signature: Buffer.alloc(64, 1).toString("base64"), guestId: "ffff6666" });
  assert.equal(forged.kind, "unverified");
  // a guest account (g-*.relay.t) verifies but is a guest
  const s2 = mk({ verifyOwner: async () => true });
  const gk = signer();
  const t = todayToken(s2);
  clock += ticks * 50;
  const g = (await s2.daily.submit({ record: rec, token: t, simVersion: SIM_VERSION, account: "g-abcd12.relay.t", publicKey: gk.pk, signature: gk.sign(dailyMessage(day, inputLogHash(rec.inputs))) }, "3.3.3.4")).json as { kind: string; earns: number; name: string };
  assert.equal(g.kind, "guest");
  assert.equal(g.earns, 0);
  assert.equal(g.name, "Guest abcd");
  // a contract-made guest (g-*.<game contract>, mainnet create_guest) is a guest too
  const s3 = mk({ verifyOwner: async () => true, gameContract: "game.t" });
  const t3 = todayToken(s3);
  clock += ticks * 50;
  const g3 = (await s3.daily.submit({ record: rec, token: t3, simVersion: SIM_VERSION, account: "g-00aa11bb22.game.t", publicKey: gk.pk, signature: gk.sign(dailyMessage(day, inputLogHash(rec.inputs))) }, "3.3.3.5")).json as { kind: string; earns: number };
  assert.equal(g3.kind, "guest");
  assert.equal(g3.earns, 0);
  const rows = (s.daily.leaderboard(null).json as { rows: { kind: string; account: string | null }[] }).rows;
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["real", "unverified", "unverified"]);
  assert.equal(rows.filter((r) => r.account).length, 1);
});

test("daily: submissions are rate limited per IP", async () => {
  clock = T0;
  const s = mk();
  const rec = play(dayCfg(), "idle");
  let last = 0;
  for (let i = 0; i < 32; i++) last = (await s.daily.submit(guestBody(rec, "2026-11-14.1.2.3", "gggg7777"), "4.4.4.4")).code;
  assert.equal(last, 429);
});

// ------------------------------------------------------------------ http
test("http: routes, CORS, og page and the daily board work end to end", async () => {
  clock = Date.now();
  const s = createSocial({ dataDir: tmp(), allowedOrigins: ["http://127.0.0.1:5192"], verifyOwner: async () => false, realtimeFactor: 0, secret: "test-secret-0123456789" });
  const origins = ["http://127.0.0.1:5192"];
  const srv = http.createServer(async (req, res) => {
    const r = await s.handle(req, "5.5.5.5");
    writeReply(res, r ?? { code: 404, json: {} }, req.headers.origin, origins);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", origin: origins[0] }, body: JSON.stringify(b) });
    const c = await post("/api/challenge", body(recA, { game: "http://127.0.0.1:5192/" }));
    assert.equal(c.status, 200);
    assert.equal(c.headers.get("access-control-allow-origin"), origins[0]);
    const { id } = (await c.json()) as { id: string };
    const g = await (await fetch(`${base}/api/challenge/${id}`)).json() as { cfg: MatchConfig; token: string };
    const friend = play(g.cfg, "idle");
    const ans = await post(`/api/challenge/${id}/answer`, body(friend, { token: g.token, name: "Sam" }));
    assert.equal(ans.status, 200, await ans.clone().text());
    const pg = await fetch(`${base}/c/${id}`);
    assert.equal(pg.headers.get("content-type"), "text/html; charset=utf-8");
    assert.ok((await pg.text()).includes("og:title"));
    assert.equal((await fetch(`${base}/c/aaaaaaaa`)).status, 404);
    const d = await (await fetch(`${base}/api/daily`)).json() as { token: string; day: string };
    const rec = play(dailyConfig(d.day), "idle");
    const sub = await post("/api/daily/submit", { record: rec, token: d.token, simVersion: SIM_VERSION, guestId: "hhhh8888" });
    assert.equal(sub.status, 200, await sub.clone().text());
    const lb = await (await fetch(`${base}/api/daily/leaderboard`)).json() as { rows: { name: string }[] };
    assert.equal(lb.rows[0].name, "Guest hhhh");
    assert.equal((await fetch(`${base}/api/daily/leaderboard?day=bogus`)).status, 400);
    assert.equal((await post("/api/challenge", "not an object")).status, 400);
  } finally {
    srv.close();
  }
});

// ------------------------------------------------------------------ daily: races and closed days
test("daily: two concurrent submissions with ONE token -> exactly one accepted (even with a slow owner lookup)", async () => {
  clock = T0;
  const key = signer();
  const s = mk({ verifyOwner: async () => { await new Promise((r) => setTimeout(r, 50)); return true; } });
  const rec = play(dayCfg(), "bot");
  const ticks = analyze(dayCfg(), rec.inputs).ticksTotal;
  const day = utcDay(clock);
  const t = todayToken(s);
  clock += ticks * 50;
  const who = { account: "alice.testnet", publicKey: key.pk, signature: key.sign(dailyMessage(day, inputLogHash(rec.inputs))) };
  const [a, b] = await Promise.all([1, 2].map((i) => s.daily.submit({ record: rec, token: t, simVersion: SIM_VERSION, ...who }, `7.7.7.${i}`)));
  assert.deepEqual([a.code, b.code].sort(), [200, 409]);
  assert.equal(((a.code === 409 ? a : b).json as { code: string }).code, "token_used");
  assert.equal((s.daily.leaderboard(null).json as { total: number }).total, 1);
});

test("daily: reading old leaderboards never evicts today's file or loses a used token", async () => {
  clock = T0;
  const s = mk();
  const rec = play(dayCfg(), "idle");
  const ticks = analyze(dayCfg(), rec.inputs).ticksTotal;
  const t = todayToken(s);
  clock += ticks * 50;
  assert.equal((await s.daily.submit(guestBody(rec, t, "iiii9999"), "8.1.1.1")).code, 200);
  for (let i = 1; i <= 12; i++) s.daily.leaderboard(`2026-10-${String(i).padStart(2, "0")}`);
  assert.equal((s.daily.leaderboard(null).json as { total: number }).total, 1);
  assert.equal(((await s.daily.submit(guestBody(rec, t, "iiii9999"), "8.1.1.1")).json as { code: string }).code, "token_used");
});

test("daily: a submission after the end of the token's day is rejected (no grace)", async () => {
  clock = Date.parse("2026-11-14T23:50:00Z");
  const s = mk({ realtimeFactor: 0 });
  const rec = play(dayCfg(), "idle");
  const t = todayToken(s);
  clock = Date.parse("2026-11-15T00:00:01Z");
  const r = await s.daily.submit(guestBody(rec, t, "jjjj0000"), "8.2.2.2");
  assert.equal(r.code, 409);
  assert.equal((r.json as { code: string }).code, "day_closed");
  assert.equal((s.daily.leaderboard("2026-11-14").json as { total: number }).total, 0);
  clock = T0;
});
