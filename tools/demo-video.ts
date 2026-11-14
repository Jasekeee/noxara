// Draft demo video (~80 s, 1440x900 webm) following the shot list in docs/SUBMISSION.md §3, with captions
// drawn over the game. Local only: the webm is gitignored and never uploaded.
//   node tools/demo-video.ts [--base http://127.0.0.1:5180] [--out docs/screens/demo-draft.webm]
// Needs the game dev server (and, for live chain data, the match server on :8788).
import { mkdirSync, renameSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { chromium, type Page } from "@playwright/test";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("base", "http://127.0.0.1:5180");
const OUT = arg("out", "docs/screens/demo-draft.webm");
const tmp = join(dirname(OUT), ".demo-tmp");

let shot = 0;
async function caption(p: Page, text: string, sub = "") {
  await p.waitForTimeout(600).catch(() => undefined);
  await p.evaluate(
    ([t, s]) => {
      let el = document.getElementById("__cap") as HTMLDivElement | null;
      if (!el) {
        el = document.createElement("div");
        el.id = "__cap";
        el.style.cssText =
          "position:fixed;left:50%;bottom:15%;transform:translateX(-50%);z-index:99999;pointer-events:none;text-align:center;font:900 34px/1.15 system-ui,sans-serif;color:#fff;-webkit-text-stroke:1.5px #15112b;paint-order:stroke fill;text-shadow:0 4px 18px rgba(0,0,0,.6);max-width:80vw";
        document.body.appendChild(el);
      }
      el.textContent = t;
      if (s) {
        const d = document.createElement("div");
        d.style.cssText = "font:700 20px/1.3 system-ui,sans-serif;margin-top:8px;-webkit-text-stroke:0";
        d.textContent = s;
        el.appendChild(d);
      }
    },
    [text, sub],
  );
  await p.waitForTimeout(400);
  await p.screenshot({ path: join(dirname(OUT), `demo-frame-${++shot}.jpg`), type: "jpeg", quality: 60 }).catch(() => undefined);
}
const wait = (p: Page, ms: number) => p.waitForTimeout(ms);
async function clickNav(p: Page, id: string) {
  await p.locator(`#${id}`).click({ timeout: 20000 }).catch(() => undefined);
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: tmp, size: { width: 1440, height: 900 } } });
const p = await ctx.newPage();

// 0–6 s: title
await p.goto(`${BASE}/`);
await wait(p, 4500);
await caption(p, "Only one walks out.", "A 3-minute battle royale vs 9 AI fighters with NEAR wallets");
await wait(p, 4000);
// 6–36 s: a match (the human plays itself here: ?autoplay)
await p.goto(`${BASE}/?autoplay`);
await caption(p, "No wallet. No gas. Just play.", "Guests are in a match within seconds");
await wait(p, 9000);
await caption(p, "10 fighters. 3 minutes. One island.", "Tap or click to auto-aim · bushes hide you · the storm closes in");
await wait(p, 11000);
await caption(p, "The richest fighter carries a bounty.", "Every match is seeded by the next block and settled on NEAR after a replay check");
await wait(p, 10000);
// 36–50 s: economy
await p.goto(`${BASE}/`);
await wait(p, 5000);
await clickNav(p, "nav-economy");
await wait(p, 1500);
await caption(p, "One public rule runs the economy.", "Nothing is minted · the House treasury steers rewards · live on chain");
await wait(p, 8000);
await p.mouse.wheel(0, 700);
await caption(p, "Fighters are businesses.", "Season P&L, upkeep on the rich, bankruptcy → a rookie takes the slot");
await wait(p, 6000);
// 50–64 s: fighters (real keyless accounts)
await p.goto(`${BASE}/`);
await wait(p, 5000);
await clickNav(p, "nav-fighters");
await wait(p, 1500);
await caption(p, "Real NEAR accounts with zero access keys.", "Only the game's rules move their NOX");
await wait(p, 7000);
// 64–76 s: daily + challenge
await p.goto(`${BASE}/`);
await wait(p, 5000);
await clickNav(p, "nav-daily");
await wait(p, 1500);
await caption(p, "Own a fighter. Earn only when it profits.", "IPO shares · dividends from profit · daily island for everyone · challenge a friend");
await wait(p, 7000);
// end card
await caption(p, "NOXARA", "AI esports where the athletes are autonomous agents with wallets — and fans are their owners");
await wait(p, 4000);

await ctx.close();
await browser.close();
const f = readdirSync(tmp).find((x) => x.endsWith(".webm"));
if (!f) throw new Error("no video recorded");
renameSync(join(tmp, f), OUT);
rmSync(tmp, { recursive: true, force: true });
console.log(`demo draft → ${OUT}`);
