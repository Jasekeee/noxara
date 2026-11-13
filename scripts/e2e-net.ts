// Live end-to-end through the GAME's client (src/net/client.ts), exactly as the browser uses it.
//   node --env-file=.env --import ./relayer/src/ts-resolve.ts scripts/e2e-net.ts [--matches 3]
import { createGameClient } from "../src/net/client.ts";
import { createMatch } from "../src/sim/match.ts";
import { botInput } from "../src/sim/ai.ts";
import { Recorder } from "../src/sim/record.ts";
import { MATCH_TICKS, type MatchRecord } from "../src/sim/types.ts";

const i = process.argv.indexOf("--matches");
const n = i > 0 ? Number(process.argv[i + 1]) : 2;
const c = await createGameClient({ relayer: "http://127.0.0.1:8788", contract: process.env.GAME_CONTRACT_ID });
console.log("mode:", c.mode);
let t = performance.now();
console.log("account:", await c.account(), `${Math.round(performance.now() - t)} ms`);
for (let k = 0; k < n; k++) {
  t = performance.now();
  const s = await c.startMatch();
  console.log(`start ${s.matchId}: seed ${s.cfg.seed}, pot ${s.pot}, bounty idx ${s.bountyIdx} worth ${s.bountyValue}, ${Math.round(performance.now() - t)} ms, tx ${s.tx}`);
  const m = createMatch(s.cfg);
  const rec = new Recorder();
  while (!m.state.over && m.state.tick < MATCH_TICKS) {
    const inp = botInput(m, 0);
    rec.push(m.state.tick, 0, inp);
    m.step(new Map([[0, inp]]));
  }
  const record: MatchRecord = { version: 1, cfg: s.cfg, inputs: rec.inputs, hash: m.hash(), winner: m.state.winner, placements: m.state.fighters.map((f) => f.placement) };
  t = performance.now();
  const r = await c.settle(s.matchId, record);
  console.log(`settle: ${Math.round(performance.now() - t)} ms`, JSON.stringify(r));
}
for (const f of await c.fighters()) console.log(`${f.name.padEnd(9)} ${String(f.balance).padStart(7)} ${f.bounty ? `BOUNTY(${f.bountyValue})` : ""} w${f.upgrades.weaponTier}a${f.upgrades.armor} gen${f.generation} ${JSON.stringify(f.record)}`);
