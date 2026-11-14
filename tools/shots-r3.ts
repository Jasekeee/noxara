// Round-3 screenshots (desktop 1440x900 + 390 px): title with the mercenary board + live ticker, About page,
// Big Island, and a chain match's end screen (money flow + Verified). Needs the game on --base and the match server.
//   node tools/shots-r3.ts [--base http://127.0.0.1:5180] [--out docs/screens]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices } from "@playwright/test";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("base", "http://127.0.0.1:5180");
const OUT = arg("out", "docs/screens");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const errors: string[] = [];

const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p = await desk.newPage();
p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await p.goto(`${BASE}/`);
await p.waitForTimeout(10000);
await p.screenshot({ path: join(OUT, "r3-title-desktop.png") });
await p.locator("#nav-about").click();
await p.waitForTimeout(800);
await p.screenshot({ path: join(OUT, "r3-about-desktop.png") });
await p.goto(`${BASE}/?map=big`);
await p.waitForTimeout(6000);
await p.locator("#big-island").click().catch(() => undefined);
await p.waitForTimeout(16000);
await p.screenshot({ path: join(OUT, "r3-big-island-desktop.png") });
// a real (chain) match played by the autopilot, to the end screen
await p.goto(`${BASE}/?autoplay`);
await p.locator(".lg-verified, .mf").first().waitFor({ timeout: 300000 }).catch(() => undefined);
await p.waitForTimeout(2500);
await p.screenshot({ path: join(OUT, "r3-end-moneyflow-desktop.png") });

const mob = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });
const m = await mob.newPage();
await m.goto(`${BASE}/`);
await m.waitForTimeout(10000);
await m.screenshot({ path: join(OUT, "r3-title-390.png") });
await m.locator("#nav-about").click();
await m.waitForTimeout(800);
await m.screenshot({ path: join(OUT, "r3-about-390.png") });

await browser.close();
console.log(`shots → ${OUT}; console errors: ${errors.length}${errors.length ? "\n" + errors.slice(0, 5).join("\n") : ""}`);
