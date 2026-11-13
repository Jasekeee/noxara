// Checkpoint media: a ~45 s desktop video of an autoplay match + screenshots, and a mobile screenshot.
// Needs a dev server on 5184:  npx vite --host 127.0.0.1 --port 5184 --strictPort
//   node tools/capture.ts [--seconds 45] [--seed 7] [--until-over] [--headed] [--out docs/screens]
// Writes docs/screens/: desktop-title.png, desktop-05s.png, desktop-20s.png, desktop-40s.png,
// [desktop-over.png], mobile-title.png, mobile-play.png, match-desktop.webm
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices, type Page } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const SECONDS = Number(opt("--seconds", "45"));
const SEED = Number(opt("--seed", "7"));
const UNTIL_OVER = args.includes("--until-over");
const HEADED = args.includes("--headed");
const BASE = process.env.BR_URL ?? "http://127.0.0.1:5184";
const OUT = opt("--out", "docs/screens");
const TMP = join(OUT, ".video-tmp");

try {
  await fetch(BASE + "/");
} catch {
  console.error(`no server at ${BASE}. Start one first: npx vite --host 127.0.0.1 --port 5184 --strictPort`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

type Hook = { phase(): string; tick(): number; alive(): number; placement(): number | null; fps(): number };
const hook = (page: Page) =>
  page.evaluate(() => {
    const br = (window as unknown as { __br?: Hook }).__br;
    return br ? { phase: br.phase(), tick: br.tick(), alive: br.alive(), placement: br.placement(), fps: Math.round(br.fps()) } : null;
  });
const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: join(OUT, name) });
  console.log(`  ${name}  ${JSON.stringify(await hook(page).catch(() => null))}`);
};
async function waitPlaying(page: Page) {
  await page
    .waitForFunction(() => (window as unknown as { __br?: Hook }).__br?.phase() === "playing", undefined, { timeout: 20_000 })
    .catch(() => console.log("  (window.__br never reported 'playing' — timing from page load instead)"));
}

// GPU flags help headless WebGL on macOS; --headed gives the most faithful frames.
const browser = await chromium.launch({
  headless: !HEADED,
  channel: "chromium",
  args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=metal"],
});
const errors: string[] = [];
// The relayer (:8788) only allows CORS from its dev ports. When capturing from another port (BR_URL),
// proxy relayer calls and add the header, so the lobby shows the live wallets instead of "offline".
const RELAYER = process.env.BR_RELAYER ?? "http://127.0.0.1:8788";
const ORIGIN = new URL(BASE).origin;
async function corsProxy(ctx: import("@playwright/test").BrowserContext) {
  await ctx.route(`${RELAYER}/**`, async (route) => {
    const cors = {
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    try {
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
    } catch {
      await route.abort();
    }
  });
}
const play = `/?e2e&autoplay&seed=${SEED}&bots=1`;

// ---- desktop title (no video)
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE });
  await corsProxy(ctx);
  const page = await ctx.newPage();
  await page.goto("/?e2e");
  await page.waitForTimeout(6_000); // assets + live roster from the chain
  await shot(page, "desktop-title.png");
  await ctx.close();
}

// ---- desktop match with video
{
  rmSync(TMP, { recursive: true, force: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    baseURL: BASE,
    recordVideo: { dir: TMP, size: { width: 1440, height: 900 } },
  });
  await corsProxy(ctx);
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`desktop console: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`desktop pageerror: ${e.message}`));
  await page.goto(play);
  await waitPlaying(page);
  const t0 = Date.now();
  const at = async (s: number) => page.waitForTimeout(Math.max(0, t0 + s * 1000 - Date.now()));
  for (const s of [5, 20, 40].filter((s) => s < SECONDS)) {
    await at(s);
    await shot(page, `desktop-${String(s).padStart(2, "0")}s.png`);
  }
  await at(SECONDS);
  if (UNTIL_OVER) {
    await page
      .waitForFunction(() => (window as unknown as { __br?: Hook }).__br?.phase() === "over", undefined, { timeout: 240_000 })
      .catch(() => console.log("  (match did not reach 'over' within 240 s)"));
    await page.waitForTimeout(1_500);
    await shot(page, "desktop-over.png");
  }
  const video = page.video();
  await ctx.close();
  if (video) {
    await video.saveAs(join(OUT, "match-desktop.webm"));
    console.log(`  match-desktop.webm (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  rmSync(TMP, { recursive: true, force: true });
}

// ---- mobile 390x844 (Pixel 7 touch profile)
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, baseURL: BASE });
  await corsProxy(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`mobile pageerror: ${e.message}`));
  await page.goto("/?e2e");
  await page.waitForTimeout(6_000);
  await shot(page, "mobile-title.png");
  await page.goto(play);
  await waitPlaying(page);
  await page.waitForTimeout(8_000);
  await shot(page, "mobile-play.png");
  await ctx.close();
}

await browser.close();
if (errors.length) {
  console.log(`${errors.length} console/page errors:`);
  for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
}
console.log(`done → ${OUT}/`);
