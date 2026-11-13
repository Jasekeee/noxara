import { expect, test } from "@playwright/test";
import { collectErrors, hasHorizontalScroll, phase, requireHook } from "./hook";

test.use({ video: "on" });

test("guest opens → plays a full match", async ({ page }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await page.goto("/?e2e&autoplay&seed=7&bots=1");
  await requireHook(page);

  // ?bots=1 skips the title: the match should be running almost immediately
  await expect.poll(() => phase(page), { timeout: 15_000 }).not.toBe("title");
  expect(await hasHorizontalScroll(page), "no horizontal scroll while playing").toBe(false);

  // matches are ≤180 s of game time
  await page.waitForFunction(() => window.__br!.phase() === "over", undefined, { timeout: 240_000, polling: 500 });

  const result = await page.evaluate(() => ({
    placement: window.__br!.placement(),
    tick: window.__br!.tick(),
    alive: window.__br!.alive(),
    hasRecord: typeof window.__br!.record === "function",
  }));
  console.log(`match over: placement ${result.placement}, tick ${result.tick}, alive ${result.alive}`);
  expect(result.placement).not.toBeNull();
  expect(result.placement!).toBeGreaterThanOrEqual(1);
  expect(result.placement!).toBeLessThanOrEqual(10);
  expect(result.hasRecord, "window.__br.record() exposed on match end").toBe(true);
  expect(await hasHorizontalScroll(page), "no horizontal scroll on the end screen").toBe(false);
  expect(errors, "zero console errors / page errors").toEqual([]);
});
