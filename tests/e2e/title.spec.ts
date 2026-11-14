import { expect, test } from "@playwright/test";
import { collectErrors, isolateFromChain, offlineUrl, phase, requireHook } from "./hook";

test("title: PLAY is keyboard-reachable and starts the match", async ({ page }) => {
  const errors = collectErrors(page);
  const chainCalls = await isolateFromChain(page);
  await page.goto(offlineUrl());
  await requireHook(page);
  expect(await phase(page)).toBe("title");

  const play = page.getByRole("button", { name: /play/i }).first();
  await expect(play).toBeVisible();

  // reachable by keyboard: Tab from the start of the document lands on PLAY within a few presses
  await page.locator("body").focus();
  let focused = false;
  for (let i = 0; i < 15 && !focused; i++) {
    await page.keyboard.press("Tab");
    focused = await play.evaluate((el) => el === document.activeElement);
  }
  expect(focused, "PLAY button receives focus via Tab").toBe(true);

  await play.click();
  await expect.poll(() => phase(page), { timeout: 10_000 }).toBe("playing");
  expect(errors).toEqual([]);
  expect(chainCalls, "offline page made no relayer/RPC calls").toEqual([]);
});

test("title: Enter on the focused PLAY button starts the match", async ({ page }) => {
  const chainCalls = await isolateFromChain(page);
  await page.goto(offlineUrl());
  await requireHook(page);
  const play = page.getByRole("button", { name: /play/i }).first();
  await play.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => phase(page), { timeout: 10_000 }).toBe("playing");
  expect(chainCalls, "offline page made no relayer/RPC calls").toEqual([]);
});

test("about: /?about opens the page and the title link opens it", async ({ page }) => {
  const errors = collectErrors(page);
  await isolateFromChain(page);
  await page.goto(offlineUrl("about"));
  await requireHook(page);
  await expect(page.getByRole("heading", { name: "ABOUT THE GAME" })).toBeVisible();
  await expect(page.getByText("Only one walks out. Hunt the richest. Take the bounty.")).toBeVisible();
  await expect(page.getByText("X post: coming soon")).toBeVisible();
  await page.goto(offlineUrl());
  await requireHook(page);
  await page.getByRole("button", { name: "About the game" }).click();
  await expect(page.getByRole("heading", { name: "ABOUT THE GAME" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("title: the mode selector decides what PLAY starts (training, remembered, soon modes disabled)", async ({ page }) => {
  const errors = collectErrors(page);
  await isolateFromChain(page);
  await page.goto(offlineUrl());
  await requireHook(page);

  const seg = page.locator("#mode-seg");
  await expect(seg.getByRole("button", { name: /standard/i })).toHaveAttribute("aria-pressed", "true");
  // coming-soon modes are visibly disabled and never selectable
  await expect(seg.locator(".seg.soon")).toHaveCount(2);
  await expect(seg.locator(".seg.soon").first()).toHaveAttribute("aria-disabled", "true");
  await seg.locator(".seg.soon").first().click({ force: true });
  await expect(seg.getByRole("button", { name: /standard/i })).toHaveAttribute("aria-pressed", "true");

  // no mode label contains the word "play" (the first /play/i button must be the big PLAY)
  for (const t of await seg.locator(".seg").allInnerTexts()) expect(t).not.toMatch(/play/i);
  await expect(page.getByRole("button", { name: /play/i }).first()).toHaveId("play");

  await page.locator("#training").click();
  await expect(page.locator("#training")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#mode-desc")).toContainText("Easy bots");
  // remembered across a reload
  await page.reload();
  await requireHook(page);
  await expect(page.locator("#training")).toHaveAttribute("aria-pressed", "true");

  await page.locator("#play").click();
  await expect.poll(() => phase(page), { timeout: 15_000 }).toBe("playing");
  const training = await page.evaluate(() => (window.__br!.record?.() as unknown as { cfg?: { training?: boolean } } | undefined)?.cfg?.training);
  expect(training, "PLAY started a training match").toBe(true);
  expect(errors).toEqual([]);
});

test("title: How to play and the cup rules open, close on Esc, and the cup card is there", async ({ page }) => {
  await isolateFromChain(page);
  await page.goto(offlineUrl());
  await requireHook(page);
  await expect(page.locator("#cup")).toContainText("Free to enter");
  await expect(page.locator("#cup")).toContainText("Prizes announced soon");
  await page.locator("#howto-btn").click();
  await expect(page.getByRole("dialog", { name: "HOW TO PLAY" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".sheet")).toHaveCount(0);
  await page.locator("#cup-rules").click();
  await expect(page.getByRole("dialog")).toContainText("Void where prohibited");
  await page.getByRole("button", { name: "CLOSE" }).click();
  await expect(page.locator(".sheet")).toHaveCount(0);
});
