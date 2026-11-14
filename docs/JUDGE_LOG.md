# Cold-judge log

Fresh subagent each time; it sees only the README, the running build and the track text.

| When (UTC) | Build | Verdict | Tech | Orig | NEAR | Demo | Pack | Fit | Main | /70 |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-13 ~15:45 | T1 (c50530a), no chain in browser | "Somewhat fun"; real-game feel 6/10 | 7 | 6 | 2 | 7 | 7 | 4 | 6 | **39** |

## T1 — top weaknesses → fixes (assigned to Agent A, T2 round)
1. Economy/bounty invisible → post-match ledger (winner, pot, bounty, per-bot payouts/upgrades/retirements), wallets on the title/lobby.
2. Storm damage unreadable/brutal → red edge vignette + tick sound + self damage numbers + slower ramp + arrow to safe zone.
3. Hits without knowing from where → directional damage indicators, longer incoming tracers.
4. Popper partial-mag idle reload → auto-reload when not firing.
5. Lootable vs solid crates look the same → distinct chest model/colour, more chests near spawns.
Bugs: stray click leaves the death screen; spectate has no exit; spectate HUD shows the bot's weapon/HP unlabeled; name tags draw over the HUD; results never name the winner; 390 px weapon panel covers the SPECTATING banner.
Strong: instant start, bush/HIDDEN mechanic, named bots + crown, native-feeling phone layout.
| 2026-11-13 ~16:40 | T2 (b3e7d07), chain in browser (testnet) | "Somewhat fun"; real-game feel 7/10; economy visible across matches (wallets, retirements, rookies, bounty) | 8 | 7 | 7 | 7 | 7 | 6 | 4 | **46** |

## T2 — top weaknesses → fixes (assigned for T3)
1. Player has no stake / no sign-in → sign-in + sponsorship market (C contract, A UI — merged UI f455659).
2. No player-owned market → sponsorship (back a bot, share winnings, lose on retirement) — C.
3. Rich get richer (Pep ~50% wins in 6) → progressive entry fee by wealth (C), bounty carrier visible on the minimap (A).
4. Early lethality (spawn three-ways, weak Popper) → spawn spacing + 3 s spawn protection + Popper buff (B, SIM_VERSION r5).
5. Clarity → unique names (C migration), ROOKIE badge only for the first few matches + lobby change feed "+/-" (A), mobile portrait zoom-out (A).
Bugs: results flip from "Pot → You" to "House" for guests (A: pending state, guests never shown as pot receiver); duplicate wallet link (A); broke bot (0 $BOUNTY) played one more match (C); lobby background names ≠ roster (A); README stale (lead).
Note: the judge saw matches auto-start twice without input — likely another controller sharing the MCP browser; not reproduced idle for 70 s.

## Cold judge #3 — 2026-11-13 ~22:40 UTC (after economy v2, daily rewards, aim assist, menu, challenge/daily)
| Tech | Orig | NEAR | Demo | Pack | Fit | Main | Total |
|---|---|---|---|---|---|---|---|
| 8 | 7 | 9 | 7 | 8 | 8 | 6 | **53/70** (was 46) |

Top weaknesses → action:
1. Supply card said "minted after: 250" vs "nothing minted" → explained (v1 minted 250 before the v2 upgrade on testnet), verify now checks 0 minted since v2 — fixed (05b3128).
2. Newcomers die helpless; own fighter hard to read → player highlight, first-match coaching cues (helper, ovn-judge). Bot difficulty for first matches would need a sim change → left as a recommendation.
3. Exit → 409 → silent offline with a stale roster; menu says PAUSED while running → retry + clear toast + cached roster; MENU title (helper).
4. Money doesn't reconcile across screens (pot, bounty + House bonus); explorer shows the old "BOUNTY" label → end-screen breakdown (helper); explorer note in CHAIN.md (fixed).
5. Market invisible to guests; same IPO for veterans; raw story log → "if you owned 10%" preview + story summary (helper); IPO wording fixed.
Strengths: chain claims real and checkable (next-block seed, replay, settle, keyless bots, NEP-366); presentation; track fit.

## Cold judge #4 — 2026-11-13 ~23:55 UTC (after judge #3 fixes + training island)
| Tech | Orig | NEAR | Demo | Pack | Fit | Main | Total |
|---|---|---|---|---|---|---|---|
| 9 | 7 | 8 | 7 | 8 | 8 | 8 | **55/70** (46 → 53 → 55) |

Weaknesses → action:
1. Nearblocks shows "Bounty (BOUNTY)" — the explorer's cached metadata; on-chain `ft_metadata` is Nox/NOX (documented in CHAIN.md). A mainnet deploy starts clean.
2. Storm death confusing → warning now says "OUTSIDE THE ZONE · −X HP/s · GET TO THE CIRCLE" (+ red vignette already there).
3. Ledger contradictions → the pot estimate uses the live House top-up (get_economy), the breakdown explains burn/cut, the bounty line says what really happened ("Nobody claimed X's bounty" / "X won and kept the bounty").
4. README vs live data → shares (1,000 per fighter, 300 in the IPO), minting (v1 legacy 250 explained, verify checks 0 since), example account fixed.
5. Fan ownership invisible to guests; challenge link uses the play-test LAN address; og:image relative → read-only "if you owned 10%" preview exists on profiles; a public base URL needs hosting (owner decision) — `VITE_PUBLIC_URL` makes og absolute at build.

## Cold judge #5 — 2026-11-14 ~07:40 UTC (after playtest rounds 2–3)
**56/70** — Tech 9 · Orig 7 · NEAR 8 · Demo 9 · Pack 8 · Fit 8 · Main 7 (was 55).
Strongest: the verifiable loop is visible end to end (sealed seed → money flow → Verified settle tx); the NPC economy feels alive (WANTED Mark, Hall of the Broke, rookies); polish (0 console errors, no horizontal scroll at 390 px).
Top weaknesses → action:
1. Player-owned share market empty (0 holders/trades) → not fixed before the 10:00 stop (needs real players; no fake trades). Owner can buy an IPO block from his own wallet on mainnet as the first real holder.
2. End-screen headline showed the winner's account id instead of the name; "$NOX" vs "NOX" → **fixed** (names in headlines, the id as its own link; "NOX" everywhere).
3. Difficulty cliff training → real match; guests' impact on bot wallets not explained → not fixed (round-2 hard stop).
4. ECONOMY "monthly report" with 2-day seasons → **fixed** ("season report"); quiet world between sessions → not fixed.
5. WANTED bounty badge clipped at 1440×900; mobile tab row cut off; coming-soon buttons in prime space → **fixed** (all modes in one row, quieter roadmap buttons; tabs wrap on phones).
