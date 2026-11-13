import { describe, expect, it } from "vitest";
import { FIGHTERS, MATCH_TICKS, type FighterSpec, type Input, type Match, type MatchConfig, type SimEvent } from "./types";
import { FP, Rng, dist2, iatan2, icos, isin } from "./fixed";
import { createMatch } from "./match";
import { Recorder, replayRecord } from "./record";
import { botOnlyRoster, t1Roster } from "./roster";
import { botInput } from "./ai";
import { simulateBots } from "./headless";
import { FIGHTER_R, WEAPONS } from "./rules";

const NONE = new Map<number, Input>();

function allHuman(): FighterSpec[] {
  return t1Roster().map((f) => ({ ...f, human: true }));
}

/** A scripted, jittery "human" for fighter 0 (pseudo-random but reproducible). */
function scriptedHuman(seed: number) {
  const rng = new Rng(seed);
  let cur: Input = { mx: 0, my: 0, aim: 0, fire: false };
  return (tick: number): Input => {
    if (tick % 7 === 0) {
      const a = rng.below(4096);
      cur = { mx: Math.trunc((icos(a) * 1000) / 1024), my: Math.trunc((isin(a) * 1000) / 1024), aim: rng.below(4096), fire: rng.chance(60) };
      if (rng.chance(50)) cur.aimDist = rng.range(0, 12000);
    }
    return cur;
  };
}

function playLive(cfg: MatchConfig, human: (tick: number) => Input) {
  const m = createMatch(cfg);
  const rec = new Recorder();
  const hashes: string[] = [];
  while (!m.state.over) {
    const inp = human(m.state.tick);
    rec.push(m.state.tick, 0, inp);
    m.step(new Map([[0, inp]]));
    if (m.state.tick % 300 === 0) hashes.push(m.hash());
  }
  return { m, rec, hashes };
}

function runBots(seed: number): { m: Match; events: SimEvent[] } {
  const m = createMatch({ seed, fighters: botOnlyRoster() });
  const events: SimEvent[] = [];
  while (!m.state.over) events.push(...m.step(NONE));
  return { m, events };
}

