// npm run verify — one command, PASS/FAIL per README claim. Offline-capable: the chain checks print SKIP
// when the NEAR RPC is unreachable. Exit 1 on any FAIL.
//   npm run verify                 the live game: NEAR mainnet, contract noxara.near
//   npm run verify -- --testnet    the testnet rehearsal contract (royale.br-7e8492.testnet)
//   env BR_RPC / BR_CONTRACT override either
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanSim } from "./scan.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TESTNET = process.argv.includes("--testnet");
const NET = TESTNET ? "testnet" : "mainnet";
const RPC = process.env.BR_RPC ?? (TESTNET ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com");
const CONTRACT = process.env.BR_CONTRACT ?? (TESTNET ? "royale.br-7e8492.testnet" : "noxara.near");
/** sha256 of the audited release wasm deployed on mainnet (docs/MAINNET.md; rebuild: node scripts/build-contract.ts) */
const MAINNET_WASM_SHA256 = "d734724f07c8c0a4de5461d2e72fef86f20ba8c2e0a7960e74c3da8d19057472";
/** mainnet: nothing was ever minted beyond genesis (9 × 100 to the bots + 2,000 to the House) */
const GENESIS = 2900n * 10n ** 18n;
const BALANCE_N = 300;
/** total_minted when the testnet contract was upgraded to economy v2 (2026-11-13): genesis 2,900 + 250 minted by v1 top-ups */
const MINTED_AT_V2 = 3150n * 10n ** 18n; // smaller samples are noisy around the 40% line

type Status = "PASS" | "FAIL" | "SKIP";
const results: { status: Status; claim: string; detail: string }[] = [];
function report(status: Status, claim: string, detail: string, ms: number) {
  results.push({ status, claim, detail });
  console.log(`${status}  ${claim}\n      ${detail} (${(ms / 1000).toFixed(1)} s)`);
}
async function check(claim: string, fn: () => Promise<[Status, string]> | [Status, string]) {
  const t0 = performance.now();
  let out: [Status, string];
  try {
    out = await fn();
  } catch (e) {
    out = ["FAIL", `error: ${(e as Error).message}`];
  }
  report(out[0], claim, out[1], performance.now() - t0);
}
function run(cmd: string, args: string[], cwd = ROOT) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe", maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status };
}
const bin = (name: string) => join(ROOT, "node_modules", ".bin", name);
const lastLines = (s: string, n = 4) => s.trim().split("\n").slice(-n).join(" | ");
// strip ANSI colours from tool output
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

console.log("NOXARA — verifying the README claims\n");

await check("TypeScript compiles under strict mode (src, tools, tests)", () => {
  const r = run(bin("tsc"), ["--noEmit", "-p", "."]);
  return r.ok ? ["PASS", "tsc --noEmit: 0 errors"] : ["FAIL", lastLines(r.out, 6)];
});

await check("Unit tests pass (determinism, replay, bots, storm, chests, bushes)", () => {
  const r = run(bin("vitest"), ["run"]);
  const out = plain(r.out);
  const line = out.match(/Tests\s+([^\n]+)/)?.[1]?.trim() ?? lastLines(out);
  return [r.ok ? "PASS" : "FAIL", `vitest: ${line}`];
});

await check("src/sim uses no Math.random / float trig / Date / performance (deterministic sim)", () => {
  const s = scanSim(join(ROOT, "src", "sim"));
  if (s.hits.length) return ["FAIL", s.hits.slice(0, 5).join("; ")];
  if (s.stubs.length) return ["FAIL", `still stubs: ${s.stubs.join(", ")}`];
  return ["PASS", `${s.files.length} files scanned, 0 banned calls`];
});

await check("Every committed match replays to its stored hash, winner and placements", () => {
  const dir = join(ROOT, "matches");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  if (!files.length) return ["FAIL", "no matches/*.json committed"];
  const bad: string[] = [];
  for (const f of files) {
    const r = run(process.execPath, [join(ROOT, "tools", "verify-match.ts"), join("matches", f)]);
    if (!r.ok) bad.push(`${f}: ${lastLines(r.out, 2)}`);
  }
  return bad.length ? ["FAIL", bad.join("; ")] : ["PASS", `${files.length}/${files.length} reproduced (${files.join(", ")})`];
});

