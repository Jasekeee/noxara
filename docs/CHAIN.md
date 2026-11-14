# BOUNTY ROYALE on NEAR (testnet)

The chain is invisible to the player: a guest gets a walletless account from the relayer in a few
seconds, `start_match` is a gasless NEP-366 meta-transaction, and the match server settles the result.
The nine AI fighters are real NEAR accounts with **no access keys**: only the contract's rules move their
$BOUNTY. Their economy (entries, prizes, bounties, upgrades, retirements, rookies) runs on chain with no
dev patch.

## Deployed (testnet, 2026-11-13) [verified]

| What | Account |
|---|---|
| Game contract + $BOUNTY token | `royale.br-7e8492.testnet` |
| Owner (root, faucet-created) | `br-7e8492.testnet` |
| Match server (only account allowed to `settle_match`) | `server.br-7e8492.testnet` |
| Relayer / guest parent (`g-*.relay.br-7e8492.testnet`) | `relay.br-7e8492.testnet` |
| House treasury (keyless) | `house.royale.br-7e8492.testnet` |
| Genesis bots (keyless) | `bramble`, `ox`, `pip`, `vex`, `moss`, `juno`, `rook`, `tink`, `sable` `.royale.br-7e8492.testnet` (a fresh deploy now uses the t1Roster nine: Brindle, Quillon, Vesper, Magpie, Tallow, Dorrit, Zinnia, Okapi, Fenwick; the live contract kept its bots through the migrations) |

| Tx | Hash |
|---|---|
| create + deploy + `new()` (creates house + 9 bots, mints genesis) | `6friAiTr2Qs9DWdTuGpZGPgYx8z2tL7aL4GssBxZ35GB` |
| create server account | `Ax3sZQ8krFvmGd2eHEWMtM13zaTxmS2R1H8tGNRLsv7Y` |
| create relayer account | `3oGwqax4tLPZ5TLivKwAt1RDhNFEAtTUKJPMoqEcyQea` |
| live e2e: guest (match 4) | `GWpGYPF3aPULfh9HZjgtf2gR3wDewjxwyUA8bVtUp3Yc` |
| live e2e: relayed `start_match` #4 | `CsJCwCBjjeLHfVJ1fgHtnmY627ZagcoeCXo6ofjGPPiU` |
| live e2e: `settle_match` #4 (Vex won, real sim replayed by the server) | `8ikqTyFN2J7KjqTJ6B4LDBgekV4yk5eyWTbTbYWSMsC9` |
| live e2e: `settle_match` #5..#7 | `64Zy8cYWExbDdLKJvRvm5p71UfNKVj5K3azkH1oQyFWw`, `3pnDcuqbD4duCYzt4YFxf4VfSgQc1Dombvx4bLymyXRf`, `6daxzXywUnYSgQbA6msNCLtdWux8zs1F3EdNyUJmsdXQ` |
| live e2e: `settle_match` #9 (sim round 2): Bramble + Ox went broke and retired, rookies Pep + Kit spawned with new keyless accounts (29 Tgas) | `W19iJAQ4GbxpjKeyiBuL9m1m6sWAXVTYEzXyXF5W65r` |
| migration 1: economy retune (deploy + `migrate`, same account, bots and balances kept) | `AJah7gF5kH8NFmZPzZjJdmgtGZ3qddEz8eqBemRv87K` |
| migration 2: the house reinvests above its floor | `9bkZhcLyxmKFqxDchdQhRLDw48db6M3BbvDP2ZkW2PZ9` |
| migration 3: unique rookie names | `gZGvktitGfoaThArEEYw7Y2oLA5bJUCXmKyVJdc6DPR` |
| game client (`src/net/client.ts`) live: relayed start #10 / settle #10 | `3N9AZGUcr44mThDynKk8RdsHFQ6zVqhWucMe9Z9peVqN` / `3evgSJ8tSTYnMxqpcfzK5GD7VJqHFMDLCLTLXQdAh3E6` |
| game client live after migration 2: start #13 / settle #13 | `DYZu1i7WoPfCwpfyTGTc898VJhtNucdBxEvM9apqR8wY` / `GjLi1XqfSGBnYfxW8TRGRmRcNajmrh95pNma7B7sTyp6` |
| migration 4: **state V1 → V2** (sponsorship, progression, history; duplicate "Pep" renamed "Ash") | `6qfo7kenRcEyes8THEyGGnXfmj5kfQxUp67emEdD9f8` |
| `set_max_free(24)` | `DycYSVwD5gmquH3fqaLRtXMHs3wUyw48xJuKsHPHAMRC` |
| migration 5: sponsorship review fixes (code only, V2 → V2) | `EBxwrtQymR9RuxVBxm93oGgYdM6f33RyoBUKwUJMdqUC` |
| migration 6: deposit payer / refund to payer (code only) | `7Brr5XP1kTSyhviC6N5nif2cHEAdMkMvTxPZYf7J6hJt` |
| migration 7: V1 player records fail closed to the relayer as payer (code only) | `6v2dzRbizjP3QaF2kcTjHymjKESKxez7GwQdvaJNy4cb` |
| migration 8: NOXARA + audits #1/#2 (code only; Nox/NOX metadata) / `set_teardown_beneficiary(br-7e8492.testnet)` | `He34ga4cPqAmAKzt21m3wCTKpTtvwzNH2eaZv5eWQ8cS` / `1wo26HWKkHEhYZtYuHyqZTREt9QvEzaNi9AzPaerJdq` |
| migration 9: teardown_clear review fix (code only) | `CjH3XLH87dwNP1bHJiUUZxutRNsW5DyyQEnFPXYPGb85` |
| live check after migration 8: guest match #50 start / settle (verified, played in real time) | `2QtTrSx4oZ4bQJpMtuQMkE2mQ3Cn5h4sy6MKdHVFsHDc` / `HtHbHewJmJMNfX1cyDArRXCqCdbq26HoTKdueD6Pmgcj` |
| T3 live (game client): real account created / wallet adds the game key | `DBxrCqzzSwc9SrHUdQ4wHhV1tHvTbmuF4SHCd2xq4iA7` / `iwpQgpWqkjpADK9TVmzJt6WERewsCBH72SzfyNikEc4` |
| T3 live: `house_grant` 60 (testing on-ramp) / relayed `sponsor` Pep 20 | `9RnX2RXNaswbbSZKrijUyAauBE8fhuBDfAm1pL9u5gVG` / `D4bU7p7cSzDGzyJfm25C6nhfaVGRpUSP1Unzc9AKV2Z8` |
| T3 live: paid match #42 start / settle (Pep won, sponsor got 7.04 cash) | `Frk8ex3MUgn6oTawvfBSmEyJoi61zqLVg9PDW1wBwx8L` / `EZNFJ1SMGGqjMNjg4EKkep4B8VX84SQbdJq25Koo7QBy` |

