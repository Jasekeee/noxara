// Determinism suite: the match result must be a pure function of (cfg, human input log).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MatchConfig, MatchRecord } from "../../src/sim/types";
import { createMatch } from "../../src/sim/match";
import { botInput } from "../../src/sim/ai";
import { Recorder, replayRecord } from "../../src/sim/record";
import { t1Roster } from "../../src/sim/roster";
import { botRoster, runMatch, scriptedInput, toRecord, type Sim } from "../../tools/simlib";

const sim: Sim = { createMatch, botInput, Recorder, replayRecord, t1Roster };
const SIM_DIR = fileURLToPath(new URL("../../src/sim", import.meta.url));
/** Agent B's placeholder files start with a "STUB" comment; checks that need the real sim skip them. */
const isStub = (file: string) => /^\/\/.*\bSTUB\b/.test(readFileSync(join(SIM_DIR, file), "utf8").split("\n", 1)[0]);
const stubSim = ["match.ts", "record.ts"].some(isStub);
const stubMsg = "(skipped: src/sim match.ts/record.ts are still the stubs; runs after the real sim merges)";

const SAMPLE = 100;
function hashTrace(cfg: MatchConfig, human = scriptedInput): string[] {
  const trace: string[] = [];
  const m = createMatch(structuredClone(cfg));
  runMatch(m, { human, onTick: (mm) => mm.state.tick % SAMPLE === 0 && trace.push(`${mm.state.tick}:${mm.hash()}`) });
  trace.push(`end ${m.state.tick}:${m.hash()}`);
  return trace;
}

describe("same config → same simulation", () => {
  for (const seed of [1, 7, 4242]) {
    it(`seed ${seed}, scripted human: identical hash every ${SAMPLE} ticks`, () => {
      const cfg: MatchConfig = { seed, fighters: t1Roster() };
      const a = hashTrace(cfg);
      expect(a.length).toBeGreaterThan(1);
      expect(hashTrace(cfg)).toEqual(a);
    });
  }

  it("bot-only match (idx 0 is a bot): identical hash every 100 ticks", () => {
    const cfg: MatchConfig = { seed: 99, fighters: botRoster(sim, "aggressive") };
    expect(hashTrace(cfg)).toEqual(hashTrace(cfg));
  });

  it("two matches stepped interleaved equal two matches run alone (no shared module state)", () => {
    const cfgA: MatchConfig = { seed: 11, fighters: t1Roster() };
    const cfgB: MatchConfig = { seed: 12, fighters: t1Roster() };
    const soloA = hashTrace(cfgA);
    const soloB = hashTrace(cfgB);
    const a = createMatch(structuredClone(cfgA));
    const b = createMatch(structuredClone(cfgB));
    const ta: string[] = [];
    const tb: string[] = [];
    const step = (m: typeof a, t: string[]) => {
      const inp = new Map();
      if (m.state.fighters[0].alive) inp.set(0, scriptedInput(m, 0));
      m.step(inp);
      if (m.state.tick % SAMPLE === 0) t.push(`${m.state.tick}:${m.hash()}`);
    };
    for (let i = 0; i < 3600 && !(a.state.over && b.state.over); i++) {
      if (!a.state.over) step(a, ta);
      if (!b.state.over) step(b, tb);
    }
    expect(ta).toEqual(soloA.slice(0, ta.length));
    expect(tb).toEqual(soloB.slice(0, tb.length));
  });

  it.skipIf(stubSim)(`different seeds diverge ${stubSim ? stubMsg : ""}`, () => {
    const a = hashTrace({ seed: 1, fighters: t1Roster() });
    const b = hashTrace({ seed: 2, fighters: t1Roster() });
    expect(a[0]).not.toEqual(b[0]);
  });

  it("hash is a hex string", () => {
    expect(createMatch({ seed: 5, fighters: t1Roster() }).hash()).toMatch(/^[0-9a-f]+$/);
  });
});

describe("record → replay reproduces the match", () => {
  const cases: [string, typeof scriptedInput][] = [
    ["scripted human", scriptedInput],
    ["autoplay human (botInput, like ?autoplay)", botInput],
  ];
  for (const [label, human] of cases) {
    it.skipIf(stubSim)(`${label} ${stubSim ? stubMsg : ""}`, () => {
      for (const seed of [3, 17]) {
        const cfg: MatchConfig = { seed, fighters: t1Roster() };
        const rec = new Recorder();
        const run = runMatch(createMatch(structuredClone(cfg)), { human, recorder: rec });
        expect(run.over, `seed ${seed} finished within MATCH_TICKS`).toBe(true);
        // round-trip through JSON, exactly like matches/<id>.json
        const stored = JSON.parse(JSON.stringify(toRecord(cfg, rec.inputs, run))) as MatchRecord;
        const replay = replayRecord(stored.cfg, stored.inputs);
        expect(replay.hash).toBe(stored.hash);
        expect(replay.winner).toBe(stored.winner);
        expect(replay.placements).toEqual(stored.placements);
      }
    });
  }

  it("Recorder only stores input changes", () => {
    const rec = new Recorder();
    const i = { mx: 1000, my: 0, aim: 7, fire: true };
    rec.push(0, 0, i);
    rec.push(1, 0, { ...i });
    rec.push(2, 0, { ...i, fire: false });
    expect(rec.inputs).toEqual([
      [0, 0, 1000, 0, 7, 1],
      [2, 0, 1000, 0, 7, 0],
    ]);
  });
});

describe("src/sim uses only deterministic primitives", () => {
  const BANNED: [string, RegExp][] = [
    ["Math.random", /\bMath\.random\b/],
    ["Math.sin", /\bMath\.sin\b/],
    ["Math.cos", /\bMath\.cos\b/],
    ["Math.tan", /\bMath\.tan\b/],
    ["Math.atan2", /\bMath\.atan2\b/],
    ["Math.atan/asin/acos", /\bMath\.a(?:tan|sin|cos)h?\b/],
    ["Math.exp/log/hypot/cbrt", /\bMath\.(?:exp|expm1|log|log2|log10|log1p|hypot|cbrt)\b/],
    ["Date", /\bDate\b/],
    ["performance", /\bperformance\b/],
    ["crypto", /\bcrypto\b/],
  ];
  /** Remove comments so documentation like "never use Math.random" doesn't trip the scan. */
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const files = readdirSync(SIM_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const real = files.filter((f) => !isStub(f));

  it("finds the sim sources", () => {
    expect(files).toContain("fixed.ts");
    expect(files).toContain("types.ts");
    const stubs = files.filter(isStub);
    if (stubs.length) console.warn(`determinism scan skips stub files: ${stubs.join(", ")}`);
  });

  for (const file of real) {
    it(`${file} has no nondeterministic calls`, () => {
      const code = stripComments(readFileSync(join(SIM_DIR, file), "utf8"));
      const hits = BANNED.flatMap(([name, re]) =>
        code.split("\n").flatMap((line, i) => (re.test(line) ? [`${file}:${i + 1} ${name}: ${line.trim()}`] : [])),
      );
      expect(hits).toEqual([]);
    });
  }
});
