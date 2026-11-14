import { expect, test } from "@playwright/test";
import { collectErrors, isolateFromChain, offlineUrl, phase, requireHook } from "./hook";

// Big Island (cfg.map = "big", behind BIG_ISLAND_ENABLED in src/modes.ts): offline, bigger map.
const MIN_FPS = Number(process.env.BR_MIN_FPS ?? 30);

test("big island: the title button starts an offline match on the big map", async ({ page }) => {
  const errors = collectErrors(page);
  const chainCalls = await isolateFromChain(page);
  await page.goto(offlineUrl());
  await requireHook(page);
  const btn = page.locator("#big-island");
  await expect(btn).toBeVisible();
  await expect(page.locator("#play")).toHaveText("PLAY", { timeout: 30_000 });
  await btn.click();
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe("playing");
  const cfg = await page.evaluate(() => (window.__br as unknown as { match(): { cfg: { map?: string }; map: { radius: number } } }).match());
  expect(cfg.cfg.map).toBe("big");
  expect(cfg.map.radius).toBe(58000);
  await expect.poll(() => page.evaluate(() => window.__br!.tick()), { timeout: 20_000 }).toBeGreaterThan(80);
  expect(errors).toEqual([]);
  expect(chainCalls, "offline page made no relayer/RPC calls").toEqual([]);
});

test("big island perf: average fps over 5 s of play", async ({ page }, info) => {
  await isolateFromChain(page);
  await page.goto(offlineUrl("autoplay&bots=1&map=big"));
  await requireHook(page);
  await expect.poll(() => phase(page), { timeout: 20_000 }).toBe("playing");
  await page.waitForTimeout(2_000);
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    samples.push(await page.evaluate(() => window.__br!.fps()));
    await page.waitForTimeout(250);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  console.log(`[${info.project.name}] big island fps avg ${avg.toFixed(1)} (min ${Math.min(...samples).toFixed(1)}), threshold ${MIN_FPS}`);
  info.annotations.push({ type: "fps", description: `big island avg ${avg.toFixed(1)}` });
  if (info.project.name === "desktop") expect(avg).toBeGreaterThanOrEqual(MIN_FPS);
});