All NPC accounts were checked to have 0 access keys after deploy (`scripts/deployments/testnet.json`).
Keys of `server.*` and `relay.*` live only in the worktree's `.env` (gitignored, mode 600).
Explorer: `https://testnet.nearblocks.io/address/royale.br-7e8492.testnet`.

## Costs [measured]

| Action | Gas | NEAR |
|---|---|---|
| `start_match` relayed (incl. `resolve_start`) | ~15 Tgas (testnet), 12 Tgas (sandbox) | ~0.0014, paid by the relayer |
| `settle_match` (typical: prize, bounty, records, maybe one upgrade) | 9-10.5 Tgas | ~0.001, paid by the server |
| `settle_match` with many retirements (7 rookies = 7 new accounts) | up to 65 Tgas | ~0.007 |
| `new()` (10 sub-accounts) | 89 Tgas | |
| New guest | | 0.003 account + 0.02 storage deposit + gas ≈ 0.024 (relayer) |
| Contract code | 280 KB | 2.8 NEAR storage |
| Replay on the match server | 45-110 ms per 3-min match | |

## The match loop

1. **Guest:** `POST /api/guest {publicKey}` → the relayer creates `g-<hex>.relay…` with a function-call key
   (receiver = the game, methods `start_match`, `sweep_match`) and prepays its NEP-145 storage
   (`storage_deposit({account_id})`, 0.02 NEAR).
   **Mainnet (`GUEST_VIA_CONTRACT=1`):** ONE relayer tx to the game with two calls: `create_guest({id,
   public_key})` (attached: the 0.003 funding) and `storage_deposit`. The **contract** creates
   `g-<id>.<contract>` and adds the browser key (receiver = the contract, `start_match,sweep_match`,
   allowance 0.05 NEAR — constants in the contract, not relayer input). Only the relayer account
   (`guest_parent`) may call it; ids are 8–32 lowercase hex; an existing account makes the creation
   fail as a whole (nothing overwritten) and the `on_guest_created` callback refunds the funding to the
   relayer. So a hosted relayer never needs a key of the contract account. Both forms (`g-*.<relayer>`
   and `g-*.<contract>`) are guests everywhere (earn 0, no shares, no welcome credit, no dailies).
2. **Start:** the client signs a delegate action for `start_match` → `POST /api/relay`. The contract:
   - lazily sweeps up to 3 expired free matches; abandons the player's previous unsettled match (see rules);
   - charges each active bot `ENTRY_FEE` (4 $BOUNTY) into escrow (the contract's own token balance);
     a real player with ≥ 4 $BOUNTY pays too;
   - a bot that can't pay **and** has nothing in escrow retires; a rookie takes the slot;
   - marks the richest active bot as the bounty carrier;
   - self-calls `resolve_start`, which fixes the **seed in a later block** (`random_seed` + sha256 with the
     match id and player). The tx's final value is `MatchStart {match_id, seed, roster, bounty_idx, ...}`.
3. **Play:** the client builds the sim config with `matchConfigFromChain(start)` (src/net/roster.ts;
   fighter idx 0 = the player, idx 1..9 = bot slots 0..8) and plays with the shared deterministic sim.
4. **Settle:** the client signs `settleMessage(match_id, inputLogHash(record.inputs))` with its key and
   `POST /api/settle {match_id, record, publicKey, signature}`. The server checks the signature belongs to
   the match's player, rebuilds the config from the chain (the record's roster/upgrades/seed must match),
   re-runs the match with `replayRecord`, requires the same final hash, collects kills and the bounty killer,
   stores the record (`GET /api/match/<id>/record`) and calls `settle_match` with the server key.
5. **Settlement on chain:** the pot = escrowed entries + `POT_TOP_UP` (20, minted); 2% burned, 5% to the
   house, the rest to the winner. The bounty killer takes 25% of the carrier's wallet. Records update.
   Then the bot economy runs (below). Everything emits NEP-297 events (`standard: "bountyroyale"`,
   plus NEP-141 `ft_mint`/`ft_transfer`/`ft_burn`).

## Rules that matter

| Rule | Value |
|---|---|
| Entry | bots: 4 $BOUNTY + 2% of the wallet above the 50 reserve, max 16 (progressive); real players: 4 if they have it |
| Pot top-up | 30 $BOUNTY per settled match: paid by the house while it holds > 1,000 (`HOUSE_FLOOR`), minted only below that |
| Burn / house cut | 2% / 5% of each pot |
| Bounty | 15% of the carrier's wallet, to whoever killed it (guests / non-payers: to the house) |
| Winner payout | bot → its wallet; real player who paid → their wallet; guest, non-payer or no winner → house |
| Upgrades (one per bot per settlement, only if ≥ 50 left after) | weapon tier 1/2: 60/120; armor 1/2: 90/180; then a new skin: 150. Paid to the house |
| Retirement | at `start_match`: a bot that can't pay the base entry retires (escrow elsewhere doesn't count — judge #2 saw a 0-$BOUNTY bot play); after settlement: wallet < entry and nothing in escrow. The bot keeps its dust, its record stays (`get_retired`) |
| Rookie | play style from the match seed, a name no active fighter uses, new keyless account `<name>-<n>.royale…`, 100 from the house (or what it has), generation = predecessor + 1 |
| Expiry | free matches 500 blocks, paid 1,200 blocks; `sweep_match` by anyone; `start_match` sweeps the oldest free ones. Free pool 24 (owner `set_max_free`), paid pool 1,000 |
| Storage | 0.02 NEAR per player (NEP-145, min = max); guests: prepaid by the relayer. Measured: 983 bytes for player + FT account + one pending match |

