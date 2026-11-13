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

## Results
_Pending the real simulation (Agent B). Against the stub every match times out (`0/N finished`)._

| personality | fighters/match | win share | win/fighter | avg kills |
|---|---|---|---|---|
| — | — | — | — | — |

Avg match length: — · storm deaths: — · ended by clock: — · speed: — matches/s
