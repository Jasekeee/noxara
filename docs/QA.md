# QA — how to run every check and what it proves

Owner: Agent D (`tests/**`, `tools/**`, `playwright.config.ts`, `vitest.config.ts`). All tools run on
Node 24 directly (`node tools/x.ts`, type stripping). Dev/preview servers use **port 5184** only.

**One command: `npm run verify`** (`tools/verify.ts`, ~35 s) prints PASS/FAIL per README claim and
exits 1 on any FAIL: tsc · vitest · determinism source scan · `verify-match` on every committed
`matches/*.json` · 300-match balance gate · relayer `node --test` · read-only testnet checks via
`https://test.rpc.fastnear.com` (contract deployed; every `get_fighters()` account has 0 access keys;
latest settled match in `get_recent_matches` has an `input_log_hash`). Offline, the chain checks print
SKIP, not FAIL. Needs `cd relayer && npm ci` once (otherwise the relayer line FAILs with that hint).
Env: `BR_RPC`, `BR_CONTRACT`.

Last run (2026-11-13 16:30 UTC, main d0425f9 + QA): **9 PASS, 0 FAIL, 0 SKIP** — 41 vitest tests;
10 sim files scanned; 2/2 matches reproduced; balance win share balanced 32.3 % (3 of 10 slots incl. idx 0),
camper 19.7, aggressive 16.7, coward 14.7, looter 8.7, sniper 8.0, avg 134.5 s; relayer 34/34; 9/9 bots
keyless; match #32 settled with its input-log hash. Note: at 100 matches "balanced" hit 41 % (noise
around 3 slots × 10 %), so the gate uses 300.

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
| axe (WCAG A/AA) | `npx playwright test a11y` | no axe violations on title and in-match HUD | `@axe-core/playwright@4.14.0` (installed) |

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
**Non-chain specs never touch the network:** they load `/?e2e&offline&seed=7…` (`?seed` already means
"local match, no network"; `?offline` is the explicit switch) and `isolateFromChain()` aborts any request
to the relayer / NEAR RPC / wallet hosts and asserts there were none. Console errors from such a blocked
request are the only errors tolerated; any other console or page error fails the test. Only
`chain.spec.ts` (opt-in) talks to testnet. Every test waits up to 20 s for `window.__br`; if the client doesn't expose it, the test is **skipped**
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
- `chain.spec.ts` (opt-in, desktop only): `RUN_CHAIN=1 BR_PORT=5186 npx playwright test chain --project=desktop`.
  Lobby `#net-mode` says "live wallets" → `/?e2e&autoplay` (no `?seed`, so `start_match` seals the seed on
  testnet; autoplay starts by itself) plays to "over" → the ledger shows **Verified** (server replayed and
  settled) → `window.__br.record()` replays in Node with `replayRecord` to the same hash/winner/placements,
  and the bots are `.testnet` accounts. Needs the relayer on :8788. Creates one real guest + match on
  testnet (gas paid by the relayer). The relayer only allows CORS from its dev ports (5173/5180/5181/5184),
  so the spec proxies relayer calls through Playwright and adds the header. Passed 16:35 UTC (2.1 min,
  seed 3653452201, browser record replayed bit-for-bit).
- `a11y.spec.ts` — axe WCAG 2.0/2.1 A+AA on title and HUD (needs `@axe-core/playwright@4.14.0`).

`BR_PORT=5186` runs Playwright's own dev server on another port (default 5184, e.g. when a judge is
playing there). Run one project: `npx playwright test --project=desktop`.

**Stability (2026-11-13 17:32–17:48 UTC, main d288401, `BR_PORT=5186`):** whole suite 3× in a row,
desktop + mobile: **11 passed / 3 skipped each run, 0 failures, 0 flakes** (skips = chain ×2 opt-in,
perf on mobile). Match always ends at tick 2725, placement 2 (deterministic seed 7); desktop fps avg
55.0 / 54.8 / 53.6 (min 36–42) headless. HTML report: `npx playwright show-report`.

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
and prints the scores with PASS/FAIL against accessibility ≥95 and performance ≥80. Use
`BR_URL=http://127.0.0.1:5186` for a preview on another port.

### Results (2026-11-13 17:50 UTC, main d288401, `vite preview` on 5186, page `/`, 3 runs back to back)
| | Performance | Accessibility | Best practices |
|---|---|---|---|
| Desktop | **70** / 100 / 100 | 100 | 96 |
| Mobile | 83 / 99 / 99 | 100 | 96 |

| Run | Desktop TBT · LCP · CLS | Mobile TBT · LCP · CLS |
|---|---|---|
| 1 (first after the preview server started) | 1,240 ms · 0.5 s · 0 | 630 ms · 2.0 s · 0.045 |
| 2 | 0 ms · 0.2 s · 0 | 80 ms · 0.8 s · 0.04 |
| 3 | 0 ms · 0.2 s · 0 | 120 ms · 0.8 s · 0.04 |

- **Flag:** warm runs are well over the gate (desktop 100, mobile 99; much better than d0425f9's 76–100 /
  81–92 thanks to the chunked boot and CLS reservations). The **first run after the server starts** still
  fails desktop (70): Total Blocking Time 1.24 s, i.e. boot-time script work in the 828 KB (226 KB gzip)
  bundle (model parsing, shader compile, first `buildMatch`) landing as long tasks on a cold cache. If a
  judge's first load matters: split three.js + game code from the lobby, or start `compileAsync`/`buildMatch`
  after first input / `requestIdleCallback`.
- Mobile CLS is down to 0.04 (was 0.106).
- Best practices 96 = console errors that exist only on the QA port: the relayer refuses CORS from 5186
  (`/api/health` blocked). On 5184 this audit should pass.
- Accessibility 100 on every run.

### Earlier (16:40 UTC, d0425f9): desktop 76 / 100 / 100, mobile 88 / 81 / 92, a11y 100, BP 96.

## Checkpoint (18:00 UTC) recipe
```sh
npx vite --host 127.0.0.1 --port 5184 --strictPort &      # dev server
node tools/capture.ts --until-over                           # docs/screens/*.png + match-desktop.webm (gitignored)
# on another port: BR_URL=http://127.0.0.1:5186 node tools/capture.ts --until-over (relayer calls are proxied for CORS)
npx playwright test --project=desktop match                  # pass/fail + test-results/**/video.webm
npm run sim -- 1000 --json docs/balance.json                 # balance numbers for docs/BALANCE.md
node tools/make-record.ts && npm run verify-match demo-1     # verifiable match
```

## Requests to the lead
- (done) `@axe-core/playwright@4.14.0` is installed; the a11y spec runs and passes.
- There is no `@types/node`; `tools/node-shim.d.ts` declares the few Node APIs the tools use. If the lead
  adds `@types/node`, delete the shim (they would conflict).