**$BOUNTY supply:** minted only at genesis (9 × 100 to the bots, 2,000 to the house) and as the per-match
pot top-up when the house is below its floor; burned 2% of every pot (+ unregister burns). Entries,
prizes, bounties, upgrades, rookie grants and house-funded top-ups move existing tokens. `get_config`
exposes `total_minted`, `total_burned`, `total_supply`, `house_floor`; tests assert
`sum(balances) == total_supply == minted − burned` after every match.

## Economy tuning (scripts/econ-sim.ts) [simulated]

`node scripts/econ-sim.ts [--curve]` mirrors the contract rules (defaults = lib.rs) and draws winners from
docs/balance.json's per-personality win rates (300 bot-only matches), × (1 + 0.12 per upgrade level)
[assumed], with the human a guest winning 8% [assumed]; the bounty carrier is killed by someone else 75%
of the time when it doesn't win [assumed]. 400 runs × 200 matches:

| Constants | Retirements / 200 matches | First weapon tier 2 (median match) | Tier 2 by match 20 | House after 200 |
|---|---|---|---|---|
| old (entry 10, top-up 20, bounty 25%, reserve 40, weapon 120/240) | 72 (1 per 2.8) | 26 | 35% of runs | 5,446 (≈ all supply) |
| **new** (entry 4, top-up 30, bounty 15%, reserve 50, weapon 60/120, armor 90/180, house floor) | **10 (1 per 20)**, p10 6, max 18 | **11** | **95%** | ~1,800, supply flat/slightly deflationary |

Robustness of the new set: human win 3% → 8 retirements, 15% → 12; upgrade edge 0.05 → 9, 0.25 → 11
(all within ~1 per 17–25 matches). Without the house floor the house soaked up ~90% of the supply; with
it the house reinvests its income (cut + upgrades + guest wins) as the top-up.

## T3: sponsorship market, progression, history, leaderboards (state V2)

**Sponsorship (real accounts only, `sponsor` / `unsponsor`, relayed and gasless):**
- A stake moves INTO the bot's wallet (it really pays the bot's entries and upgrades) and buys pool
  shares of the bot's bankroll (wallet + entries in escrow). The bot owns the rest; sponsors together
  own at most 30%. Minimum stake 10 $BOUNTY.
- **10% of every prize or bounty** the bot collects is paid to its sponsors in cash, split by shares.
- `unsponsor` after the bot played 5 matches since the (last) stake returns the stake's CURRENT value
  (can be less than staked).
- A bot that retires broke closes its pool once nothing of it is left in escrow: sponsors split the dust,
  the rest of the stake is lost.
- Bounded: 3 bots per player, 12 sponsors per bot; the player's 0.02 NEAR storage deposit covers it
  (measured 1,674 of 2,000 bytes incl. a pending match, XP and 3 sponsorships). `sponsor` ≈ 3 Tgas.
- Simulated (scripts/econ-sim.ts, a 20-$BOUNTY stake every 4 matches, 60% on the richest bot, held 5–30
  matches): 62% of positions profitable, median ROI +21%, 2% lost to retirement (median −88% there)
  [assumed behaviour]. A 30% cut gave +128% and drained bots, so 10% was chosen.

**Progression:** `contracts/royale/src/progression.rs` mirrors `src/sim/progression.ts` exactly (the
unit test reads `src/sim/progression.vectors.json`). Every settled match adds XP to the player (guests
too). `start_match` stores the level's upgrades in the match and returns `player_upgrades` /
`player_level`; `matchConfigFromChain` puts them into `cfg.fighters[0].upgrades`, so the server's replay
uses exactly what the client played. View: `get_progress(account_id)`.

**History and leaderboards:** a ring of the last 24 events per fighter (`get_history`: win, death,
bounty, upgrade, retired, rookie, sponsored, unsponsored, dividend); `get_top(kind: "bots"|"players",
by: "earnings"|"wins"|"kills", n)`; the contract keeps the top 50 players.

**Migration V1 → V2:** `migrate()` peeks the `version` field (first in every layout), converts the V1
state (new maps start empty), loads V1 matches as V2 (player upgrades = base) and renames duplicate
active names. Sandbox test `migrates_from_the_v1_contract` deploys the real V1 wasm
(`tests/fixtures/royale_v1_eedaf34.wasm`), plays, upgrades and settles a V1 pending match under V2
(deploy + migrate 28 Tgas).

**Sponsorship review fixes (each with a unit test):**
1. `storage_unregister` refuses while the account sponsors anything and removes its XP/history;
   dividends go only to registered sponsors (`unregister_needs_closed_sponsorships_and_cleans_xp`).
2. No front-running: `sponsor`/`unsponsor` are refused while the bot has entries in escrow, i.e. while
   it's in an unsettled match (`no_sponsoring_or_withdrawing_while_the_bot_is_in_a_match`). Trade-off:
   during busy periods a player may have to retry between matches.
3. A retired bot's pool closes only after its last escrowed entry came back (refund or settlement),
   so late refunds and prizes reach its sponsors; the closing uses the bankroll, which then equals the
   wallet (`a_pool_closes_only_after_the_retired_bots_escrow_comes_back`).

4. **(HIGH) Storage-subsidy farming.** A deposit paid by someone else (the relayer, for guests and
   signed-in accounts) is recorded as `deposit_payer` and `storage_unregister` refunds THE PAYER, never
   the account; V1 guest records load with the relayer as payer. The relayer subsidises each account at
   most once ever (persisted in `relayer/data/subsidised.json`, gitignored) and at most
   `REGISTER_GLOBAL_PER_HOUR` (30) per hour; a repeat gets 403 `already_subsidised` (the player can
   still register with their own wallet). Tests: `a_subsidised_deposit_is_refunded_to_its_payer_not_the_account`
   (unit), `a_relayer_paid_deposit_goes_back_to_the_relayer` (sandbox),
   `register -> unregister -> register` and the hourly budget (relayer node tests).
   Follow-up: V1 player records (written before the payer was tracked) **fail closed**: every V1 record
   loads with the relayer as payer, guest or not (a player who truly paid their own V1 deposit loses at
   most 0.02 NEAR to the relayer). `scripts/seed-subsidies.ts` seeded `relayer/data/subsidised.json`
   from the relayer's on-chain `storage_deposit` txs (42 txs → 42 accounts, the only non-guest was the
   T3 test account `pmwf85tyi.br-7e8492.testnet`). Test: `a_migrated_v1_non_guest_refunds_the_relayer`.

