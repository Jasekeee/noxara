# C — Fresh judge + AI screener audit: NOXARA

Auditor: fresh judge subagent (no prior context). Date: 2026-11-14, ~13:45–14:25 UTC.
Clone: `git clone ~/Developer/bounty-royale` → `scratchpad/audit/clone` at `31d694a` (257 commits, first commit `6649b77` 2026-11-13). Node v24.21.0.
Live: https://playnoxara.vercel.app (headless Chromium, desktop 1440×900 + 390×844). **0 live ranked matches played** (Training Island / `?offline` only; no wallet sign-in; no chain writes). Mainnet facts below come from read-only RPC views (`rpc.mainnet.fastnear.com`).
Screenshots: `scratchpad/audit/C-shots/` (live-desk-*, live-m390-*). Logs: `scratchpad/audit/*.log`.

## Stage 1 — AI screener checklist

| # | Item (README / docs claim) | Result | Evidence |
|---|---|---|---|
| S-1 | `npm install` | PASS [verified] | 1.5 s, clean; only an `fsevents` install-script notice |
| S-2 | `npm run dev` → http://127.0.0.1:5180 | PASS with note [verified] | 5180 was already taken on this machine (another process); ran `vite --port 5191`, ready in 854 ms. Note: `npm run dev` has no `--strictPort`, so Vite would silently pick another port while README says 5180 |
| S-3 | `npm start --prefix relayer` | SKIPPED | Needs `.env` with relayer/server keys (secrets) |
| S-4 | `npm test` | PASS [verified] | 6 files, 86/86 tests, 41.6 s |
| S-5 | `npm run verify` ("checks every claim in this README") | **FAIL on a fresh clone** [verified] | `10 passed, 1 failed`: "relayer dependencies missing: run `cd relayer && npm ci` first". README never tells you to run `npm ci --prefix relayer` before `verify` |
| S-6 | `npm run verify` checks the live product | **FAIL (scope)** [verified] | Chain checks default to `royale.br-7e8492.testnet`; the minted check hard-codes 3,150 (testnet). README headline says the product is live on **mainnet** `noxara.near` (minted 2,900) — `verify` cannot check the mainnet claim and would FAIL if pointed at it |
| S-7 | `npm run verify-match matches/demo-1.json` → PASS | PASS [verified] | hash `c0c22e3cd784356e`, winner 7, placements reproduced in 126 ms |
| S-8 | `npm run sim -- 300` → no personality > 40% | PASS [verified] | max share balanced 33.0%; avg 133 s; determinism check same hash |
| S-9 | `npm run test:e2e` → guest full match desktop+phone, 0 console errors, axe | PASS [verified] | 21 passed, 7 skipped (chain/social need servers + secrets; mobile perf desktop-only), 6.2 min; full match 2.4 min each; fps avg 51–54 (swiftshader) |
| S-10 | `node scripts/econ-sim-v2.ts` → PASS + charts | PASS [verified] | all 11 criteria PASS; "0 minted"; Gini 0.243 |
| S-11 | `npm test --prefix relayer` | FAIL as written / PASS after `npm ci --prefix relayer` [verified] | Without install: `test/social.test.ts ✖`. After `npm ci --prefix relayer`: 66/66 pass |
| S-12 | `(cd contracts/royale && cargo test)` "unit + sandbox tests" | **FAIL on a fresh clone** [verified] | Unit 115/115 pass, then `tests/anchor.rs` fails: `No such file or directory` (needs `../anchor/target/near/anchor.wasm`). After I ran `cargo near build non-reproducible-wasm`: sandbox 14 passed, **3 failed** (need a second `--features teardown-override` wasm). README gives no build step |
| S-13 | LICENSE present, type | PASS [verified] | `LICENSE` = MIT ("NOXARA contributors"); Kenney CC0 licence texts in `public/licenses/` (3 files) |
| S-14 | AI-assistance disclosure | PASS [verified] | README Credits: "Built with AI assistance (Claude Code)"; `CLAUDE.md` committed |
| S-15 | Hackathon tag plan | PARTIAL [verified] | `docs/SUBMISSION.md §6`: `pre-hackathon` not needed (first commit 2026-11-13), `hackathon-submission` tag to be pushed by owner. `git tag` → no tags yet |
| S-16 | CI badge / status | Badge MISSING; CI green [verified] | No badge in README. `gh run list`: last 5 runs on `main` = success (latest 13:33 UTC). CI runs unit, build, verify-match, sim 50, relayer tests, `cargo test --lib`, gitleaks — **not** e2e, not sandbox |
| S-17 | Secrets hygiene | PASS [verified] | `gitleaks git --all`: 208 commits, no leaks; only `.env.example` tracked; `.gitignore` covers `.env*`, `.near-credentials/` |
| S-18 | "live on NEAR mainnet", contract `noxara.near`, deploy tx `BmMiB9cc…` | PASS [verified] | RPC: `noxara.near` has code (`FV53G9…`, 536,523 B); tx status SuccessValue, actions DeployContract+FunctionCall; `ft_metadata` Nox/NOX |
| S-19 | "Fighters are keyless NEAR accounts" | PASS [verified] | Mainnet `brindle/okapi/vesper/house.noxara.near`: 0 access keys. Testnet: 9/9 keyless (verify). `noxara.near` itself: 1 FullAccess key (disclosed as "developer keeps the contract key") |
| S-20 | "nothing minted by economy v2" (mainnet) | PASS [verified] | Mainnet `get_economy`: minted = genesis = 2,900; burned 131.82; supply 2,768.18 |
| S-21 | "Every match ... settled on chain" | PASS [verified] | Mainnet `get_recent_matches(50)`: 5 returned (ids 3–7), all `Settled` with `input_log_hash`. Note: only ~7 mainnet matches exist (low traction) |
| S-22 | README consistency mainnet vs testnet | **FAIL** [verified] | Header: "live on NEAR mainnet"; "How NEAR powers" bullet: "**Testnet only until the owner says yes**"; section `## Mainnet`: "**Prepared, not deployed**". Do/See table example `pip.royale.br-7e8492.testnet` (live shows `brindle.noxara.near`, different names) |
| S-23 | docs consistency | **FAIL** [verified] | `docs/MAINNET.md` title "mainnet release plan (NOT executed)… Nothing here has been run on mainnet"; says "the README lists every admin method" — it doesn't. `docs/SUBMISSION.md` Do/See: `brindle.royale.br-7e8492.testnet`, "Sign in with a testnet wallet", "`npm run verify` … live testnet reads". `docs/DECISIONS.md #3` says tap auto-aims with ±8° assist; README says "manual aim, no aim assist" |
| S-24 | Live About page contract label | **FAIL** [verified in code + seen once live] | `src/ui/about.ts:66` hard-codes `Game contract (testnet): ${id}`; on the mainnet build connected state renders "Game contract (testnet): noxara.near" (seen in the first live load) |
| S-25 | Live Economy copy | MINOR FAIL [verified] | Mainnet economy page: "(on testnet, 250 NOX were minted by the v1 economy…)" — irrelevant/confusing on mainnet |
| S-26 | "Press PLAY. No wallet…" (live) / ranked availability | FLAKY [verified] | 3 live loads: (1) "Ranked unavailable · Try again — NEAR is busy", (2) desktop "Connecting…" after 8 s, (3) mobile "Live · NEAR mainnet". Mobile load logged **11× HTTP 429** console errors; client RPC = `free.rpc.fastnear.com` (16 requests per load) |
| S-27 | TRAINING ISLAND → offline easy match (live) | PASS [verified] | Match starts ≤2.5 s; HUD, HIDDEN in bush, aim arrow, storm timer, crown marker, minimap; "Training island: the bots go easy on you. Not ranked." Screens `live-desk-training-12s.png`, `live-m390-training-start.png` |
| S-28 | Bush → "HIDDEN" | PASS [verified] | HUD label "HIDDEN" over player in bush (desktop screenshot) |
| S-29 | Fighters → real account + explorer link | PASS [verified] | Profile shows `brindle.noxara.near`, wallet/W/K/M, story, links to `nearblocks.io/address/brindle.noxara.near`; list rows have no direct link (profile does) |
| S-30 | ECONOMY live report | PASS [verified] | Supply 2,768.17 / 2,900, 0 minted, House 1,999.84 vs target 1,000, m ×1.50, brake 0.78, season ends 1d 10h |
| S-31 | `?about` / `/?offline` | PASS [verified] | About renders pitch, how-to, economy, mainnet links; `?offline` → "Practice · not ranked" |
| S-32 | 390 px, no horizontal scroll | PASS [verified] | `scrollWidth − innerWidth = 0` on title; status pill "LIVE · NEAR MAI…" truncated, ticker "IE MARK: oka" clipped (cosmetic) |
| S-33 | Links | PARTIAL [verified/assumed] | playnoxara.vercel.app 200; GitHub `Jasekeee/noxara` **404** (private — must be public before judging); nearblocks 403 to curl (bot protection, [assumed] fine in a browser) |
| S-34 | Challenge a friend / Daily / Sign-in / IPO shares / end-screen Verified | NOT CHECKED | Needs a live ranked match or wallet sign-in (out of my budget/rules); `match.spec` covers a full offline match only |
| S-35 | Repo hygiene for public release | NOTE [verified] | Internal ops docs in repo: `docs/MORNING_REPORT.md` (Russian), `OVERNIGHT_LOG.md`, `OWNERSHIP.md` ("Agent A"), `CLAUDE.md` says "No mainnet"; `.env.example` header still "BOUNTY ROYALE" |

