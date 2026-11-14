// Audit F-6: the client reads contract views through the match server's /api/view (not the public RPC),
// dedupes them, retries rate limits, falls back to the RPC for an older server, and reports outages as
// outages (never as a missing feature).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGameClient, isMissingView, ViewError } from "./client";
import { SIM_VERSION } from "../sim/types";
import type { GameClientT3 } from "./api";

const RELAYER = "http://relayer.test";
const RPC = "http://rpc.test";
const CONTRACT = "game.test";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rpcOk = (v: unknown) => json(200, { jsonrpc: "2.0", id: 1, result: { result: [...new TextEncoder().encode(JSON.stringify(v))] } });
const TOP = [{ account: "vesper.game.test", name: "Vesper", bot: true, wins: 2, kills: 5, earnings: "1000000000000000000", matches: 4 }];

function stub(view: (u: URL) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    calls.push(u.origin === RPC ? "rpc" : u.pathname);
    if (u.pathname === "/api/health") return json(200, { ok: true, game: CONTRACT, simVersion: SIM_VERSION, guests: "open" });
    if (u.origin === RPC) return rpcOk(TOP);
    return view(u);
  });
  return calls;
}
const client = async () => (await createGameClient({ relayer: RELAYER, rpc: RPC, contract: CONTRACT })) as unknown as GameClientT3;

afterEach(() => vi.unstubAllGlobals());

describe("contract views via the match server", () => {
  it("uses /api/view, never the RPC, and dedupes concurrent identical views", async () => {
    const calls = stub((u) => {
      expect(u.searchParams.get("method")).toBe("get_top");
      expect(JSON.parse(u.searchParams.get("args")!)).toEqual({ kind: "bots", by: "earnings", n: 50 });
      return json(200, { status: 200, result: TOP });
    });
    const c = await client();
    expect(c.mode).toBe("chain");
    const [a, b] = await Promise.all([c.leaderboard("bots"), c.leaderboard("bots")]);
    expect(a[0].name).toBe("Vesper");
    expect(b).toEqual(a);
    expect(calls.filter((x) => x === "/api/view")).toHaveLength(1);
    expect(calls).not.toContain("rpc");
  });

  it("falls back to the RPC when the server has no /api/view (older server)", async () => {
    const calls = stub(() => json(404, { error: "not found" }));
    const c = await client();
    expect((await c.leaderboard("bots"))[0].wins).toBe(2);
    expect(calls).toContain("rpc");
  });

  it("retries a busy server twice, then reports 'unavailable' (not a missing view)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      let n = 0;
      stub(() => (n++, json(200, { status: 503, error: "live data is unavailable right now", code: "rpc_busy" })));
      const c = await client();
      const p = c.leaderboard("players").catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const e = await p;
      expect(e).toBeInstanceOf(ViewError);
      expect(isMissingView(e)).toBe(false);
      expect(n).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a missing view (MethodNotFound) means an empty board, not an error", async () => {
    stub(() => json(200, { status: 404, error: "this view does not exist on the contract", code: "method_not_found" }));
    const c = await client();
    expect(await c.leaderboard("players")).toEqual([]);
  });
});
