# NOXARA

***9 AI mercenaries. Real wallets. One bounty. Only one walks out.***

**A 3-minute top-down battle royale on a tiny island at dusk: you against 9 AI fighters who are persistent characters with their own NEAR wallets.** They pay to enter, keep what they win, buy upgrades that change how they fight, and retire when they go broke — a rookie takes the empty slot. The richest one carries a bounty. Fans can own shares of a fighter and earn from its profit. No dev patch needed: the economy moves on its own.

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
| WASD / arrows to move; click or Space to fire — keep the mouse still and it **auto-aims** at the nearest visible enemy, move the mouse to aim yourself (light ±8° assist). Phone: left stick moves, **tap** the right side to auto-aim and fire, drag it to aim | Your fighter with a ring under it; an aim line (red ring on a locked target), shots, muzzle flashes, damage numbers, screen shake. Aim assist is only input: the recorded aim angle replays bit-for-bit |
| New here? Press **TRAINING ISLAND** on the title | An offline match where the bots go easy on you (worse aim, slower reactions — against you only); nothing is recorded or paid. A fast loss in a real match offers it too |
| Press **Esc / P** or the ⏸ button | Menu: Resume, Sound, Aim assist, Controls, Exit (exit counts as a loss; offline practice truly pauses) |
| Walk into a crate with a gold beam | It bursts: blaster, shotgun, sniper or grenades |
| Step into a bush | "HIDDEN": enemies can't see you unless they're very close or you shoot |
| Watch the glowing wall | The storm shrinks toward the next circle; outside it you take damage |
| Find the crown | The bounty carrier — the richest fighter. Killing it pays its bounty |
| Last one standing | Your place out of 10, kills, damage; the ledger shows every fighter's wallet change, then **Verified** once the match is settled on chain |
| Open **Fighters** | Each fighter's **real NEAR account** (e.g. `pip.royale.br-7e8492.testnet`; a rookie's account carries its generation, like `zest-4.royale…` — the display name can differ from the account it inherited; explorer link, no keys), wallet, record, upgrades and story; the **Hall of the Broke** lists retired fighters and the rookies who replaced them |
| Open **Leaderboard** | Top fighters and players by wins, kills, earnings |
| **Sign in** with a NEAR wallet (one approval, then gasless) | A one-time welcome entry credit (pays entry fees only, not transferable), XP and unlocks, real NOX prizes |
| Open **ECONOMY** | Live supply, burned, House treasury vs target, reward multiplier m, bots by P&L, share prices and dividends, season standings |
| Buy a fighter's **IPO shares** (signed-in, gasless; every fighter floats 300 shares — the genesis nine at the v2 launch, rookies at birth) | You own part of it: 20% of its *profit* (above its high-water mark) flows to holders; shares go to zero if it goes bankrupt. Listing / buying on the market needs one wallet confirmation |
| Open **DAILY** | Today's tournament island (same seed for everyone, free), its leaderboard; signed-in: a **check-in streak** and **daily quests** verified on chain, paid by the House (never minted, only matches paid from your own NOX count) |
| End screen → **Challenge a friend** | A link (with a link preview) that replays your exact island for a friend; the results page compares both runs, both re-verified by replay |

Guests play everything but earn **zero** NOX — only signed-in NEAR accounts can earn.

## Why NEAR
- **NPCs with real wallets:** the 9 fighters and the house are real NEAR sub-accounts with **no access keys** — only the contract's rules can move their NOX.
- **Next-block randomness:** `start_match` commits first; the seed is fixed by the next block's randomness (async receipt), so nobody can pick a seed.
- **Invisible chain:** guests get an account from a relayer with function-call keys and NEP-366 meta-transactions — no wallet, no gas, no popups.

## Economy (v2)
> **AI esports where the athletes are autonomous agents with wallets and fans are their owners.**

