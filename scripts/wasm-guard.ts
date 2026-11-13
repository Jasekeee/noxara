// Refuse to deploy a wasm that is older than the contract sources (audit #3: a stale build at the
// default path would have shipped code without the security fixes). Prints the sha256 to record.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function checkWasm(wasmPath: string): { bytes: number; sha256: string } {
  const repo = path.join(import.meta.dirname, "..");
  const srcDir = path.join(repo, "contracts/royale");
  const files = ["Cargo.toml", "Cargo.lock", ...fs.readdirSync(path.join(srcDir, "src")).map((f) => path.join("src", f))];
  const newest = Math.max(...files.map((f) => fs.statSync(path.join(srcDir, f)).mtimeMs));
  const st = fs.statSync(wasmPath);
  if (st.mtimeMs < newest) {
    throw new Error(`stale wasm: ${wasmPath} is older than contracts/royale sources — rebuild with \`cargo near build non-reproducible-wasm\` first`);
  }
  const buf = fs.readFileSync(wasmPath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  console.log(`wasm ${path.relative(repo, wasmPath)}: ${buf.length} bytes, sha256 ${sha256}`);
  return { bytes: buf.length, sha256 };
}