await check(`Balance: ${BALANCE_N} bot-only matches, no personality wins >40%, all end within 180 s`, () => {
  const r = run(process.execPath, [join(ROOT, "tools", "headless.ts"), String(BALANCE_N)]);
  const shares = [...r.out.matchAll(/^(\w+)\s+[\d.]+\s+\d+\s+([\d.]+)%/gm)].map((m) => `${m[1]} ${m[2]}%`);
  const len = r.out.match(/avg match length\s+(.+)/)?.[1]?.trim();
  const fails = r.out.split("\n").filter((l) => l.startsWith("FAIL"));
  return r.ok
    ? ["PASS", `win share: ${shares.join(", ")}; avg length ${len}`]
    : ["FAIL", fails.join("; ") || lastLines(r.out)];
});

await check("Economy v2: simulated matches pass every criterion (no minting after genesis, solvent House, rich bots fall, rookies rise)", () => {
  const r = run(process.execPath, [join(ROOT, "scripts", "econ-sim-v2.ts"), "--runs", "6", "--out", join(ROOT, "node_modules", ".cache", "noxara-econ-verify")]);
  const out = plain(r.out);
  const fails = out.split("\n").filter((l) => l.startsWith("FAIL ")).length;
  return [r.ok ? "PASS" : "FAIL", r.ok ? "econ-sim-v2: 6 runs x 10,000 matches, all checks PASS (README/ECONOMY.md figures use 20 runs)" : `econ-sim-v2: ${fails} check(s) FAIL`];
});

