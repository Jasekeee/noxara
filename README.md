# BOUNTY ROYALE

**A 3-minute top-down battle royale on a tiny island: you against 9 AI fighters who are persistent characters with their own NEAR wallets.** They pay to enter, keep what they win, buy upgrades that change how they fight, and retire when they go broke. The richest one carries a bounty.

Track: **Games** (NEAR HACKATHON). Status: **T1 first playable** (the game itself, no chain in the browser yet); the contract, bot wallets and verifying match server are on testnet and being wired in (T2).

## Play (localhost)
```bash
npm install
npm run dev            # http://127.0.0.1:5180
```
Press **PLAY**. No wallet, no sign-up.

| Do | See |
|---|---|
| WASD / arrows to move, mouse to aim, hold click to shoot (phone: left stick moves, right stick aims + fires) | Your fighter runs with a ring under it; shots, muzzle flashes, damage numbers |
| Walk into a crate with a gold beam | It bursts: you get a blaster, shotgun, sniper or grenades |
| Step into a bush | "HIDDEN": enemies can't see you unless they're very close or you shoot |
| Watch the purple wall | The storm shrinks toward the next circle (white ring); outside it you take damage |
| Find the crown | The bounty carrier: killing it pays its bounty |
| Last one standing | "LAST ONE STANDING" / your place out of 10, kills, damage |

## How it's built
- **Deterministic match simulation** (`src/sim/`, pure TypeScript): 20 Hz fixed tick, integer fixed-point math, pre-computed trig tables, one seeded PRNG — no `Math.random`, no floating trig. The browser renders it at 60 FPS with interpolation; Node runs the exact same code.
- **Anyone can re-verify a match offline:** every match is recorded as its seed + the human's inputs. `npm run verify-match <file>` replays it and checks the result hash, winner and placements. A match played in the browser replays bit-for-bit in Node (checked).
- **Bots** are utility AIs with personalities (aggressive, camper, sniper, looter, coward, balanced): they loot, rotate with the storm, hide in bushes, pick favourable fights and steal last hits.
- **Chain (testnet, T2):** contract `royale.br-7e8492.testnet` — 9 bot fighters are real sub-accounts with **no access keys** (only game rules move their $BOUNTY), entries/pot/bounty/upgrades/retirement, seed from the next block, and a match server that **re-runs the match from its input log before settling**. Trust model: the server computes, the chain records, anyone can re-verify any match offline. Details: `docs/CHAIN.md`.

## Verify it yourself
```bash
npm test                                   # 38 unit tests: determinism, replay, bots, storm, chests, bushes
npm run verify-match matches/demo-1.json   # PASS: result reproduced from the input log
npm run sim -- 300                         # 300 bot-only matches: no personality wins > 40%
npm run test:e2e                           # a guest plays a full match on desktop + phone, 0 console errors, axe a11y
```

## Credits
Code MIT. 3D models: **Kenney** — Mini Characters, Blaster Kit, Nature Kit (CC0, www.kenney.nl; licences in `public/licenses/`). All sounds are synthesized in code. Built with AI assistance (Claude Code).
