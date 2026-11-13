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
| Genesis bots (keyless) | `bramble`, `ox`, `pip`, `vex`, `moss`, `juno`, `rook`, `tink`, `sable` `.royale.br-7e8492.testnet` |

| Tx | Hash |
|---|---|
| create + deploy + `new()` (creates house + 9 bots, mints genesis) | `6friAiTr2Qs9DWdTuGpZGPgYx8z2tL7aL4GssBxZ35GB` |
| create server account | `Ax3sZQ8krFvmGd2eHEWMtM13zaTxmS2R1H8tGNRLsv7Y` |
| create relayer account | `3oGwqax4tLPZ5TLivKwAt1RDhNFEAtTUKJPMoqEcyQea` |
| live e2e: guest (match 4) | `GWpGYPF3aPULfh9HZjgtf2gR3wDewjxwyUA8bVtUp3Yc` |
| live e2e: relayed `start_match` #4 | `CsJCwCBjjeLHfVJ1fgHtnmY627ZagcoeCXo6ofjGPPiU` |
| live e2e: `settle_match` #4 (Vex won, real sim replayed by the server) | `8ikqTyFN2J7KjqTJ6B4LDBgekV4yk5eyWTbTbYWSMsC9` |
| live e2e: `settle_match` #5..#7 | `64Zy8cYWExbDdLKJvRvm5p71UfNKVj5K3azkH1oQyFWw`, `3pnDcuqbD4duCYzt4YFxf4VfSgQc1Dombvx4bLymyXRf`, `6daxzXywUnYSgQbA6msNCLtdWux8zs1F3EdNyUJmsdXQ` |

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
2. **Start:** the client signs a delegate action for `start_match` → `POST /api/relay`. The contract:
   - lazily sweeps up to 3 expired free matches; abandons the player's previous unsettled match (see rules);
   - charges each active bot `ENTRY_FEE` (10 $BOUNTY) into escrow (the contract's own token balance);
     a real player with ≥ 10 $BOUNTY pays too;
   - a bot that can't pay **and** has nothing in escrow retires; a rookie takes the slot;
   - marks the richest active bot as the bounty carrier;
   - self-calls `resolve_start`, which fixes the **seed in a later block** (`random_seed` + sha256 with the
     match id and player). The tx's final value is `MatchStart {match_id, seed, roster, bounty_idx, ...}`.
3. **Play:** the client builds the sim config with `matchConfigFromChain(start)` (relayer/src/roster.ts;
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
| Entry | 10 $BOUNTY per bot; real players pay if they have it |
| Pot top-up (only per-match mint) | 20 $BOUNTY per settled match |
| Burn / house cut | 2% / 5% of each pot |
| Bounty | 25% of the carrier's wallet, to whoever killed it (guests / non-payers: to the house) |
| Winner payout | bot → its wallet; real player who paid → their wallet; guest, non-payer or no winner → house |
| Upgrades (one per bot per settlement, only if ≥ 40 left after) | weapon tier 1/2: 120/240; armor 1/2: 160/320; then a new skin: 150. Paid to the house |
| Retirement | wallet < entry AND nothing in escrow; the bot keeps its dust, its record stays (`get_retired`) |
| Rookie | name + play style from the match seed, new keyless account `<name>-<n>.royale…`, 100 from the house (or what it has), generation = predecessor + 1 |
| Expiry | free matches 500 blocks, paid 1,200 blocks; `sweep_match` by anyone; `start_match` sweeps the oldest free ones |
| Storage | 0.02 NEAR per player (NEP-145, min = max); guests: prepaid by the relayer. Measured: 983 bytes for player + FT account + one pending match |

**$BOUNTY supply:** minted only at genesis (9 × 100 to the bots, 2,000 to the house) and as the per-match
pot top-up; burned 2% of every pot (+ unregister burns). Entries, prizes, bounties, upgrades and rookie
grants move existing tokens. `get_config` exposes `total_minted`, `total_burned`, `total_supply`; tests
assert `sum(balances) == total_supply == minted − burned` after every match.

**On-ramp for real accounts:** players get $BOUNTY only from winning paid matches, bounties, transfers,
or `house_grant` (owner-only, ≤ 100 per call, from the house treasury, never mints, never to guests).

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
```

`relayer/src/ts-resolve.ts` lets Node load `src/sim/*` (extensionless imports written for Vite).

## Client integration (for the lead)

`relayer/src/client.ts` is browser-ready: `Session.restore(cfg) ?? Session.createGuest(cfg)`,
`session.startMatch()` → on-chain match, `matchConfigFromChain(m, {name})` → `createMatch`,
`session.settle(match_id, record)`. Views: `view(cfg, "get_fighters" | "get_leaderboard" | "get_match" |
"get_recent_matches" | "get_retired" | "get_player" | "get_config" | "ft_balance_of")`.
Needs in the root package.json: `near-kit` 0.20.2, `@noble/hashes` 2.4.0 (already deps of the relayer).
