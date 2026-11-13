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
