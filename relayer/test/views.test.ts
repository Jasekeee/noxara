// The read-only view proxy (audit F-6) and the persisted per-IP daily guest cap (audit F-14).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ViewProxy, VIEW_TTL_MS, checkViewRequest, stableJson, type RpcPost } from "../src/views.ts";
import { IpDailyCap } from "../src/budget.ts";
import { normalizeIp, RateLimiter } from "../src/policy.ts";

const okReply = (v: unknown) => ({ status: 200, json: { jsonrpc: "2.0", id: 1, result: { result: [...Buffer.from(JSON.stringify(v))], logs: [], block_height: 1 } } });

function fakeRpc(replies: Array<(url: string, body: { params: Record<string, string> }) => { status: number; json: unknown } | Promise<{ status: number; json: unknown }>>) {
  const calls: Array<{ url: string; body: { params: Record<string, string> } }> = [];
  let i = 0;
  const post: RpcPost = async (url, body) => {
    const b = body as { params: Record<string, string> };
    calls.push({ url, body: b });
    const f = replies[Math.min(i++, replies.length - 1)];
    return f(url, b);
  };
  return { post, calls };
}

test("only allow-listed views with small object args pass; contract and RPC method are fixed", async () => {
  assert.equal(checkViewRequest("get_fighters", {}).ok, true);
  assert.equal(checkViewRequest("get_fighters", undefined).ok, true);
  for (const bad of ["settle_match", "start_match", "ft_transfer", "__proto__", "constructor", "toString", "", 42, null]) assert.equal(checkViewRequest(bad, {}).ok, false, String(bad));
  assert.equal(checkViewRequest("get_history", [1]).ok, false);
  assert.equal(checkViewRequest("get_history", "x").ok, false);
  assert.equal(checkViewRequest("get_history", { account_id: "a".repeat(600) }).ok, false);
  assert.equal(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');

  const { post, calls } = fakeRpc([() => okReply([{ name: "Vesper" }])]);
  const p = new ViewProxy({ contract: "noxara.near", rpcUrls: ["https://rpc.example"], post });
  const r = await p.view("get_history", { account_id: "x.near" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.result, [{ name: "Vesper" }]);
  assert.equal(calls.length, 1);
  const q = calls[0].body as unknown as { method: string; params: Record<string, string> };
  assert.equal(q.method, "query");
  assert.equal(q.params.request_type, "call_function");
  assert.equal(q.params.account_id, "noxara.near");
  assert.equal(q.params.method_name, "get_history");
  assert.deepEqual(JSON.parse(Buffer.from(q.params.args_base64, "base64").toString()), { account_id: "x.near" });
  const refused = await p.view("settle_match", {});
  assert.equal(refused.status, 400);
  assert.equal(calls.length, 1, "a refused view never reaches the RPC");
});

test("TTL cache, in-flight coalescing, `fresh` bypass and invalidation", async () => {
  let now = 1_000_000;
  let n = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { post, calls } = fakeRpc([async () => (await gate, okReply(++n))]);
  const p = new ViewProxy({ contract: "g", rpcUrls: ["u"], post, now: () => now });
  const a = Promise.all([p.view("get_economy", {}), p.view("get_economy", {}), p.view("get_economy", {})]);
  release();
  const rs = await a;
  assert.equal(calls.length, 1, "three concurrent identical views = one RPC call");
  for (const r of rs) assert.equal(r.body.result, 1);
  assert.equal((await p.view("get_economy", {})).body.cached, true);
  assert.equal(calls.length, 1);
  now += VIEW_TTL_MS.get_economy + 1;
  assert.equal((await p.view("get_economy", {})).body.result, 2);
  assert.equal((await p.view("get_economy", { fresh: 1 })).body.result, 3, "a new args object is its own key (no magic bypass flag)");
  assert.equal((await p.view("get_economy", {})).body.cached, true, "the shared entry stays cached");
  // a relayed call drops live state, keeps histories; a settle drops everything
  await p.view("get_history", { account_id: "b" });
  const before = calls.length;
  p.invalidate();
  await p.view("get_history", { account_id: "b" });
  assert.equal(calls.length, before, "history survives a relay invalidation");
  await p.view("get_economy", {});
  assert.equal(calls.length, before + 1, "live state refetched after a relay");
  p.invalidate(true);
  await p.view("get_history", { account_id: "b" });
  assert.equal(calls.length, before + 2);
});

test("RPC 429/5xx: fail over to the next RPC, else serve stale data, else an honest 503 (never 'method missing')", async () => {
  let now = 0;
  const seq: Array<"ok" | "429" | "500" | "throw"> = ["ok", "429", "429", "500", "throw"];
  let i = 0;
  const post: RpcPost = async (url) => {
    const k = seq[Math.min(i++, seq.length - 1)];
    if (k === "throw") throw new Error("timeout");
    if (k === "ok") return okReply({ url });
    return { status: Number(k), json: k === "429" ? { error: "rate limited" } : null };
  };
  const p = new ViewProxy({ contract: "g", rpcUrls: ["a", "b"], post, now: () => now });
  assert.equal((await p.view("get_top", { kind: "bots" })).status, 200);
  now += 60_000;
  const s = await p.view("get_top", { kind: "bots" });
  assert.equal(s.status, 200, "stale beats an error");
  assert.equal(s.body.stale, true);
  assert.deepEqual(s.body.result, { url: "a" });
  const none = await p.view("get_top", { kind: "players" });
  assert.equal(none.status, 503);
  assert.equal(none.body.code, "rpc_busy");

  // failover: the first RPC is rate-limited, the second answers
  let j = 0;
  const p2 = new ViewProxy({ contract: "g", rpcUrls: ["a", "b"], post: async (url) => (j++ === 0 ? { status: 429, json: null } : okReply(url)) });
  assert.deepEqual((await p2.view("get_config", {})).body.result, "b");
});

test("a missing view is reported as method_not_found (404); a panicking view as view_failed (400)", async () => {
  const p = new ViewProxy({
    contract: "g",
    rpcUrls: ["a"],
    post: async (_u, body) => {
      const m = (body as { params: { method_name: string } }).params.method_name;
      return m === "get_economy"
        ? { status: 200, json: { error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: {} }, data: "wasm execution failed with error: MethodResolveError(MethodNotFound)" } } }
        : { status: 200, json: { result: { error: "wasm execution failed with error: FunctionCallError(HostError(GuestPanic { panic_msg: \"bad account\" }))", logs: [] } } };
    },
  });
  const a = await p.view("get_economy", {});
  assert.equal(a.status, 404);
  assert.equal(a.body.code, "method_not_found");
  const b = await p.view("get_progress", { account_id: "?" });
  assert.equal(b.status, 400);
  assert.equal(b.body.code, "view_failed");
});

