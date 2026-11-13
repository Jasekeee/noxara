// Build the release wasm (and the sandbox-only teardown-override wasm) and record which sources they came from.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sourcesHash } from "./wasm-guard.ts";

const crate = path.join(import.meta.dirname, "../contracts/royale");
const run = (args: string[]) => execFileSync("cargo", ["near", "build", "non-reproducible-wasm", ...args], { cwd: crate, stdio: "inherit" });
const src = sourcesHash();
run(["--features", "teardown-override", "--out-dir", "target/near/override"]);
fs.writeFileSync(path.join(crate, "target/near/override/royale.wasm.src-sha256"), src + "\n");
run([]);
fs.writeFileSync(path.join(crate, "target/near/royale.wasm.src-sha256"), src + "\n");
console.log(`built from sources ${src}`);
