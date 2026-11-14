// Deploy NOXARA (contract crate `royale`): the game + $NOX token contract, which creates the house and
// the 9 keyless bot wallets in new(), plus the relayer account.
//
//   Mainnet topology (contract ON the root, the relayer also signs settlements):
//     node scripts/deploy.ts --root noxara.near --network mainnet --contract-on-root --owner <your-account.near> [--dry-run]
//   Testnet / sub-account topology (contract at <name>.<root>, a separate server account):
//     node scripts/deploy.ts --root br-7e8492.testnet [--name royale] [--fund 4.5] [--dry-run]
//
// Options: --owner (default: root; with --contract-on-root it MUST be another account you control: it alone
// can teardown once the root's keys are removed), --beneficiary (teardown payee, default = owner, fixed
// forever at new()), --relay-fund, --server-fund, --wasm, --rpc.
// Deploy and init always go in ONE batch transaction (new() is private: nobody can front-run it).
// --dry-run prints the steps and a NEAR cost estimate and touches nothing (no keys needed).
// Keys: the root key comes from DEPLOYER_PRIVATE_KEY, else ~/.near-credentials/<network>/<root>.json.
// New keys for the relayer (and server) accounts go ONLY to ../.env (gitignored; refused otherwise).
// Never prints key material. Mainnet: refused unless BR_MAINNET_YES=yes (the owner's explicit approval).
import { Near, InMemoryKeyStore, generateKey, parseKey } from "near-kit";
import { execFileSync } from "node:child_process";
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

