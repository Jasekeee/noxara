// Title-screen screenshots (desktop + 390px) incl. the How-to-play sheet and the cup rules. Usage: BR_PORT=5188 node tools/title-shots.mjs
import { chromium } from "@playwright/test";
const port = process.env.BR_PORT ?? "5188";
const url = `http://127.0.0.1:${port}/?e2e&offline&seed=7`;
const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
for (const [name, vp, mobile] of [["desktop", { width: 1440, height: 900 }, false], ["390", { width: 390, height: 844 }, true]]) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(url);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `docs/screens/title-${name}.png` });
  await page.click("#howto-btn");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `docs/screens/title-${name}-howto.png` });
  await page.keyboard.press("Escape");
  await page.click("#cup-rules");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `docs/screens/title-${name}-rules.png` });
  await page.keyboard.press("Escape");
  const sx = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  console.log(name, "hscroll", sx, "errors", errs);
  await ctx.close();
}
await b.close();
