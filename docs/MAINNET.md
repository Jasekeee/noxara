# NOXARA — mainnet release (EXECUTED 2026-11-14)

> **Executed 2026-11-14.** Contract `noxara.near`, deploy tx `BmMiB9ccNQcWkGnFZxCLMG8VQRn7GDBGT1EHXK2r26H6`, code sha256 `d734724f07c8c0a4de5461d2e72fef86f20ba8c2e0a7960e74c3da8d19057472`; owner `zhasik.near`; relayer / match server `relay.noxara.near`. Game https://playnoxara.vercel.app, server https://noxara-production.up.railway.app. The full-access key on `noxara.near` is kept for fixes during judging. The admin methods are listed in the README ("Admin powers"). The testnet build (`royale.br-7e8492.testnet`) remains as the rehearsal environment.
> **Ranked (on-chain) play runs until 2026-12-15 00:00 UTC** (the contract then refuses new matches; extended from 2026-11-20 by a code upgrade, see §6); practice modes are always available. 2026-12-15 to 2026-12-20 is the exit window (players reclaim deposits); teardown from 2026-12-20.
>
> Everything below is the original plan, kept as history; where it says "NOT executed", "pending" or "after yes", read it as done unless the box above says otherwise.

*History (2026-11-13):* the owner decided mainnet yes in the cheapest safe form — prepare, then ask; every step waited for the literal reply "yes, deploy".