const network = arg("network", "testnet") as "testnet" | "mainnet";
if (network !== "testnet" && network !== "mainnet") throw new Error("--network testnet|mainnet");
const root = arg("root");
const onRoot = has("contract-on-root");
const name = arg("name", "royale");
const owner = arg("owner", root);
const beneficiary = arg("beneficiary", owner);
if (onRoot && owner === root) throw new Error("--contract-on-root needs --owner <another account you control> (it alone can teardown once the root's keys are gone)");
const fund = Number(arg("fund", "4.5"));
const serverFund = Number(arg("server-fund", "1"));
// on the root (mainnet): 0.5 guest budget + 0.25 real-account budget + 0.25 settlement gas (docs/COST.md)
const relayFund = Number(arg("relay-fund", onRoot ? "1.0" : "4"));
const headroom = Number(arg("headroom", "0.3")); // contract state growth: measured ~0.6 KB per match paid by the contract (docs/COST.md)
const dryRun = has("dry-run");
const repo = path.join(import.meta.dirname, "..");
const wasmPath = arg("wasm", path.join(repo, "contracts/royale/target/near/royale.wasm"));
const rpcUrl = arg("rpc", network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com");
const envPath = path.join(repo, ".env");

const contract = onRoot ? root : `${name}.${root}`;
const relay = `relay.${root}`;
const server = onRoot ? relay : `server.${root}`; // mainnet: the relayer is also the match server
const BOTS = ["brindle", "quillon", "vesper", "magpie", "tallow", "dorrit", "zinnia", "okapi", "fenwick"];
const npcs = ["house", ...BOTS].map((b) => `${b}.${contract}`);

checkWasm(wasmPath);
const wasm = fs.readFileSync(wasmPath);
const STORAGE_PER_BYTE = 1e-5; // NEAR per byte (10^19 yocto)
const NPC_NEAR = 0.001; // lib.rs NPC_NEAR: each keyless sub-account (not refundable: it can't be deleted)
const GENESIS_STATE_BYTES = 6_000; // genesis state, rounded up (see docs/CHAIN.md)
const codeNear = +(wasm.length * STORAGE_PER_BYTE).toFixed(4);
const stateNear = +(GENESIS_STATE_BYTES * STORAGE_PER_BYTE).toFixed(4);
const npcTotal = +(npcs.length * NPC_NEAR).toFixed(4);
const contractNeed = +(codeNear + stateNear + npcTotal + headroom).toFixed(3); // + headroom (recent matches, retirements)
const plan = {
  network,
  topology: onRoot ? "contract on the root; relayer = match server" : "contract on a sub-account; separate server account",
  contract,
  owner,
  teardown_beneficiary: beneficiary,
  relayer: relay,
  guests: `g-<hex>.${contract} via create_guest (relayer env GUEST_VIA_CONTRACT=1)`,
  server,
  npcs,
  wasm_bytes: wasm.length,
  steps: [
    onRoot
      ? `1. ONE tx signed by ${root} to itself: DeployContract(royale.wasm, ${wasm.length} B) + new(owner=${owner}, server=${server}, guest_parent=${relay}, teardown_beneficiary=${beneficiary})`
      : `1. ONE tx by ${root}: CreateAccount(${contract}) + Transfer(${fund} NEAR) + AddKey(root key) + DeployContract(${wasm.length} B) + new(owner=${owner}, server=${server}, guest_parent=${relay}, teardown_beneficiary=${beneficiary})`,
    `   new() mints the genesis NOX (9 x 100 to the bots, 2,000 to the house) and creates ${npcs.length} sub-accounts with ${NPC_NEAR} NEAR each and NO access keys`,
    `2. ${root} creates ${relay} (${relayFund} NEAR: guest budget (GUEST_BUDGET_NEAR) + real-account budget (RELAYER_BUDGET_NEAR)${onRoot ? " + settlement gas" : ""}) with a fresh key -> .env RELAYER_PRIVATE_KEY${onRoot ? " (= SERVER_PRIVATE_KEY)" : ""}`,
    `   guests: run the relayer with GUEST_VIA_CONTRACT=1 -> guests are g-<hex>.${contract}, created by the contract's create_guest (callable only by ${relay}); the hosted relayer holds NO key of ${contract}`,
    ...(onRoot ? [] : [`3. ${root} creates ${server} (${serverFund} NEAR; pays settle_match gas) with a fresh key -> .env SERVER_PRIVATE_KEY`]),
    `${onRoot ? 3 : 4}. verify: get_config, get_fighters, ft_metadata (Nox / NOX), 0 access keys on every NPC account`,
    ...(onRoot ? [`4. optional (owner's call): remove ${root}'s full-access keys = no more upgrades; teardown still works: ${owner} calls teardown() after 2026-12-20 00:00 UTC, NEAR goes to ${beneficiary}`] : []),
  ],
  cost_estimate_near: {
    contract_code_storage: codeNear,
    contract_genesis_state: stateNear,
    npc_accounts_not_refundable: npcTotal,
    contract_headroom: headroom,
    contract_total: onRoot ? contractNeed : fund,
    relayer_account: relayFund,
    server_account: onRoot ? 0 : serverFund,
    per_guest: "0.0275 measured (0.01514 storage -> contract, refundable at teardown; 0.003 funding + ~0.0094 gas spent), capped by GUEST_BUDGET_NEAR (0.5) and DAILY_GUEST_CAP (18)",
    per_match_gas: "0.00153 start (relayed) + 0.00274 settle, measured on testnet",
    gas_upper_bound_deploy: 0.05,
    total_from_root: +((onRoot ? contractNeed : fund) + relayFund + (onRoot ? 0 : serverFund) + 0.05).toFixed(3),
    refundable_at_teardown: onRoot ? "everything on the root (code + state + leftover) via the owner's teardown(); the NPC sub-accounts' NEAR stays" : "the contract account's balance via teardown()",
  },
};
console.log(JSON.stringify(plan, null, 2));
if (dryRun) process.exit(0);
if (network === "mainnet" && process.env.BR_MAINNET_YES !== "yes") {
  throw new Error("mainnet deploy needs BR_MAINNET_YES=yes (the owner's explicit approval)");
}

// .env must be gitignored before we write any key into it
try {
  execFileSync("git", ["check-ignore", "-q", envPath], { cwd: repo });
} catch {
  throw new Error(`${envPath} is not gitignored: refusing to write keys`);
}

// The root key: DEPLOYER_PRIVATE_KEY, else the legacy keychain file <root>.json, else near-cli-rs's
// per-key layout <root>/<public-key>.json (the one whose public key is a FULL-ACCESS key of <root> on chain).
// Only the public key is ever printed.
async function rootKeyFromKeychain(): Promise<string> {
  const base = path.join(os.homedir(), `.near-credentials/${network}`);
  const single = path.join(base, `${root}.json`);
  const cands: string[] = [];
  if (fs.existsSync(single)) cands.push(JSON.parse(fs.readFileSync(single, "utf8")).private_key as string);
  const dir = path.join(base, root);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory())
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) cands.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).private_key as string);
  if (!cands.length) throw new Error(`no key for ${root} in ${base} (${root}.json or ${root}/*.json): import it with \`near account import-account using-web-wallet network-config ${network}\` and choose the legacy keychain`);
  for (const k of cands) {
    const pub = parseKey(k).publicKey.toString();
    const r = (await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "final", account_id: root, public_key: pub } }) })).json()) as { result?: { permission: unknown } };
    if (r.result && r.result.permission === "FullAccess") {
      console.log(`root key: ${pub} (full access on ${root})`);
      return k;
    }
  }
  throw new Error(`none of the ${cands.length} local key(s) for ${root} is a full-access key on chain`);
}
const rootKey = process.env.DEPLOYER_PRIVATE_KEY ?? (await rootKeyFromKeychain());
const rootPub = parseKey(rootKey).publicKey.toString();
if (has("check-key")) {
  console.log(`check-key: ${root} will sign with ${rootPub}; nothing sent`);
  process.exit(0);
}