test("a global upstream budget bounds RPC calls (cache-busting args can't amplify)", async () => {
  let calls = 0;
  const p = new ViewProxy({ contract: "g", rpcUrls: ["a"], upstreamPerMin: 3, now: () => 5, post: async () => (calls++, okReply(0)) });
  for (let i = 0; i < 6; i++) await p.view("ft_balance_of", { account_id: `x${i}.near` });
  assert.equal(calls, 3);
  assert.equal((await p.view("ft_balance_of", { account_id: "y.near" })).status, 503);
});

test("per-IP daily guest cap: persisted across restarts, resets at the UTC day, stores no raw IPs", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ipcap-")), "guest-ip-daily.json");
  const day = 86_400_000;
  const t = 20_000 * day + 5;
  const c = new IpDailyCap(file, 3, t);
  assert.ok(c.take("203.0.113.7", t) && c.take("203.0.113.7", t) && c.take("203.0.113.7", t));
  assert.equal(c.take("203.0.113.7", t), false);
  assert.equal(c.take("198.51.100.1", t), true, "another address is independent");
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("203.0.113.7") && !raw.includes("198.51.100.1"), "only salted hashes on disk");
  const after = new IpDailyCap(file, 3, t + 1000); // a restart
  assert.equal(after.take("203.0.113.7", t + 1000), false, "a restart doesn't reopen the cap");
  after.release("198.51.100.1", t + 1000);
  assert.equal(after.take("203.0.113.7", t + day), true, "the next UTC day reopens it");
});

test("a per-caller miss limit: one address cycling args can't drain the shared upstream budget", async () => {
  let calls = 0;
  const p = new ViewProxy({ contract: "g", rpcUrls: ["a"], upstreamPerMin: 1000, now: () => 5, post: async () => (calls++, okReply(7)) });
  const perIp = new RateLimiter(3, 60_000);
  const mine = () => perIp.take("203.0.113.9", 5);
  for (let i = 0; i < 6; i++) await p.view("ft_balance_of", { account_id: `x${i}.near` }, mine);
  assert.equal(calls, 3);
  const r = await p.view("ft_balance_of", { account_id: "z.near" }, mine);
  assert.equal(r.status, 429);
  // cache hits never count against the caller
  assert.equal((await p.view("ft_balance_of", { account_id: "x0.near" }, mine)).body.result, 7);
  // another caller still gets through
  assert.equal((await p.view("ft_balance_of", { account_id: "z.near" }, () => perIp.take("198.51.100.2", 5))).status, 200);
});

test("normalizeIp: IPv4-mapped IPv6 -> IPv4, IPv6 -> /64, IPv4 unchanged", () => {
  assert.equal(normalizeIp("203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeIp("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeIp("::FFFF:203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeIp("0:0:0:0:0:ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeIp(" 203.0.113.7 "), "203.0.113.7");
  const a = normalizeIp("2001:db8:abcd:12:1:2:3:4");
  assert.equal(a, "2001:db8:abcd:12::/64");
  assert.equal(normalizeIp("2001:0db8:abcd:0012:ffff:ffff:ffff:ffff"), a, "same /64, different interface id");
  assert.equal(normalizeIp("2001:db8:abcd:12::1"), a);
  assert.equal(normalizeIp("[2001:db8:abcd:12::99]"), a);
  assert.equal(normalizeIp("2001:db8:abcd:12::1%eth0"), a);
  assert.notEqual(normalizeIp("2001:db8:abcd:13::1"), a, "another /64 is another key");
  assert.equal(normalizeIp("::1"), "0:0:0:0::/64");
  assert.equal(normalizeIp("2001:db8::"), "2001:db8:0:0::/64");
  assert.equal(normalizeIp("?"), "?");
});