## 0. Gate before any mainnet step
| Gate | Status |
|---|---|
| Independent security audit #1 of `contracts/royale` | done 2026-11-13: **NO-GO** (2 HIGH, 3 MEDIUM, 2 LOW) — fixes in progress |
| All HIGH/MEDIUM fixed, each with a regression test (incl. the audit's PoC exploits) | pending |
| Second fresh audit says GO | pending |
| Full mainnet topology rehearsed on testnet (deploy → match → settle → teardown → balance returned) | pending |
| Independent audit #3 | done 2026-11-13 ~20:00 UTC: GO once the stale default wasm is rebuilt (done) + MEDIUM sponsor-cut scaling (fixed, test `audit3_a_small_stake_earns_a_proportional_cut`); LOWs can follow as an upgrade |
| Release wasm rebuilt from the audited commit (branch `release/v1`) | `contracts/royale/target/near/royale.wasm`, 394,518 bytes, sha256 `a6377e2ea4124985a6fe006dd53bb167dc98e2b227b3f00f603f1128f39063ca`; `scripts/deploy.ts`/`upgrade.ts` refuse a wasm older than the sources |

**Deadline rule:** if mainnet is not live and stable by 2026-11-14 15:00 UTC, the testnet version is submitted. **Keys:** the contract's full-access key is NOT removed (fixes during judging, teardown after 2026-12-20); the README lists every admin method ("Admin powers").

**Latest build (main, 2026-11-14 07:20 UTC):** wasm 524,292 bytes, sha256 `9cf9a98585c2f8128559a550b28ad51d36205b7cdfe3edd37d03525dd977e4b4` (sources `ce6bbdd9…`; adds the daily login reward with split pools and `create_guest`; audit #7 GO for testnet and mainnet after the M-1/L-1/L-2 fixes; unit 115/115, sandbox 17/17), live on testnet since tx `EzfE6CMCiP2P7oGpa4sbVWMxjbL9Uti41KkxNjGLaYNa` (supply unchanged). Previous: 504,653 B `a087c20a…` (tx `3ovpnnJo…`).

**Economy v2 release candidate (branch `main` after the econ-v2 merge):** audits #4 (1 HIGH, 2 MEDIUM — fixed with regression tests) and #5 (GO); unit 99/99, sandbox 14/14; wasm 491,729 bytes, sha256 `3f8113a2a0e254a004660547bf7c3716c10384e3694136218456a42d752795ad` (sources `8bb89e2a4523`), live on testnet since tx `Cee2iTn4tY1ViFucoT4j8qfQ4gkX2i7wfuGmW4B2EJSA`. Fallback: `release/v1` (economy v1, audit #3 GO, sha256 `a6377e2e…063ca`).

## 1. Accounts (nothing beyond these)
| Account | Role |
|---|---|
| `noxara.near` | root **and** contract: game + Nox (NOX) token in one contract. Free as of 2026-11-13 (read-only `view_account` check; fallbacks `playnoxara.near`, `noxaragame.near` also free) |
| `relay.noxara.near` | relayer (guest accounts, storage, relayed gas) **and** the only account allowed to `settle_match`. Trade-off: one hot key instead of two; whoever holds it can settle matches, but every settlement stores its input-log hash and anyone can re-verify it offline (`npm run verify-match`); the owner can rotate it with `set_server` |
| `g-<hex>.noxara.near` | walletless guests. Created by the **contract** (`create_guest`, callable only by `relay.noxara.near`, which attaches the 0.003 NEAR funding) with one function-call key: receiver `noxara.near`, methods `start_match`/`sweep_match`, allowance 0.05 NEAR — fixed in the contract. The relayer runs with `GUEST_VIA_CONTRACT=1` and never holds a key of `noxara.near`. Old `g-*.relay.*` guests (testnet) stay guests too |
| `<bot>.noxara.near` ×10 (9 fighters + house) | created by the contract with **no access keys**, funded with exactly their storage (100 bytes ≈ 0.001 NEAR) |

The owner account (your wallet, e.g. `<you>.near`) is set as `owner` and as the fixed teardown beneficiary at `new()`.

## 2. Cost — superseded by docs/COST.md (measured 2026-11-14: option A ≈ 6.38 NEAR to fund, ≈ 5.6–5.9 refundable; option B ≈ 0.07 NEAR). The table below is the older estimate.
| Item | NEAR | Kind |
|---|---|---|
| Contract code storage (wasm 524,292 B incl. daily check-in/quests, login reward, `create_guest` → 1 NEAR per 100 KB) | ≈ 5.24 | refundable (on teardown) |
| Contract state headroom (testnet: ≈ 56 KB after 46 matches) | ≈ 0.96 | refundable |
| Relayer budget: guest accounts + storage deposits + relayed gas, hard-capped | 1.00 | mostly spent; unused part refundable |
| 10 keyless bot/house accounts | 0.01 | spent (no key → can't be deleted) |
| Deploy gas | ≤ 0.05 | spent |
| **Total** | **≈ 7.3** (fund the root with ≥ 8) | ≈ 6.2 refundable / ≈ 1.1 spent |

Ongoing: Railway smallest plan for match server + relayer (≈ $5/month [assumed — check price before launch]); Vercel static hosting free tier [assumed].

**Guest budget:** when the relayer's 1 NEAR budget (or the daily guest cap / per-IP limit) is used up, the
relayer stops cleanly (`/api/health` → `guests: "closed"`); guests then play offline (clearly labelled,
nothing recorded) while signed-in players keep playing with their own function-call key allowance.

## 3. Steps
**Owner:**
1. In your own wallet create `noxara.near` and fund it with ≥ 7 NEAR.
2. Import its key without typing a seed phrase anywhere here:
   `near account import-account using-web-wallet network-config mainnet` (approve in the wallet page).
3. Reply **"yes, deploy"** and say whether you run the deploy commands yourself (Claude writes them out
   verbatim) or Claude runs them via the CLI keychain (Claude never prints or opens the key file).

**Claude, after "yes, deploy":**
4. Rebuild the wasm from the audited commit; run all tests; record the checksum here.
5. `BR_MAINNET_YES=yes node scripts/deploy.ts --network mainnet --root noxara.near --contract-on-root --owner <you>.near`
   — deploy + `new()` in **one atomic transaction** (init can't be front-run), creates `relay.noxara.near`
   and the 10 keyless accounts, writes `scripts/deployments/mainnet.json` (accounts + tx hashes, no keys).
   The relayer key goes only to a local gitignored `.env.mainnet` for the hosting step.
6. Read-only checks: contract metadata (Nox/NOX), 10 accounts with 0 keys, one smoke match settled.
7. Hosting (needs the same "yes"): Vercel (frontend) + Railway (relayer). You paste the relayer key into
   Railway's secret variables yourself; Claude gives the exact variable names.
   The relayer's variables include `GUEST_VIA_CONTRACT=1` (guests become `g-<hex>.noxara.near`, made by the
   contract); only `RELAYER_PRIVATE_KEY` (= `relay.noxara.near`) is secret — no key of `noxara.near` is hosted.

## 4. Teardown after 2026-12-20 (planned)
Ranked play ends 2026-12-15 00:00 UTC (new matches are refused from then); 2026-12-15 to 2026-12-20 is the exit window; teardown is allowed from 2026-12-20 00:00 UTC. NOX is play-money.
players can unregister to get self-paid storage deposits back.
1. Delete the game contract and return its whole balance (code + state storage) to your wallet:
   `near account delete-account noxara.near beneficiary <you>.near network-config mainnet sign-with-legacy-keychain send`
   The key is kept, so the CLI path works once the state has been cleared (an account with >~10 KB of state can't be deleted — run the owner-only, time-locked state-clearing calls first). Owner method alternative:
   `near contract call-function as-transaction noxara.near teardown json-args '{}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as <you>.near network-config mainnet sign-with-legacy-keychain send`
   (it sweeps any unsettled match first and pays the fixed beneficiary; refused before 2026-12-20).
2. Delete the relayer account (key from `.env.mainnet` / Railway):
   `near account delete-account relay.noxara.near beneficiary <you>.near network-config mainnet sign-with-legacy-keychain send`
3. Delete the Railway service and the Vercel project.
4. Not refundable: keyless bot/rookie accounts (≈ 0.001 NEAR each) and guest accounts (≈ 0.003 NEAR each).
5. After deletion the name `noxara.near` can be registered again by anyone.

## 5. Risks
| Risk | Mitigation |
|---|---|
| Relayer drained | 1 NEAR hard budget, daily guest cap, per-IP limit, clean stop |
| Relay/server key compromise | can only relay and settle; settlements carry input-log hashes anyone can re-verify; `set_server` rotation |
| Player searches offline for a winning input log (seed is public before play, sim is deterministic) | server rejects records submitted faster than real time and implausible input rates; settlement proves consistency, not human play; winnings are play-money |
| Token treated as an investment | NOX is play-money: no sale, no swap, no NEAR→NOX purchase, guests earn 0, ranked play ends 2026-12-15 |
| Block randomness | seed fixed by `random_seed` of a later block; not validator-proof (documented) |

## 6. Season extension upgrade (owner's "yes": ranked play through judging)
What changes (code-only upgrade, `STATE_VERSION` stays 2, no state layout change): `SEASON_END_MS`
2026-11-20 → **2026-12-15 00:00 UTC** (1797292800000); `TEARDOWN_AFTER_MS` 2026-11-25 → **2026-12-20 00:00 UTC**
(1797724800000), so the 5-day exit window is kept. The lock is stored in state at `new()`, so `migrate()` rewrites
it, and only if it equals the first release's value 1795564800000; any other stored value is left alone.

| | wasm | bytes | sha256 | code hash (base58, what explorers/`view_account` show) |
|---|---|---|---|---|
| live now (first release, main 844dfda, contract sources = ff5058d) | `contracts/royale/tests/fixtures/royale_v3_d734724.wasm` | 520,948 | `d734724f07c8c0a4de5461d2e72fef86f20ba8c2e0a7960e74c3da8d19057472` | `FV53G9XMGr2muMTSgYMcuqh4dyb1axe97fg1y8wbwSSu` |
| season extension (branch `season`) | `contracts/royale/target/near/royale.wasm` | 521,197 | `2c85142b3afd34b40a52fe68864bb3fb3fd4c1cf6387edc69c69d869330f7db9` | `3zndndRVT2kNgncJq6CfYTSyjw4Jeo6dQvKqjHq9ng48` |

Extra code storage: +249 B ≈ 0.0025 NEAR. Deploy + migrate measured at 39 Tgas in the sandbox (≈ 0.004 NEAR).
Testnet rehearsal (`royale.br-7e8492.testnet`): upgrade `E4kLgrTmo1qb4osvJWnEKi7LuhQLk88ow3CismQBtQvH`
(teardown 1795564800000 → 1797724800000, supply unchanged), then a real match through the client: start
`9MSDmfC4V3EJsEkVw1dB7Vv2YDK4A5a9TVJfGmzFwmrm`, settle `Gp1iLpDT8ZJvkEyM35PZsti8Ek2BChRqzASzgcTT6Nx1` (Verified).

**Owner commands** (from a checkout that contains this change; the key of `noxara.near` comes from the legacy
keychain `~/.near-credentials/mainnet/noxara.near.json` (or `noxara.near/<pk>.json`), exactly as `deploy.ts` read it;
no `.env` / `ENV_FILE` is used):
```sh
node scripts/build-contract.ts
shasum -a 256 contracts/royale/target/near/royale.wasm   # must print 2c85142b3afd34b40a52fe68864bb3fb3fd4c1cf6387edc69c69d869330f7db9
# 1. dry run: prints the plan, reads no key, sends nothing
node scripts/upgrade.ts --network mainnet --root noxara.near --contract-on-root --expect-sha256 2c85142b3afd34b40a52fe68864bb3fb3fd4c1cf6387edc69c69d869330f7db9 --dry-run
# 2. key check: finds the full-access key of noxara.near, prints only its PUBLIC key, sends nothing
node scripts/upgrade.ts --network mainnet --root noxara.near --contract-on-root --expect-sha256 2c85142b3afd34b40a52fe68864bb3fb3fd4c1cf6387edc69c69d869330f7db9 --check-key
# 3. the upgrade: ONE tx signed by noxara.near = DeployContract + migrate()
BR_MAINNET_YES=yes node scripts/upgrade.ts --network mainnet --root noxara.near --contract-on-root --expect-sha256 2c85142b3afd34b40a52fe68864bb3fb3fd4c1cf6387edc69c69d869330f7db9
```
Expected output of step 3: `before: {"teardown_after":"1795564800000","is_season_ending":false}`, a tx hash after
`upgraded + migrated:`, the same `total_supply` before/after with `version 2`, and
`after: {"teardown_after":"1797724800000","is_season_ending":false}`.

**Verify after:**
```sh
near contract call-function as-read-only noxara.near get_teardown_after json-args '{}' network-config mainnet now
#   -> "1797724800000"   (2026-12-20 00:00 UTC)
near contract call-function as-read-only noxara.near is_season_ending json-args '{}' network-config mainnet now
#   -> false             (turns true at 2026-12-15 00:00 UTC)
curl -s https://free.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"noxara.near"}}'
#   -> "code_hash":"3zndndRVT2kNgncJq6CfYTSyjw4Jeo6dQvKqjHq9ng48"
```
One settled match: play one guest match on https://playnoxara.vercel.app to the end; the result screen shows
**Verified**, and https://nearblocks.io/address/noxara.near lists a `settle_match` from `relay.noxara.near` after the
upgrade tx. (No relayer or frontend change is needed: neither checks the date.)

**Rollback** (back to the first release, sha256 d734724f…). The fixture in this repo is byte-identical to the live
code; `--rollback` refuses any other wasm. To rebuild it from git instead:
`git worktree add ../nox-d734724 844dfda && cd ../nox-d734724 && (cd scripts && npm ci) && node scripts/build-contract.ts && shasum -a 256 contracts/royale/target/near/royale.wasm`
(must print d734724f…; the source guard hash is 354e1fe4…), then pass that path as `--wasm`.
```sh
node scripts/upgrade.ts --network mainnet --root noxara.near --contract-on-root --rollback --wasm contracts/royale/tests/fixtures/royale_v3_d734724.wasm --dry-run
BR_MAINNET_YES=yes node scripts/upgrade.ts --network mainnet --root noxara.near --contract-on-root --rollback --wasm contracts/royale/tests/fixtures/royale_v3_d734724.wasm
```
After a rollback: state and balances are kept (the old `migrate` just re-reads v2 state); `get_teardown_after` stays
**1797724800000** (2026-12-20: the old code reads the stored lock, and `migrate` already rewrote it), while ranked play
ends again at **2026-11-20 00:00 UTC** (the old constant). The old code's error text still says "locked until
2026-11-25", but the lock it enforces is the stored 2026-12-20. Rehearsed in the sandbox
(`upgrades_the_live_mainnet_code_and_extends_the_season`).
