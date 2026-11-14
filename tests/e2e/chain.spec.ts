// Live testnet loop (opt-in: RUN_CHAIN=1, needs the match server on :8788):
// lobby says "Live" → an autoplay match with a chain seed plays to the end → the ledger shows
// "Verified" (the server replayed it and settled on NEAR) → the browser's record replays in Node too.
import { expect, test } from "@playwright/test";
import type { MatchRecord } from "../../src/sim/types";
import { replayRecord } from "../../src/sim/record";
import { requireHook } from "./hook";

const RELAYER = process.env.BR_RELAYER ?? "http://127.0.0.1:8788";

test.skip(!process.env.RUN_CHAIN, "chain e2e is opt-in: RUN_CHAIN=1 npx playwright test chain --project=desktop");

test("chain: live wallets → autoplay match → Verified → record replays in Node", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one live match per run (desktop project)");
  test.setTimeout(420_000);

  // The relayer only allows CORS from its dev ports; when QA serves on another port (BR_PORT), proxy
  // relayer calls through Playwright and add the header so the client still sees "chain" mode.
  const origin = new URL(info.project.use.baseURL!).origin;
  await page.route(`${RELAYER}/**`, async (route) => {
    const req = route.request();
    const cors = {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // 1. lobby: live wallets
  await page.goto("/?e2e");
  await requireHook(page);
  await expect(page.locator("#net-mode")).toContainText("Live", { timeout: 30_000 });

  // 2. autoplay without ?seed → the seed comes from the chain (start_match); autoplay starts by itself
  await page.goto("/?e2e&autoplay");
  await requireHook(page);
  await page.waitForFunction(() => window.__br!.phase() === "playing" && window.__br!.tick() > 0, undefined, {
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__br!.phase() === "over", undefined, { timeout: 300_000, polling: 1000 });

  // 3. ledger: Verified after the server replays and settles
  await expect(page.locator("#ledger .lg-verified")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("#ledger .lg-verified")).toContainText("Verified");

  // 4. the browser's record replays bit-for-bit in Node
  const rec = (await page.evaluate(() => window.__br!.record!())) as MatchRecord | null;
  expect(rec, "window.__br.record() after the match").not.toBeNull();
  const replay = replayRecord(rec!.cfg, rec!.inputs);
  console.log(`chain match: seed ${rec!.cfg.seed}, winner ${rec!.winner}, ${rec!.inputs.length} inputs, hash ${rec!.hash}`);
  expect(replay.hash).toBe(rec!.hash);
  expect(replay.winner).toBe(rec!.winner);
  expect(replay.placements).toEqual(rec!.placements);
  expect(rec!.cfg.fighters.slice(1).some((f) => f.id.endsWith(".testnet")), "bots are chain accounts").toBe(true);
  expect(errors, "no uncaught page errors").toEqual([]);
});