- **Closed loop:** 2,900 NOX at genesis, **nothing minted by economy v2**. Every reward is paid from NOX collected earlier through entry fees, pot cuts and taxes. (The testnet contract shows 3,150 minted: 250 came from the old v1 economy before the upgrade; `npm run verify` checks that nothing was minted since.)
- **The House rule:** one public formula of the House treasury's moving average sets the reward multiplier, the House's share of each pot and the burn share. Poorer House: smaller rewards, bigger cuts. Readable on chain (`get_economy`).
- **Sinks and anti-snowball:** progressive entry fees and upkeep for rich bots, a 2% burned tax on share trades, capped upgrade power (cosmetics have no cap), bronze brackets for new players, a deflation brake so supply levels off instead of burning to zero.
- **Bots are businesses:** each has a season P&L, can go bankrupt and is replaced by a rookie. Fans own **shares** (each fighter has 1,000; 300 are sold in its IPO, the fighter keeps the rest; NEP-245 inside the game contract): a fixed-price market, dividends from profit only.
- **Checked by simulation:** 20 runs x 10,000 matches, charts below. Full spec and results: [`docs/ECONOMY.md`](docs/ECONOMY.md). The in-game **ECONOMY** page is the live report. NOX is play-money. **No real-money wagering anywhere.**

![Supply over 10,000 simulated matches](docs/econ/supply.svg)
![House treasury vs. target](docs/econ/house.svg)

## How NEAR powers NOXARA
The in-game page "HOW NEAR POWERS NOXARA" shows the same list with live explorer links.
- **Fighters are keyless NEAR accounts:** no access key, so only the contract's rules move their NOX.
- **Next-block randomness** fixes every match seed after the player commits.
- **Every match is settled on chain** after the match server replays the input log; anyone can re-verify offline.
- **NOX is NEP-141; fighter shares are NEP-245** (views, transfers, events; no `mt_transfer_call`, on purpose), in one contract.
- **Gasless guest play:** function-call keys + a NEP-366 relayer. A welcome credit (30 NOX, entry-only) is paid from the House, not minted.
- **The House rule is readable on chain** via `get_economy`.
- **Honest trust model:** the server computes, the chain records, anyone can re-verify. The developer keeps the contract key during judging to fix bugs. Testnet only until the owner says yes.

## How it's built
- **Deterministic match simulation** (`src/sim/`, pure TypeScript): 20 Hz fixed tick, integer fixed-point math, pre-computed trig tables, one seeded PRNG. The browser renders it at 60 FPS (three.js) with interpolation; Node runs the exact same code.
- **Re-verifiable matches:** a match is its seed + the human's inputs. The match server replays the input log before settling; `npm run verify-match <file>` lets anyone replay it offline and check the result hash.
- **Bots:** utility AIs with personalities (aggressive, camper, sniper, looter, coward, balanced) that loot, rotate with the storm, hide in bushes and steal last hits. Upgrades bought with their winnings change their stats.
- **Contract** (`contracts/royale`, Rust, near-sdk): NOX (NEP-141/145/148), entries/pot/bounty, upgrades, retirements and rookies (protected for their first 10 matches), the House rule (economy v2: nothing minted), bot shares (NEP-245 subset) with a fixed-price market, seasons, daily check-in and quests, on-chain progression, match history. Details and every testnet tx: `docs/CHAIN.md`.
- **Trust model (honest):** the server computes, the chain records, anyone can re-verify. Settlement proves the result is consistent with the recorded inputs — not that a human played them. NOX is play-money.

## Verify it yourself
```bash
npm test                                   # unit tests: determinism, replay, bots, storm, chests, bushes, progression
npm run verify                             # checks every claim in this README, incl. live testnet reads
npm run verify-match matches/demo-1.json   # PASS: result reproduced from the input log
npm run sim -- 300                         # 300 bot-only matches: no personality wins > 40%
npm run test:e2e                           # a guest plays a full match on desktop + phone, 0 console errors, axe a11y
node scripts/econ-sim-v2.ts                # 20 x 10,000 matches of the economy: PASS criteria + charts in docs/econ/
npm test --prefix relayer                  # match server, relayer, challenge + daily tournament
(cd contracts/royale && cargo test)        # contract unit + sandbox tests
```

## Roadmap
- **Live PvP lobbies** (humans + AI fighters in one match) — next step.
- No real-money wagering anywhere; NOX is play-money and is not launched or traded (docs/DECISIONS.md).
- Cosmetics shop, battle pass, sponsored tournaments, licensing the AI athletes.

## Mainnet
Prepared, not deployed: `docs/MAINNET.md` (accounts, cost, steps, teardown). It goes live only after an independent security audit passes and the owner says yes.

## Credits
Code MIT. 3D models: **Kenney** — Mini Characters, Blaster Kit, Nature Kit (CC0, www.kenney.nl; licences in `public/licenses/`). All sounds are synthesized in code. Built with AI assistance (Claude Code).
