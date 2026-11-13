# NOXARA

***Only one walks out.***

**A 3-minute top-down battle royale on a tiny island at dusk: you against 9 AI fighters who are persistent characters with their own NEAR wallets.** They pay to enter, keep what they win, buy upgrades that change how they fight, and retire when they go broke — a rookie takes the empty slot. The richest one carries a bounty. Players can sponsor a fighter and share its winnings. No dev patch needed: the economy moves on its own.

Track: **Games** (NEAR HACKATHON). Status: **playable on NEAR testnet** — every match is seeded on chain, re-verified by replaying its inputs, and settled on chain. Token: **Nox (NOX)**, play-money only.

## Play (localhost)
```bash
npm install
npm run dev            # http://127.0.0.1:5180
npm start --prefix relayer   # optional: match server + relayer (needs .env from .env.example); without it the game runs offline
```
Press **PLAY**. No wallet, no sign-up, no popups. Add `?offline` to the URL for local practice with nothing recorded.

| Do | See |
|---|---|
| WASD / arrows to move, mouse to aim, hold click to shoot (phone: left stick moves, right stick aims + fires) | Your fighter with a ring under it; shots, muzzle flashes, damage numbers, screen shake |
| Walk into a crate with a gold beam | It bursts: blaster, shotgun, sniper or grenades |
| Step into a bush | "HIDDEN": enemies can't see you unless they're very close or you shoot |
| Watch the glowing wall | The storm shrinks toward the next circle; outside it you take damage |
| Find the crown | The bounty carrier — the richest fighter. Killing it pays its bounty |
| Last one standing | Your place out of 10, kills, damage; the ledger shows every fighter's wallet change, then **Verified** once the match is settled on chain |
| Open **Fighters** | Each fighter's wallet, record, upgrades and story; the **Hall of the Broke** lists retired fighters and the rookies who replaced them |
| Open **Leaderboard** | Top fighters and players by wins, kills, earnings |
| **Sign in** with a NEAR wallet (one approval, then gasless) | A one-time welcome entry credit (pays entry fees only, not transferable), XP and unlocks, real NOX prizes |
| **Sponsor** a fighter (signed-in) | You own a share of its bankroll and get 10% of every prize or bounty it wins, split by shares |

Guests play everything but earn **zero** NOX — only signed-in NEAR accounts can earn.

## Why NEAR
- **NPCs with real wallets:** the 9 fighters and the house are real NEAR sub-accounts with **no access keys** — only the contract's rules can move their NOX.
- **Next-block randomness:** `start_match` commits first; the seed is fixed by the next block's randomness (async receipt), so nobody can pick a seed.
- **Invisible chain:** guests get an account from a relayer with function-call keys and NEP-366 meta-transactions — no wallet, no gas, no popups.

## How it's built
- **Deterministic match simulation** (`src/sim/`, pure TypeScript): 20 Hz fixed tick, integer fixed-point math, pre-computed trig tables, one seeded PRNG. The browser renders it at 60 FPS (three.js) with interpolation; Node runs the exact same code.
- **Re-verifiable matches:** a match is its seed + the human's inputs. The match server replays the input log before settling; `npm run verify-match <file>` lets anyone replay it offline and check the result hash.
- **Bots:** utility AIs with personalities (aggressive, camper, sniper, looter, coward, balanced) that loot, rotate with the storm, hide in bushes and steal last hits. Upgrades bought with their winnings change their stats.
- **Contract** (`contracts/royale`, Rust, near-sdk): NOX (NEP-141/145/148), entries/pot/bounty, upgrades, retirements and rookies, sponsorship market, on-chain progression, match history. Details and every testnet tx: `docs/CHAIN.md`.
- **Trust model (honest):** the server computes, the chain records, anyone can re-verify. Settlement proves the result is consistent with the recorded inputs — not that a human played them. NOX is play-money.

## Verify it yourself
```bash
npm test                                   # unit tests: determinism, replay, bots, storm, chests, bushes, progression
npm run verify                             # checks every claim in this README, incl. live testnet reads
npm run verify-match matches/demo-1.json   # PASS: result reproduced from the input log
npm run sim -- 300                         # 300 bot-only matches: no personality wins > 40%
npm run test:e2e                           # a guest plays a full match on desktop + phone, 0 console errors, axe a11y
(cd contracts/royale && cargo test)        # contract unit + sandbox tests
```

## Mainnet
Prepared, not deployed: `docs/MAINNET.md` (accounts, cost, steps, teardown). It goes live only after an independent security audit passes and the owner says yes.

## Credits
Code MIT. 3D models: **Kenney** — Mini Characters, Blaster Kit, Nature Kit (CC0, www.kenney.nl; licences in `public/licenses/`). All sounds are synthesized in code. Built with AI assistance (Claude Code).
