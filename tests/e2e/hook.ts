// Helpers for the client test hook (docs/OWNERSHIP.md): with ?e2e the client exposes window.__br.
import { test, type Page } from "@playwright/test";
import type { MatchRecord } from "../../src/sim/types";

export type Phase = "title" | "playing" | "over";
export interface BrHook {
  phase(): Phase;
  tick(): number;
  alive(): number;
  placement(): number | null;
  fps(): number;
  record?(): MatchRecord;
}
declare global {
  interface Window {
    __br?: BrHook;
  }
}

/** Wait for window.__br; skip the test (with a clear reason) if the client doesn't expose it. */
export async function requireHook(page: Page, timeout = 20_000): Promise<void> {
  const found = await page
    .waitForFunction(() => typeof window.__br?.phase === "function", undefined, { timeout })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, "window.__br test hook missing: the client does not implement ?e2e yet (Agent A, docs/OWNERSHIP.md)");
}

export const phase = (page: Page) => page.evaluate(() => window.__br!.phase());

/** Collects console errors and uncaught page errors from the moment it is attached. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

export async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}
