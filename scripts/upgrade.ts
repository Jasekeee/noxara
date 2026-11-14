// Upgrade the deployed royale contract in place: deploy the new wasm + call migrate() in one tx
// (state is versioned; migrate re-reads it). Keeps the contract id, the bots and every balance.
//
//   Testnet (contract at <name>.<root>):
//     node scripts/upgrade.ts --root br-7e8492.testnet [--name royale] [--dry-run]
//   Mainnet (contract ON the root, e.g. noxara.near):
//     node scripts/upgrade.ts --network mainnet --root noxara.near --contract-on-root --expect-sha256 <hex> [--dry-run | --check-key]
//   Rollback to the first mainnet release (sha256 d734724f…, a wasm built from older sources, so the source
//   guard is replaced by an exact-hash check):
//     node scripts/upgrade.ts --network mainnet --root noxara.near --contract-on-root --rollback --wasm contracts/royale/tests/fixtures/royale_v3_d734724.wasm
//
// Keys: DEPLOYER_PRIVATE_KEY, else ~/.near-credentials/<network>/<root>.json, else <root>/<public-key>.json
// (the one that is a FULL-ACCESS key of the signer on chain). --dry-run needs no key; --check-key only
// resolves the key and sends nothing. Mainnet: refused unless BR_MAINNET_YES=yes. Never prints key material.
import { Near, InMemoryKeyStore, parseKey } from "near-kit";
import crypto from "node:crypto";
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
const has = (k: string) => process.argv.includes(`--${k}`);
/** The first mainnet release (noxara.near, 2026-11-14): the only wasm `--rollback` will deploy. */
const ROLLBACK_SHA256 = "d734724f07c8c0a4de5461d2e72fef86f20ba8c2e0a7960e74c3da8d19057472";

const network = arg("network", "testnet") as "testnet" | "mainnet";
if (network !== "testnet" && network !== "mainnet") throw new Error("--network testnet|mainnet");
const root = arg("root");
const onRoot = has("contract-on-root");
if (onRoot && process.argv.includes("--name")) throw new Error("--contract-on-root and --name are exclusive");
const contract = onRoot ? root : `${arg("name", "royale")}.${root}`;
const signer = onRoot ? root : contract; // testnet: the root's key is also a full-access key of royale.<root>
const wasmPath = path.resolve(arg("wasm", path.join(import.meta.dirname, "../contracts/royale/target/near/royale.wasm")));
const rollback = has("rollback");
let sha256: string;
if (rollback) {
  // a known release built from older sources: the source guard can't apply, the exact hash does
  sha256 = crypto.createHash("sha256").update(fs.readFileSync(wasmPath)).digest("hex");
  if (sha256 !== ROLLBACK_SHA256) throw new Error(`--rollback deploys only the first mainnet release (sha256 ${ROLLBACK_SHA256}); ${wasmPath} is ${sha256}`);
  console.log(`rollback wasm ${wasmPath}: sha256 ${sha256} (the first mainnet release)`);
} else {
  sha256 = checkWasm(wasmPath).sha256;
}
const expect = process.argv.includes("--expect-sha256") ? arg("expect-sha256") : undefined;
if (expect && expect !== sha256) throw new Error(`wasm sha256 ${sha256} != --expect-sha256 ${expect}`);
if (network === "mainnet" && !expect && !rollback) throw new Error("mainnet needs --expect-sha256 <the reviewed wasm's sha256>");
const wasm = fs.readFileSync(wasmPath);
const rpcUrl = arg("rpc", network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com");
console.log(JSON.stringify({ network, contract, signer, topology: onRoot ? "contract on the root" : "contract on a sub-account", wasm_bytes: wasm.length, sha256, rollback, steps: [`ONE tx signed by ${signer}: DeployContract(${wasm.length} B) + migrate() (private, init(ignore_state))`] }, null, 2));
if (has("dry-run")) process.exit(0);

async function keyFromKeychain(account: string): Promise<string> {
  const base = path.join(os.homedir(), `.near-credentials/${network}`);
  const cands: string[] = [];
  const single = path.join(base, `${root}.json`);
  if (fs.existsSync(single)) cands.push(JSON.parse(fs.readFileSync(single, "utf8")).private_key as string);
  const dir = path.join(base, root);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory())
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) cands.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).private_key as string);
  if (!cands.length) throw new Error(`no key for ${root} in ${base} (${root}.json or ${root}/*.json)`);
  for (const k of cands) {
    const pub = parseKey(k).publicKey.toString();
    const r = (await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "final", account_id: account, public_key: pub } }) })).json()) as { result?: { permission: unknown } };
    if (r.result && r.result.permission === "FullAccess") {
      console.log(`signer key: ${pub} (full access on ${account})`);
      return k;
    }
  }
  throw new Error(`none of the ${cands.length} local key(s) for ${root} is a full-access key of ${account} on chain`);
}
if (network === "mainnet" && process.env.DEPLOYER_PRIVATE_KEY) throw new Error("mainnet signs with the keychain key (checked full-access on chain): unset DEPLOYER_PRIVATE_KEY");
const key = process.env.DEPLOYER_PRIVATE_KEY ?? (await keyFromKeychain(signer));
if (has("check-key")) {
  console.log(`check-key: ${signer} will sign with ${parseKey(key).publicKey.toString()}; nothing sent`);
  process.exit(0);
}
if (network === "mainnet" && process.env.BR_MAINNET_YES !== "yes") throw new Error("mainnet needs BR_MAINNET_YES=yes");
const near = new Near({ network, rpcUrl, keyStore: new InMemoryKeyStore({ [signer]: key }) });
const dates = async () => ({ teardown_after: await near.view(contract, "get_teardown_after", {}), is_season_ending: await near.view(contract, "is_season_ending", {}) });
// NEAR's code_hash is base58(sha256(wasm))
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58Hex = (hex: string) => {
  let n = BigInt(`0x${hex}`), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  return s;
};
const codeHash = async () => ((await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: contract } }) })).json()) as { result: { code_hash: string } }).result.code_hash;
const onChain = await codeHash();
// mainnet: refuse unless the live code is exactly the release we reviewed against (or this very wasm: a no-op re-run)
if (network === "mainnet" && !rollback && onChain !== base58Hex(ROLLBACK_SHA256) && onChain !== base58Hex(sha256))
  throw new Error(`live code_hash ${onChain} is neither the reviewed release ${base58Hex(ROLLBACK_SHA256)} nor this wasm: refusing`);