**Judge #2 fixes:** progressive bot entry (sim: ~1 retirement per 17 matches, tier 2 by match ~9; it
barely changes wealth concentration — richest bot ≈ 19% of bot wealth either way; the bounty and the
upgrade price ladder are the real brakes [simulated]); strict broke rule at `start_match`; unique names.

## Signing in with a real NEAR account

`signIn()` makes a key in the browser and redirects to the wallet's login page
(`VITE_WALLET_URL`, default `https://testnet.mynearwallet.com/login/?public_key=…&contract_id=royale…&methodNames=start_match&…sponsor&…unsponsor`).
One approval adds that **function-call key** (game contract only, no deposits); on return
`createGameClient` finishes the sign-in, and `POST /api/register` (the relayer checks a signature by
that key AND that the key is on the account) prepays the account's 0.02 NEAR storage. From then on it's
gasless exactly like a guest. `signOut()` forgets the key locally (it can be deleted in the wallet).
Zero new dependencies. For multi-wallet support (Meteor, HOT, Intear…) I propose
`@hot-labs/near-connect` **0.12.0** (no runtime deps, 234 KB unpacked) — not added, awaiting the lead.
The live run used a script in place of the wallet (it adds the same key), see the T3 txs above.

## NOXARA mainnet preparation (nothing executed on mainnet)

The project is now **NOXARA** ("Only one walks out."); the token is **Nox / NOX** (`ft_metadata`
name "Nox", symbol "NOX", new dark-coin icon). Event standard names are unchanged
(`bountyroyale`, `nep141`). Historical testnet notes above keep "$BOUNTY". NOX is play-money.

**Mainnet topology** (`scripts/deploy.ts --contract-on-root --owner <owner.near>`):
- the game + NOX contract lives ON the root account (e.g. `noxara.near`): one contract for game and
  token; the house, the bots and every rookie are its keyless sub-accounts (`brindle.noxara.near`, …;
  0.001 NEAR each, not refundable: keyless accounts can't be deleted — 10 at genesis = 0.01 NEAR, plus
  0.001 per rookie, ~1 per 18 matches);
