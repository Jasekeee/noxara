// End of season: the OWNER asks the contract to delete its own account (it sends all its NEAR to the
// teardown beneficiary fixed at new()). Optionally also deletes the relayer account (it has a key) to
// the same beneficiary. Works when the contract account has no keys left.
//
//   node scripts/teardown.ts --contract nx-4ba5bb.testnet --owner br-7e8492.testnet [--relay relay.nx-4ba5bb.testnet --env .env.rehearsal]
// Keys: the owner's from ~/.near-credentials/<network>/<owner>.json; the relayer's from the env file.
// Mainnet: refused unless BR_MAINNET_YES=yes. Never prints key material.
import { Near, InMemoryKeyStore } from "near-kit";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  if (i > 0) return process.argv[i + 1];
  if (d === undefined) throw new Error(`missing --${k}`);
  return d;
};
const network = arg("network", "testnet") as "testnet" | "mainnet";
if (network === "mainnet" && process.env.BR_MAINNET_YES !== "yes") throw new Error("mainnet needs BR_MAINNET_YES=yes");
const contract = arg("contract");
const owner = arg("owner");
const relay = arg("relay", "");
const rpcUrl = network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com";
const ownerKey = JSON.parse(fs.readFileSync(path.join(os.homedir(), `.near-credentials/${network}/${owner}.json`), "utf8")).private_key as string;
const keys: Record<string, string> = { [owner]: ownerKey };
if (relay) {
  const env = fs.readFileSync(arg("env", ".env"), "utf8");
  keys[relay] = /^RELAYER_PRIVATE_KEY=(.*)$/m.exec(env)![1].trim();
}
const near = new Near({ network, rpcUrl, keyStore: new InMemoryKeyStore(keys) });
const bal = async (a: string) => {
  const j = (await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: a } }) })).json()) as { result?: { amount: string } };
  return j.result ? Number(BigInt(j.result.amount) / 10n ** 18n) / 1e6 : null;
};
const beneficiary = (await near.view(contract, "get_teardown_beneficiary", {})) as string;
const b0 = await bal(beneficiary);
const c0 = await bal(contract);
console.log(`${contract}: ${c0} NEAR; beneficiary ${beneficiary}: ${b0} NEAR`);
for (let i = 0; i < 20; i++) {
  const o = await near.transaction(owner).functionCall(contract, "teardown", {}, { gas: "300 Tgas" }).send({ waitUntil: "FINAL" });
  console.log(`teardown call ${i + 1}: ${o.transaction.hash}`);
  if ((await bal(contract)) === null) break; // deleted (else: more matches to close, call again)
}
const b1 = await bal(beneficiary);
console.log(`${contract} deleted: ${(await bal(contract)) === null}; beneficiary got ${((b1 ?? 0) - (b0 ?? 0)).toFixed(4)} NEAR (contract held ${c0})`);
if (relay) {
  const r0 = await bal(relay);
  const o = await near.transaction(relay).deleteAccount({ beneficiary }).send({ waitUntil: "FINAL" });
  console.log(`relayer ${relay} (${r0} NEAR) deleted -> ${beneficiary}: ${o.transaction.hash}`);
  console.log(`beneficiary now ${await bal(beneficiary)} NEAR`);
}
