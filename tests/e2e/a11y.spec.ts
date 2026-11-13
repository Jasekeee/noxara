import { expect, test } from "@playwright/test";
import { phase, requireHook } from "./hook";

// axe-core WCAG 2.x A/AA scan. Needs the dev dependency @axe-core/playwright@4.14.0 (requested from
// the lead, see docs/QA.md); the test skips with a message until it is installed.
const AXE = "@axe-core/playwright";

async function loadAxe(): Promise<any> {
  try {
    return (await import(/* @vite-ignore */ AXE as string)).default;
  } catch {
    return null;
  }
}

for (const [label, url] of [
  ["title screen", "/?e2e"],
  ["in-match HUD", "/?e2e&autoplay&seed=7&bots=1"],
] as const) {
  test(`a11y: no WCAG A/AA violations on the ${label}`, async ({ page }) => {
    const AxeBuilder = await loadAxe();
    test.skip(!AxeBuilder, `${AXE} is not installed (dependency request: ${AXE}@4.14.0)`);
    await page.goto(url);
    await requireHook(page);
    if (url.includes("bots=1")) await expect.poll(() => phase(page), { timeout: 15_000 }).toBe("playing");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const summary = results.violations.map(
      (v: { id: string; impact: string; nodes: unknown[] }) => `${v.impact} ${v.id} (${v.nodes.length} nodes)`,
    );
    expect(summary).toEqual([]);
  });
}
