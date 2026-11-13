// Live end-to-end against a running relayer/match server (testnet):
//   guest account -> start_match (NEP-366 via the relayer) -> play (headless, the shared sim) ->
//   signed record -> /api/settle (server replays, then settle_match) -> on-chain result.
//
//   node --env-file=.env --import ./relayer/src/ts-resolve.ts scripts/e2e.ts [--relayer http://127.0.0.1:8788] [--matches 1]
import { Session, view, matchConfigFromChain, type ChainConfig } from "../relayer/src/client.ts";
import { Recorder } from "../src/sim/record.ts";
import { createMatch } from "../src/sim/match.ts";
import { botInput } from "../src/sim/ai.ts";
import { MATCH_TICKS, type MatchRecord } from "../src/sim/types.ts";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const cfg: ChainConfig = {
  network: (process.env.NEAR_NETWORK ?? "testnet") as "testnet",
  rpc: process.env.NEAR_RPC ?? "https://test.rpc.fastnear.com",
  relayer: arg("relayer", "http://127.0.0.1:8788"),
  game: process.env.GAME_CONTRACT_ID!,
};
const n = Number(arg("matches", "1"));

const t0 = performance.now();
const s = await Session.createGuest(cfg);
console.log(`guest ${s.accountId} in ${Math.round(performance.now() - t0)} ms (tx ${s.lastTx})`);
for (let i = 0; i < n; i++) {
  const t1 = performance.now();
  const m = await s.startMatch();
  console.log(`match ${m.match_id}: seed ${m.seed}, bounty idx ${m.bounty_idx}, ${Math.round(performance.now() - t1)} ms (tx ${s.lastTx})`);
  const matchCfg = matchConfigFromChain(m, { name: "E2E" });
  // the "human" is played by the bot AI (like ?autoplay) and recorded the way the client does
  const match = createMatch(matchCfg);
  const rec = new Recorder();
  while (!match.state.over && match.state.tick < MATCH_TICKS) {
    const inp = botInput(match, 0);
    rec.push(match.state.tick, 0, inp);
    match.step(new Map([[0, inp]]));
  }
  const record: MatchRecord = { version: 1, cfg: matchCfg, inputs: rec.inputs, hash: match.hash(), winner: match.state.winner, placements: match.state.fighters.map((f) => f.placement) };
  console.log(`  played: winner idx ${record.winner} (${record.winner === 0 ? "you" : matchCfg.fighters[record.winner ?? 0]?.name}), ${record.inputs.length} inputs`);
  const t2 = performance.now();
  const out = await s.settle(m.match_id, record);
  console.log(`settled in ${Math.round(performance.now() - t2)} ms (tx ${out.tx}):`, JSON.stringify(out.result));
}
const fighters = await view<Array<{ name: string; balance: string; upgrades: unknown; record: unknown; bounty: boolean }>>(cfg, "get_fighters");
for (const f of fighters) console.log(`${f.name.padEnd(8)} ${(Number(BigInt(f.balance) / 10n ** 16n) / 100).toFixed(2).padStart(8)} $BOUNTY ${f.bounty ? "BOUNTY " : ""}${JSON.stringify(f.upgrades)} ${JSON.stringify(f.record)}`);
