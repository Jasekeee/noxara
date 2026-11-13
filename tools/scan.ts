// Source scan: src/sim must use only deterministic primitives (CLAUDE.md "Deterministic match simulation").
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BANNED: [string, RegExp][] = [
  ["Math.random", /\bMath\.random\b/],
  ["Math.sin", /\bMath\.sin\b/],
  ["Math.cos", /\bMath\.cos\b/],
  ["Math.tan", /\bMath\.tan\b/],
  ["Math.atan2", /\bMath\.atan2\b/],
  ["Math.atan/asin/acos", /\bMath\.a(?:tan|sin|cos)h?\b/],
  ["Math.exp/log/hypot/cbrt", /\bMath\.(?:exp|expm1|log|log2|log10|log1p|hypot|cbrt)\b/],
  ["Date", /\bDate\b/],
  ["performance", /\bperformance\b/],
  ["crypto", /\bcrypto\b/],
];

/** Remove comments so documentation like "never use Math.random" doesn't trip the scan. */
export const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Placeholder files start with a "// … STUB …" comment. */
export const isStubSource = (src: string) => /^\/\/.*\bSTUB\b/.test(src.split("\n", 1)[0]);

export interface ScanResult {
  files: string[];
  stubs: string[];
  hits: string[];
}

/** Scans every *.ts in `dir` except *.test.ts (and stub placeholders). */
export function scanSim(dir: string): ScanResult {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const stubs: string[] = [];
  const hits: string[] = [];
  for (const file of files) {
    const src = readFileSync(join(dir, file), "utf8");
    if (isStubSource(src)) {
      stubs.push(file);
      continue;
    }
    stripComments(src)
      .split("\n")
      .forEach((line, i) => {
        for (const [name, re] of BANNED) if (re.test(line)) hits.push(`${file}:${i + 1} ${name}: ${line.trim()}`);
      });
  }
  return { files, stubs, hits };
}
