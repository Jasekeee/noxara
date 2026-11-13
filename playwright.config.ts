import { defineConfig, devices } from "@playwright/test";

// BR_PORT lets QA run its own server while someone plays on the default 5184.
const PORT = Number(process.env.BR_PORT ?? 5184);

export default defineConfig({
  testDir: "tests/e2e",
  // a full match is ≤180 s of game time; headless rendering can be slower than real time
  timeout: 300_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // one WebGL match at a time keeps fps/perf numbers meaningful
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    video: "off", // match.spec.ts turns it on (checkpoint videos)
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    // /@vite/client answers 200 on any Vite dev server, even before index.html exists
    url: `http://127.0.0.1:${PORT}/@vite/client`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