## Findings

| ID | Severity | Finding | Evidence | Fix plan | Effort |
|---|---|---|---|---|---|
| C-1 | CRITICAL | README contradicts itself on the single most important fact: mainnet live vs "Testnet only" vs "Prepared, not deployed" | S-22 | Rewrite the "How NEAR powers" last bullet and the `## Mainnet` section: "Live on mainnet since <date> (tx …); testnet = rehearsal". Replace testnet account examples with `brindle.noxara.near` | S |
| C-2 | HIGH | `npm run verify` prints FAIL on a fresh clone (relayer deps) — the flagship "verify every claim" fails for the first judge who runs it | S-5 | Either `verify.ts` runs `npm ci --prefix relayer` itself / SKIPs with a hint, or README adds `npm ci --prefix relayer` before `verify` | S |
| C-3 | HIGH | `verify` only verifies testnet; the headline mainnet claims (keyless bots, 0 minted, settled matches on `noxara.near`) are not machine-checked | S-6 | Add `npm run verify -- --mainnet` (BR_RPC mainnet, BR_CONTRACT noxara.near, `MINTED_AT_V2` per network = 2,900 on mainnet); README: run both | S |
| C-4 | HIGH | `cargo test` as written fails on a fresh clone (anchor + 3 sandbox tests need prebuilt wasm) | S-12 | README: `cargo test --lib` for unit, plus a `scripts/contract-test.sh` that builds both wasms (normal + `teardown-override`, anchor) then runs sandbox; or `#[ignore]` the wasm-dependent tests with a message | S–M |
| C-5 | HIGH | Live ranked mode flaky: "NEAR is busy"/"Connecting…" and 11× HTTP 429 console errors from the free RPC | S-26 | Paid/keyed RPC (FastNEAR/Lava/Infura) or proxy views through the Railway server with caching; back off + dedupe view calls; never log 429 as console error | M |
| C-6 | MEDIUM | About page says "Game contract (testnet): noxara.near" on mainnet | S-24 | Label from network: `Game contract (${NET}): …` | S |
| C-7 | MEDIUM | docs/MAINNET.md, docs/SUBMISSION.md, CLAUDE.md still describe mainnet as not executed / testnet wallet; MAINNET.md promises README lists admin methods (it doesn't) | S-23 | Add "Executed <date>, tx …" banner to MAINNET.md; fix SUBMISSION Do/See rows; add an "Admin methods (owner key)" list to README trust section | S |
| C-8 | MEDIUM | Repo private → GitHub link 404 on the live About page and in README | S-33 | Make public before judging (owner action); then add CI badge | S |
| C-9 | MEDIUM | Low on-chain traction: ~7 mainnet matches | S-21 | Drive play (daily cup post, owner-approved), show "matches settled on mainnet: N" counter on the title | M |
| C-10 | LOW | No CI badge; CI omits e2e and sandbox tests | S-16 | Add badge; add an e2e job (offline specs) | S |
| C-11 | LOW | Economy page mentions testnet v1 mint on mainnet | S-25 | Show the testnet note only when `NET === "testnet"` | S |
| C-12 | LOW | DECISIONS.md #3 (auto-aim) conflicts with README (no aim assist) | S-23 | Mark #3 superseded | S |
| C-13 | LOW | Internal agent logs (Russian morning report, overnight log, OWNERSHIP "Agent A") in the public repo; `.env.example` says BOUNTY ROYALE | S-35 | Move to `docs/process/` with a one-line note or drop; rename header | S |
| C-14 | LOW | `npm run dev` port not strict; 390 px status pill/ticker clipped | S-2, S-32 | `--strictPort`; shorten pill to "LIVE · MAINNET" at <420 px | S |

## Stage 2 — Rubric scores (7 × /10)

### Persona 1 — Protocol engineer: **47 / 70**

| Criterion | Score | Reason | What would make it a 10 |
|---|---|---|---|
| Tech | 7 | Deterministic fixed-point sim, input-log replay (verified), 115 unit + 14 sandbox tests; but server is trusted to replay, and contract tests don't run from a clean clone | One-command green contract suite from a fresh clone (C-4); publish a replay of a real **mainnet** match id (fetch inputs → `verify-match` → compare to `input_log_hash` on chain) |
| Orig | 7 | Keyless NPC accounts as bankruptable businesses + fan shares (NEP-245) is fresh | A visible on-chain "fighter retires → rookie account created" event on mainnet with explorer links |
| NEAR | 7 | Keyless sub-accounts, next-block seed, NEP-366 guests, NEP-141/245, mainnet live and 0 minted (verified) | `verify --mainnet` (C-3); list admin methods + owner key policy; show the next-block seed receipt per match |
| Demo | 6 | Practice works great; ranked path flaky (429, "NEAR is busy") | Reliable RPC (C-5); a "last 10 mainnet matches" panel with tx links |
| Pack | 5 | README self-contradicts mainnet/testnet; `verify` and `cargo test` fail fresh | C-1/C-2/C-4 fixed → every README command green from a clean clone |
| Fit | 8 | Literally "NPCs with wallets, economies that evolve without a dev patch" | Show one economy change on mainnet that happened without a patch (m multiplier history chart) |
| Main | 7 | 257 commits, CI green, gitleaks, MIT, tests across 3 layers | CI badge + e2e in CI; tag `hackathon-submission` |

### Persona 2 — VC / investor: **48 / 70**

| Criterion | Score | Reason | What would make it a 10 |
|---|---|---|---|
| Tech | 7 | Looks like a real product, runs smoothly, real mainnet contract | One reliability metric on the page (uptime/settle latency) |
| Orig | 7 | "AI esports, fans own the athletes" is a pitchable wedge | 1-slide thesis in README: who pays, why fans hold shares, what's defensible |
| NEAR | 7 | Uses NEAR-native features credibly; chain invisible to guests | Explain why this can't run on another chain in 3 bullets with numbers (cost per match, latency) |
| Demo | 7 | 30-second-to-fun; polished visuals; video still a script | Ship the 60–90 s video; title shows live mainnet counters |
| Pack | 6 | Strong copy, but contradictory status lines erode trust fast | C-1 + a one-screen "status: live on mainnet since …, N matches, M players" |
| Fit | 8 | Strong track fit | Show NPC wallets changing over time (chart per fighter) |
| Main | 6 | ~7 mainnet matches, repo private, no social presence yet | Owner-approved launch post + Weekly Cup with announced prizes; public repo |

### Persona 3 — Gamer: **50 / 70**

| Criterion | Score | Reason | What would make it a 10 |
|---|---|---|---|
| Tech | 8 | Smooth (~51–54 fps headless), responsive aim indicators, mobile twin-stick works | Hold 60 fps on a mid laptop; preload so the first match never stutters |
| Orig | 6 | Top-down BR vs bots is familiar; the economy meta is cool but not felt in the first match | Make the bounty/crown hunt and fighter rivalry (grudges, revenge bounties) felt within the first 60 s |
| NEAR | 7 | Chain is truly invisible in practice; occasional "Connecting…/NEAR is busy" breaks the illusion | Never show chain status as an error; queue the seal behind the drop-in animation |
| Demo | 8 | Training Island instant, juicy HUD, clear storm + crown | Fix ranked flakiness so PLAY always works (C-5) |
| Pack | 7 | Clean title, mercenary board with personalities, clear how-to-play | Shorter title copy on 390 px (clipped pill/ticker) |
| Fit | 8 | NPC rivals with wallets and stories are the game | Fighter profile shows "last match vs you" and its wallet history |
| Main | 6 | Feels alive but player counts are tiny | Daily leaderboard populated; visible "N players today" |

**Totals: Protocol engineer 47/70 · VC 48/70 · Gamer 50/70.**

## Top 5 fixes (ordered by score gain per hour)
1. C-1 + C-6 + C-7 + C-11: one consistency pass "mainnet is live" across README, docs, About, Economy copy (≈1 h, +1–2 Pack on all personas).
2. C-2 + C-4: every README command green on a fresh clone (≈1 h).
3. C-3: `verify --mainnet` (≈1 h) — turns the mainnet headline into a checked claim.
4. C-5: reliable RPC / server-proxied views (≈2 h; needs owner if paid RPC).
5. C-8/C-9/C-10: public repo, CI badge, tag, demo video, a few dozen real mainnet matches.
