// Seed relayer/data/subsidised.json with every account the relayer ever paid a storage deposit for
// (scans the relayer's storage_deposit txs: nearblocks index -> archival RPC for the arguments), so
// accounts registered before the one-subsidy rule can't be subsidised again.
//   node scripts/seed-subsidies.ts --relayer relay.br-7e8492.testnet [--network testnet]
import fs from "node:fs";
import path from "node:path";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const relayer = arg("relayer", "relay.br-7e8492.testnet");
const network = arg("network", "testnet");
const index = network === "testnet" ? "https://api-testnet.nearblocks.io" : "https://api.nearblocks.io";
const rpc = network === "testnet" ? "https://archival-rpc.testnet.fastnear.com" : "https://archival-rpc.mainnet.fastnear.com";
const out = path.join(import.meta.dirname, "../relayer/data/subsidised.json");

const hashes: string[] = [];
for (let page = 1; page < 100; page++) {
  let r: { txns?: { transaction_hash: string; predecessor_account_id: string }[] } = {};
  for (let attempt = 0; attempt < 5 && !r.txns; attempt++) {
    r = (await (await fetch(`${index}/v1/account/${relayer}/txns?method=storage_deposit&per_page=100&page=${page}`)).json()) as typeof r;
    if (!r.txns) await new Promise((res) => setTimeout(res, 3000)); // the public index rate-limits
  }
  if (!r.txns) throw new Error("the nearblocks index did not answer: try again in a minute");
  const t = (r.txns ?? []).filter((x) => x.predecessor_account_id === relayer);
  hashes.push(...t.map((x) => x.transaction_hash));
  if ((r.txns ?? []).length < 100) break;
}
const accounts = new Set<string>();
try {
  for (const a of JSON.parse(fs.readFileSync(out, "utf8")) as string[]) accounts.add(a);
} catch {
  // none yet
}
const before = accounts.size;
let failed = 0;
type TxResult = { result?: { transaction: { actions: { FunctionCall?: { method_name: string; args: string } }[] } } };
for (const h of new Set(hashes)) {
  let j: TxResult = {};
  for (let attempt = 0; attempt < 6 && !j.result; attempt++) {
    if (attempt) await new Promise((res) => setTimeout(res, 1000 * attempt)); // archival RPC rate limit
    j = (await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: h, sender_account_id: relayer, wait_until: "NONE" } }) })).json().catch(() => ({}))) as TxResult;
  }
  if (!j.result) failed++;
  for (const a of j.result?.transaction.actions ?? []) {
    if (a.FunctionCall?.method_name !== "storage_deposit") continue;
    const args = JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString()) as { account_id?: string };
    if (args.account_id) accounts.add(args.account_id);
  }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify([...accounts]));
const real = [...accounts].filter((a) => !a.startsWith("g-"));
if (failed) console.log(`WARNING: ${failed} txs could not be read: run again`);
console.log(`${hashes.length} storage_deposit txs by ${relayer}; ${accounts.size} subsidised accounts (+${accounts.size - before}); non-guest: ${real.join(", ") || "none"}`);
