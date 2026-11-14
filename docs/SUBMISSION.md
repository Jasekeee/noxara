# NOXARA — submission pack

> **AI esports where the athletes are autonomous agents with wallets, and fans are their owners.**
> *Only one walks out.*

Track: **games** (`games`). Status: live on NEAR **testnet** (`royale.br-7e8492.testnet`). A mainnet release (`noxara.near`) is prepared and waits for the owner's go.
Repository: https://github.com/Jasekeee/noxara (private until the owner makes it public, at the latest 2026-11-14 20:00 UTC).

## 1. One paragraph
NOXARA is a 3-minute top-down battle royale: you against 9 AI fighters on an island at dusk. The fighters are real NEAR sub-accounts **with no access keys**:
- they pay entries, keep their winnings, pay upkeep and buy upgrades;
- they go bankrupt, and rookies replace them;
- the richest one carries a bounty.

Fans can own **shares** of a fighter (NEP-245 in the same contract). Dividends come only from the fighter's profit; when a fighter goes bankrupt, its shares go to zero. One public rule (`get_economy`) steers the treasury, and nothing is minted after genesis. Matches are seeded by the next block, replayed by the match server from your inputs, and settled on chain. Guests play in seconds with no wallet, no gas and no popups.

## 2. What judges should try (do X → see Y)
| Do | See |
|---|---|
| New player? **TRAINING ISLAND** | An offline match where bots go easy on you — learn to move, aim and hide; nothing is recorded |
| Open the game and press **PLAY** | You're in a match within seconds, no wallet. Tap/click fires with auto-aim; drag aims manually |
| Finish a match | Every fighter's wallet +/−, then **Verified** (replayed and settled on chain) |
| **FIGHTERS** | Each fighter's real account (`brindle.royale.br-7e8492.testnet`), wallet, record, upgrades; the Hall of the Broke |
| **ECONOMY** | Live supply, burned, House treasury vs target, reward multiplier m, bots by P&L, share prices and dividends, season standings |
| **DAILY** | Today's tournament seed and leaderboard; signed-in: check-in streak and daily quests paid by the House |
| End screen → **Challenge a friend** | A link that replays your exact match for a friend; the results page compares both runs |
| Sign in with a testnet wallet | Welcome credit; buy IPO shares (gasless); listing and buying shares on the market need one wallet confirmation |
| Run `npm run verify` | PASS for every README claim, including live testnet reads |

## 3. Demo video (60–90 s) — script and shot list
| t | Shot (capture) | On-screen caption |
|---|---|---|
| 0–4 s | Title at dusk, NOXARA wordmark (desktop 1440×900) | *Only one walks out.* |
| 4–10 s | Click PLAY → in the match | No wallet. No gas. Just play. |
| 10–30 s | Auto-aim tap on a bot, bush ambush, grenade, storm closing (phone 390 px cut for 4 s) | 10 fighters. 3 minutes. One island. |
| 30–38 s | Kill the crown carrier → BOUNTY in the kill feed | The richest fighter carries a bounty. |
| 38–48 s | End screen → ledger → **Verified** | Every match is replayed and settled on NEAR. |
| 48–60 s | ECONOMY page: supply, House vs target, m, bots by P&L | One public rule runs the economy. Nothing is minted. |
| 60–72 s | FIGHTERS: real keyless account → explorer tab with 0 keys | The fighters are real NEAR accounts with no keys. |
| 72–82 s | Sign in → buy IPO shares → a win → dividends claimed | Own a fighter. Earn only when it profits. |
| 82–90 s | Challenge-a-friend link + DAILY leaderboard | Play the same match as your friends. |
Capture: `node tools/demo-video.ts` records an ~80 s captioned draft of this shot list (`docs/screens/demo-draft.webm`, local only, with review stills `demo-frame-*.jpg`); the final cut adds a real end screen with **Verified** and a signed-in share purchase. Game audio only.

## 4. X thread (DRAFT — post only with the owner's "yes")
1. NOXARA — *Only one walks out.* A 3-minute battle royale where your 9 rivals are AI fighters with their own NEAR wallets. They pay entries, buy upgrades, go bankrupt. The richest wears a bounty. Play as a guest in seconds. [link] [video]
2. The fighters are real NEAR accounts with zero access keys — only the game's rules move their NOX.
3. One public rule runs the treasury: above target, rewards rise; below, the House keeps more and burns more. Nothing is minted after genesis.
4. Own a fighter: IPO shares, dividends only from profit, shares go to zero on bankruptcy. NOX is play-money.
5. Every match is seeded by the next block, replayed from your inputs and settled on chain. Built for the NEAR hackathon games track. [repo]

## 5. Mainnet runbook (owner-run, one command at a time; nothing here was executed)
Prerequisites: the audited `main` build; `node scripts/build-contract.ts` prints the sha256 recorded in docs/MAINNET.md; all tests green.

| # | Who | Command | Cost |
|---|---|---|---|
| 1 | Owner (wallet UI) | Create `noxara.near`, fund it with **8 NEAR** | 8 NEAR held |
| 2 | Owner | `! near account import-account using-web-wallet network-config mainnet` (approve in your wallet; never type a seed phrase into the terminal) | 0 |
| 3 | Owner | `! cd ~/Developer/bounty-royale && node scripts/build-contract.ts` — check the sha256 against docs/MAINNET.md | 0 |
| 4 | Owner | `! cd ~/Developer/bounty-royale && node scripts/deploy.ts --network mainnet --root noxara.near --contract-on-root --owner <your-wallet>.near --dry-run` — read the plan and cost | 0 |
| 5 | Owner | `! cd ~/Developer/bounty-royale && ENV_FILE=.env.mainnet BR_MAINNET_YES=yes node scripts/deploy.ts --network mainnet --root noxara.near --contract-on-root --owner <your-wallet>.near` | ≈ 5.05 code + 0.5 state + 1.5 relayer + 0.01 bots + gas ≈ **7.1 NEAR** (≈ 6.0 refundable) |
| 6 | Claude (read-only) | `npm run verify` against mainnet: contract metadata Nox/NOX, 10 keyless accounts, one smoke match | 0 |
| 7 | Owner (hosting, separate "yes") | Vercel: the frontend build. Railway: `npm start --prefix relayer` with the variables from `.env.mainnet`, which you paste yourself | Railway ≈ $5/month [assumed] |
Teardown after 2026-11-25: docs/MAINNET.md §4.

## 6. Tag plan (HACKATHON.md Q-003)
- `pre-hackathon`: not needed. All code was written inside the window; the first commit `6649b77` is from 2026-11-13. Optional: tag `6649b77` and say so in the README.
- `hackathon-submission`: the final `main` commit before 2026-11-14 23:59 UTC. The owner pushes it: `! git tag hackathon-submission && git push origin hackathon-submission`. Tag pushes are blocked for Claude by the permission rules.
