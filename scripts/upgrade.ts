// Upgrade the deployed royale contract in place: deploy the new wasm + call migrate() in one tx
// (state is versioned; migrate re-reads it). Keeps the contract id, the bots and every balance.
//
//   node scripts/upgrade.ts --root br-7e8492.testnet [--name royale] [--dry-run]
// Mainnet: refused unless BR_MAINNET_YES=yes. Never prints key material.
import { Near, InMemoryKeyStore } from "near-kit";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkWasm } from "./wasm-guard.ts";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  if (i > 0) return process.argv[i + 1];
  if (d === undefined) throw new Error(`missing --${k}`);
  return d;
};
const network = arg("network", "testnet") as "testnet" | "mainnet";
const root = arg("root");
const contract = `${arg("name", "royale")}.${root}`;
const wasmPath = arg("wasm", path.join(import.meta.dirname, "../contracts/royale/target/near/royale.wasm"));
checkWasm(wasmPath);
const wasm = fs.readFileSync(wasmPath);
const rpcUrl = arg("rpc", network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com");
console.log(JSON.stringify({ network, contract, wasm_bytes: wasm.length, steps: ["deploy royale.wasm to the contract account", "call migrate() (private, init(ignore_state))"] }, null, 2));
if (process.argv.includes("--dry-run")) process.exit(0);
if (network === "mainnet" && process.env.BR_MAINNET_YES !== "yes") throw new Error("mainnet needs BR_MAINNET_YES=yes");
const key = process.env.DEPLOYER_PRIVATE_KEY ?? (JSON.parse(fs.readFileSync(path.join(os.homedir(), `.near-credentials/${network}/${root}.json`), "utf8")).private_key as string);
const near = new Near({ network, rpcUrl, keyStore: new InMemoryKeyStore({ [contract]: key }) });
const before = await near.view(contract, "get_config", {});
const o = await near.transaction(contract).deployContract(contract, wasm).functionCall(contract, "migrate", {}, { gas: "100 Tgas" }).send({ waitUntil: "FINAL" });
console.log("upgraded + migrated:", o.transaction.hash);
const after = (await near.view(contract, "get_config", {})) as Record<string, unknown>;
console.log("supply before/after:", (before as Record<string, unknown>).total_supply, after.total_supply, "version", after.version);
const mf = process.argv.indexOf("--set-max-free");
if (mf > 0) {
  const near2 = new Near({ network, rpcUrl, keyStore: new InMemoryKeyStore({ [root]: key }) });
  const t = await near2.transaction(root).functionCall(contract, "set_max_free", { max_free: Number(process.argv[mf + 1]) }, { gas: "10 Tgas" }).send({ waitUntil: "FINAL" });
  console.log("set_max_free:", t.transaction.hash);
}
