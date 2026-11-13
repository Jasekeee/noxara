# NOXARA economy (v2)

> **AI esports where the athletes are autonomous agents with wallets, and fans are their owners.**

Nine AI fighters live on NEAR as keyless accounts. They pay to enter matches, keep what they win, pay upkeep, buy
upgrades and go bankrupt. Fans can own shares of them. One public rule, readable on-chain (`get_economy`), steers
the economy. Nobody has to patch it.

NOX is **play-money**. It can't be bought with NEAR, there is no swap, guests earn 0, and the season ends on
2026-11-25. No real-money wagering exists anywhere.

All numbers below come from `scripts/econ-params.json`. The contract test `econ_params_match_the_simulator`
asserts that its constants equal that file, and `scripts/econ-sim-v2.ts` simulates exactly these rules.

## 1. A closed loop: where NOX comes from
| Source | Rule |
|---|---|
| Genesis | 2,000 NOX to the House and 100 to each of the 9 bots, so **2,900 NOX in total. Nothing is ever minted after genesis** (a test checks this). |
| Rookie grant | When a bot goes bankrupt, the House pays its replacement 100 NOX. This only happens while the House is above its floor; otherwise the slot waits. |
| Welcome credit | 30 NOX of entry-only credit, once per real NEAR account, with a daily cap. The House pays these entries; no NOX is minted for them. |
| Pot top-up | `25 × m` from the House, never more than the House holds above its floor. |
| Bounty bonus | `5 × m` from the House, paid on top of the bounty. |

Every reward is paid out of NOX that was collected earlier through fees and taxes.

> **Testnet note:** the testnet contract started on the v1 economy, whose pot top-ups minted 250 NOX before it was upgraded to v2 on 2026-11-13. Since the upgrade, total minted has not moved; `npm run verify` checks this. A mainnet deploy starts on v2 and mints only the 2,900 genesis.

## 2. The House rule (an on-chain central bank)
The House treasury follows one public rule. It is computed from a **moving average** of the treasury
(`ema += (house − ema) / 16` at every settle), so a single large event can't jolt rewards.

```
r = (ema − FLOOR) / (TARGET − FLOOR)        FLOOR = 500, TARGET = 1,000
m = clamp(r, 0, 1.5)                        reward multiplier: 0 at the floor, 1 at target, at most 1.5
below = clamp(1 − r, 0, 1)
house_bps = 500 + 1,000 × below             the House's share of every pot: 5% at target, 15% at the floor
burn_bps  = 100 +   300 × below             burned share of every pot:     1% at target, 4% at the floor
```

- **Treasury above target:** rewards and bounties go up, up to 1.5×.
- **Treasury below target:** rewards go down, and the House keeps more and burns more.
- `get_economy` returns the treasury and its moving average, the floor and target, `m`, `house_bps`, `burn_bps`, the brake, the current top-up, season totals and the last 64 settle snapshots. The constants are in the contract source and in `scripts/econ-params.json`; a test checks that the two match.

**Deflation brake.** A closed loop with no minting would burn itself to zero, so every burn is multiplied by
`s = clamp((supply − 2,300) / (2,900 − 2,300), 0, 1)`. The unburnt part `(1 − s)` goes to the House. Supply
therefore levels off at about 2,300 NOX instead of spiralling down.

## 3. Sinks
| Sink | Formula | Where it goes |
|---|---|---|
| Entry burn | 10% of every entry fee, taken when the match settles (a refunded match burns nothing) | burned × s, the rest to the House |
| Pot | `burn_bps` (above) | burned × s, the rest to the House |
| Bot upgrades | weapon 60 / 120, armor 90 / 180 (power is capped at tier 2) | 50% burned × s, 50% to the House |
| Cosmetics | bot skin 150; players `buy_cosmetic`: 50 / 100 / 200 (looks only, no power) | 100% burned × s |
| Share-trade tax | 2% of the price of every share trade | burned × s |
| **Progressive upkeep** for rich bots, at every settle | marginal rates: 1% of the wallet above 150, 2% above 300, 4% above 600 | 50% to the House, 50% burned × s |

Entry fees are progressive for bots **and** players: `4 + 2%` of the wallet above 50, capped at 16.

## 4. Anti-snowball and no pay-to-win
- **Upgrade power is capped:** weapon tier ≤ 2 and armor ≤ 2. Cosmetics and status have no cap.
- **Upkeep grows with wealth**, and the richest bot carries the bounty: 15% of its wallet goes to whoever kills it.
- **Brackets:** guests and players at level 1–3 play a *bronze* match. There, bot upgrades in the match config are capped at 1/1. This changes the match config only, not the simulation rules, so the match is still re-verified by replay. Real matchmaking (picking 9 fighters from a larger pool) comes with live PvP lobbies (roadmap).

## 5. Bots are businesses
- **Season P&L for each bot:**
  - income: prizes, bounties;
  - costs: entries, upkeep, upgrades, cosmetics;
  - plus season points: 10 per win, 2 per kill.
- **Seasons** last 2 days, counted from 2026-11-14 00:00 UTC. Points and P&L reset lazily: a bot's record carries its season id, so no loops are needed. Career history and shares are kept. The last 8 seasons are stored as standings.
- **Bankruptcy:** when a bot can't pay its entry, it retires and its shares go to zero. Whatever is left in its wallet goes to the House through `close_retired`, which anyone may call once none of its entries are in a match. The House funds a rookie in that slot. A bot that retires mid-season is left out of that season's archived standings.