// keep an existing .env (and its keys); a different deployment gets its own file via ENV_FILE
const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : envPath;
if (envFile !== envPath) {
  try {
    execFileSync("git", ["check-ignore", "-q", envFile], { cwd: repo });
  } catch {
    throw new Error(`${envFile} is not gitignored: refusing to write keys`);
  }
}
const envLines = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8").split("\n") : [];
const envGet = (k: string) => envLines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
const envSet = (k: string, v: string) => {
  const i = envLines.findIndex((l) => l.startsWith(`${k}=`));
  if (i >= 0) envLines[i] = `${k}=${v}`;
  else envLines.push(`${k}=${v}`);
};
const keyFor = (k: string, account: string) => {
  const existing = envGet(k);
  if (existing && envGet(k.replace("PRIVATE_KEY", "ACCOUNT_ID")) === account) return existing;
  const kp = generateKey();
  envSet(k, kp.secretKey);
  return kp.secretKey;
};
const relayKey = keyFor("RELAYER_PRIVATE_KEY", relay);
const serverKey = onRoot ? relayKey : keyFor("SERVER_PRIVATE_KEY", server);
if (onRoot) envSet("SERVER_PRIVATE_KEY", relayKey);
envSet("NEAR_NETWORK", network);
envSet("GAME_CONTRACT_ID", contract);
envSet("SERVER_ACCOUNT_ID", server);
envSet("RELAYER_ACCOUNT_ID", relay);
fs.writeFileSync(envFile, envLines.filter((l, i) => l || i < envLines.length - 1).join("\n") + "\n", { mode: 0o600 });
console.log(`keys for ${relay}${onRoot ? " (also the match server)" : ` and ${server}`} are in ${path.basename(envFile)} (not printed)`);

