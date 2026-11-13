import { expect, test } from "@playwright/test";
import { collectErrors, phase, requireHook } from "./hook";

test("title: PLAY is keyboard-reachable and starts the match", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?e2e");
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
});

test("title: Enter on the focused PLAY button starts the match", async ({ page }) => {
  await page.goto("/?e2e");
  await requireHook(page);
  const play = page.getByRole("button", { name: /play/i }).first();
  await play.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => phase(page), { timeout: 10_000 }).toBe("playing");
});
