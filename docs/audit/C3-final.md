# C3: final fresh judge panel, NOXARA (2026-11-14, ~16:30–16:50 UTC)

Scope (read-only): README.md, docs/SUBMISSION.md, docs/AUDIT.md, docs/audit/C2-rescore.md, trailer and explainer contact sheets (docs/video/*-contact.png), live game https://playnoxara.vercel.app (Playwright Chromium, one browser context), mainnet RPC (read-only), `npm run verify`. No wallet sign-in, no chain writes by me (the guest's match was started and settled by the game's own relayer), no .env read, no edits.

## What I checked

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `npm run verify` (mainnet) | **11 passed, 0 failed** [verified] | tsc 0 errors; vitest 90/90; no Math.random/float in sim; 2/2 committed matches replay; balance max personality 33.0%; econ-sim v2 PASS; relayer 74/74; code hash = sha256 `2c85142b…` (the season-extension build); 9/9 bots keyless; match #13 has an input-log hash; minted 2,900 = genesis, burned 166.14 |
| 2 | Proof txs given in the brief | Both real `settle_match` calls [verified, RPC `EXPERIMENTAL_tx_status`] | `3fBKspfL…` = match #7, signer `relay.noxara.near`, SuccessValue, `bounty_killer: 3`, NEP-141 events (House pot top-up 37.5 NOX, prize, house cut), ~24.8 Tgas. `EJPkiz7X…` = match #13, prize 71.31 NOX to `okapi.noxara.near`, ~24.6 Tgas |
| 3 | Live title, desktop 1440×900 | Strong [verified] | "LIVE · NEAR MAINNET" pill, 3D dusk island, Mercenary Board of 9 `*.noxara.near` fighters with archetypes, wallets, P&L sparklines, WANTED card, THE MARK pill, Weekly Bounty Cup panel ("Prizes announced soon") |
| 4 | **One live ranked match** (guest, 1 of 1 allowed) | **Played and Verified** [verified] | PLAY → HUD with "10 ALIVE" in ~6 s, no popup, no wallet. Spawned "OUTSIDE THE NEXT ZONE · MOVE ←". Picked up a sniper. My scripted input was crude: eliminated #6 at 1:06 by tallow's grenades, 0 kills, 0 damage |
| 5 | **WATCH THE PAYOUT** (failed in C2 with `too_fast`) | **Fixed** [verified] | 4× fast-forward reached the winner in ~19 s. The end screen then showed: winner brindle, pot 78.64, Brindle 71.43, House cut 3.79, burned 3.42, bounty 24.77 to Quillon (21.19 carrier + 3.58 House), and **"Verified on NEAR — the server replayed every input; open the settle tx"**. Settle tx `7nbwD9FE9YSD2FEcJ1u2jVCkWP7fsYG3HJcnutyrZchA` = `settle_match` match #14, SuccessValue (RPC). Start tx `WsTgbY1S…` = NEP-366 Delegate action `start_match` from `g-56b385ec80.noxara.near`, relayed by `relay.noxara.near` |
| 6 | Pot estimate vs settled pot | Labelled honestly now [verified] | Elimination card: "Pot ≈ 80.26 NOX (estimate — the settle tx has the final split)". Settled pot was 78.64 |
| 7 | Console | **0 errors, 0 warnings** in the whole session [verified] | Playwright console log |
| 8 | Wallets move after my match | Yes [verified] | Back on the title: THE MARK moved to brindle (144.83 NOX, +44.83 P&L). Board now shows "10M" played per fighter |
| 9 | ECONOMY page (mainnet) | Real, readable [verified] | Supply 2,705.34, 0 minted since genesis, burned 194.65, House 1,904.57 vs target 1,000, m ×1.50, brake 0.68, P&L table. **Shares: 9 × 300 IPO left, 0 holders, "no trades", 0 dividends, no listings** |
| 10 | Contract config (`get_config`, RPC) | [verified] | `matches_started: 15`, `matches_settled: 10`, `rookies: 0`, `total_minted` 2,900 NOX. So 5 of 15 started matches never settled (cause not checked: abandoned tabs, server refusals or in-flight) [assumed] |
| 11 | 390×844, `?offline` + Training Island | OK [verified] | `scrollWidth − innerWidth = 0`; clean HUD (alive, kills, shrink timer, minimap, weapon, HP). Spawned **"OUTSIDE THE NEXT ZONE"** again (2 of 2 of my spawns). Hint row says "WASD / Mouse aim / Click shoot" (desktop hints in a desktop browser at 390 px, so expected without touch emulation) [verified] |
| 12 | Trailer (6 frames) + explainer (6 frames) | Good [verified frames only, no audio] | Bold captions over real gameplay: "9 AI mercenaries. Real wallets." → "Only one walks out." → "Hunt the richest." → "Take the bounty." → "Every fighter is a real NEAR account." → end card with URL and "Built on NEAR". Explainer adds "Every match settled on NEAR mainnet" over a real Verified end screen. The trailer's 33 s frame shows a "Sealing the match seed on NEAR…" spinner, a small sign of the chain |
| 13 | Repo / packaging | Gaps, owner actions [verified] | `https://github.com/Jasekeee/noxara` → **404**; `git tag` → none; README still holds the `<!-- TRAILER … added after posting -->` placeholder; SUBMISSION "Video" / "X post" = "added after posting" |

## Persona 1: Protocol engineer, **53 / 70**

| Criterion | Score | One-line reason |
|---|---|---|
| Tech | 8 | Deterministic integer sim shared by browser and server, replay-verified settlement, 11/11 mainnet verify, settle bug from C2 fixed and re-checked live [verified]; correctness still rests on one trusted server |
| Orig | 7 | Keyless NPC accounts as on-chain businesses, plus fan shares and a House rule, is a fresh mix; the BR shell is familiar |
| NEAR | 8 | Keyless sub-accounts, next-block seed, NEP-366 Delegate `start_match` from a contract-created guest account (seen on chain), NEP-141 events, NEP-245 subset [verified] |
| Demo | 8 | My path PLAY → die → WATCH THE PAYOUT → Verified → settle tx all worked, with 0 console errors [verified] |
| Pack | 7 | Precise README, honest trust model, admin-powers table, one-command proof; repo 404, no tag, trailer not linked yet [verified] |
| Fit | 8 | NPCs with wallets that pay entries, win, pay upkeep and get replaced = the track text |
| Main | 7 | Time-locked teardown, exit window, reviewed upgrade path; thin usage (15 started / 10 settled) [verified] |

Top 2 weaknesses:
1. Single trusted settler plus a public seed and a deterministic sim: the result is "consistent with the inputs", not "played by a human"; commit-reveal and TEE are only on the roadmap [verified from README].
2. One third of mainnet matches never settled (5/15) and nothing on the site or in verify reports or explains that ratio [verified counts; cause assumed].

## Persona 2: VC / investor, **49 / 70**

| Criterion | Score | One-line reason |
|---|---|---|
| Tech | 7 | Runs like a shipped product on mainnet; one operator, Railway-hosted |
| Orig | 7 | "AI esports with athletes that own wallets, and fans own the athletes" is a clean wedge |
| NEAR | 7 | NEAR-native and invisible to guests; no cost-per-match / unit-economics line (I measured ~25 Tgas per settle myself) [verified gas; README line absent: assumed] |
| Demo | 8 | Punchy trailer and explainer built from real gameplay plus a real Verified screen [verified frames] |
| Pack | 7 | Clear one-liner and consistent docs; repo private and no posted video at the time of judging [verified] |
| Fit | 8 | Literal fit to "NPCs with wallets, player-owned markets, economy without a dev patch" |
| Main | 5 | The thesis market is empty: 0 share holders, 0 trades, 0 dividends; `rookies: 0`, so the bankruptcy→rookie story has never happened on mainnet; ~10 settled matches [verified] |

Top 2 weaknesses:
1. Zero evidence of the "player-owned market" on mainnet (0 holders / trades / dividends) [verified].
2. The "economy evolves on its own" loop is shown only in simulation; live, no fighter has gone broke and no rookie has entered (`rookies: 0`), and the Weekly Cup says "Prizes announced soon" [verified].

## Persona 3: Gamer, **52 / 70**

| Criterion | Score | One-line reason |
|---|---|---|
| Tech | 8 | Smooth 3D, fast HUD, clean 390 px layout, 0 console errors [verified] |
| Orig | 6 | Top-down BR against bots is familiar; the WANTED/bounty/Mark layer is the hook |
| NEAR | 9 | No wallet, no gas, no popup; ~6 s from PLAY to a live match (C2 measured 11–17 s before) [verified] |
| Demo | 7 | Juicy end screen with payout split and Verified; but I spawned outside the next zone in 2/2 matches and died by 1:06 [verified, n=2, scripted input] |
| Pack | 8 | The best-looking title of any NEAR BR-style entry I'd expect; consistent Kenney art and type [verified look; comparison assumed] |
| Fit | 8 | The fighters' wallets visibly change after my match (Brindle +71.43, Mark moved) [verified] |
| Main | 6 | Guests earn nothing ("Guests play for glory"); ONLINE / 3v3 "SOON" tabs take prime space; tiny daily population |

Top 2 weaknesses:
1. Spawn "OUTSIDE THE NEXT ZONE" in the first seconds (2/2 of my spawns), so a new player's first lesson is to run, not to fight [verified, n=2].
2. Low personal stakes for guests: no NOX, only XP, so a loss or a win changes nothing you own [verified from end-screen copy].

## The 3 most impactful remaining fixes (overall)
1. **Finish the packaging (owner actions, ~10 min):** make the repo public, push the `hackathon-submission` tag, replace the README `<!-- TRAILER -->` placeholder with a thumbnail that links to the X video, and fill "Video" / "X post" in SUBMISSION.md. Today a judge clicking the README badges gets a 404. Lifts Pack for all three personas.
2. **Put one honest real event in the empty market (owner + small UI work):** the owner buys one IPO block from his own wallet (labelled as the owner), so ECONOMY shows ≥1 holder, and the first dividend appears when that fighter profits. Add a "Season so far" line with live counters (matches started/settled, rookies so far = 0, "first bankruptcy pending") so the gap reads as an early season rather than a missing feature. Biggest Main lift for the VC persona.
3. **Fix the first-30-seconds of a ranked match and explain the settle ratio:** never spawn the human outside the next zone (or delay the first shrink for the human's side), and log or expose why 5/15 started matches never settled (abandoned vs refused) in `/api/health` or the Economy page. Lifts Demo and Main for the gamer and engineer personas.

## Summary
- Totals: **Protocol engineer 53/70 · VC 49/70 · Gamer 52/70** (C2: 52 / 48 / 51; first C: 47 / 48 / 50).
- `npm run verify` → 11/11 PASS against mainnet, code hash `2c85142b…` [verified].
- One live ranked guest match: no wallet, ~6 s to play, died #6, WATCH THE PAYOUT → **Verified**, settle tx `7nbwD9FE…` (match #14) on mainnet; C2's `too_fast` bug is fixed [verified].
- Weakest axis is Main/traction: 0 share holders, `rookies: 0`, 10 of 15 matches settled [verified]. Repo 404, no tag and no linked trailer are owner actions still open [verified].
