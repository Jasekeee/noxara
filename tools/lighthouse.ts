// Lighthouse (desktop + mobile) against a production build served by `vite preview` on 5184.
//   npx vite build && npx vite preview --host 127.0.0.1 --port 5184 --strictPort   (other terminal)
//   node tools/lighthouse.ts [path=/]
// Writes docs/lighthouse/{desktop,mobile}.report.{html,json} and prints the category scores.
// Gates (CLAUDE.md): accessibility ≥ 95, performance ≥ 80.
import { mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const URL_ = `${process.env.BR_URL ?? "http://127.0.0.1:5184"}${process.argv[2] ?? "/"}`;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = "docs/lighthouse";
const GATES: Record<string, number> = { accessibility: 95, performance: 80 };

try {
  await fetch(URL_);
} catch {
  console.error(`no server at ${URL_}. Run: npx vite build && npx vite preview --host 127.0.0.1 --port 5184 --strictPort`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

let failed = false;
for (const form of ["desktop", "mobile"] as const) {
  const res = spawnSync(
    "npx",
    [
      "-y",
      "lighthouse@13.6.0",
      URL_,
      ...(form === "desktop" ? ["--preset=desktop"] : []), // no preset = mobile emulation (Moto G Power, slow 4G)
      "--only-categories=performance,accessibility,best-practices",
      "--output=json",
      "--output=html",
      `--output-path=${OUT}/${form}`,
      "--chrome-flags=--headless=new",
      "--quiet",
    ],
    { stdio: "inherit", env: { ...process.env, CHROME_PATH: CHROME } },
  );
  if (res.status !== 0) {
    console.log(`FAIL lighthouse ${form} exited with ${res.status}`);
    failed = true;
    continue;
  }
  const lhr = JSON.parse(readFileSync(`${OUT}/${form}.report.json`, "utf8")) as {
    categories: Record<string, { score: number | null }>;
  };
  const line = Object.entries(lhr.categories)
    .map(([k, c]) => {
      const s = Math.round((c.score ?? 0) * 100);
      const bad = GATES[k] !== undefined && s < GATES[k];
      failed ||= bad;
      return `${k} ${s}${bad ? ` (<${GATES[k]})` : ""}`;
    })
    .join(" · ");
  console.log(`${form.padEnd(8)} ${line}`);
}
console.log(failed ? "FAIL lighthouse gate" : "PASS lighthouse gates (a11y ≥95, perf ≥80)");
process.exitCode = failed ? 1 : 0;
