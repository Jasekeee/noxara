# Mainnet cost — option A (full game) vs option B (anchor only)

> **History:** option A (the full game on `noxara.near`) was chosen and executed on 2026-11-14. Option B was not used.

All numbers measured on testnet on 2026-11-14 unless marked [assumed]. Storage: 1 NEAR per 100 KB (10^-5 NEAR/byte).
Gas: mainnet and testnet use the same minimum gas price (0.1 Ngas → 0.0001 NEAR per Tgas).

## Measured inputs
| Item | Value | Source |
|---|---|---|
| Game contract wasm (optimized build) | 520,948 B (was 524,292 B, −0.64%) | `node scripts/build-contract.ts`, sha256 `d734724f07c8c0a4de5461d2e72fef86f20ba8c2e0a7960e74c3da8d19057472`; recipe (wasm-opt 123 pinned, cargo-near 0.23.0, toolchain 1.95.0) is part of the source guard |
| One new guest (account funding + storage + gas + its first relayed start) | 0.0275 NEAR = 0.01514 storage (into the contract, refundable at teardown) + 0.003 funding (stays in the guest account) + ≈ 0.0094 gas | relayer budget delta around one live guest + match (g-e85b5e1586…, start `Dfy4jVgH…`) |
| Relayed `start_match` | 0.00153 NEAR (16.0 Tgas) | tx `Dfy4jVgHPySJ3GnyRGSDgNVbnkrZMq6nq483XLExnePf` |
| `settle_match` | 0.00274 NEAR (27.6 Tgas) | tx `35hGrbpJDm2PicNNkQQKSypvJomdzFWDYWnme2rHnaoT` |
| Contract state growth paid by the contract | testnet: ≈ 96 KB of state after 84 matches, including guest/player rows paid by their own deposits; 0.3 NEAR headroom = 30 KB [assumed enough for a few hundred matches — top up if `get_economy` calls start failing] | `view_account` storage_usage 620,586 − code |
| Anchor contract (option B) | 2,254 B (after the security fix that ties days to block time); one daily record ≈ 245 B + 40 B overhead ≈ 0.0029 NEAR | `contracts/anchor` (built by `scripts/build-contract.ts`), `node scripts/anchor-daily.ts` |

## Option A — the whole game on mainnet (`noxara.near`, contract on the root)
| Item | NEAR | Kind |
|---|---|---|
| Contract code storage (520,948 B) | 5.2095 | locked, refundable (delete-account after 2026-11-25) |
| Genesis state | 0.06 | locked, refundable |
| State headroom | 0.30 | locked, refundable (whatever isn't used) |
| 10 keyless NPC accounts (9 fighters + house) | 0.01 | **spent** (keyless accounts can't be deleted) |
| `relay.noxara.near`: guest budget (owner: 0.5 ≈ 18 guests, cap 18/day; then guests get the free Training Island) | 0.50 | ≈ 0.22 spent (funding + gas), ≈ 0.27 storage → contract → refundable |
| `relay.noxara.near`: real-account budget (≈ 10 registrations + gas; then players sign their own txs) | 0.25 | storage refundable, gas spent |
| `relay.noxara.near`: settlement gas (≈ 90 matches at 0.00274) | 0.25 | **spent** as used; leftover refundable |
| Deploy gas (upper bound) | 0.05 | **spent** (expected ≈ 0.01) |
| **Total to fund `noxara.near`** | **6.63** (owner funds 6.7) | |
| Of which locked & refundable after teardown | ≈ 5.6–5.9 | |
| Of which really spent (≈ 18 guests, ≈ 90 matches) | ≈ 0.55 at full use; ≈ 0.1 if traffic is light | |
Not included (both options): registering the name `noxara.near` itself in your wallet.

## Option B — game stays on testnet; mainnet holds an anchor + the 9 mercenaries' identities
| Item | NEAR | Kind |
|---|---|---|
| Anchor contract code on `noxara.near` (2,254 B) | 0.0225 | locked, refundable (delete-account) |
| Account record + your full-access key + the server's function-call key (limited to `anchor`) | ≈ 0.004 | locked, refundable |
| 9 keyless mainnet identities `<name>.noxara.near` (100 B each, no keys, no NOX) | 0.009 | **spent** |
| One record per UTC day until 2026-11-25 (12 days × ≈ 0.0029) | ≈ 0.035 | locked, refundable with the account |
| Daily `anchor` gas (≈ 3 Tgas × 12) + creation txs | ≈ 0.006 | **spent** |
| **Total to fund `noxara.near`** | **≈ 0.08** (fund 0.1) | |
| Really spent | ≈ 0.015 | |
Hosting is the same in both options (Railway relayer + match server, Vercel game).

### How option B would be presented (honestly)
README "On NEAR" section:
> The game — 9 AI mercenaries with real wallets, the NOX economy, every match — runs on **NEAR testnet** (`royale.br-7e8492.testnet`).
> On **mainnet**, `noxara.near` runs a 2.3 KB append-only **anchor**: once per UTC day the match server writes the SHA-256 of every match settled on testnet that day (`id:input_log_hash` lines) plus an economy snapshot (supply, burned, House). The 9 mercenaries also have mainnet identities `<name>.noxara.near` with **zero keys** — they hold no NOX on mainnet; their wallets live on testnet.
`npm run verify` would add: "PASS mainnet anchor for <day>: the recorded root equals the root recomputed from testnet" and "PASS 9 mainnet identities have 0 access keys".

## Recommendation
**Option A, if you can lock ≈ 6.4 NEAR until 2026-11-25** — the real game on mainnet (keyless mercenaries with mainnet wallets, guests as `g-<id>.noxara.near`) for ≈ 0.1–0.45 NEAR actually spent; ≈ 5.6–5.9 NEAR comes back on teardown.
**Option B if you don't want to lock that much**: ≈ 0.08 NEAR in total, but mainnet then proves only that the testnet history wasn't rewritten — the game itself stays on testnet (allowed by the hackathon rules, Q-010).
Fallback rule unchanged: if A isn't live and stable by 15:00 UTC, submit testnet (optionally with B).

## Security checks on these changes (2026-11-14)
- Optimized build: **GO** (exports/imports identical before/after -Oz, overflow checks kept, no new wasm features, binaryen pinned + lockfile integrity, sandbox 17/17 on the optimized wasm). Fixed: exact `binaryen` pin; the source guard now covers the build recipe.
- Anchor contract: **GO after fix A1** — a record's day must be a real date between (block day − 2) and the block day, so a leaked writer key can't brick the anchor with a far-future date. Writer = a function-call key on the anchor account limited to `anchor`, with a finite allowance (0.25 NEAR). Sandbox test covers stranger writes, future/stale/fake dates, overwrite, backdating, deposits, size cap.