const near = new Near({ network, rpcUrl, keyStore: new InMemoryKeyStore({ [root]: rootKey, [contract]: rootKey }) });
const txs: Record<string, string> = {};
// --teardown-after-ms only has an effect with a wasm built with the `teardown-override` feature
// (testnet rehearsals); release builds always lock teardown until 2026-12-20 00:00 UTC
const teardownAfter = process.argv.includes("--teardown-after-ms") ? arg("teardown-after-ms") : undefined;
if (teardownAfter && network === "mainnet") throw new Error("--teardown-after-ms is for testnet rehearsals only");
const initArgs = { owner, server, guest_parent: relay, teardown_beneficiary: beneficiary, ...(teardownAfter ? { teardown_after_ms: teardownAfter } : {}) };
const rpcq = async (params: Record<string, unknown>) =>
  (await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }) })).json()) as { result?: Record<string, unknown> };

if (onRoot) {
  const a = await rpcq({ request_type: "view_account", account_id: root });
  if (a.result?.code_hash && a.result.code_hash !== "11111111111111111111111111111111") {
    console.log(`${root} already has a contract: skipping deploy (use scripts/upgrade.ts)`);
  } else {
    const o = await near.transaction(root).deployContract(root, wasm).functionCall(root, "new", initArgs, { gas: "250 Tgas" }).send({ waitUntil: "FINAL" });
    txs.deploy_and_new = o.transaction.hash;
    console.log("deployed + initialised on the root (one tx):", o.transaction.hash);
  }
} else if (!(await near.accountExists(contract))) {
  const o = await near
    .transaction(root)
    .createAccount(contract)
    .transfer(contract, `${fund} NEAR`)
    .addKey(rootPub, { type: "fullAccess" })
    .deployContract(contract, wasm)
    .functionCall(contract, "new", initArgs, { gas: "250 Tgas" })
    .send({ waitUntil: "FINAL" });
  txs.deploy_and_new = o.transaction.hash;
  console.log("deployed + initialised (one tx):", o.transaction.hash);
} else {
  console.log(`${contract} exists: skipping create/deploy (use scripts/upgrade.ts)`);
}
const accounts: [string, number, string][] = [[relay, relayFund, relayKey]];
if (!onRoot) accounts.push([server, serverFund, serverKey]);
for (const [id, amount, key] of accounts) {
  if (await near.accountExists(id)) {
    console.log(`${id} exists: skipping`);
    continue;
  }
  const o = await near.transaction(root).createAccount(id).transfer(id, `${amount} NEAR`).addKey(parseKey(key).publicKey.toString(), { type: "fullAccess" }).send({ waitUntil: "FINAL" });
  txs[`create_${id.split(".")[0]}`] = o.transaction.hash;
  console.log("created", id, o.transaction.hash);
}

const cfg = (await near.view(contract, "get_config", {})) as Record<string, unknown>;
const fighters = (await near.view(contract, "get_fighters", {})) as Array<{ account: string; name: string; personality: string }>;
const meta = (await near.view(contract, "ft_metadata", {})) as { symbol: string; name: string };
console.log("config:", JSON.stringify(cfg));
console.log("token:", meta.name, meta.symbol);
const keyless: Record<string, number> = {};
for (const id of npcs) {
  const j = await rpcq({ request_type: "view_access_key_list", account_id: id });
  keyless[id] = j.result ? (j.result.keys as unknown[]).length : -1;
  console.log(`${id}: ${j.result ? `${keyless[id]} access keys` : "MISSING"}`);
}
const acct = await rpcq({ request_type: "view_account", account_id: contract });
console.log(`${contract}: storage_usage ${acct.result?.storage_usage} bytes, balance ${Number(BigInt(String(acct.result?.amount ?? 0)) / 10n ** 20n) / 1e4} NEAR`);
const out = path.join(import.meta.dirname, `deployments/${network}${onRoot ? `-root-${root.split(".")[0]}` : ""}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ deployed_at: new Date().toISOString(), topology: plan.topology, contract, owner, teardown_beneficiary: beneficiary, server, relayer: relay, txs, storage_usage: acct.result?.storage_usage, npc_access_keys: keyless, fighters: fighters.map((f) => ({ account: f.account, name: f.name, personality: f.personality })) }, null, 2) + "\n");
console.log("wrote", out);
