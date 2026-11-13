// Refuse to deploy a wasm that was not built from the current contract sources (audit #3: a stale build at the
// default path would have shipped code without the security fixes). `scripts/build-contract.ts` writes
// <wasm>.src-sha256 = hash of the sources it built from; this check recomputes and compares.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const repo = path.join(import.meta.dirname, "..");
const crate = path.join(repo, "contracts/royale");

/** sha256 over Cargo.toml, Cargo.lock and src/*.rs except tests.rs (tests don't change the wasm). */
export function sourcesHash(): string {
  const h = crypto.createHash("sha256");
  const files = ["Cargo.toml", "Cargo.lock", ...fs.readdirSync(path.join(crate, "src")).filter((f) => f.endsWith(".rs") && f !== "tests.rs").sort().map((f) => `src/${f}`)];
  for (const f of files) h.update(f).update("\0").update(fs.readFileSync(path.join(crate, f))).update("\0");
  return h.digest("hex");
}

export function checkWasm(wasmPath: string): { bytes: number; sha256: string } {
  const side = `${wasmPath}.src-sha256`;
  const built = fs.existsSync(side) ? fs.readFileSync(side, "utf8").trim() : "";
  if (built !== sourcesHash()) {
    throw new Error(`stale wasm: ${path.relative(repo, wasmPath)} was not built from the current contract sources — run \`node scripts/build-contract.ts\` first`);
  }
  const buf = fs.readFileSync(wasmPath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  console.log(`wasm ${path.relative(repo, wasmPath)}: ${buf.length} bytes, sha256 ${sha256} (sources ${built.slice(0, 12)})`);
  return { bytes: buf.length, sha256 };
}
