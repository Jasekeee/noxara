// Cold-load timing: first contentful paint, title visible, PLAY ready (data-loading removed), bytes transferred.
//   node tools/load-timing.ts [url] [--mobile] [--runs 3]
import { chromium, devices } from "@playwright/test";

const url = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:5184/";
const mobile = process.argv.includes("--mobile");
const ri = process.argv.indexOf("--runs");
const runs = ri > 0 ? Number(process.argv[ri + 1]) : 3;
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu"] });
const rows: number[][] = [];
for (let i = 0; i < runs; i++) {
  const ctx = await browser.newContext(mobile ? { ...devices["iPhone 13"] } : { viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  let bytes = 0;
  p.on("response", async (r) => {
    const l = Number((await r.allHeaders())["content-length"] ?? 0);
    bytes += l;
  });
  const t0 = Date.now();
  await p.goto(url, { waitUntil: "commit" });
  await p.locator("#logo").waitFor({ state: "visible" });
  const title = Date.now() - t0;
  await p.waitForFunction(() => document.getElementById("play")?.dataset.loading !== "1", null, { timeout: 60000 });
  const ready = Date.now() - t0;
  const fcp = await p.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? -1);
  const marks = await p.evaluate(() => performance.getEntriesByType("mark").filter((m) => m.name.startsWith("br:")).map((m) => `${m.name.slice(3)} ${Math.round(m.startTime)}`).join(" · "));
  if (marks) console.log(`  marks: ${marks}`);
  await p.waitForTimeout(1500);
  rows.push([Math.round(fcp), title, ready, Math.round(bytes / 1024)]);
  await ctx.close();
}
await browser.close();
const med = (k: number) => rows.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
console.log(`${url} ${mobile ? "mobile" : "desktop"} cold x${runs}: FCP ${med(0)} ms · title visible ${med(1)} ms · PLAY ready ${med(2)} ms · transfer ≈ ${med(3)} KB (content-length; compressed where served compressed)`);
console.log(JSON.stringify(rows));
