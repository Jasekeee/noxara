# QA — how to run every check and what it proves

Owner: Agent D (`tests/**`, `tools/**`, `playwright.config.ts`, `vitest.config.ts`). All tools run on
Node 24 directly (`node tools/x.ts`, type stripping). Dev/preview servers use **port 5184** only.

| Check | Command | Proves | Needs |
|---|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | src, tools and tests compile under `strict` | — |
| Unit + determinism | `npx vitest run` (= `npm test`) | the match is a pure function of (cfg, input log); `src/sim` uses no nondeterministic APIs | real sim for 3 of the tests (skipped with a message while `match.ts`/`record.ts` are stubs) |
| Balance sim | `npm run sim -- 1000 --json docs/balance.json` | no personality wins >40 %, every match ends within `MATCH_TICKS`; prints the metrics in `docs/BALANCE.md` | real sim (stub: prints `FAIL … did not finish`, exit 1) |
| Make a demo record | `node tools/make-record.ts [matches/demo-1.json] [--seed 1] [--autoplay]` | writes a `MatchRecord` from a scripted human (idx 0) and self-checks the replay | real sim |
| Verify a match | `npm run verify-match demo-1` or `npm run verify-match path/to/record.json` | replaying the stored input log reproduces hash, winner and placements (exit 1 on mismatch, 2 on bad input) | real sim |
| E2E (Playwright) | `npx playwright test` (= `npm run test:e2e`) | see below | client test hook (`?e2e`, Agent A) |
| Checkpoint media | dev server running, then `node tools/capture.ts [--seconds 45] [--until-over] [--headed]` | `docs/screens/`: desktop title + 5 s / 20 s / 40 s screenshots, `match-desktop.webm` (1440×900), mobile 390×844 title + in-play | dev server on 5184, client |
| Lighthouse | see below | performance ≥80, accessibility ≥95 (CLAUDE.md gates) | production build |
| axe (WCAG A/AA) | `npx playwright test a11y` | no axe violations on title and in-match HUD | **dependency request:** `@axe-core/playwright@4.14.0` (devDependency) — the test skips until installed |

## Determinism suite (`tests/unit/determinism.test.ts`)
- Same `MatchConfig` run twice → identical `hash()` every 100 ticks and at the end (scripted human, and
  bot-only with idx 0 as a bot).
- Two matches stepped interleaved give the same traces as when run alone → no shared module-level state.
- Different seeds diverge (real sim only).
- Record → JSON → `replayRecord` reproduces hash, winner and placements, both with a scripted human and
  with `botInput` driving the human (what the client's `?autoplay` does). This also catches a `botInput`
  that mutates match state/RNG (it would desync the client's recording from the verifier).
- `Recorder` stores input changes only.
- Source scan: every non-stub `src/sim/*.ts` (not `*.test.ts`), comments stripped, contains no
  `Math.random`, `Math.sin/cos/tan/atan2/asin/acos/atan`, `Math.exp/log/hypot/cbrt`, `Date`,
  `performance`, `crypto`. Files whose first line is a `// … STUB …` comment are skipped (and listed).

**Recording convention the tools assume:** `Recorder.push(tick, idx, input)` is called with
`match.state.tick` *before* the `step()` that consumes the input, and only while that fighter is alive
(see `runMatch` in `tools/simlib.ts`). `replayRecord` must apply an input recorded at tick `t` in the step
taken when `state.tick === t`, and run until `state.over` (cap `MATCH_TICKS`).

## E2E (`tests/e2e/`, projects `desktop` 1440×900 and `mobile` Pixel 7 at 390×844)
Playwright starts `npx vite --host 127.0.0.1 --port 5184 --strictPort` itself, or reuses one already running.
Every test waits up to 20 s for `window.__br`; if the client doesn't expose it, the test is **skipped**
with "window.__br test hook missing" (that is the state before Agent A's merge).
- `match.spec.ts` — `/?e2e&autoplay&seed=7&bots=1` reaches `phase() === "over"` within 240 s,
  `placement()` is 1..10, `record()` is exposed, zero console errors / page errors, no horizontal scroll.
  Video is always recorded: `test-results/match-*/video.webm`.
- `title.spec.ts` — `/?e2e` shows a PLAY button (`role=button`, name /play/i) reachable with Tab;
  clicking it (and Enter on it) → `phase() === "playing"` within 10 s.
- `perf.spec.ts` (desktop only) — mean of `fps()` sampled every 250 ms for 5 s ≥ `BR_MIN_FPS`
  (default 30, because headless Chromium renders WebGL in software; the real target is 60 — run
  `BR_MIN_FPS=45 npx playwright test perf --headed` on a laptop). The measured value is logged and attached
  as an annotation.
- `a11y.spec.ts` — axe WCAG 2.0/2.1 A+AA on title and HUD (needs `@axe-core/playwright@4.14.0`).

Run one project: `npx playwright test --project=desktop`. HTML report: `npx playwright show-report`.

## Lighthouse (13.6.0, desktop + mobile)
```sh
npx vite build
npx vite preview --host 127.0.0.1 --port 5184 --strictPort   # terminal 1
node tools/lighthouse.ts /                                     # terminal 2 → docs/lighthouse/*.report.{html,json}
```
The script runs, for each form factor (mobile = Lighthouse's default emulation, desktop = `--preset=desktop`):
```sh
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  npx -y lighthouse@13.6.0 http://127.0.0.1:5184/ --preset=desktop \
  --only-categories=performance,accessibility,best-practices \
  --output=json --output=html --output-path=docs/lighthouse/desktop --chrome-flags=--headless=new
```
and prints the scores with PASS/FAIL against accessibility ≥95 and performance ≥80.

## Checkpoint (18:00 UTC) recipe
```sh
npx vite --host 127.0.0.1 --port 5184 --strictPort &      # dev server
node tools/capture.ts --until-over                           # docs/screens/*.png + match-desktop.webm
npx playwright test --project=desktop match                  # pass/fail + test-results/**/video.webm
npm run sim -- 1000 --json docs/balance.json                 # balance numbers for docs/BALANCE.md
node tools/make-record.ts && npm run verify-match demo-1     # verifiable match
```

## Requests to the lead
- devDependency `@axe-core/playwright@4.14.0` (axe test).
- Optional npm scripts: `"make-record": "node tools/make-record.ts"`, `"capture": "node tools/capture.ts"`,
  `"lighthouse": "node tools/lighthouse.ts"`.
- There is no `@types/node`; `tools/node-shim.d.ts` declares the few Node APIs the tools use. If the lead
  adds `@types/node`, delete the shim (they would conflict).
