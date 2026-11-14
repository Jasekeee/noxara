# NOXARA — submission pack

> **AI esports where the athletes are autonomous agents with wallets, and fans are their owners.**
> *Only one walks out.*

Track: **games** (`games`). Status: **live on NEAR mainnet** — play at **https://playnoxara.vercel.app** (contract `noxara.near`, deploy tx `BmMiB9ccNQcWkGnFZxCLMG8VQRn7GDBGT1EHXK2r26H6`). The testnet build (`royale.br-7e8492.testnet`) stays up as the rehearsal environment.
Repository: https://github.com/Jasekeee/noxara (private until the owner makes it public, at the latest 2026-11-14 20:00 UTC).

## 0. Submission form — final answers (copy/paste)
| Field | Answer |
|---|---|
| Title | **NOXARA** |
| One-liner | 9 AI mercenaries. Real wallets. One bounty. Only one walks out. |
| Description (short) | A 3-minute battle royale against 9 AI mercenaries whose wallets are real, keyless NEAR accounts. They pay entries, buy upgrades, go broke and get replaced; the richest carries a bounty. Guests play in seconds with no wallet and no gas; every ranked match is replayed by the server and settled on NEAR mainnet (`noxara.near`), where anyone can check it. |
| Description (long) | Use §1 below. |
| Primary track | **Games** — NPCs with wallets and an economy that evolves without a dev patch: the 9 fighters are on-chain businesses (entries, prizes, upkeep, upgrades, bankruptcy → rookie), fans can own NEP-245 shares, and players never touch the chain as guests. |
| Secondary track | **Memecoins** — honest scope: NOX is play-money, not a traded coin; what fits is the mechanic: a treasury that follows one public on-chain rule (`get_economy`) and a supply that only burns after genesis. |
| Live demo | https://playnoxara.vercel.app |
| Repository | https://github.com/Jasekeee/noxara |
| Video | trailer: posted on X by the owner (link added after posting) |
| X post | added after posting |
| Mainnet contract | `noxara.near` — https://nearblocks.io/address/noxara.near (deploy tx `BmMiB9ccNQcWkGnFZxCLMG8VQRn7GDBGT1EHXK2r26H6`; code sha256 `d734724f07c8c0a4de5461d2e72fef86f20ba8c2e0a7960e74c3da8d19057472`) |
| Proof in one command | `npm run verify` → 11/11 PASS on mainnet (code hash = audited build, 9 keyless bots, settled match input-log hash, minted = genesis 2,900) |
| Traction (live, 2026-11-14 15:54 UTC, `get_config` via the match server) | 11 matches started, 7 settled on mainnet; 2,900 NOX minted (genesis only), 162.48 burned |
| AI disclosure | Built by the owner directing Claude Code (Anthropic); all code, tests and docs were generated with AI assistance and reviewed by tests, independent AI security reviews and the owner. Art: Kenney CC0. |

## 1. One paragraph
NOXARA is a 3-minute top-down battle royale: you against 9 AI fighters on an island at dusk. The fighters are real NEAR sub-accounts **with no access keys**:
- they pay entries, keep their winnings, pay upkeep and buy upgrades;
- they go bankrupt, and rookies replace them;
- the richest one carries a bounty.

Fans can own **shares** of a fighter (NEP-245 in the same contract). Dividends come only from the fighter's profit; when a fighter goes bankrupt, its shares go to zero. One public rule (`get_economy`) steers the treasury, and nothing is minted after genesis. Matches are seeded by the next block, replayed by the match server from your inputs, and settled on chain. Guests play in seconds with no wallet, no gas and no popups.

## 2. What to try (do X → see Y)
Judge path: open https://playnoxara.vercel.app, press PLAY as a guest (no wallet), finish a match and look for **Verified**; then FIGHTERS, ECONOMY and the contract `noxara.near` on https://nearblocks.io/address/noxara.near. Mainnet accounts: `noxara.near` (game + NOX), `relay.noxara.near` (relayer + match server), `<fighter>.noxara.near` (keyless fighters), owner `zhasik.near`. Ranked (on-chain) play is open until 2026-11-20 00:00 UTC; practice modes always. The testnet build `royale.br-7e8492.testnet` is the rehearsal environment.
| Do | See |
|---|---|
| **About the game** (title link, in-match menu, or `/?about`) | The pitch, how to play, the economy in plain words, links to the contract and live transactions |
| New player? **TRAINING ISLAND** | An offline match where bots go easy on you — learn to move, aim and hide; nothing is recorded |
| Open the game and press **PLAY** | You're in a match within seconds, no wallet. Click fires toward the mouse; on a phone drag the right stick to aim and fire |
| Finish a match | Every fighter's wallet +/−, then **Verified** (replayed and settled on chain) |
| **FIGHTERS** | Each fighter's real account (`brindle.noxara.near`), wallet, record, upgrades; the Hall of the Broke |
| **ECONOMY** | Live supply, burned, House treasury vs target, reward multiplier m, bots by P&L, share prices and dividends, season standings |
| **DAILY** | Today's tournament seed and leaderboard; signed-in: check-in streak and daily quests paid by the House |
| End screen → **Challenge a friend** | A link that replays your exact match for a friend; the results page compares both runs |
| Sign in with a NEAR (mainnet) wallet | Welcome credit; buy IPO shares (gasless); listing and buying shares on the market need one wallet confirmation |
| Run `npm run verify` | PASS for every README claim, including live chain reads |

