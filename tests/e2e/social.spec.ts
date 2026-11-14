// Daily tournament + Challenge a friend, offline game client against a chain-less social server
// (relayer/src/social-server.ts) on :8790 with SOCIAL_REALTIME=0 (the e2e plays at ?speed=16, so the
// real-time check is off here; it is covered by relayer/test/social.test.ts):
//   PORT=8790 SOCIAL_REALTIME=0 CORS_ORIGINS=http://127.0.0.1:5192 node --import ./src/ts-resolve.ts src/social-server.ts   (in relayer/)
//   VITE_RELAYER_URL=http://127.0.0.1:8790 BR_PORT=5192 npx playwright test social
import { expect, test, type Page } from "@playwright/test";
import { collectErrors, hasHorizontalScroll, requireHook } from "./hook";

const SOCIAL = process.env.BR_SOCIAL ?? "http://127.0.0.1:8790";

test.beforeAll(async () => {
  const ok = await fetch(`${SOCIAL}/api/health`).then((r) => r.ok).catch(() => false);
  test.skip(!ok, `social server not running on ${SOCIAL} (see the header of this file)`);
});

const over = (page: Page) => page.waitForFunction(() => window.__br!.phase() === "over", undefined, { timeout: 120_000, polling: 500 });

test("daily: play it, land on the board highlighted, then challenge a friend and answer it", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await page.goto("/?e2e&offline&speed=16");
  await requireHook(page);
  await page.locator("#nav-daily").click();
  const sp = page.locator("#social-page");
  await expect(sp).toBeVisible();
  await expect(page.getByRole("button", { name: "PLAY DAILY" })).toBeVisible();
  expect(await hasHorizontalScroll(page), "no horizontal scroll on the daily page").toBe(false);
  await page.getByRole("button", { name: "PLAY DAILY" }).click();
  await over(page);

  // the run was verified and ranked: the board shows us, highlighted
  await expect(sp).toBeVisible({ timeout: 15_000 });
  await expect(sp.locator("tr[aria-current='true']")).toHaveCount(1);
  await expect(sp.getByText(/Your run:/)).toBeVisible();
  await expect(sp.locator("tr[aria-current='true'] .sc-tag", { hasText: "GUEST" })).toBeVisible();
  expect(await hasHorizontalScroll(page), "no horizontal scroll on the board").toBe(false);

  // end screen -> challenge a friend
  await sp.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("#end")).toBeVisible();
  await page.locator("#challenge").click();
  await page.getByRole("button", { name: "CREATE LINK" }).click();
  const link = await page.locator("#sc-link").inputValue();
  expect(link).toMatch(/\/c\/[a-z2-7]{8}$/);
  await expect(page.getByRole("button", { name: "COPY LINK" })).toBeVisible();
  const id = link.slice(-8);
  // the share page carries the score for link previews and redirects to the game
  const html = await (await fetch(link, { redirect: "manual" })).text();
  expect(html).toMatch(/og:title" content="Placed \d+\/10 with \d+ kills?/);
  expect(html).toContain(`?challenge=${id}`);
  expect(errors, "zero console errors").toEqual([]);

  // a friend opens the link: banner, same cfg, plays, sees the side-by-side
  const ctx = await browser.newContext({ ...test.info().project.use });
  const friend = await ctx.newPage();
  const ferrors = collectErrors(friend);
  await friend.goto(`/?e2e&offline&speed=16&challenge=${id}`);
  await requireHook(friend);
  await expect(friend.locator("#challenge-banner")).toContainText("Beat");
  await expect(friend.locator("#challenge-banner")).toContainText("Same island, same fighters");
  await friend.locator("#play").click();
  await over(friend);
  const fs = friend.locator("#social-page");
  await expect(fs).toBeVisible({ timeout: 15_000 });
  await expect(fs.getByRole("table")).toBeVisible();
  await expect(fs.getByText("Took the bounty")).toBeVisible();
  await expect(fs.locator(".verdict")).toHaveText(/YOU WIN|TIE|WINS/);
  expect(await hasHorizontalScroll(friend), "no horizontal scroll on the result page").toBe(false);
  expect(ferrors, "zero console errors (friend)").toEqual([]);
  await ctx.close();
});

test("unreachable server: daily shows a clear message, practice still works", async ({ page }) => {
  const errors = collectErrors(page);
  await page.route("**/api/daily**", (r) => r.abort("connectionrefused"));
  await page.goto("/?e2e&offline");
  await requireHook(page);
  await page.locator("#nav-daily").click();
  await expect(page.locator("#social-page")).toContainText("Can't reach the NOXARA server");
  await expect(page.locator("#social-page")).toContainText("Practice is open");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("#play")).toBeVisible();
  expect(errors.filter((e) => !/ERR_|Failed to load resource/.test(e))).toEqual([]);
});
