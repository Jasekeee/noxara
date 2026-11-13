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
- `get_economy` returns `r`, `m`, `house_bps`, `burn_bps`, the brake `s` and every constant.

**Deflation brake.** A closed loop with no minting would burn itself to zero, so every burn is multiplied by
`s = clamp((supply − 2,300) / (2,900 − 2,300), 0, 1)`. The unburnt part `(1 − s)` goes to the House. Supply
therefore levels off at about 2,300 NOX instead of spiralling down.

## 3. Sinks
| Sink | Formula | Where it goes |
|---|---|---|
| Entry burn | 10% of every entry fee, at `start_match` | burned × s, the rest to the House |
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
- **Bankruptcy:** when a bot can't pay its entry, it retires. Its shares go to zero, whatever is left in its wallet goes to the House, and the House funds a rookie in that slot.

## 6. Bot shares (NEP-245, inside the game contract)
- Each bot has 1,000 shares; `token_id` = the bot's account.
- **IPO:** a rookie floats 300 shares at 0.1 NOX each (`buy_ipo`). The NOX goes into the bot's own wallet, so investors fund its bankroll. Shares not yet sold stay with the bot.
- **Dividends come only from profit.** When a settle leaves the bot's wallet above its high-water mark, holders receive 20% of the gain, pro rata to the shares they own out of 1,000. After that the mark resets; spending and losses lower it. The payout uses an accumulator (`acc_per_share` plus each holder's debt), so it costs O(1) gas and writes one log line. Holders call `claim_dividends`; a transfer settles what is owed first.
- **Trading:** `mt_transfer` between registered **real** accounts only. Guests and game wallets can't hold shares. A fixed-price market (`list_shares`, `buy_listing`, `cancel_listing`) charges a 2% tax that is burned. The last trade sets the share price.
- **Not implemented, on purpose:** `mt_transfer_call`. Shares never leave the game contract, which closes off a whole class of callback attacks. NEP-245 support is therefore partial: views, transfers and NEP-297 events.

## 7. Anti-sybil
- **Guests:** earn 0 and can't hold shares.
- **Welcome credit:** once per real account, with a daily cap.
- **Diminishing daily rewards:** a player's first 3 paid wins in a UTC day pay 100% of the prize, the next 3 pay 50%, and later wins pay 25%. The rest goes to the House.

## 8. Simulation results
`node scripts/econ-sim-v2.ts` runs 20 runs × 10,000 matches. Charts: `docs/econ/*.svg`; numbers: `docs/econ/summary.json`.

| Check | Result |
|---|---|
| Minting after genesis | 0 |
| Supply | levels off at 79% of genesis (the brake), drift over the last 10% of matches ≈ 0 |
| House | never below its floor; median 725 against a target of 1,000 (within ±30%) |
| Reward multiplier m | 0.13–1.21; largest change between two matches 0.036 (smooth) |
| Bot life | median 55 matches |
| Rich bots fall | 100% of the top-3 at match 2k are out of the top-3 by 4k |
| Rookies rise | 86% reach the top-3 within 300 matches |
| Gini of bot wealth | 0.24 |
| Shares | buying every IPO returns −8% (fair). A single IPO has a median of −59%: most rookies fail and a few pay off. That is real risk, and NOX is play-money. |

The results hold across 10 seeds, a guest share of 50–90%, 200 players, a stronger human player and heavy share trading.

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
