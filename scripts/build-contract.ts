// Build the release wasm (and the sandbox-only teardown-override wasm) and record which sources they came from.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sourcesHash } from "./wasm-guard.ts";
console.log(`wasm-opt ${execFileSync(path.join(import.meta.dirname, "node_modules/.bin/wasm-opt"), ["--version"]).toString().trim()} · ${execFileSync("cargo", ["near", "--version"]).toString().trim()}`);

const crate = path.join(import.meta.dirname, "../contracts/royale");
const run = (args: string[]) => execFileSync("cargo", ["near", "build", "non-reproducible-wasm", ...args], { cwd: crate, stdio: "inherit" });
// Size only, no logic change: binaryen wasm-opt -Oz (pinned devDependency) with exactly the wasm features
// rustc already emits for wasm32 (bulk memory, sign-ext, mutable globals, non-trapping float->int), so no new
// instruction kinds are introduced; debug/producer sections stripped. Contract storage costs 1 NEAR per 100 KB.
const wasmOpt = path.join(import.meta.dirname, "node_modules/.bin/wasm-opt");
const FEATURES = ["--enable-bulk-memory-opt", "--enable-sign-ext", "--enable-mutable-globals", "--enable-nontrapping-float-to-int"];
const shrink = (file: string) => {
  const before = fs.statSync(file).size;
  execFileSync(wasmOpt, ["-Oz", ...FEATURES, "--strip-debug", "--strip-producers", file, "-o", file], { stdio: "inherit" });
  console.log(`wasm-opt -Oz: ${path.relative(crate, file)} ${before} -> ${fs.statSync(file).size} bytes`);
};
const src = sourcesHash();
run(["--features", "teardown-override", "--out-dir", "target/near/override"]);
shrink(path.join(crate, "target/near/override/royale.wasm"));
fs.writeFileSync(path.join(crate, "target/near/override/royale.wasm.src-sha256"), src + "\n");
run([]);
shrink(path.join(crate, "target/near/royale.wasm"));
fs.writeFileSync(path.join(crate, "target/near/royale.wasm.src-sha256"), src + "\n");
console.log(`built from sources ${src}`);

// Option B anchor (contracts/anchor): plain cargo (no near-sdk, no ABI), same -Oz step, its own source guard.
const anchor = path.join(import.meta.dirname, "../contracts/anchor");
execFileSync("cargo", ["build", "--target", "wasm32-unknown-unknown", "--release"], { cwd: anchor, stdio: "inherit" });
fs.mkdirSync(path.join(anchor, "target/near"), { recursive: true });
const aw = path.join(anchor, "target/near/anchor.wasm");
fs.copyFileSync(path.join(anchor, "target/wasm32-unknown-unknown/release/anchor.wasm"), aw);
shrink(aw);
fs.writeFileSync(`${aw}.src-sha256`, sourcesHash(anchor) + "\n");
console.log(`anchor built from sources ${sourcesHash(anchor)}`);