await check("Match server: signature checks, replay judge, relay policy (relayer node tests)", () => {
  if (!existsSync(join(ROOT, "relayer", "node_modules"))) {
    // fresh clone: install the match server's dependencies (lockfile, no scripts) instead of failing
    console.log("      installing relayer dependencies (npm ci --prefix relayer)…");
    const inst = spawnSync("npm", ["ci", "--prefix", "relayer", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" });
    if (inst.status !== 0) return ["FAIL", `could not install relayer dependencies: ${lastLines(inst.stderr ?? "", 2)}`];
  }
  const r = run(process.execPath, ["--import", "./relayer/src/ts-resolve.ts", "--test", "relayer/test/*.test.ts"]);
  const n = (k: string) => r.out.match(new RegExp(`ℹ ${k} (\\d+)`))?.[1] ?? "?";
  return [r.ok ? "PASS" : "FAIL", `node --test: ${n("pass")} pass, ${n("fail")} fail`];
});

// ---------------------------------------------------------------- chain (read-only; mainnet by default)
console.log(`\nchain checks: ${NET}, contract ${CONTRACT}, RPC ${RPC}`);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** base58 of the bytes given as hex (NEAR's code_hash = base58(sha256(wasm))) */
function base58Hex(hex: string): string {
  let n = BigInt(`0x${hex}`), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (let i = 0; i < hex.length && hex.slice(i, i + 2) === "00"; i += 2) s = `1${s}`;
  return s;
}
async function rpc<T>(params: Record<string, unknown>, tries = 4): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429 && tries > 1) {
    // the free public RPC rate-limits bursts: back off and retry
    await new Promise((r) => setTimeout(r, 1500 * (5 - tries)));
    return rpc<T>(params, tries - 1);
  }
  const j = (await res.json()) as { result?: T & { error?: string }; error?: { cause?: { name?: string }; message?: string } };
  if (j.error) throw new Error(j.error.cause?.name ?? j.error.message ?? "rpc error");
  if (j.result?.error) throw new Error(j.result.error);
  return j.result as T;
}
async function view<T>(method: string, args: unknown = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>({
    request_type: "call_function",
    account_id: CONTRACT,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}
const keyCount = async (account: string) =>
  (await rpc<{ keys: unknown[] }>({ request_type: "view_access_key_list", account_id: account })).keys.length;

let online = true;
try {
  await rpc({ request_type: "view_account", account_id: CONTRACT });
} catch (e) {
  online = !/fetch failed|timeout|abort|ENOTFOUND|ECONN|network/i.test(`${(e as Error).message} ${(e as Error).name}`);
}
const CHAIN_CLAIMS = [
  TESTNET ? `Contract ${CONTRACT} is deployed on testnet` : `Contract ${CONTRACT} is live on NEAR mainnet and runs the audited build (code hash = sha256 ${MAINNET_WASM_SHA256.slice(0, 12)}…)`,
  "Every bot fighter account has 0 access keys (only the contract's rules move its NOX)",
  "The latest settled match is recorded on chain with its input-log hash",
  TESTNET ? "Economy v2 mints nothing: total minted is unchanged since the v2 upgrade (only burns move supply)" : "Nothing is minted after genesis: total minted = 2,900 NOX and supply = minted − burned",
];
if (!online) {
  for (const c of CHAIN_CLAIMS) report("SKIP", c, `offline: ${RPC} unreachable`, 0);
} else {
  await check(CHAIN_CLAIMS[0], async () => {
    const a = await rpc<{ code_hash: string; storage_usage: number }>({ request_type: "view_account", account_id: CONTRACT });
    if (a.code_hash === "11111111111111111111111111111111") return ["FAIL", "account exists but has no contract code"];
    if (TESTNET) return ["PASS", `code_hash ${a.code_hash}, storage ${a.storage_usage} bytes`];
    // NEAR's code_hash is base58(sha256(wasm)): compare with the audited release build
    const want = base58Hex(MAINNET_WASM_SHA256);
    return a.code_hash === want
      ? ["PASS", `code_hash ${a.code_hash} = sha256 ${MAINNET_WASM_SHA256.slice(0, 16)}… (rebuild with node scripts/build-contract.ts to compare yourself)`]
      : ["FAIL", `code_hash ${a.code_hash} ≠ the audited build ${want}`];
  });
  await check(CHAIN_CLAIMS[1], async () => {
    const fighters = await view<{ account: string; name: string }[]>("get_fighters");
    // one at a time: the free public RPC rate-limits parallel bursts
    const counts: number[] = [];
    for (const f of fighters) {
      counts.push(await keyCount(f.account));
      await new Promise((r) => setTimeout(r, 250));
    }
    const keyed = fighters.flatMap((f, i) => (counts[i] > 0 ? [`${f.account} (${counts[i]} keys)`] : []));
    return keyed.length || !fighters.length
      ? ["FAIL", keyed.length ? `accounts with keys: ${keyed.join(", ")}` : "get_fighters() returned no fighters"]
      : ["PASS", `${fighters.length}/${fighters.length} bots keyless: ${fighters.map((f) => f.name).join(", ")}`];
  });
  await check(CHAIN_CLAIMS[2], async () => {
    const ms = await view<{ id: string; status: string; result: { input_log_hash?: string; winner: number | null } | null }[]>(
      "get_recent_matches",
      { n: 10 },
    );
    const settled = ms.find((m) => m.status === "Settled");
    if (!settled) return ["FAIL", `no settled match among the last ${ms.length}`];
    const h = settled.result?.input_log_hash ?? "";
    return h
      ? ["PASS", `match #${settled.id}: input_log_hash ${h.slice(0, 16)}…, winner idx ${settled.result?.winner}`]
      : ["FAIL", `match #${settled.id} is settled without an input_log_hash`];
  });

  await check(CHAIN_CLAIMS[3], async () => {
    const e = await view<{ minted: string; burned: string; supply: string }>("get_economy");
    const minted = BigInt(e.minted), burned = BigInt(e.burned), supply = BigInt(e.supply);
    const expect = TESTNET ? MINTED_AT_V2 : GENESIS;
    const ok = minted === expect && supply === minted - burned;
    return [ok ? "PASS" : "FAIL", `minted ${Number(minted / 10n ** 16n) / 100} (expected ${Number(expect / 10n ** 16n) / 100}${TESTNET ? " at the v2 upgrade" : " = genesis"}), burned ${Number(burned / 10n ** 16n) / 100}, supply = minted − burned: ${supply === minted - burned}`];
  });
}

const count = (s: Status) => results.filter((r) => r.status === s).length;
console.log(`\n${count("FAIL") ? "FAIL" : "PASS"}  ${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped`);
process.exitCode = count("FAIL") ? 1 : 0;