describe("determinism", () => {
  it("same cfg + inputs -> same hash at every checkpoint", () => {
    const cfg = { seed: 12345, fighters: t1Roster() };
    const a = playLive(cfg, scriptedHuman(7));
    const b = playLive(cfg, scriptedHuman(7));
    expect(a.hashes).toEqual(b.hashes);
    expect(a.m.hash()).toBe(b.m.hash());
    expect(a.m.hash()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("different seeds give different matches", () => {
    expect(runBots(1).m.hash()).not.toBe(runBots(2).m.hash());
  });

  it("record -> replay reproduces hash, winner and placements", () => {
    for (const seed of [3, 99, 4242]) {
      const cfg = { seed, fighters: t1Roster() };
      const live = playLive(cfg, scriptedHuman(seed));
      const rep = replayRecord(cfg, live.rec.inputs);
      expect(rep.hash).toBe(live.m.hash());
      expect(rep.winner).toBe(live.m.state.winner);
      expect(rep.placements).toEqual(live.m.state.fighters.map((f) => f.placement));
      // the recorder only stores changes
      expect(live.rec.inputs.length).toBeLessThan(live.m.state.tick);
    }
  });

  it("autoplay (botInput for the human) is recordable and replayable", () => {
    const cfg = { seed: 777, fighters: t1Roster() };
    const m = createMatch(cfg);
    const rec = new Recorder();
    while (!m.state.over) {
      const inp = botInput(m, 0);
      rec.push(m.state.tick, 0, inp);
      m.step(new Map([[0, inp]]));
    }
    const rep = replayRecord(cfg, rec.inputs);
    expect(rep.hash).toBe(m.hash());
    expect(rep.winner).toBe(m.state.winner);
  });
});

describe("bot-only matches", () => {
  it("50 seeds: each ends within MATCH_TICKS with exactly one winner and valid placements", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { m, events } = runBots(seed);
      expect(m.state.over).toBe(true);
      expect(m.state.tick).toBeLessThanOrEqual(MATCH_TICKS);
      expect(m.state.winner).not.toBeNull();
      const pl = m.state.fighters.map((f) => f.placement).sort((a, b) => a - b);
      expect(pl).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(m.state.fighters[m.state.winner!].placement).toBe(1);
      expect(m.state.fighters.filter((f) => f.alive).length).toBe(1);
      expect(events.filter((e) => e.t === "win").length).toBe(1);
      const kills = events.filter((e) => e.t === "kill").length;
      if (m.state.tick < MATCH_TICKS) expect(kills).toBe(FIGHTERS - 1);
      else expect(kills).toBeLessThanOrEqual(FIGHTERS - 1);
    }
  }, 60_000);

  it("headless simulateBots matches a manual run", () => {
    const a = simulateBots(5);
    const { m } = runBots(5);
    expect(a.hash).toBe(m.hash());
    expect(a.winner).toBe(m.state.winner);
    expect(a.placements).toEqual(m.state.fighters.map((f) => f.placement));
  });

  it("bots actually fight: shots, hits, chests and kills by players", () => {
    const { events } = runBots(5);
    expect(events.some((e) => e.t === "shot")).toBe(true);
    expect(events.some((e) => e.t === "hit" && e.by >= 0)).toBe(true);
    expect(events.some((e) => e.t === "chest")).toBe(true);
    expect(events.some((e) => e.t === "kill" && e.by !== null)).toBe(true);
  });

  it("bounty carrier death emits a bounty event with the killer", () => {
    let seen = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { m, events } = runBots(seed);
      const carrier = m.state.fighters.findIndex((f) => f.bounty);
      const kill = events.find((e) => e.t === "kill" && e.who === carrier);
      const b = events.find((e) => e.t === "bounty");
      if (kill && kill.t === "kill" && kill.by !== null) {
        expect(b).toEqual({ t: "bounty", who: carrier, by: kill.by });
        seen++;
      } else expect(b).toBeUndefined();
    }
    expect(seen).toBeGreaterThan(0);
  }, 60_000);

  it("perf: a full 10-bot match runs headless well under 1 s", () => {
    runBots(1); // warm-up (JIT)
    const clock = (globalThis as unknown as { process: { hrtime: { bigint(): bigint } } }).process.hrtime; // Node-only test timer
    const t0 = clock.bigint();
    const { m } = runBots(31337);
    const ms = Number(clock.bigint() - t0) / 1e6;
    console.log(`[perf] bot match seed 31337: ${m.state.tick} ticks in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1000);
  });
});

describe("map generation", () => {
  it("fair layout across 300 seeds: spawns free, inside island, items reachable", () => {
    for (let seed = 0; seed < 300; seed++) {
      const m = createMatch({ seed, fighters: t1Roster() });
      const { map } = m;
      expect(map.spawns.length).toBe(FIGHTERS);
      expect(map.obstacles.length).toBeGreaterThanOrEqual(15);
      expect(map.bushes.length).toBeGreaterThanOrEqual(12);
      expect(m.state.chests.length).toBe(9);
      expect(m.state.heals.length).toBe(6);
      for (const s of map.spawns) {
        expect(s.x * s.x + s.y * s.y).toBeLessThan((map.radius - FIGHTER_R) ** 2);
        for (const o of map.obstacles) expect(dist2(s.x, s.y, o.x, o.y)).toBeGreaterThan((o.r + FIGHTER_R) ** 2);
        for (const b of map.bushes) expect(dist2(s.x, s.y, b.x, b.y)).toBeGreaterThan(b.r ** 2);
      }
      for (const it of [...m.state.chests, ...m.state.heals]) {
        expect(it.x * it.x + it.y * it.y).toBeLessThan((map.radius - 2 * FP) ** 2);
        for (const o of map.obstacles) expect(dist2(it.x, it.y, o.x, o.y)).toBeGreaterThan((o.r + FIGHTER_R + 500) ** 2);
      }
      // walkable gaps between obstacles
      for (let i = 0; i < map.obstacles.length; i++)
        for (let j = i + 1; j < map.obstacles.length; j++) {
          const a = map.obstacles[i], b = map.obstacles[j];
          expect(dist2(a.x, a.y, b.x, b.y)).toBeGreaterThan((a.r + b.r + 2 * FIGHTER_R + 200) ** 2);
        }
    }
  });

  it("same seed -> same map", () => {
    const a = createMatch({ seed: 9, fighters: t1Roster() });
    const b = createMatch({ seed: 9, fighters: t1Roster() });
    expect(JSON.stringify(a.map)).toBe(JSON.stringify(b.map));
    expect(JSON.stringify(a.state.chests)).toBe(JSON.stringify(b.state.chests));
  });
});

describe("rules", () => {
  it("storm kills idle fighters, emits storm + kill(by null, storm) events, one winner", () => {
    const m = createMatch({ seed: 2024, fighters: allHuman() });
    const ev: SimEvent[] = [];
    while (!m.state.over) ev.push(...m.step(NONE));
    expect(m.state.tick).toBeLessThanOrEqual(MATCH_TICKS);
    expect(ev.filter((e) => e.t === "storm").length).toBeGreaterThanOrEqual(2);
    const stormKills = ev.filter((e) => e.t === "kill" && e.by === null && e.weapon === "storm");
    expect(stormKills.length).toBeGreaterThan(0);
    expect(m.state.winner).not.toBeNull();
    expect(m.state.fighters.filter((f) => f.placement === 1).length).toBe(1);
  });

  it("grenades land at Input.aimDist (clamped to max range) and explode", () => {
    for (const [want, expectD] of [[4000, 4600], [undefined, 9600], [50000, 9600], [200, 1600]] as const) {
      const m = createMatch({ seed: 21, fighters: allHuman() });
      const f = m.state.fighters[0];
      f.x = 0; f.y = 0; f.weapon = "grenade"; f.ammo = 3;
      for (const o of m.state.fighters) if (o.idx !== 0) { o.x = 30000; o.y = 0; }
      m.map.obstacles.length = 0;
      const inp: Input = { mx: 0, my: 0, aim: 0, fire: true };
      if (want !== undefined) inp.aimDist = want;
      let boom: SimEvent | undefined;
      for (let i = 0; i < 30 && !boom; i++) {
        boom = m.step(new Map([[0, i === 0 ? inp : { mx: 0, my: 0, aim: 0, fire: false }]])).find((e) => e.t === "explode");
      }
      expect(boom && boom.t === "explode").toBe(true);
      if (boom && boom.t === "explode") expect(Math.abs(boom.x - expectD)).toBeLessThan(150);
    }
  });

  it("walking into a chest opens it and gives its weapon with full ammo", () => {
    const m = createMatch({ seed: 55, fighters: allHuman() });
    const c = m.state.chests[0];
    const f = m.state.fighters[0];
    f.x = c.x - 2500;
    f.y = c.y;
    let got: SimEvent | undefined;
    for (let i = 0; i < 20 && !got; i++) {
      const a = iatan2(c.y - f.y, c.x - f.x);
      got = m.step(new Map([[0, { mx: Math.trunc((icos(a) * 1000) / 1024), my: Math.trunc((isin(a) * 1000) / 1024), aim: 0, fire: false }]])).find((e) => e.t === "chest");
    }
    expect(got).toEqual({ t: "chest", who: 0, chest: c.id, weapon: c.weapon });
    expect(c.open).toBe(true);
    expect(f.weapon).toBe(c.weapon);
    expect(f.ammo).toBe(WEAPONS[c.weapon].mag);
  });

  it("bushes hide fighters unless close, recently shooting or recently hurt", () => {
    const m = createMatch({ seed: 77, fighters: allHuman() });
    const bush = m.map.bushes[0];
    const [a, b] = [m.state.fighters[0], m.state.fighters[1]];
    b.x = bush.x;
    b.y = bush.y;
    a.x = bush.x + 8 * FP;
    a.y = bush.y;
    // keep a outside obstacles for this check (collision may nudge it; that's fine)
    m.step(NONE);
    expect(b.inBush).toBe(true);
    expect(m.canSee(1, 1)).toBe(true);
    if (dist2(a.x, a.y, b.x, b.y) > 2600 * 2600) expect(m.canSee(0, 1)).toBe(false);
    expect(m.canSee(1, 0)).toBe(!a.inBush || dist2(a.x, a.y, b.x, b.y) <= 2500 * 2500);
    // shooting reveals
    m.step(new Map([[1, { mx: 0, my: 0, aim: 2048, fire: true }]]));
    expect(b.lastShotTick).toBe(m.state.tick);
    expect(m.canSee(0, 1)).toBe(true);
    // ... for 20 ticks only
    for (let i = 0; i < 22; i++) m.step(NONE);
    if (dist2(a.x, a.y, b.x, b.y) > 2600 * 2600) expect(m.canSee(0, 1)).toBe(false);
    // close range reveals
    a.x = b.x + 2000;
    a.y = b.y;
    expect(m.canSee(0, 1)).toBe(true);
  });

  it("bots never target what they cannot see (no bush hacks)", () => {
    // A hidden, idle human in a bush far from everyone should take no bullet damage from bots
    // until it reveals itself; checked over many ticks.
    const roster = t1Roster();
    const m = createMatch({ seed: 4, fighters: roster });
    const bush = m.map.bushes.reduce((best, b) => (b.r > best.r ? b : best), m.map.bushes[0]);
    const me = m.state.fighters[0];
    let hiddenHits = 0;
    for (let i = 0; i < 400 && !m.state.over; i++) {
      me.x = bush.x;
      me.y = bush.y;
      me.hp = 100;
      const ev = m.step(new Map([[0, { mx: 0, my: 0, aim: 0, fire: false }]]));
      // a bot can only hit us if it was within 2.5 u (reveal) or we were hurt <10 ticks ago (chain)
      for (const e of ev) if (e.t === "hit" && e.who === 0 && e.by >= 0) {
        const s = m.state.fighters[e.by];
        if (dist2(s.x, s.y, me.x, me.y) > 14 * FP * 14 * FP) hiddenHits++;
      }
    }
    expect(hiddenHits).toBe(0);
  });

  it("damage, armor and weapon tier scale hits; heals cap at max hp", () => {
    const roster = allHuman();
    roster[1] = { ...roster[1], upgrades: { weaponTier: 0, armor: 2, skin: 1 } };
    const m = createMatch({ seed: 8, fighters: roster });
    const [a, b] = [m.state.fighters[0], m.state.fighters[1]];
    // put them in the open, 3 u apart, a shooting at b
    a.x = 0; a.y = 0; b.x = 3000; b.y = 0;
    m.map.obstacles.length = 0; // test-only: clear line of fire
    let hit: SimEvent | undefined;
    for (let i = 0; i < 10 && !hit; i++) hit = m.step(new Map([[0, { mx: 0, my: 0, aim: 0, fire: true }]])).find((e) => e.t === "hit");
    expect(hit && hit.t === "hit" && hit.who).toBe(1);
    if (hit && hit.t === "hit") expect(hit.dmg).toBe(hit.crit ? 18 - 4 : 12 - 4);
    const h = m.state.heals[0];
    b.hp = 90;
    b.x = h.x; b.y = h.y;
    const ev = m.step(NONE);
    expect(ev.find((e) => e.t === "heal")).toEqual({ t: "heal", who: 1, amount: 10 });
    expect(b.hp).toBe(100);
  });
});
