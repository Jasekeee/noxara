// Deploy BOUNTY ROYALE: the royale contract (which creates the house + 9 keyless bot wallets in
// new()), the match-server account and the relayer account.
//
//   node scripts/deploy.ts --root br-7e8492.testnet [--name royale] [--fund 4.5] [--server-fund 1] [--relay-fund 4] [--dry-run]
//
// --dry-run prints the steps and a NEAR cost estimate and touches nothing (no keys needed).
// Keys: the root key comes from DEPLOYER_PRIVATE_KEY, else ~/.near-credentials/<network>/<root>.json.
// New keys for the server and relayer accounts are generated here and written ONLY to ../.env
// (gitignored; refused otherwise). The script never prints key material.
// Mainnet: refused unless BR_MAINNET_YES=yes (the owner's explicit approval).
import { Near, InMemoryKeyStore, generateKey, parseKey } from "near-kit";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const name = arg("name", "royale");
const fund = Number(arg("fund", "4.5"));
const serverFund = Number(arg("server-fund", "1"));
const relayFund = Number(arg("relay-fund", "4"));
const dryRun = has("dry-run");
const repo = path.join(import.meta.dirname, "..");
const wasmPath = arg("wasm", path.join(repo, "contracts/royale/target/near/royale.wasm"));
const rpcUrl = arg("rpc", network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com");
const envPath = path.join(repo, ".env");

const contract = `${name}.${root}`;
const server = `server.${root}`;
const relay = `relay.${root}`;
const BOTS = ["brindle", "quillon", "vesper", "magpie", "tallow", "dorrit", "zinnia", "okapi", "fenwick"];
const npcs = ["house", ...BOTS].map((b) => `${b}.${contract}`);

const wasm = fs.readFileSync(wasmPath);
const STORAGE_PER_BYTE = 1e-5; // NEAR per byte (10^19 yocto)
const NPC_NEAR = 0.001; // the contract funds each keyless sub-account (lib.rs NPC_NEAR)
const plan = {
  network,
  contract,
  server,
  relayer: relay,
  npcs,
  wasm_bytes: wasm.length,
  steps: [
    `1. ${root} creates ${contract}, funds it with ${fund} NEAR, adds the root's key (upgrades via migrate), deploys royale.wasm (${wasm.length} bytes), calls new(owner=${root}, server=${server}, guest_parent=${relay})`,
    `   new() mints the genesis $BOUNTY (9 x 100 to the bots, 2,000 to the house) and creates ${npcs.length} sub-accounts with ${NPC_NEAR} NEAR each and NO access keys`,
    `2. ${root} creates ${server} (${serverFund} NEAR; pays gas for settle_match) with a fresh key -> .env SERVER_PRIVATE_KEY`,
    `3. ${root} creates ${relay} (${relayFund} NEAR; pays guest accounts, their storage deposits and relayed gas) with a fresh key -> .env RELAYER_PRIVATE_KEY`,
    `4. verify: get_config, get_fighters, ft_metadata, 0 access keys on every NPC account`,
  ],
  cost_estimate_near: {
    contract_code_storage: +(wasm.length * STORAGE_PER_BYTE).toFixed(3),
    contract_state_headroom: +(fund - wasm.length * STORAGE_PER_BYTE - npcs.length * NPC_NEAR).toFixed(3),
    contract_funding_total: fund,
    server_account: serverFund,
    relayer_account: relayFund,
    per_guest: "~0.024 (0.003 account + 0.02 storage deposit + gas)",
    per_match_gas: "~0.001 start (relayer) + ~0.001-0.007 settle (server)",
    gas_upper_bound_deploy: 0.05,
    total_from_root: +(fund + serverFund + relayFund + 0.05).toFixed(3),
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

let rootKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!rootKey) {
  const f = path.join(os.homedir(), `.near-credentials/${network}/${root}.json`);
  rootKey = JSON.parse(fs.readFileSync(f, "utf8")).private_key as string;
}
const rootPub = parseKey(rootKey).publicKey.toString();

// keep an existing .env (and its keys) — only add what's missing
const envLines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split("\n") : [];
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
const serverKey = keyFor("SERVER_PRIVATE_KEY", server);
const relayKey = keyFor("RELAYER_PRIVATE_KEY", relay);
envSet("NEAR_NETWORK", network);
envSet("GAME_CONTRACT_ID", contract);
envSet("SERVER_ACCOUNT_ID", server);
envSet("RELAYER_ACCOUNT_ID", relay);
fs.writeFileSync(envPath, envLines.filter((l, i) => l || i < envLines.length - 1).join("\n") + "\n", { mode: 0o600 });
console.log(`keys for ${server} and ${relay} are in .env (not printed)`);

const near = new Near({ network, rpcUrl, keyStore: new InMemoryKeyStore({ [root]: rootKey, [contract]: rootKey }) });
const txs: Record<string, string> = {};

if (!(await near.accountExists(contract))) {
  const o = await near
    .transaction(root)
    .createAccount(contract)
    .transfer(contract, `${fund} NEAR`)
    .addKey(rootPub, { type: "fullAccess" })
    .deployContract(contract, wasm)
    .functionCall(contract, "new", { owner: root, server, guest_parent: relay }, { gas: "250 Tgas" })
    .send({ waitUntil: "FINAL" });
  txs.deploy_and_new = o.transaction.hash;
  console.log("deployed + initialised:", o.transaction.hash);
} else {
  console.log(`${contract} exists: skipping create/deploy`);
}
for (const [id, amount, key] of [[server, serverFund, serverKey], [relay, relayFund, relayKey]] as const) {
  if (await near.accountExists(id)) {
    console.log(`${id} exists: skipping`);
    continue;
  }
  const o = await near
    .transaction(root)
    .createAccount(id)
    .transfer(id, `${amount} NEAR`)
    .addKey(parseKey(key).publicKey.toString(), { type: "fullAccess" })
    .send({ waitUntil: "FINAL" });
  txs[`create_${id.split(".")[0]}`] = o.transaction.hash;
  console.log("created", id, o.transaction.hash);
}

const cfg = await near.view(contract, "get_config", {});
const fighters = (await near.view(contract, "get_fighters", {})) as Array<{ account: string; name: string; personality: string; balance: string }>;
const meta = (await near.view(contract, "ft_metadata", {})) as { symbol: string };
console.log("config:", JSON.stringify(cfg));
console.log("token:", meta.symbol);
const keyless: Record<string, number> = {};
for (const id of npcs) {
  const j = (await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: id } }) })).json()) as { result?: { keys: unknown[] }; error?: unknown };
  keyless[id] = j.result ? j.result.keys.length : -1;
  console.log(`${id}: ${j.result ? `${j.result.keys.length} access keys` : "MISSING"}`);
}
const out = path.join(import.meta.dirname, `deployments/${network}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ deployed_at: new Date().toISOString(), contract, server, relayer: relay, owner: root, txs, npc_access_keys: keyless, fighters: fighters.map((f) => ({ account: f.account, name: f.name, personality: f.personality })) }, null, 2) + "\n");
console.log("wrote", out);