- **the relayer is also the match server** (`relay.noxara.near` = contract `server`): one key both pays
  guests' gas and signs `settle_match`. Trade-off: if that key leaks, the attacker can relay AND settle
  arbitrary results (move play-money NOX, drain the relayer's NEAR budget). It can't upgrade, mint
  beyond the rules, touch deposits or teardown. Mitigations: key only in the hosted env, budget caps,
  `set_server` by the owner rotates it.
- the **owner** is a separate account the owner controls (the only one who can `teardown`,
  `set_server`, `set_owner`, `house_grant`); deploy and `new()` go in ONE batch tx (`new` is
  `#[private]`, so nobody can front-run the init).
- dry run: `node scripts/deploy.ts --network mainnet --root noxara.near --contract-on-root --owner <owner.near> --dry-run`
  prints the steps and costs (code ≈ 3.7 NEAR at 370 KB, genesis state ≈ 0.06, NPCs 0.01, headroom
  0.5, relayer 1.5 → ≈ 5.8 NEAR). A real mainnet run still refuses without `BR_MAINNET_YES=yes`.

**Upgrade / lock policy (audit #8):** the root's full-access key can redeploy (`scripts/upgrade.ts`).
The owner decides before submission whether to remove it (lock: no more upgrades, teardown still works
through the owner account).

**Season end and teardown:**
- from **2026-12-15 00:00 UTC** no new matches start; players can `storage_unregister` and get their
  OWN storage deposits back (open sponsorships are closed at their wallet value; never blocked by
  other people's matches);
- from **2026-12-20 00:00 UTC** the owner calls `teardown()` (no argument): it closes anything still
  in flight (max 60 per call, call again if more) and deletes the contract's own account, sending all
  its NEAR (code + state + leftover, incl. deposits the relayer paid) to the **teardown beneficiary
  fixed at `new()`**. Works without any full-access key. All NOX disappears with it (play-money). The
  account name becomes re-registrable afterwards. Release builds can't move the date (only test builds /
  the `teardown-override` feature can).
- sandbox `contract_on_root_relay_as_server_and_teardown`: contract on the root, relay = server, a
  guest match, the root's only key deleted, a pending match left by a "griefer", the season clock
  passes, the owner tears down: 7.92 of 7.92 NEAR returned.

**Testnet rehearsal of the mainnet topology (2026-11-13, faucet root `nx-4ba5bb.testnet`)** [verified]:

| Step | Tx |
|---|---|
| deploy + `new()` in ONE tx on the root itself (owner `br-7e8492.testnet`, server = guest parent = `relay.nx-4ba5bb.testnet`, beneficiary = owner; `teardown-override` build with the lock 15 min ahead — mainnet uses the release build, locked to 2026-11-25 at deploy, moved to 2026-12-20 by the season-extension upgrade) | `8sN695wi7ZZ4hdJ3joFMjc58crHXNBbCFJ3gKYSnZAKF` |
| create the relayer (also the match server) | `HPpAKJDirDkXqFKuynM8jHjVhgwbJ2gpqtcTbeSUh27j` |
| guest match #2: relayed start / settle signed by the relayer (12.7 Tgas), played in real time (the server refused an instant record #1 as `too_fast`) | `GuazvDYPTDZ4XTUn4Ctj45fdFKxY6t8a5L72v3KwEkoc` / `G1oS32CTS1YXmDDmsStjJRBaWtpjpVbYXAbWYTDE6eKy` |
| the root's ONLY full-access key deleted (0 keys left) | `46JS52ouTGZvBYfxMJFb1iX796d7iy4wAyHHYEYcfYR6` |
| owner `teardown()` after the lock: closed the pending match #1, deleted the keyless root → 7.9376 of 7.9386 NEAR to the beneficiary | `48QEMtUCywkUp68awtzpeyGkfND4VNPpGhBsQReCDnnq` |
| relayer account deleted → 1.9449 NEAR to the beneficiary | `L7Heytk1WEXHXbiooWPGmCxqG3SayjD9zCzA9gZb61V` |

Root storage after deploy: 379,446 bytes (375,865 code + ~3.6 KB genesis state). Of the 10 NEAR faucet
funds, 9.88 came back; the rest is gas, the 10 keyless NPC accounts (0.01) and 2 guest accounts
(0.003 each + their storage deposits, which went back with the root). The relayer's budget counted
0.054 NEAR for 2 guests + 2 relayed starts (≈ 0.027 per guest).

**Guest budget mode:** the relayer spends at most `RELAYER_BUDGET_NEAR` (default 1) on players (new
guests, their storage, registrations, relayed gas; persisted in `relayer/data/budget.json`) and at most
`DAILY_GUEST_CAP` (200) new guests a day. When either is used up, `/api/health` says
`guests: "closed"` + `reason` (`budget` | `daily_cap`); guests play offline (`offlineReason:
"guests_closed"`, clearly labelled), signed-in accounts keep playing on chain by signing their own
transactions with their function-call key (allowance 0.25 NEAR set at sign-in pays the gas), and a
new sign-in pays its own storage through the wallet. Settlement is not counted (match-server duty).

**Guest storage, measured:** a guest's record (player + FT account + one pending match + XP) is
**1,261 bytes** with worst-case names (36-char guest id, 36-char bot ids); +20% → `GUEST_STORAGE_DEPOSIT`
= 1,514 bytes = **0.01514 NEAR** (was 0.02). Real players keep 0.02 NEAR (measured 1,897 bytes with 3
sponsorships + welcome records). The relayer reads both from `get_config`.

**Wasm size** (release, `cargo near build non-reproducible-wasm`, wasm-opt included): 375,865 bytes
(3.76 NEAR of storage). `--no-embed-abi` → **370,091** (−5.8 KB; publish `royale_abi.json` in the repo
instead); `RUSTFLAGS=-C link-arg=-s` → no change (already stripped); `opt-level = "s"` → 414,299 (worse,
kept `z`); `lto`, `codegen-units = 1`, `panic = "abort"` were already set; `overflow-checks` stay on
(safety). Further gains would need code changes (the ~60 `json!` event sites, the NEP-141
`ft_transfer_call`/resolver path) for maybe 5–10% more — not worth the risk before the second audit.

## Admin powers (every privileged method)

| Method | Who | What it can do | What it cannot do |
|---|---|---|---|
| `new` | only the contract account itself (`#[private]`), once, in the deploy tx | set owner, server, guest parent, the teardown beneficiary (never the contract itself) | run twice; be called by anyone else |
| `migrate` | only the contract account itself (`#[private]`) | re-read state after a code upgrade | change balances |
| **deploy new code** | whoever holds the contract account's **full-access key** (owner decision: KEPT on mainnet for fixes during judging) | **anything**: new code can change every rule, including balances | — this is the real trust assumption; every upgrade is a public tx |
| `settle_match` | only the configured `server` (on mainnet: the relayer account) | report a match result the server re-computed from the recorded inputs: winner, placements, kills, bounty killer. The pot is entries + a top-up of **at most 30 NOX** (from the house or minted below its floor), split by fixed rules | move any player's NOX directly; settle a match twice or one that isn't pending; the result it reports is replayable by anyone from the stored input log (a lying server is detectable, not preventable) |
| `set_server` | owner | rotate the match-server account | settle itself |
| `propose_owner` / `accept_owner` | owner, then the proposed account | hand ownership over (two steps) | — |
| `set_max_free` | owner | size the free-match pool (≤ 96) | affect paid matches |
| `house_grant` | owner | give ≤ 100 NOX from the house to a registered real player (testing / on-ramp), never below the house floor | mint; touch any player's or bot's NOX |
| `set_teardown_beneficiary` | owner, only if never set | set the payee once (older deployments) | change it |
| `teardown_clear` | owner, from 2026-12-20 00:00 UTC | close pending matches (8/call) and delete state in bounded batches | run before the lock (release builds can't move it) |
| `teardown` | owner, from 2026-12-20 00:00 UTC | delete the contract account, all its NEAR to the fixed beneficiary | run earlier; choose another payee |
| `withdraw_excess` | owner, from 2026-12-20 00:00 UTC | send NEAR above the storage cost (+0.05) to the fixed beneficiary | touch storage-backing NEAR |
| `create_guest` | only the relayer account (`guest_parent`) | create `g-<8–32 hex>.<contract>` with a fixed function-call key (this contract, `start_match,sweep_match`, 0.05 NEAR allowance), funded by its own attached deposit (≤ 0.01 NEAR); failure refunds the deposit to the relayer | add a full-access key; create any other name; overwrite an existing account; spend the contract's NEAR beyond a refund of what was attached |
| `close_retired`, `sweep_match` | anyone | settle a retired bot (sponsors get its wallet by share, rest to the house) / refund an expired match | anything else |

No method lets the owner or the server move a player's NOX: transfers out of a player's balance only
happen when that player calls `ft_transfer`/`sponsor`/`start_match` (entry) or by the fixed match
rules. Game wallets (the contract, the house, every bot and rookie) refuse NEP-141 transfers.

**Teardown steps (after 2026-12-20 00:00 UTC):** NEAR refuses to delete an account whose state is
large (`DeleteAccountWithLargeState`; the testnet contract has ~56 KB). So: (1) `teardown_clear` in
batches until `done` (`scripts/teardown.ts` lists every registered player from the chain's
`storage_deposit` history and loops); (2) then EITHER the owner calls `teardown()` (works without
keys) OR, since the full-access key is kept, `near account delete-account <root> beneficiary <...>`
works too — both only after the state was cleared. Fallback at any time after the lock:
`withdraw_excess(amount)`. Sandbox `audit2_large_state_cleared_then_deleted`: 60 guests + matches →
state 113 KB, `teardown` fails and loses nothing, `withdraw_excess` works, 3 `teardown_clear` calls
(76 / 37 / 4 Tgas) bring the state to 1,240 bytes, then `teardown` deletes and the beneficiary
receives the balance.

## Independent audit #2 (NO-GO → fixes; audit #3 pending)

| # | Finding | Fix | Regression test |
|---|---|---|---|
| 1 CRITICAL | `ft_transfer_call` into a keyless bot/house inflates its wallet until the refund (drain via `unsponsor`, house-floor bypass, bounty value) | `ft_transfer` / `ft_transfer_call` refuse any game wallet: the contract, the house, every bot / rookie, any sub-account of the contract (future rookies too) | sandbox `audit2_sponsor_drain_via_transfer_call_fails` (the batch fails, nothing moves); unit `audit2_no_transfers_into_game_wallets` |
| 2 HIGH | teardown can't delete a large state | `teardown_clear` (bounded batches), `withdraw_excess`, both owner-only and time-locked | sandbox `audit2_large_state_cleared_then_deleted`; unit `audit2_teardown_clear_empties_state_in_bounded_batches` |
| 3 MED | settle logs with 12 long-named sponsors + bounty + retirements | dividends: ONE transfer line + ONE event per payout; slimmer retire event | unit `audit2_settle_logs_k0..k7` on "noxara.near": 7.5–12.3 KB (< 16 KB); sandbox `audit2_settle_with_double_dividends_fits_the_log_limit` |
| 4 LOW | teardown sweep of 60 matches overflowed logs | 8 per call, call again | unit `audit2_teardown_closes_pending_matches_in_small_batches`, sandbox `audit2_teardown_with_many_pending_matches` (15 pending → 2 calls) |
| 5 LOW | `storage_balance_bounds.min` below the real price | min = max = 0.02 (the guest price stays internal: `get_config.guest_storage_deposit`) | `storage_bounds_and_double_registration` |
| 6 LOW | free-start markers never removed | pruned at settlement / close | `audit2_free_start_markers_are_pruned` |
| 7 LOW | sybils eat the welcome cap | self-registration / `claim_welcome` have their own sub-cap (10 of the 50 a day); the relayer path is rate-limited per IP | `audit2_self_registration_has_its_own_welcome_sub_cap` |
| 8 INFO | init / owner / grant | beneficiary ≠ contract at `new`; two-step owner change; `house_grant` respects the floor; admin powers table above | `audit2_house_grant_respects_the_floor_and_owner_change_is_two_step` |
| review | clearing could delete Pending match records / desync pending counters | range deletion only once nothing is in flight (and never a Pending record); every sweep branch keeps `pending_paid` and its id list in step | `teardown_clear_never_loses_escrow_or_credit_and_keeps_counters` (escrow == pending pots, counter == list, supply invariant after every batch) |
| 9 DEPENDABOT | wee_alloc (unmaintained) via near-sdk default features | `near-sdk` with `default-features = false, features = ["legacy"]`: the Rust allocator (no `wee_alloc` in the tree) | wasm 375,865 → 382,179 B (+6.3 KB, dlmalloc); with this round's new methods 393,730 B. Gas unchanged: start_match + resolve 13 Tgas (was 13), settle 10 / 11 / 12 Tgas (was 10 / 11 / 12), retirement wave 71 Tgas (was 72) |

## Independent audit (NO-GO → fixes; second audit pending)

| # | Finding | Fix | Regression test |
|---|---|---|---|
| 1 HIGH | logs > 16 KiB froze `start_match`/sweeps (pool closures + retirement waves) | pools are never closed inside start/settle: permissionless bounded `close_retired(bot)` (one aggregated event); entries/refunds emit ONE `ft_transfer` line; lazy sweep = 1 match per start | `audit_worst_case_logs_fit_in_16_kib`: 50-char contract id, 27 sponsors with 64-char names, 8 retirements in one settle → start 2,053 B, settle 10,775 B, close 1,623 B (< 16,384) |
| 2 HIGH | 24 concurrent free matches force-retired every bot | retirement = wallet + escrow below the entry; a bot short only because of escrow makes FREE matches wait ("island busy") instead (paid ones proceed); rookies only when the house can fund them above its floor; `close_retired` sweeps leftovers to the house | `audit_concurrent_free_matches_cannot_force_mass_retirement`, `a_bot_short_only_because_of_escrow_blocks_free_matches_not_paid_ones` |
| 3 MED | 24 cheap accounts lock the free pool | free matches only for relayer guests; one free start per 100 blocks per guest | `a_real_account_without_funds_cannot_take_a_free_slot`, `free_matches_have_a_cooldown_and_are_for_guests_only` |
| 4 MED | any pending match locked sponsors' funds | `unsponsor` and season-end exits are valued on the bot's WALLET only (entries in play stay with the others), so they're never blocked and can't profit from an unsettled outcome; buying in is still refused mid-match | `audit_a_pending_match_never_blocks_unsponsor`, `no_buying_in_during_a_match_but_withdrawing_is_never_blocked`, `season_end_exit_works_even_with_a_match_pending` |
| 5 MED | sponsors farmed the house's top-up via free matches | in a free match sponsors only share the entries part of the prize | `sponsors_get_no_cut_of_the_house_top_up_in_free_matches` |
| 6 LOW | unfunded rookies churned every settle | no unfunded rookies, never retire a 0-match rookie, broke bots keep their slot until the house can fund a successor | `audit_an_empty_house_does_not_churn_rookies` |
| 7 LOW (accepted) | sybil accounts cost ~0.001 NEAR | welcome credit daily cap (50), credits only pay entries, guests earn nothing | — |
| 8 INFO | full-access key on the contract | upgrade/lock policy above | — |
| 9 INFO | public seed + deterministic sim → offline input search | the match server refuses records submitted faster than the replayed match could be played (`too_fast`: ≥ 90% of ticks/20 s − 5 s since `start_match`); input rows bounded. Settlement verifies consistency, not that a human played; winnings are play-money | relayer `real time: … too_fast` |
| 10 INFO | start_match gas | measured settle with 8 retirements + rookies: 72 Tgas; relayer cap and client gas for `start_match` raised to 150 Tgas | sandbox gas prints |

Economy after the fixes (`scripts/econ-sim.ts`, 400×200): ~1 retirement per 18 matches, weapon tier 2
by match ~9, house ~1,800; sponsorship is now roughly break-even (50% profitable, median ROI ≈ 0%),
since free-match prizes no longer pay sponsors from the house's top-up.

## Welcome credit (owner decision: real accounts' first stake)

- Every real NEAR account gets ONE welcome credit of **30** (≈ 7 entries at the base 4), never guests,
  bots, the house or the contract. It is **not $BOUNTY**: it only pays the player's match entries; it
  can't be `ft_transfer`red, used to `sponsor`, or withdrawn. Nothing is minted for it: when the credit
  pays an entry, **the house funds that entry** at `start_match` (only while the house stays above its
  1,000 floor; otherwise the credit simply waits and the player plays free). A credit-paid entry makes
  the player prize-eligible; winnings are normal $BOUNTY. An unseeded refund goes back to the house and
  the credit (never to the wallet); a seeded abandon/expiry forfeits it to the house as usual.
- Granted only when the account registers itself (`storage_deposit` paid by the account) or through
  the trusted relayer's `/api/register`. A third party's `storage_deposit` for someone else grants
  nothing and never counts toward the cap. If the day's cap (50 per UTC day) was full, the account
  calls `claim_welcome()` itself later (once, cap-checked). The "welcomed" record is permanent; its
  storage is paid from the player's deposit (0.001 NEAR kept on `storage_unregister`), so unregister →
  register brings no new credit. Measured storage per real player: 1,897 of 2,000 bytes.
- Views: `got_welcome`, `get_welcome_credit`. Event `welcome`. The client exposes `welcomeCredit()` and
  `claimWelcome()` (proposed for GameClientT3; `claim_welcome` is in the sign-in key's methods).
- Economy: worst case the house funds 50 × 30 = 1,500 $BOUNTY of entries a day, but only above its
  floor — the house hovers ~1,600 in the simulation, so credits are paid out of house income (cut,
  upgrades, guest wins) and pause when it runs low; supply is unaffected (no minting).
- Tests: `welcome_credit_once_per_real_account_never_guests`,
  `the_credit_pays_entries_funded_by_the_house_and_wins_are_real`,
  `the_credit_cannot_be_transferred_or_sponsored_with`, `an_unseeded_refund_returns_to_the_credit_and_the_house`,
  `below_the_house_floor_the_credit_waits`, `third_parties_never_grant_or_touch_the_daily_cap`
  (100 third-party registrations leave the cap at 0), `the_daily_cap_and_a_later_self_claim`,
  `unregister_then_register_brings_no_new_credit_and_keeps_the_record_paid`; sandbox `real_player_pays_and_earns`.

**Multi-wallet sign-in:** `signIn()` now uses `@hot-labs/near-connect` 0.12.0 (lazy-loaded chunk,
58 KB): `connector.connect({addFunctionCallKey: {contractId, publicKey, allowMethods: start_match,
sweep_match, sponsor, unsponsor, claim_welcome}})` — the picker only offers wallets that add the key
during sign-in (seen: Meteor, Intear, Ledger, Nightly, NEAR CLI), so it stays exactly ONE approval.
Cancel → "Sign-in was cancelled."; if the connector fails to load or run, it falls back to the
MyNearWallet login redirect. Verified in a browser (Vite dev on my own port): the wallet picker opens.

## Real players' first $BOUNTY (the proposals the owner chose from: option 1, as a credit)

Today a real account gets $BOUNTY only from `house_grant` (owner-only, ≤ 100 per call; testing only),
transfers, or winning a paid match — which it can't enter without $BOUNTY. A real account that plays
free can't win. The owner hasn't chosen yet; nothing below is implemented.

1. **Welcome stake from the house (one-time, small).** On the first `storage_deposit` of a non-guest
   account, the house moves `ENTRY_FEE × 3` to it (only while the house is above its floor). The account
   is paid-eligible from match one. Sybil cost: an account + the 0.02 NEAR deposit, refundable on
   unregister — so cap it per day globally (e.g. 50 welcomes/day) and require the account to be older
   than the contract's last N blocks, or have a NEAR balance ≥ 0.5. Simple, instant, a bit farmable.
2. **Earned qualification ("prove yourself on the free island").** Free matches stay prize-ineligible,
   but a real account that finishes top-3 in K free matches (counted on chain from settled results,
   e.g. K = 3) earns a one-time qualifying purse from the house (e.g. 3 entries). Rewards skill and play
   time, not account creation; the match server already verifies every result, so farming costs real
   (replayed) play. Slower and needs a counter in `PlayerV1` (state migration V2).

Recommendation: (2) fits "judged on the game loop" better; (1) is the fallback if we need it today.

## Security review fixes (2026-11-13)

1. **No free option on the seed.** Starting a new match abandons the previous one. If its seed was already
   fixed, the player's entry is forfeited to the house and it counts as a loss; bots are refunded. Only an
   unseeded match (callback never ran) is fully refunded. Same for expiry. Tests:
   `abandon_after_seed_forfeits_the_players_entry`, `abandon_before_the_seed_is_fixed_refunds_everything`,
   `expired_matches_are_swept_by_anyone`, sandbox `real_player_pays_and_earns`.
2. **Pending matches can't drain the bots.** One unsettled match per player; per-bot `escrowed` tracking so
   a bot that is short only because its entries are in escrow plays on what it has and is never retired
   for it. Test: `bots_short_only_because_of_escrow_are_not_retired`.
3. **No fee bypass.** A player who paid no entry is prize- and bounty-ineligible exactly like a guest.
   Tests: `real_player_who_paid_nothing_wins_nothing`, sandbox `real_player_pays_and_earns`.
4. **No free-match DoS on paid play.** Free matches (guests / no entry) have their own pool (default 100,
   owner-adjustable with `set_max_free`) with a short expiry, lazily swept inside `start_match` before the
   cap check; paid matches have a separate cap (1,000). Guests are further limited by the relayer
   (per-IP and global guest creation, per-sender and per-IP relay rate, per-sender and global gas budgets).
   Tests: `free_matches_are_capped_and_lazily_swept_but_never_block_paid_play`, sandbox
   `full_free_pool_never_blocks_a_paying_player`.

## Trust model (say it honestly in the README)

- The **match server computes** the result (it re-runs the recorded inputs with the same TS simulation the
  browser runs) and is the only account allowed to settle. The **chain records** the result, the input-log
  hash (`sha256(JSON.stringify(record.inputs))`) and the final sim hash.
- **Anyone can re-verify** a match offline: fetch `GET /api/match/<id>/record`, check its input-log hash
  equals `get_match(id).result.input_log_hash`, rebuild the config from `get_match`, run `replayRecord` and
  compare placements and `result_hash`.
- Seeds come from next-block randomness, so nobody (server included) knows the map/bot behaviour before the
  match is committed. A player could still search inputs offline after the seed is known (deterministic
  sim); the server checks only that the inputs are legal and reproduce the claimed result.
- The owner can upgrade the contract (`migrate`) and change the server account (`set_server`).

## Running it

```sh
# contract
cd contracts/royale && cargo test --lib && cargo near build non-reproducible-wasm && cargo test --test sandbox
# relayer + match server (reads ../.env; port 8788 — 8787 is the HOARD relayer)
npm i --prefix relayer && npm test --prefix relayer && npm start --prefix relayer
# live end-to-end on testnet (guest -> start -> play with the real sim -> settle)
node --env-file=.env --import ./relayer/src/ts-resolve.ts scripts/e2e.ts --matches 3
# deploy (dry run prints steps + NEAR cost; mainnet refused without BR_MAINNET_YES=yes)
npm i --prefix scripts && node scripts/deploy.ts --root <root>.testnet --dry-run
# upgrade in place (deploy + migrate; keeps bots and balances)
node scripts/upgrade.ts --root br-7e8492.testnet [--dry-run]
# economy simulation (defaults = lib.rs constants)
node scripts/econ-sim.ts --curve
```

`relayer/src/ts-resolve.ts` lets Node load `src/sim/*` (extensionless imports written for Vite).

## Simulation version guard

The browser and the match server must run the same simulation or every replay mismatches.
`SIM_VERSION` (src/sim/types.ts, bumped on any rule/AI/mapgen change) is checked on both sides:

- `GET /api/health` returns `simVersion`. `createGameClient()` goes offline with
  `offlineReason: "sim_version_mismatch"` if it differs (or is missing: an old server).
- The client sends `simVersion` with every `/api/settle`; the server refuses a different one with
  409 `{code: "sim_version_mismatch", simVersion: <server's>}` before replaying anything, and the client
  then switches to offline for the rest of the session.
- `/api/settle` error codes: `bad_request`, `sim_version_mismatch`, `no_match`, `bad_signature`,
  `unknown_key`, `busy`, `config_mismatch`, `replay_mismatch`, `chain_refused`.
- `offlineReason` values: `relayer_unreachable`, `wrong_contract`, `sim_version_mismatch`,
  `no_webcrypto`, `chain_error`. The client never logs to the console (quality gate); the last error
  text is kept in the client's `lastError` for debugging.
- Deploy rule: restart the match server from the same commit as the client build.

Live check (server on :8798, sim r4): wrong version → `sim_version_mismatch`; the game client played and
settled match #20 verified (start `AuSDe77Y8yfZwoNimJ4NTYCE9B81TGzNBEgsDPFRyFfr`, settle
`HZEp1dXU6sPSs5rk6PzYPxnzBbHgkMnXjDMoAPE34V43`).

## Client integration

`src/net/client.ts` implements `GameClient` (src/net/api.ts) with **no new dependencies**:
`src/net/near.ts` does ed25519 with WebCrypto, base58, borsh for NEP-366 delegate actions, sha256 and RPC
views (tested against near-kit's decoder and the relayer's signature checks in relayer/test/net.test.ts).

- `createGameClient()` probes `GET /api/health` (2.5 s); chain mode only if the relayer serves the expected
  contract and WebCrypto ed25519 exists, else `mode: "offline"` (local seed + `t1Roster()`).
- Any chain failure during `account()`, `fighters()` or `startMatch()` flips to offline for the session;
  `settle()` never throws: on failure it returns `verified: false` with no payouts.
- The guest key is stored in localStorage (`bountyroyale.guest.v1`); a stale guest (unknown key / not
  registered, e.g. after a fresh deploy) is replaced automatically.
- Config: `VITE_RELAYER_URL` (default `http://127.0.0.1:8788`), `VITE_CONTRACT_ID` (default
  `royale.br-7e8492.testnet`), `VITE_NEAR_RPC`, `VITE_EXPLORER`.
- The relayer allows CORS from 5173/5180/5181/5184 on localhost and 127.0.0.1 (`CORS_ORIGINS` overrides).
- `settle()` reads payouts from the `settle_match` result and retirements / rookies / upgrades from the
  tx's `bountyroyale` events (returned by `/api/settle`).
- Live check: `node --env-file=.env --import ./relayer/src/ts-resolve.ts scripts/e2e-net.ts --matches 3`
  (relayed start ≈ 3–4.5 s incl. next-block seed, settle ≈ 2.2–2.6 s, new guest ≈ 4 s).


## Explorer labels
Nearblocks may still label testnet transfers "Bounty (BOUNTY)": it cached the token metadata from before the rename. The contract's `ft_metadata` returns name "Nox", symbol "NOX" (check: `near contract call-function as-read-only royale.br-7e8492.testnet ft_metadata json-args {} network-config testnet now`). A mainnet deploy starts with the new metadata.

## Minting history (testnet)
Genesis 2,900 NOX + 250 NOX minted by v1 pot top-ups while the House was below its floor = 3,150 total minted. Since the economy v2 upgrade (2026-11-13) total minted is unchanged (`npm run verify` checks it); supply only falls by burns.
