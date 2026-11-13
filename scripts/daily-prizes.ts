// DRY RUN ONLY: prints who would get a daily-tournament prize and the exact testnet commands the OWNER
// can run. It never sends a transaction and never reads a key. Play-money only (NOX on testnet).
//   node scripts/daily-prizes.ts [YYYY-MM-DD]        (default: yesterday, UTC)
//   env: GAME_CONTRACT_ID (default royale.br-7e8492.testnet), OWNER_ACCOUNT_ID (the contract owner)
// Only entries marked kind "real" (a valid ed25519 signature by a key of that NEAR account, checked by
// the server) are eligible. Guests and "unverified" entries never earn. `house_grant` is owner-only,
// capped at 100 NOX per call, refuses guests and unregistered accounts, and can't take the House below
// its floor (contracts/royale/src/lib.rs): a refused grant is just a failed command.
import fs from "node:fs";
import path from "node:path";

const ONE = 10n ** 18n; // 1 NOX in contract units
const PRIZES_NOX = [100n, 50n, 25n]; // each <= MAX_GRANT (100 NOX)
const contract = process.env.GAME_CONTRACT_ID ?? "royale.br-7e8492.testnet";
const owner = process.env.OWNER_ACCOUNT_ID ?? "<OWNER_ACCOUNT>";
const day = process.argv[2] ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("day must be YYYY-MM-DD");

type Entry = { key: string; name: string; kind: "real" | "guest" | "unverified"; account?: string; placement: number; kills: number; ticksSurvived: number; at: number };
const file = path.join(import.meta.dirname, "../relayer/data/daily", `${day}.json`);
if (!fs.existsSync(file)) {
  console.log(`no leaderboard file for ${day} (${file})`);
  process.exit(0);
}
const d = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Record<string, Entry> };
const all = Object.values(d.entries).sort((a, b) => a.placement - b.placement || b.kills - a.kills || b.ticksSurvived - a.ticksSurvived || a.at - b.at);
const eligible = all.filter((e) => e.kind === "real" && e.account);
console.log(`Daily ${day}: ${all.length} entries, ${eligible.length} verified real accounts (guests/unverified excluded)`);
console.log("DRY RUN: nothing is sent.\n");
eligible.slice(0, 3).forEach((e, i) => {
  const amount = PRIZES_NOX[i] * ONE;
  console.log(`#${i + 1} ${e.account}: placement ${e.placement}/10, ${e.kills} kills, ${(e.ticksSurvived / 20).toFixed(0)} s alive -> ${PRIZES_NOX[i]} NOX`);
  console.log(
    `  near contract call-function as-transaction ${contract} house_grant json-args '{"account_id":"${e.account}","amount":"${amount}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${owner} network-config testnet sign-with-keychain send`,
  );
});
if (!eligible.length) console.log("nobody to pay: no verified real account played that day.");
