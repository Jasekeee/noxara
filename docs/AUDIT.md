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

## Phase 2 — fixes
(filled in as they land)
