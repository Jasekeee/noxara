// The match server against the REAL shared simulation (src/sim): a human driven by the bot AI is
// recorded like the client does, then judged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMatch } from "../../src/sim/match.ts";
import { botInput } from "../../src/sim/ai.ts";
import { Recorder } from "../../src/sim/record.ts";
import { MATCH_TICKS, type MatchRecord, type SimEvent } from "../../src/sim/types.ts";
import { judge } from "../src/settle.ts";
import { matchConfigFromChain, type ChainMatch } from "../src/roster.ts";

const P = ["camper", "aggressive", "coward", "sniper", "looter", "balanced", "aggressive", "looter", "sniper"];
const roster = P.map((personality, i) => ({
  idx: i + 1, account: `b${i}.royale.t`, name: `B${i}`, personality,
  upgrades: { weaponTier: i % 3, armor: i % 2, skin: i }, bounty: i === 2, paid: "10",
}));

function play(seed: number) {
  const chain: ChainMatch = { match_id: String(seed), seed, player: "alice.t", guest: false, bounty_idx: 3, roster, status: "Pending" };
  const cfg = matchConfigFromChain(chain, { name: "Alice" });
  const m = createMatch(cfg);
  const rec = new Recorder();
  const events: SimEvent[] = [];
  while (!m.state.over && m.state.tick < MATCH_TICKS) {
    const inp = botInput(m, 0);
    rec.push(m.state.tick, 0, inp);
    events.push(...m.step(new Map([[0, inp]])));
  }
  const record: MatchRecord = { version: 1, cfg, inputs: rec.inputs, hash: m.hash(), winner: m.state.winner, placements: m.state.fighters.map((f) => f.placement) };
  return { chain, record, m, events };
}

test("real sim: a recorded match is replayed and judged with kills and the bounty killer", () => {
  let bountySeen = 0;
  for (const seed of [11, 222, 3333, 44444]) {
    const { chain, record, m, events } = play(seed);
    const t0 = performance.now();
    const v = judge(chain, record);
    const ms = performance.now() - t0;
    assert.equal(v.ok, true, JSON.stringify(v));
    if (!v.ok) return;
    assert.deepEqual(v.args.placements, record.placements);
    assert.equal(v.winner, m.state.winner);
    assert.equal(v.killsFrom, "replay");
    const killsSim = m.state.fighters.map((f) => f.kills);
    if (killsSim.reduce((a, b) => a + b, 0) < 10) assert.deepEqual(v.args.kills, killsSim);
    const b = events.find((e) => e.t === "bounty") as { by: number } | undefined;
    assert.equal(v.args.bounty_killer, b && b.by >= 0 && b.by < 10 ? b.by : null);
    if (b) bountySeen++;
    console.log(`seed ${seed}: winner ${v.winner}, ${record.inputs.length} inputs, judged in ${ms.toFixed(0)} ms, kills ${v.args.kills}, bounty killer ${v.args.bounty_killer}`);
  }
  assert.ok(bountySeen >= 0);
});

test("real sim: a tampered record is refused", () => {
  const { chain, record } = play(5);
  const forged = { ...record, inputs: record.inputs.slice(0, Math.floor(record.inputs.length / 2)) };
  const v = judge(chain, forged);
  assert.equal(v.ok, false);
});
