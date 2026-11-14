// Helpers for the client test hook (docs/process/OWNERSHIP.md): with ?e2e the client exposes window.__br.
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
  test.skip(!found, "window.__br test hook missing: the client does not implement ?e2e yet (Agent A, docs/process/OWNERSHIP.md)");
}

export const phase = (page: Page) => page.evaluate(() => window.__br!.phase());

/** Hosts the client talks to in chain mode (relayer, NEAR RPC, wallet). */
const CHAIN_HOSTS = [
  new URL(process.env.BR_RELAYER ?? "http://127.0.0.1:8788").host,
  "test.rpc.fastnear.com",
  "rpc.testnet.near.org",
  "testnet.mynearwallet.com",
];
const isChainUrl = (u: string) => {
  try {
    return CHAIN_HOSTS.includes(new URL(u).host);
  } catch {
    return false;
  }
};

/**
 * Collects console errors and uncaught page errors from the moment it is attached. Console errors
 * caused by a request that `isolateFromChain` blocked are the known offline fallback and are not counted
 * (those attempts are reported separately); every other error is.
 */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (isChainUrl(m.location().url)) return;
    errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/**
 * Non-chain specs must never depend on the relayer / testnet (rate limits and latency made them flaky).
 * Blocks those hosts and returns the URLs the page tried to reach (expected: none with ?seed / ?offline).
 */
export async function isolateFromChain(page: Page): Promise<string[]> {
  const attempts: string[] = [];
  await page.route(
    (url) => isChainUrl(url.href),
    (route) => {
      attempts.push(`${route.request().method()} ${route.request().url()}`);
      return route.abort("internetdisconnected");
    },
  );
  return attempts;
}

/**
 * URL for an offline, deterministic page: `?offline` (client never touches the network) plus `?seed=7`,
 * which already means "local match, no network" in builds that predate `?offline`.
 */
export const offlineUrl = (extra = "") => `/?e2e&offline&seed=7${extra ? `&${extra}` : ""}`;

export async function hasHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}