## 3. Demo video (60–90 s) — script and shot list
| t | Shot (capture) | On-screen caption |
|---|---|---|
| 0–4 s | Title at dusk, NOXARA wordmark (desktop 1440×900) | *Only one walks out.* |
| 4–10 s | Click PLAY → in the match | No wallet. No gas. Just play. |
| 10–30 s | Manual-aim shot on a bot, bush ambush, grenade, storm closing (phone 390 px cut for 4 s) | 10 fighters. 3 minutes. One island. |
| 30–38 s | Kill the crown carrier → BOUNTY in the kill feed | The richest fighter carries a bounty. |
| 38–48 s | End screen → ledger → **Verified** | Every match is replayed and settled on NEAR. |
| 48–60 s | ECONOMY page: supply, House vs target, m, bots by P&L | One public rule runs the economy. Nothing is minted. |
| 60–72 s | FIGHTERS: real keyless account → explorer tab with 0 keys | The fighters are real NEAR accounts with no keys. |
| 72–82 s | Sign in → buy IPO shares → a win → dividends claimed | Own a fighter. Earn only when it profits. |
| 82–90 s | Challenge-a-friend link + DAILY leaderboard | Play the same match as your friends. |
Capture: `node tools/demo-video.ts` records an ~80 s captioned draft of this shot list (`docs/screens/demo-draft.webm`, local only, with review stills `demo-frame-*.jpg`); the final cut adds a real end screen with **Verified** and a signed-in share purchase. Game audio only.

## 4. X launch thread (DRAFT — the owner posts; nothing is posted by Claude)
1/ NOXARA — 9 AI mercenaries. Real wallets. One bounty. Only one walks out.
A 3-minute battle royale where every rival is an AI fighter with its own NEAR account. Live on mainnet, play as a guest in seconds.
[trailer] https://playnoxara.vercel.app

2/ What's different: the fighters are real, keyless NEAR accounts. They pay entries, keep their winnings, buy upgrades and go broke — then a rookie takes the slot. The richest one wears the crown: take it out and the bounty is yours.

3/ Proof, not promises: every ranked match is replayed by the server from your inputs and settled on NEAR mainnet with its input-log hash (`noxara.near`). Look for "Verified", open the tx on NearBlocks, or run `npm run verify`: 11/11 checks against mainnet.
https://nearblocks.io/address/noxara.near

4/ Play in 10 seconds: open the link, press PLAY. No wallet, no gas — the chain stays out of your way. Code, economy and trust model: https://github.com/Jasekeee/noxara
Built for the NEAR hackathon games track. @NEARProtocol #NEARHackathon

## 5. Mainnet runbook (history: executed by the owner 2026-11-14)
Prerequisites: the audited `main` build; `node scripts/build-contract.ts` prints the sha256 recorded in docs/MAINNET.md; all tests green.

| # | Who | Command | Cost |
|---|---|---|---|
| 1 | Owner (wallet UI) | Create `noxara.near`, fund it with **8 NEAR** | 8 NEAR held |
| 2 | Owner | `! near account import-account using-web-wallet network-config mainnet` (approve in your wallet; never type a seed phrase into the terminal) | 0 |
| 3 | Owner | `! cd <repo> && node scripts/build-contract.ts` — check the sha256 against docs/MAINNET.md | 0 |
| 4 | Owner | `! cd <repo> && node scripts/deploy.ts --network mainnet --root noxara.near --contract-on-root --owner <your-wallet>.near --dry-run` — read the plan and cost | 0 |
| 5 | Owner | `! cd <repo> && ENV_FILE=.env.mainnet BR_MAINNET_YES=yes node scripts/deploy.ts --network mainnet --root noxara.near --contract-on-root --owner <your-wallet>.near` | ≈ 5.05 code + 0.5 state + 1.5 relayer + 0.01 bots + gas ≈ **7.1 NEAR** (≈ 6.0 refundable) |
| 6 | Claude (read-only) | `npm run verify` against mainnet: contract metadata Nox/NOX, 10 keyless accounts, one smoke match | 0 |
| 7 | Owner (hosting) | Step by step in **docs/HOSTING.md**: Railway runs the match server + relayer (`railway.json`; variables incl. `GUEST_VIA_CONTRACT=1`, pasted by you from `.env.mainnet`), Vercel builds the game (`vercel.json`; `VITE_NEAR_NETWORK=mainnet` + `VITE_RELAYER_URL`) | Railway ≈ $5/month [assumed] |
Teardown after 2026-11-25: docs/MAINNET.md §4.

## 6. Tag plan (HACKATHON.md Q-003)
- `pre-hackathon`: not needed. All code was written inside the window; the first commit `6649b77` is from 2026-11-13. Optional: tag `6649b77` and say so in the README.
- `hackathon-submission`: the final `main` commit before 2026-11-14 23:59 UTC. The owner pushes it: `! git tag hackathon-submission && git push origin hackathon-submission`. Tag pushes are blocked for Claude by the permission rules.
