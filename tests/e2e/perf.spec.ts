import { expect, test } from "@playwright/test";
import { isolateFromChain, offlineUrl, phase, requireHook } from "./hook";

// Headless Chromium without a GPU renders WebGL in software, so numbers are pessimistic.
// Real-hardware target is 60 FPS; set BR_MIN_FPS=45 (or 55) on a machine with a GPU.
const MIN_FPS = Number(process.env.BR_MIN_FPS ?? 30);

test("perf: average fps over 5 s of play", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "fps budget is measured on the desktop project only");
  await isolateFromChain(page);
  await page.goto(offlineUrl("autoplay&bots=1"));
  await requireHook(page);
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe("playing");
  await page.waitForTimeout(2_000); // let shaders compile / assets settle

  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    samples.push(await page.evaluate(() => window.__br!.fps()));
    await page.waitForTimeout(250);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const min = Math.min(...samples);
  console.log(`fps avg ${avg.toFixed(1)} (min ${min.toFixed(1)}) over 5 s, threshold ${MIN_FPS}`);
  info.annotations.push({ type: "fps", description: `avg ${avg.toFixed(1)}, min ${min.toFixed(1)}, threshold ${MIN_FPS}` });
  expect(await phase(page), "still playing during the sample").not.toBe("title");
  expect(avg).toBeGreaterThanOrEqual(MIN_FPS);
});
