# NOXARA — project rules for Claude

*Only one walks out.* (Renamed from BOUNTY ROYALE on 2026-11-13; token **Nox / NOX**, formerly $BOUNTY. The in-game bounty mechanic keeps its name.)

NEAR HACKATHON entry. Primary track: **games** (memecoins optional, don't optimize for it). The owner is not a developer: Claude writes all code. Quality bar: feels like a Brawl Stars / Fortnite slice, not a web demo.

## Hard rules
- **NOXARA is live on NEAR mainnet (`noxara.near`, since 2026-11-14); testnet is the rehearsal environment.** No further mainnet changes, `git push`, repo creation, hosting deploy or posts without the owner's explicit "yes".
- Never ask for or read seed phrases / mnemonics. Never read `~/.near-credentials/mainnet`. Secrets only in `.env` (gitignored).
- **No mainnet keys exist on this machine** until the owner imports them for the final deploy. If any mainnet credential appears in `~/.near-credentials` or `.env*` before that, stop and tell the owner (check names only, never print key material).
- Do not send users' data to NEAR AI or any external AI service.
- Assets: CC0 only (Kenney 3D kits, jsfxr / synthesized sound). No Brawl Stars / Fortnite assets or look-alike characters.
- **Do not modify the earlier HOARD prototype (separate repo)** (fallback). Copy what is needed from it.
- Mark claims **[verified]** / **[assumed]**. No fake precision. Reports to the owner: Russian, tables.

## Deadlines
- T1 first playable (no chain): **2026-11-13 18:00 UTC** — desktop + mobile screenshots, Playwright video, cold-judge "is this fun?".
- T2: **2026-11-14 01:00 UTC**. T3: **2026-11-14 07:00 UTC**. Final: **2026-11-14 23:59 UTC**.

## Track text (verbatim)
games: "Build NPCs with wallets, player-owned markets and economies that evolve without a dev patch. Judged on the game loop, not the token — bonus if players never notice the chain."

## The game
- 3D stylized top-down battle royale, angled camera. 3-minute matches. 10 fighters on a small island: you + 9 AI fighters.
- Bushes hide you; chests give weapons (blaster, shotgun, sniper, grenade); heal pickups; a shrinking storm. Last one standing wins the pot.
- The 9 AI fighters are **persistent characters** with names, personalities (aggressive, camper, sniper, looter, coward…) and their own NEAR accounts and NOX wallets. They pay entry from their wallet, keep winnings, buy upgrades (weapon tiers, armor, skins) that change how they play. Rich bots get stronger; broke bots retire and a rookie replaces them. No dev patch.
- **Bounty:** the richest bot carries a bounty; killing it pays the bounty (map marker, kill feed).
- **Sponsors (player-owned market):** players back a bot with stake and share its future winnings.
- Progression like Clash Royale: unlock/upgrade weapons between matches.
- Chain invisible: guest plays in <30 s, no wallet popups, no gas. Guests: leaderboards, ZERO tokens. Only real NEAR accounts earn.

## Architecture
- Three.js (pinned) + Vite + TypeScript. Kenney CC0 3D kits (Blaster Kit, Nature/Platformer, Mini/Animated Characters, Particle Pack) + synthesized sfx.
- **Deterministic match simulation** in `src/sim/` (pure TS, no DOM): fixed tick (20 Hz), seeded PRNG only (never `Math.random`), integer/fixed-point math and table trig (no `Math.sin/cos/atan2` in the sim), recorded player inputs. Runs in the browser (render interpolates to 60 FPS) and in Node (match server / verifier). `npm run verify-match <id>` replays the input log and reproduces the result hash.
- On chain (testnet): `start_match` (seed from next-block randomness), `settle_match(result, input-log hash)` signed by the match-server key; bot wallets, bounty, sponsorship shares, upgrades. Trust model stated honestly in README: the server computes, the chain records, anyone can re-verify any match offline.
- **`SIM_VERSION` in `src/sim/types.ts` must be bumped on ANY change to sim rules/AI/mapgen/numbers**; the match server refuses records from another version.
- Bot AI: utility AI per personality (loot, chase, kite, hide in bushes, flee storm, third-party fights). Upgrades change stats and behaviour.
- Reuse from the earlier HOARD prototype (separate repo) (copy, don't modify): relayer (NEP-366, guest FC keys, signature + key-owner checks, gas budgets), NEP-141 token code, next-block randomness pattern, NPC sub-accounts with no keys.

## Tiers (each playable; never break a working tier; cut T3 before T1/T2 quality)
- **T1:** island, WASD/arrows + mouse aim + click shoot (twin-stick touch on mobile), 3 weapons from chests, bushes hide, 9 bots with basic AI, storm, kill feed, win/lose screen, hit flashes, muzzle flash, damage numbers, screen shake, basic sounds, 60 FPS on a mid laptop. No chain.
- **T2:** personalities + persistent bot wallets on testnet, entry/pot/winnings, bounty, upgrades, guest flow via relayer, settlement + verify-match, juice + sound pass, balance sim (1,000 headless bot-only matches: no personality wins >40%).
- **T3:** sponsorship market, player progression, "Fighters" page (wallet, record, story per bot), leaderboards, mobile polish, README "do X → see Y" + `npm run verify`, mainnet release plan (steps + NEAR cost) for the owner's "yes".

## Parallel agents
Up to 4 agents, each in its own git worktree/branch, strict file ownership (see `docs/process/OWNERSHIP.md`). The lead integrates: merge every ~2 h, run all tests before merging, nobody edits another agent's files. Shared interfaces live in `src/sim/types.ts` and are changed only by the lead.

## Quality gates
0 console errors · Playwright "guest opens → plays a full match" passes · Lighthouse accessibility ≥95 (performance ≥80 for 3D) · all tests green · first match understandable with zero text walls (teach by playing) · 60 FPS on a mid laptop.

## Owner decisions (2026-11-13 ~17:50 UTC)
- First $BOUNTY for real players: **welcome stake** — once per real NEAR account, small fixed amount, play-money only; guests get 0.
- Multi-wallet sign-in: `@hot-labs/near-connect` pinned **exactly 0.12.0**.
- Hosting: **Vercel** (frontend) + **Railway** smallest plan (match server + relayer). The owner imports mainnet keys personally.

## Owner decisions (2026-11-13 evening)
- **Rename:** project NOXARA, tagline "Only one walks out.", token name "Nox", symbol NOX. Root `noxara.near` (free as of 2026-11-13, read-only check).
- **Mainnet: YES in the cheapest safe form — prepare, then ask.** Nothing on mainnet until the owner replies **"yes, deploy"**. Plan + costs + teardown: `docs/MAINNET.md`.
  - One contract on the root (game + token); bots = keyless sub-accounts with minimum balance; only root, relay, bots.
  - Guest gas budget 1 NEAR on the relayer, daily guest cap, per-IP limit, clean stop → guests play offline, real accounts still work.
  - Before any mainnet step: fresh security audit; all HIGH/MEDIUM fixed; second audit GO.
  - Ranked season ends 2026-12-15 (extended on mainnet 2026-11-14, tx BRLkqYPrbmXUQbwzhaUPC5AmM7SWa9ybd31z8UbQp63k); teardown from 2026-12-20 returns refundable storage to the owner's wallet.
- Welcome stake = a one-time, non-transferable **entry credit** (30) per real account that registers itself or via the relayer; never guests.

## Owner decisions (2026-11-14 ~00:45 UTC)
- **Fallback:** if mainnet is not live and stable by **2026-11-14 15:00 UTC**, submit the testnet version; add mainnet later only if time allows.
- **Contract keys stay** (not removed): bug fixes during judging + account deletion after 2026-12-20 to refund storage. README must disclose: the developer holds the key for fixes during judging; no method in the deployed code can move players' tokens; list every admin method with what it can and cannot do; and say plainly that the key holder could deploy new code (the honest limit of that promise).
- Next feature after current tasks are green (≤3 h, ≤1 helper, no sim-core changes): Challenge a friend (shared seed + roster, server-verified replay, X preview), daily tournament (one seed per UTC day, free, play-money NOX prizes, guests earn 0), README roadmap "Live PvP lobbies (humans + AI fighters in one match)". No real-money wagering anywhere.

