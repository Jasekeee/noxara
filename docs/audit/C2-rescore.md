# C2 — Fresh judge panel re-score: NOXARA (2026-11-14, ~14:30–15:05 UTC)

Scope: README.md, docs/SUBMISSION.md, docs/MAINNET.md, docs/JUDGE_LOG.md, docs/audit/C-judge.md, relayer/src/settle.ts, src/game.ts, src/net/client.ts (read-only). Live: https://playnoxara.vercel.app (headless Chromium 1440x900 + 390x844, one browser context, guest reused). **2 live ranked matches played** (budget used: 2/2). No wallet sign-in, no chain writes by me (the guest's matches were started/settled by the game's own relayer), no .env read. Repo HEAD `8dbd734`, working tree only `docs/econ/summary.json` modified.

## What I checked

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `npm run verify` (defaults to mainnet) | **11/11 PASS** [verified] | tsc 0 errors; vitest 90/90; no Math.random/float in sim; 2/2 committed matches replay to hash; 300 bot matches max personality 33.0%; econ-sim v2 PASS; relayer 74/74; `noxara.near` code hash = sha256 `d734724f…` (audited build); 9/9 bots keyless; latest settled match #9 has an input-log hash; minted 2,900 = genesis, burned 158.85 |
| 2 | Live title (desktop) | Strong [verified] | 3D dusk island, Mercenary Board with 9 `*.noxara.near` fighters, WANTED card on the richest, Weekly Bounty Cup panel, mode tabs incl. ONLINE/3v3 "SOON" |
| 3 | Live ranked match 1 (guest) | **Not settled** [verified] | PLAY → in match ~10 s, no popups. Died to storm at 0:49 (#8; my bot-input was crude). Pressed the end screen's highlighted **WATCH THE PAYOUT (fast-forward to the finish)**. Result: "Pot — not settled … the server could not verify the match. Wallets are unchanged." Console: 1 error, `POST /api/settle → 409`. Response body: `{"error":"this match lasts 104 s but was submitted 79 s after it started","code":"too_fast"}` |
| 4 | Root cause of #3 | **Bug** [verified in code] | `src/game.ts:1443` runs the spectated sim at 4x when `spectateFF`; `src/game.ts:1055-1058` calls `client.settle()` the moment `st.over` is true; `relayer/src/settle.ts:112-117` rejects records submitted faster than real time (0.9 x duration − 5 s); `src/net/client.ts:564+` never retries. So **every death followed by WATCH THE PAYOUT in a match that would have outlasted the real-time window fails to settle** — exactly the path the submission pack tells judges to follow ("finish a match and look for Verified") |
| 5 | Live ranked match 2 (same guest) | **Verified** [verified] | Killed at 0:21 (#10, first out) by Brindle's sniper. Pressed SPECTATE (1x). After ~100 s: winner Tallow, pot 78.07 → Tallow 70.69, House cut 3.76, burned 3.62, bounty claimed by Quillon 21.71 (14.21 carrier + 7.50 House), "Verified on NEAR — the server replayed every input; open the settle tx". Title board then showed the deltas (+70.69, +21.71, −14.21) and the new MARK (Tallow) [verified] |
| 6 | Money reconciliation | Minor gap [verified] | Pre-death card said "Pot 79.39 NOX"; settled pot was 78.07. Unsettled match 1 still awarded "+20 XP" locally |
| 7 | ECONOMY page (mainnet) | Real, readable, sparse [verified] | Supply 2,737.51, 0 minted, House 1,956.52 vs target 1,000, m ×1.50, brake 0.73, season #0; bots by P&L. **Share market: 9 fighters × 300 IPO shares left, 0 holders, "no trades", 0 dividends, no listings.** Each fighter shows 7 matches this season |
| 8 | 390 px | OK [verified] | `scrollWidth − innerWidth = 0`; layout clean; briefly "CONNECTING…" pill even under `?offline` before switching to "PRACTICE · NOT RANKED" |
| 9 | Repo / packaging | Gaps [verified] | `https://github.com/Jasekeee/noxara` → 404 (still private); `git tag` → none; README links no demo video (only a local `docs/screens/demo-draft.webm`). CI badge now present; README/MAINNET.md now consistent about mainnet (prior judge's C-1/C-3 fixed) |

## Persona 1 — Protocol engineer: **52 / 70**

| Criterion | Score | One-line reason |
|---|---|---|
| Tech | 8 | Deterministic integer sim shared by browser + server, replay-verified settlement, 114 contract tests, multiple audits, verify 11/11 on mainnet [verified]; but the settle path is fragile (4x fast-forward → `too_fast`, no retry) [verified] |
| Orig | 7 | Keyless NPC accounts as autonomous economic actors + fan shares is a fresh combination; the BR shell is familiar |
| NEAR | 8 | Keyless sub-accounts, next-block randomness, FC keys + NEP-366 gasless guests, NEP-141 + NEP-245 subset in one contract [verified via verify + README]; full-access key kept on `noxara.near` (disclosed) |
| Demo | 7 | Observed the full loop to "Verified" once; the other match silently failed to settle on the most prominent button [verified] |
| Pack | 7 | README is precise, honest trust model, admin-powers table, verify on mainnet; repo still 404, no tag, no video [verified] |
| Fit | 8 | NPCs with wallets that pay entries, win, retire and get replaced = the track text |
| Main | 7 | Live mainnet, time-locked teardown, exit window, honest roadmap; low real usage (~10 mainnet matches) [verified: match #9 latest settled before mine] |

Top 3 weaknesses:
1. Settlement fails after WATCH THE PAYOUT (client submits faster than real time, server 409 `too_fast`, no retry/backoff) [verified].
2. Trust model is server-computed: seed is public after start + deterministic sim → offline search is only blocked by the real-time check; commit-reveal is "roadmap" (README admits it) [verified from README/settle.ts].
3. Upgrade key retained on the contract during judging, so "no one can mint / move NOX" is a code property, not a guarantee [verified from README].

## Persona 2 — VC / investor: **48 / 70**

| Criterion | Score | One-line reason |
|---|---|---|
| Tech | 7 | Looks and runs like a shipped product on mainnet; one reliability bug on the core path |
| Orig | 7 | "AI esports where the athletes are autonomous agents with wallets and fans own them" is a clean wedge |
| NEAR | 7 | Uses NEAR-native features credibly, chain invisible for guests; no numbers on cost per match / why only NEAR |
| Demo | 7 | 10 s to a live match, great title; no video linked [verified] |
| Pack | 7 | Clear pitch, consistent docs now; private repo + missing video hurt a judge's 2-minute skim [verified] |
| Fit | 8 | Strong literal fit to the track text |
| Main | 5 | The "player-owned market" is empty: 0 holders, 0 trades, 0 dividends on mainnet [verified]; ~7 matches per fighter this season; no social proof yet |

Top 3 weaknesses:
1. Zero traction on the market that is the economic thesis (0 share holders/trades) [verified].
2. No demo video and repo not public — judges can't see the signed-in half (IPO, dividends) at all [verified].
3. No unit-economics slide (cost per match in gas/relayer NEAR, who pays at scale) [assumed: not found in README].

## Persona 3 — Gamer: **51 / 70**

| Criterion | Score | One-line reason |
|---|---|---|
| Tech | 8 | Smooth 3D, instant input, clean HUD, mobile layout with no overflow [verified] |
| Orig | 6 | Top-down BR vs bots is familiar; the bounty/WANTED/Hall of the Broke meta is the hook |
| NEAR | 8 | I never saw a wallet, gas or popup; ~10 s from PLAY to GO! [verified] |
| Demo | 7 | Big juicy end screens; but first ranked match died at 0:21 to a sniper (#10) and the other "could not verify" [verified] |
| Pack | 8 | Best-looking title screen of the BR-style entries I'd expect; tidy mercenary cards [verified] |
| Fit | 8 | Fighters' wallets visibly change after your match (+70.69 / −14.21 deltas on the board) [verified] |
| Main | 6 | Feels alive, but daily/leaderboard populations are tiny; ONLINE/3v3 "SOON" tabs occupy prime space |

Top 3 weaknesses:
1. "WATCH THE PAYOUT" — the button that promises the payout — produces "Not settled … wallets unchanged" [verified].
2. Difficulty cliff for a first ranked match (sniper bot kill at 0:21; storm already "OUTSIDE THE NEXT ZONE" at spawn in match 1) [verified, n=2].
3. A guest's stake is nil: no NOX for guests, so the match outcome has no personal consequence beyond XP [verified from end screen copy].

## 5 most impactful remaining fixes (ordered by score gain per hour)
1. **Fix the fast-forward settle bug** (≈30–60 min): either delay the settle POST until `start_ms + 0.9 × duration − 5 s` (show "Sealing on NEAR…" meanwhile), or retry on `code: "too_fast"` after the server-reported wait; add an e2e/unit test "die → WATCH THE PAYOUT → Verified". Also stop awarding local XP when the settle fails. Without this, a judge following SUBMISSION.md can land on "Not settled".
2. **Make the repo public, push the `hackathon-submission` tag, link a 60–90 s video** in README top (owner actions; repo is 404 now).
3. **Seed the player-owned market honestly**: owner (or a few testers) buys a real IPO block and triggers one dividend, so ECONOMY shows ≥1 holder, ≥1 trade, ≥1 dividend; add one line to README with the tx link.
4. **Soften the first ranked match for brand-new guests** (e.g. spawn protection longer / no sniper bots targeting a level-1 player in the first 30 s / storm first-shrink later), and say so honestly in About.
5. **Reconcile the pot number** (pre-death card 79.39 vs settled 78.07): label the pre-settle figure "≈ estimate" or compute it from the same House state used at settle; add a "cost per match on NEAR" line (gas + relayer) to README for the VC read.

## Summary (10 lines)
1. Totals: **Protocol engineer 52/70 · VC 48/70 · Gamer 51/70** (prior C judge: 47 / 48 / 50).
2. `npm run verify` now checks mainnet and prints 11/11 PASS (code hash, keyless bots, settled match, 0 minted) [verified].
3. Live guest play is genuinely walletless: PLAY → match in ~10 s, no popups [verified].
4. Match 2 ended in "Verified on NEAR" with a full pot/burn/House/bounty breakdown and bot wallets updated [verified].
5. **New bug:** match 1 → WATCH THE PAYOUT (4x) → settle 409 `too_fast` → "Not settled, wallets unchanged" [verified, root cause in game.ts:1443/1055 + settle.ts:112].
6. That is the exact judge path in SUBMISSION.md; fixing it is the #1 priority (≈1 h).
7. Player-owned share market on mainnet: 0 holders, 0 trades, 0 dividends [verified].
8. Repo still 404 publicly, no git tag, no linked demo video [verified].
9. First ranked match is harsh for a newcomer (killed at 0:21 by a sniper bot) [verified, n=2].
10. Docs/README mainnet consistency issues from the prior audit are fixed; the remaining gaps are one bug, traction and packaging.