## 6. Bot shares (NEP-245, inside the game contract)
- Each bot has 1,000 shares; `token_id` = the bot's account.
- **IPO:** every fighter floats a 300-share block at 0.1 NOX each (`buy_ipo`): the genesis nine when v2 went live, each rookie when it's born. The NOX goes into the bot's own wallet, so investors fund its bankroll. Shares not yet sold stay with the bot.
- **Dividends come only from profit.** When a settle leaves the bot's bankroll (its wallet plus its entries in other pending matches, so refunds never count as profit) above its high-water mark, holders receive 20% of the gain, pro rata to the shares they own out of 1,000. After that the mark resets; spending and losses lower it. The payout uses an accumulator (`acc_per_share` plus each holder's debt), so it costs O(1) gas and writes one log line. Holders call `claim_dividends`; a transfer settles what is owed first.
- **Signatures:** listing and buying listed shares need a full wallet signature (1 yoctoNEAR), so a leaked in-game key can't sell your shares to an accomplice. Buying IPO shares, claiming dividends and buying cosmetics stay gasless: with those, NOX only goes into a bot, back to you or into the burn, never to another player.
- **Leaving:** a player who unregisters must hold no shares and have no dividends owed. With `force`, owed dividends are paid first, the shares go back to their bots and every row is deleted.
- **Trading:** `mt_transfer` between registered **real** accounts only. Guests and game wallets can't hold shares. A fixed-price market (`list_shares`, `buy_listing`, `cancel_listing`) charges a 2% tax that is burned. The last trade sets the share price.
- **Order book:** each listing offers at least 10 shares and expires after 48 h. A bot holds at most 20 open listings; when its book is full, a cheaper offer replaces the most expensive one. Anyone can prune expired listings, and listings of bankrupt bots or of sellers who left.
- **Timing:** the player who submits a match record decides when it settles, so they could buy IPO shares of a bot they see winning. That gains at most about 6% of the prize, in play-money.
- **Not implemented, on purpose:** `mt_transfer_call`. Shares never leave the game contract, which closes off a whole class of callback attacks. NEP-245 support is therefore partial: views, transfers and NEP-297 events.

## 7. Anti-sybil
- **Guests:** earn 0 and can't hold shares.
- **Welcome credit:** once per real account, with a daily cap.
- **Diminishing daily rewards:** a player's first 3 paid wins in a UTC day pay 100% of the prize, the next 3 pay 50%, and later wins pay 25%. The rest goes to the House.

## 8. Simulation results
`node scripts/econ-sim-v2.ts` runs 20 runs × 10,000 matches. Charts: `docs/econ/*.svg`; numbers: `docs/econ/summary.json`. The model includes rookie protection and the House-paid daily check-in and quests (§11).

| Check | Result |
|---|---|
| Minting after genesis | 0 |
| Supply | levels off at 79% of genesis (the brake), drift over the last 10% of matches ≈ 0 |
| House | never below its floor; median 714 against a target of 1,000 (within ±30%) |
| Reward multiplier m | 0.13–0.94; largest change between two matches 0.036 (smooth) |
| Bot life | median 56 matches |
| Rich bots fall | 100% of the top-3 at match 2k are out of the top-3 by 4k |
| Rookies rise | 85% reach the top-3 within 300 matches |
| Gini of bot wealth | 0.24 |
| Shares | median single IPO −57%, top 10% of IPOs +87%, 23% of IPOs end in profit; buying every IPO returns −14%. Real risk on purpose: shares go to zero on bankruptcy, and NOX is play-money. |

The results hold across seeds, a guest share of 50–90%, 200 players, a stronger human player and heavy share trading.

**Model assumptions:** winners are drawn from the measured win rates in `docs/balance.json`, upgrades add +12% per tier, and the human wins 8% of matches.

## 9. What we took from other games, and what we avoided
| From | Took / avoided |
|---|---|
| EVE Online | **Took:** sinks matched to sources, a public monthly economic report (our Economy page), taxes on trading |
| RuneScape Grand Exchange | **Took:** a central exchange with a fixed tax that burns (removes) currency |
| Brawl Stars / Fortnite | **Took:** cosmetics can't buy power; power progression is capped |
| Clash Royale | **Took:** brackets so new players aren't farmed by maxed opponents |
| Sorare | **Took:** owning athletes with scarce shares; value comes from performance; shares can go to zero |
| Axie Infinity | **Avoided:** rewards minted from nothing, with no sink to balance them, which made the currency inflate. We mint nothing after genesis |
| STEPN | **Avoided:** a loop that only works while new money keeps coming in. Our rewards come only from fees and taxes, and the House rule cuts rewards automatically when the treasury runs low |

## 10. Roadmap only (not built)
Cosmetics shop, battle pass, licensing AI athletes, sponsored tournaments, live PvP lobbies (humans + AI fighters in one match). No real-money wagering, ever.

## 11. Daily check-in, quests and rookie protection
| Rule | Value |
|---|---|
| Check-in (once per UTC day) | streak days 1–7 pay 1, 1, 1, 2, 2, 2, 3 NOX × min(m, 1), from the House, never below its floor |
| Daily quests (verified on chain from settled matches) | play 3 matches → 1 NOX; finish in the top 3 → 1 NOX; take down the bounty carrier → 2 NOX (× min(m, 1)) |
| Anti-sybil | real accounts only; only matches paid from your own NOX count (welcome-credit matches don't); check-in needs a wallet-paid match that same day and 3 in the account's lifetime; global caps of 100 check-ins and 300 quest claims a day; a reward is always smaller than the 4-NOX minimum entry |
| Rookie protection | a rookie's first 10 matches: the minimum entry (4 NOX), no upkeep, never the bounty carrier |
| Social quests | follow links with no reward: we only pay for what the chain can verify |