console.log(`live code_hash ${onChain}`);
const before = (await near.view(contract, "get_config", {})) as Record<string, unknown>;
console.log("before:", JSON.stringify(await dates()));
const o = await near.transaction(signer).deployContract(contract, wasm).functionCall(contract, "migrate", {}, { gas: "100 Tgas" }).send({ waitUntil: "FINAL" });
console.log("upgraded + migrated:", o.transaction.hash);
const after = (await near.view(contract, "get_config", {})) as Record<string, unknown>;
console.log("supply before/after:", before.total_supply, after.total_supply, "version", after.version);
const d = await dates();
console.log("after:", JSON.stringify(d));
// self-check: the new code is live, supply untouched and the teardown lock is 2026-12-20 00:00 UTC
const problems = [
  (await codeHash()) !== base58Hex(sha256) ? "code_hash is not the deployed wasm" : "",
  before.total_supply !== after.total_supply ? "total supply changed" : "",
  String(d.teardown_after) !== "1797724800000" ? `teardown_after is ${String(d.teardown_after)}, expected 1797724800000` : "",
].filter(Boolean);
if (problems.length) {
  console.error(`CHECK FAILED: ${problems.join("; ")} — see docs/MAINNET.md §6 (rollback)`);
  process.exit(1);
}
console.log(`CHECK OK: code_hash ${base58Hex(sha256)}, supply unchanged, teardown 2026-12-20, ranked play until 2026-12-15`);
const mf = process.argv.indexOf("--set-max-free");
if (mf > 0) {
  const near2 = new Near({ network, rpcUrl, keyStore: new InMemoryKeyStore({ [root]: key }) });
  const t = await near2.transaction(root).functionCall(contract, "set_max_free", { max_free: Number(process.argv[mf + 1]) }, { gas: "10 Tgas" }).send({ waitUntil: "FINAL" });
  console.log("set_max_free:", t.transaction.hash);
}
