# NOXARA — mainnet release plan (NOT executed)

Owner decision (2026-11-13): **mainnet yes, in the cheapest safe form — prepare, then ask.** Nothing here
has been run on mainnet. No mainnet keys exist on this machine. Every mainnet or hosting step waits for
the owner's literal reply **"yes, deploy"**.

## 0. Gate before any mainnet step
| Gate | Status |
|---|---|
| Independent security audit #1 of `contracts/royale` | done 2026-11-13: **NO-GO** (2 HIGH, 3 MEDIUM, 2 LOW) — fixes in progress |
| All HIGH/MEDIUM fixed, each with a regression test (incl. the audit's PoC exploits) | pending |
| Second fresh audit says GO | pending |
| Full mainnet topology rehearsed on testnet (deploy → match → settle → teardown → balance returned) | pending |
| Release wasm rebuilt from the audited commit (+ checksum recorded here) | pending |

## 1. Accounts (nothing beyond these)
| Account | Role |
|---|---|
| `noxara.near` | root **and** contract: game + Nox (NOX) token in one contract. Free as of 2026-11-13 (read-only `view_account` check; fallbacks `playnoxara.near`, `noxaragame.near` also free) |
| `relay.noxara.near` | relayer (guest accounts, storage, relayed gas) **and** the only account allowed to `settle_match`. Trade-off: one hot key instead of two; whoever holds it can settle matches, but every settlement stores its input-log hash and anyone can re-verify it offline (`npm run verify-match`); the owner can rotate it with `set_server` |
| `<bot>.noxara.near` ×10 (9 fighters + house) | created by the contract with **no access keys**, funded with exactly their storage (100 bytes ≈ 0.001 NEAR) |

The owner account (your wallet, e.g. `<you>.near`) is set as `owner` and as the fixed teardown beneficiary at `new()`.

## 2. Cost (preliminary — final numbers after the audit fixes and the testnet rehearsal)
| Item | NEAR | Kind |
|---|---|---|
| Contract code storage (wasm ≈ 353 KB → 1 NEAR per 100 KB) | ≈ 3.53 | refundable (on teardown) |
| Contract state headroom (testnet: ≈ 56 KB after 46 matches) | ≈ 0.96 | refundable |
| Relayer budget: guest accounts + storage deposits + relayed gas, hard-capped | 1.00 | mostly spent; unused part refundable |
| 10 keyless bot/house accounts | 0.01 | spent (no key → can't be deleted) |
| Deploy gas | ≤ 0.05 | spent |
| **Total** | **≈ 5.6** (fund the root with ≥ 7) | ≈ 4.5 refundable / ≈ 1.1 spent |

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

## 4. Teardown after 2026-11-25
The season ends 2026-11-25 00:00 UTC. NOX is play-money. From the season end new matches are refused;
players can unregister to get self-paid storage deposits back.
1. Delete the game contract and return its whole balance (code + state storage) to your wallet:
   `near account delete-account noxara.near beneficiary <you>.near network-config mainnet sign-with-legacy-keychain send`
   If the contract's full-access key was removed before submission, call the time-locked owner method instead:
   `near contract call-function as-transaction noxara.near teardown json-args '{}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as <you>.near network-config mainnet sign-with-legacy-keychain send`
   (it sweeps any unsettled match first and pays the fixed beneficiary; refused before 2026-11-25).
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
| Token treated as an investment | NOX is play-money: no sale, no swap, no NEAR→NOX purchase, guests earn 0, season ends 2026-11-25 |
| Block randomness | seed fixed by `random_seed` of a later block; not validator-proof (documented) |
