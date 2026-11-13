# Balance

Gate (CLAUDE.md, T2): 1,000 headless bot-only matches, **no personality wins more than 40 %**, and every
match finishes within `MATCH_TICKS` (3,600 ticks = 180 s).

```sh
npm run sim -- 1000 --json docs/balance.json      # = node tools/headless.ts 1000 --json docs/balance.json
node tools/headless.ts 200 --from 5001 --p0 sniper   # other seeds / personality for idx 0
```

## Setup
- Roster = `t1Roster()` with idx 0 ("You") turned into a bot (`human: false`, personality `--p0`,
  default `balanced`). Every fighter is driven by the sim's own AI; no human inputs.
- Seeds `from .. from+N-1` (default 1..N). Each match runs until `state.over` or `MATCH_TICKS`.

## Metrics
| Metric | Definition |
|---|---|
| fighters/match | how many of the 10 slots have this personality |
| win share | % of finished matches won by a fighter of this personality — **the 40 % gate** |
| win/fighter | wins ÷ (fighter-matches of this personality); fair share is 10 % — compare personalities with different slot counts |
| avg kills | kills credited per fighter per match (kill events with `by` ≠ null, not suicides) |
| avg match length | mean final tick ÷ 20 Hz over finished matches |
| storm deaths | % of all deaths whose kill event is `weapon: "storm"` (or `by: null`) |
| ended by clock | % of finished matches that ended with more than one fighter alive |
| matches/s | headless throughput on this machine (the verifier / match server budget) |

`FAIL` lines (exit code 1): a personality's win share > 40 %; any match not over after `MATCH_TICKS`.
Note: a personality that fills many slots wins more often by count — if the roster has, say, 3+ fighters
of one personality, check win/fighter before re-tuning.

## Results (2026-11-13 16:55 UTC, main d0425f9, 1,000 matches, seeds 1..1000, idx 0 = balanced) — **PASS**
| personality | fighters/match | win share | win/fighter | avg kills |
|---|---|---|---|---|
| balanced | 3 | 30.3 % | 10.1 % | 0.78 |
| camper | 2 | 20.2 % | 10.1 % | 0.77 |
| aggressive | 2 | 15.5 % | 7.8 % | 1.05 |
| coward | 1 | 15.1 % | 15.1 % | 0.73 |
| looter | 1 | 11.0 % | 11.0 % | 0.80 |
| sniper | 1 | 7.9 % | 7.9 % | 0.84 |

1000/1000 finished · avg match length 134.2 s · storm deaths 7.2 % of 9,000 · ended by clock 0 % ·
determinism spot-check same hash twice · 25.8 matches/s. Raw: `docs/balance.json`.

Reading: no personality is near the 40 % gate. Per fighter, **coward** over-performs (15 % vs a fair
10 %: it survives to the end by avoiding fights) and **sniper**/**aggressive** under-perform (≈8 %);
aggressive gets the most kills but dies more. The 300-match run in `npm run verify` shows the same order.
