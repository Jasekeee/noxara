// Option B (fallback if mainnet stays minimal): the daily mainnet anchor record for one UTC day.
// Reads the TESTNET game contract (read-only): every match settled that day -> sha256 over "id:input_log_hash\n"
// lines in id order, plus an economy snapshot. Prints the exact bytes that `anchor` on the mainnet anchor
// contract (contracts/anchor) would store, and the storage cost. It never signs or sends anything: writing
// is a separate, owner-approved step (a function-call key on the anchor account limited to `anchor`).
//   node scripts/anchor-daily.ts [--day 2026-11-14] [--contract royale.br-7e8492.testnet]
import { createHash } from "node:crypto";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const day = arg("day", new Date().toISOString().slice(0, 10));
const contract = arg("contract", "royale.br-7e8492.testnet");
const rpc = arg("rpc", "https://test.rpc.fastnear.com");
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--day YYYY-MM-DD");

async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
  });
  const j = (await r.json()) as { result?: { result: number[] }; error?: unknown };
  if (!j.result) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return JSON.parse(Buffer.from(j.result.result).toString()) as T;
}

type M = { id: string; status: string; start_ms: string; result: { input_log_hash?: string } | null };
const from = Date.parse(`${day}T00:00:00Z`), to = from + 86_400_000;
const recent = await view<M[]>("get_recent_matches", { n: 200 });
const settled = recent
  .filter((m) => m.status === "Settled" && Number(m.start_ms) >= from && Number(m.start_ms) < to && m.result?.input_log_hash)
  .sort((a, b) => Number(a.id) - Number(b.id));
const lines = settled.map((m) => `${m.id}:${m.result!.input_log_hash}\n`).join("");
const root = createHash("sha256").update(lines).digest("hex");
const e = await view<{ supply: string; burned: string; house: string; m_bps: number; season: number }>("get_economy", {});
const nox = (y: string) => (Number(BigInt(y) / 10n ** 16n) / 100).toFixed(2);
const record = JSON.stringify({
  v: 1,
  testnet: contract,
  matches: settled.length,
  first: settled[0]?.id ?? null,
  last: settled.at(-1)?.id ?? null,
  root, // sha256 of "id:input_log_hash\n" for every match settled that UTC day, in id order
  supply: nox(e.supply),
  burned: nox(e.burned),
  house: nox(e.house),
  m_bps: e.m_bps,
  season: e.season,
});
const bytes = day.length + record.length;
console.log(JSON.stringify({ day, record, input_bytes: bytes, storage_near: +(((record.length + day.length + 40) * 1e-5)).toFixed(5), note: "dry run: nothing signed or sent" }, null, 2));
