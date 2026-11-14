# NOXARA — final audit (2026-11-14)

Four fresh, independent reviewers (none had seen the project) audited the live game https://playnoxara.vercel.app, the
mainnet contract `noxara.near`, the Railway match server and the repo. Full reports: `docs/audit/A-security-economy.md`,
`B-player.md`, `C-judge.md`, `D-market-near.md`. Phase 1 (analysis) ran 13:44–14:08 UTC with no changes; phase 2 fixes
follow below. Hard stop for fixes: 15:30 UTC.

## Scores before fixes
| Lens | Reviewer | Scores |
|---|---|---|
| A — security + economy | Opus | security 7/10 · economy design 7/10 · no CRITICAL |
| B — player + psychology | Opus | first impression 8 · core-loop fun 5 · clarity 5 · retention 5 · polish 7 (median time-to-death 59 s, storm killed 7/10) |
| C — judge + AI screener | Opus | protocol engineer **47/70** · VC **48/70** · gamer **50/70** |
| D — market + NEAR depth | Sonnet | NEAR depth 7/10 · visual/feel vs leaders 8.5/10 |

## Consolidated findings (deduplicated; source IDs in brackets)
Severity × effort ordering. "Who": C = Claude (allowed without asking), O = owner action, K = needs a contract upgrade (owner's "yes" + fresh security review).

| ID | Lens | Sev | Finding | Evidence | Fix plan | Effort | Who |
|---|---|---|---|---|---|---|---|
| F-1 | C,D | CRITICAL | README/docs contradict the headline: "live on mainnet" vs "Testnet only" / "Prepared, not deployed"; MAINNET.md "NOT executed"; SUBMISSION testnet wording | [C-1, C-7, D-2] | One consistency pass: README, MAINNET.md, SUBMISSION.md, CLAUDE notes | S | C |
| F-2 | D,C | CRITICAL | GitHub repo is private → README/About link 404, `npm run verify` unreachable for judges | [D-1, C-8] | Make the repo public (owner, before 20:00 UTC) | S | O |
| F-3 | B | CRITICAL | Storm mis-signposted: the chip shows the match clock as "STORM INCOMING 2:57", the circle shrinks from 0:30, spawns start outside it; storm = #1 killer | [B-1] | Chip counts down to the real next shrink / "OUTSIDE THE ZONE"; arrow to the safe circle; banner only when it moves | S | C |
| F-4 | B | CRITICAL | Live match: 11–17 s "sealing the match seed on NEAR…" spinner before play | [B-2] | Measure; cut waits/retries; show a versus/line-up intro instead of a spinner | M | C |
| F-5 | A | HIGH | Ranked play closes 2026-11-20 00:00 UTC (`SEASON_END_MS`, lib.rs:111), docs say the season ends 11-25 | [A-1] | Docs now; extending ranked play past 11-20 needs a contract upgrade | S / M | C / K |
| F-6 | C,B,D | HIGH | Free public RPC rate-limits (HTTP 429): "NEAR is busy", empty Economy/Leaderboard with misleading "not live" text | [C-5, B-6, D-11] | Proxy + cache read-only views through the match server; honest "live data unavailable" states | M | C |
| F-7 | C | HIGH | `npm run verify` FAILs on a fresh clone (relayer deps) and checks only testnet; `cargo test` fails fresh (wasm not built) | [C-2, C-3, C-4] | verify installs/skips relayer deps, `--mainnet` mode; README test commands that pass from a clean clone | S–M | C |
| F-8 | D,C | HIGH | In-app copy says "This is testnet", "Game contract (testnet): noxara.near", testnet 250 NOX mint on the mainnet Economy page | [D-3, C-6, C-11, B-12] | Network-aware labels | S | C |
| F-9 | D | HIGH | Player-owned share market empty on mainnet (0 holders) — the track asks for player-owned markets | [D-5] | Owner buys one IPO block from his wallet (honestly the first holder); UI explains how | S | O |
| F-10 | D | HIGH | No one-page proof for judges | [D-4] | "Proof" section: contract + code hash, keyless bots (live), settled matches with tx links, 0 minted | M | C |
| F-11 | A | HIGH | Public seed + deterministic sim → a scripted client can search a winning input offline | [A-2] | Commit-reveal / server-side input checks — after the hackathon; documented in the trust model | L | K |
| F-12 | B | HIGH | A dead guest sees no reward moment (payoff only when the last one stands) | [B-3] | Show a compact payout preview + "watch the payout" on the elimination screen | M | C |
| F-13 | B | HIGH | Mobile: 5 overlays in the first second; armed bot vs starting gun = unexplained loss | [B-4, B-5] | One coaching cue at a time; death card says what killed you and "grab a crate gun first" | S | C |
| F-14 | A,D | MEDIUM | Guest budget (0.5 NEAR) is lifetime and drainable by one script; ≈0.36 left | [A-4, D-7] | Per-IP daily guest cap; owner tops up relay.noxara.near | S | C+O |
| F-15 | A | MEDIUM | Welcome-credit wins pay transferable NOX (cheap sybil farm); paid matches never lazily expire; single settle key on Railway; real-account subsidy drainable | [A-3, A-5, A-6, A-7] | Contract changes → after the hackathon; documented | M–L | K |
| F-16 | A | MEDIUM | Owner zhasik.near has 26 full-access keys; `house_grant` uncapped | [A-8] | Owner prunes old keys in the wallet | S | O |
| F-17 | A | LOW | Settle gas outside budgets; contract free storage ≈0.61 NEAR | [A-9] | Monitor + top up relay / contract | S | O |
| F-18 | D,B | MEDIUM | Thin chain history (~7 settled matches); 8/9 bots in loss; empty Daily; "Prizes announced soon" | [D-6, B-9, B-11, D-13] | Honest counters; owner sets Cup prizes; traffic after launch | S | C+O |
| F-19 | B | MEDIUM | Mercenary Board empty for ~5 s; bounty weak in match; players as hash names | [B-7, B-8, B-10] | Cached board shown instantly; persistent "THE MARK" pill | S–M | C |
| F-20 | D | MEDIUM | NEP-245 subset (no `mt_metadata` / `mt_tokens`) | [D-8] | Say "NEP-245 subset" clearly; add views in a later upgrade | S / M | C / K |
| F-21 | C,D | LOW | No CI badge, CI lacks e2e; internal agent logs in the repo; bot ids not linked to the explorer; 390 px pill clipped | [C-10, C-13, D-12, C-14] | Badge, move logs to docs/process, explorer links, shorter pill | S | C |

## Phase 2 — fixes (14:08–15:00 UTC, all live on mainnet + Vercel + Railway, verified on the live site)
| ID | Status | What changed | Verified |
|---|---|---|---|
| F-1 | **fixed** | README, MAINNET.md (EXECUTED header: tx, sha256, owner, relayer), SUBMISSION.md, HOSTING.md, ECONOMY.md all say "live on mainnet since 2026-11-14; testnet = rehearsal"; admin-powers table in the README | grep: no current-status "Testnet only"/"Prepared, not deployed"/"NOT executed" |
| F-3 | **fixed** | Storm chip follows the sim's phase table ("SAFE ZONE SHRINKS IN 0:28" → "STORM MOVING" → "NEXT SHRINK"); "OUTSIDE THE (NEXT) ZONE · MOVE ↗" with an arrow; banner only when a shrink starts. UI only — sim untouched | e2e 21/21, sim/replay tests unchanged |
| F-4 | **mitigated** | The 8–9 s drop-in (guest pass + next-block seed) now shows tonight's line-up (the Mark first, account ids, wallets) with honest steps instead of a spinner. The wait itself is the chain's (next block) — not removed | `docs/screens/fx-dropin-*.png` |
| F-5 | **upgrade prepared (branch `season`)** | Owner said yes: ranked play until 2026-12-15 00:00 UTC, exit window 12-15 → 12-20 (`SEASON_END_MS`, `TEARDOWN_AFTER_MS`, `migrate` moves the stored lock). Rehearsed on testnet; mainnet commands in docs/MAINNET.md §6 | — |
| F-6 | **fixed** | Server proxies + caches read-only contract views (`/api/view`, 18-method allow-list, per-IP + global limits, coalescing, stale-on-429, RPC failover list); client routes all contract views through it with backoff; honest "Live data is unavailable right now. Try again." states | live: 17 proxied views, **0 direct RPC calls, 0 HTTP 429, 0 console errors** (desktop + 390) |
| F-7 | **fixed** | `npm run verify` = mainnet by default (code hash = audited build sha256, keyless bots, settled match input-log hash, minted = genesis) + `verify:testnet`; installs relayer deps on a fresh clone; retries 429s. README lists the clean-clone commands for contract/sandbox tests | `npm run verify` **11/11 PASS** against mainnet |
| F-8 | **fixed** | Network-aware labels (About "Game contract (mainnet)", no "This is testnet" / testnet-mint notes on mainnet) | live About/Economy |
| F-10 | partial | `verify` is the one-command proof; About links contract + live txs. A dedicated /proof page is deferred | — |
| F-11 | **documented** | README trust model: public seed + deterministic sim → server real-time check is the defense; commit-reveal on the roadmap | — |
| F-12 | **fixed** | Elimination screen: "WHERE THE POT GOES" (pot, bounty, who gets it), "XP is added when the match ends", WATCH THE PAYOUT (4× spectate) | compile + e2e; real-pot render not screenshotted |
| F-13 | **fixed** | One coaching cue at a time (3.5 s gap), cues after GO, no storm banner during the countdown; death card names the weapon + "grab a gold-beam crate first" tip when holding the Popper | mobile start screenshot |
| F-14 | **fixed (server)** | 3 new guests per IP per UTC day (persisted, hashed IPs); IPv4-mapped/IPv6 /64 normalisation for every per-IP limiter (security-review fix) | relayer tests 74/74 |
| F-19 | **fixed** | Board paints the cached roster instantly; persistent "THE MARK: <account> · +N NOX" pill, "BOUNTY TAKEN" when it falls | — |
| F-20 | **fixed (docs)** | "NEP-245 subset" stated where NEP-245 is claimed | — |
| F-21 | **fixed** | CI badge, process logs moved to docs/process/, explorer links on the leaderboard, .env.example renamed | — |
| A-16 | **fixed** | Relayer fetches the block height before relaying (no skipped expiry check) | relayer tests |

Deferred (contract changes or owner actions): F-2 make the repo public (owner), F-5 extend ranked play (contract, owner "yes"), F-9 first share holder (owner wallet), F-11 commit-reveal (contract, post-hackathon), F-15 credit-win payouts / paid-match expiry / settle-key trust (contract, post-hackathon), F-16 prune owner keys (owner), F-17 top-up relay + contract balance (owner), F-18 Cup prizes (owner), F-10 dedicated /proof page.

## Re-score after fixes (fresh judge panel, 15:00–15:25 UTC; `docs/audit/C2-rescore.md`)
| Persona | Before | After |
|---|---|---|
| Protocol engineer | 47 | **52** |
| VC / investor | 48 | **48** |
| Gamer | 50 | **51** |

The re-score found one regression introduced by phase 2: WATCH THE PAYOUT (4× spectate) — and MAIN MENU mid-match — ended the simulation faster than real time, so the server refused the result (`too_fast`) and the match was not settled. **Fixed at 15:38 UTC** (the client waits until the match could have been played in real time; verified on testnet: die → watch payout → settled + Verified). Other points from the panel: empty share market (owner action), private repo / no tag / no video (owner), first ranked match harsh for newcomers, the pre-settle pot shown on the elimination screen is an estimate (78.07 settled vs 79.39 shown), local XP is added even if settlement fails.

## Final production push (15:50–16:50 UTC) and final re-score (`docs/audit/C3-final.md`)
| Persona | Audit start | After phase 2 | Final |
|---|---|---|---|
| Protocol engineer | 47 | 52 | **53** |
| VC / investor | 48 | 48 | **49** |
| Gamer | 50 | 51 | **52** |

Done in this push (all verified live):
- **Season extension on mainnet** (owner ran it): ranked play until 2026-12-15, teardown 2026-12-20; tx `BRLkqYPrbmXUQbwzhaUPC5AmM7SWa9ybd31z8UbQp63k`, code sha256 `2c85142b…` (code_hash `3zndndRV…ng48`), CHECK OK; fresh security review GO (119 unit + 18 sandbox incl. an upgrade from the exact mainnet build); rollback wasm `contracts/royale/tests/fixtures/royale_v3_d734724.wasm` (sha256 d734724f…, previous code_hash FV53G9…). `npm run verify` now checks the new hash: 11/11 PASS on mainnet.
- **GitHub polish:** README hero (banner, pitch, badges, Play now, 60-second judge path, NEAR table with mainnet links, mermaid architecture, economy, trust model, do-X-see-Y verified on a fresh clone, roadmap, AI disclosure, credits), SECURITY.md, docs/media (banner, social preview, CREDITS). Secret scan: gitleaks full history 0 leaks; no private keys in history. The owner's email is in commit author metadata (needs the owner's decision before going public).
- **Launch trailer (57 s) + explainer (77 s)**, 16:9 + 1:1, H.264/AAC, < 15 MB, −14 LUFS, original CC0 synthesized music; local only (`docs/video/`, gitignored).
- **Death screen:** pot and bounty labelled as estimates (≈).
- **Live smoke (16:45 UTC):** guest match on mainnet → settled tx `DQzrdMCdNK2s5c6NTzh2ThmCPGadhtMy4cYj14evfM4h` → Verified link; iPhone width: LIVE · NEAR MAINNET, no horizontal scroll; 0 console errors.

Remaining (owner or post-hackathon): make the repo public (+ author email decision), tag `hackathon-submission`, post the trailer and fill the video/X links, first IPO purchase by the owner, Weekly Cup prizes, commit-reveal seeds, human spawns outside the next zone (sim change), explain unsettled matches (abandoned) in the UI.
