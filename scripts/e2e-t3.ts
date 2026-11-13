// Live T3 run through the game client against testnet: a REAL account signs in (we play the wallet's
// part: add the game's function-call key), gets $BOUNTY from house_grant (owner, testing only),
// sponsors a bot, plays paid matches, and reads progress / market / leaderboards / history.
//   node --env-file=.env --import ./relayer/src/ts-resolve.ts scripts/e2e-t3.ts --relayer http://127.0.0.1:8798 [--matches 2]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Near, InMemoryKeyStore, generateKey as nkGenerate } from "near-kit";
import { createGameClient } from "../src/net/client.ts";
import { generateKey } from "../src/net/near.ts";
import type { GameClientT3 } from "../src/net/api.ts";
import { createMatch } from "../src/sim/match.ts";
import { botInput } from "../src/sim/ai.ts";
import { Recorder } from "../src/sim/record.ts";
import { MATCH_TICKS, type MatchRecord } from "../src/sim/types.ts";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
// a browser-like localStorage for the client
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
} as Storage;

const root = arg("root", "br-7e8492.testnet");
const contract = process.env.GAME_CONTRACT_ID!;
const rootKey = JSON.parse(fs.readFileSync(path.join(os.homedir(), `.near-credentials/testnet/${root}.json`), "utf8")).private_key as string;
const player = `p${Date.now().toString(36)}.${root}`;
const full = nkGenerate();
const near = new Near({ network: "testnet", rpcUrl: "https://test.rpc.fastnear.com", keyStore: new InMemoryKeyStore({ [root]: rootKey, [player]: full.secretKey }) });

// 1. a real account (the player's own wallet in real life)
let t = await near.transaction(root).createAccount(player).transfer(player, "0.5 NEAR").addKey(full.publicKey.toString(), { type: "fullAccess" }).send({ waitUntil: "FINAL" });
console.log("real account", player, "tx", t.transaction.hash);
// 2. what the wallet does on sign-in: add the game's function-call key (one approval)
const game = await generateKey();
localStorage.setItem("bountyroyale.signin.v1", JSON.stringify({ key: game, contract }));
t = await near
  .transaction(player)
  .addKey(game.publicKey, { type: "functionCall", receiverId: contract, methodNames: ["start_match", "sweep_match", "sponsor", "unsponsor"], allowance: "0.25 NEAR" })
  .send({ waitUntil: "FINAL" });
console.log("wallet adds the function-call key, tx", t.transaction.hash);
// 3. back in the game
const c = (await createGameClient({ relayer: arg("relayer", "http://127.0.0.1:8788"), contract })) as GameClientT3 & { finishSignIn(a: string, pk: string): Promise<void> };
console.log("mode", c.mode, c.offlineReason ?? "");
await c.finishSignIn(player, game.publicKey);
console.log("signed in:", await c.account(), "guest?", c.isGuest());
// 4. testing on-ramp: the owner grants from the house
t = await near.transaction(root).functionCall(contract, "house_grant", { account_id: player, amount: (60n * 10n ** 18n).toString() }, { gas: "20 Tgas" }).send({ waitUntil: "FINAL" });
console.log("house_grant 60, tx", t.transaction.hash, "balance", await c.balance());
// 5. sponsor the bot with the most wins
const market = await c.market();
const fighters = (await c.fighters()).filter((f) => f.status === "active").sort((a, b) => b.record.wins - a.record.wins);
const bot = fighters[0];
console.log("market sample:", JSON.stringify(market.slice(0, 2)));
const sp = await c.sponsor(bot.account, 20);
console.log(`sponsored ${bot.name} with 20, tx ${sp.tx}`, JSON.stringify(await c.mySponsorships()));
try {
  await c.unsponsor(bot.account);
} catch (e) {
  console.log("unsponsor too early ->", (e as Error).message);
}
try {
  await c.sponsor(bot.account, 1000);
} catch (e) {
  console.log("sponsor too much ->", (e as Error).message);
}
// 6. paid matches as the real account
for (let k = 0; k < Number(arg("matches", "2")); k++) {
  const started = performance.now();
  const s = await c.startMatch();
  const m = createMatch(s.cfg);
  const rec = new Recorder();
  while (!m.state.over && m.state.tick < MATCH_TICKS) {
    const inp = botInput(m, 0);
    rec.push(m.state.tick, 0, inp);
    m.step(new Map([[0, inp]]));
  }
  const record: MatchRecord = { version: 1, cfg: s.cfg, inputs: rec.inputs, hash: m.hash(), winner: m.state.winner, placements: m.state.fighters.map((f) => f.placement) };
  // the match server refuses records faster than real time (audit #9): wait like a real player would
  const playMs = m.state.tick * 50;
  const waitMs = Math.max(0, playMs * 0.9 - (performance.now() - started) + 2_000);
  console.log(`  played ${Math.round(playMs / 1000)} s of game time; waiting ${Math.round(waitMs / 1000)} s (real time)`);
  await new Promise((r) => setTimeout(r, waitMs));
  const r = await c.settle(s.matchId, record);
  console.log(`match ${s.matchId}: paid ${s.playerPaid}, you L${s.cfg.fighters[0].upgrades.weaponTier}/${s.cfg.fighters[0].upgrades.armor}/${s.cfg.fighters[0].upgrades.skin}, winner ${r.winner}, verified ${r.verified}, start ${s.tx}, settle ${r.tx}`);
}
console.log("balance", await c.balance(), "progress", JSON.stringify(await c.progress()));
console.log("my sponsorships", JSON.stringify(await c.mySponsorships()));
console.log("players top:", JSON.stringify((await c.leaderboard("players")).slice(0, 3)));
console.log("bots top:", JSON.stringify((await c.leaderboard("bots")).slice(0, 2)));
console.log(`${bot.name} history:`, JSON.stringify((await c.history(bot.account)).slice(0, 4)));
const retired = (await c.fighters()).filter((f) => f.status === "retired").map((f) => f.name);
console.log("hall of the broke:", retired.join(", "));
