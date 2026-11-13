# Mainnet release plan (NOT executed — needs the owner's explicit "yes")

Nothing here has been run on mainnet. No mainnet keys exist on this machine. Every step that touches mainnet or hosting waits for the owner.

## 1. What goes live
| Piece | Where | Notes |
|---|---|---|
| Game contract + $BOUNTY (NEP-141) | `royale.<root>.near` | same code as testnet `royale.br-7e8492.testnet` (`contracts/royale`, 353 KB wasm) |
| 9 bot fighters + house | `<name>.royale.<root>.near` | created by `new()` with **no access keys** |
| Match server (only account allowed to `settle_match`) | `server.<root>.near` | key only in hosted env vars |
| Relayer (guests, storage, gas) | `relay.<root>.near` | key only in hosted env vars |
| Frontend | static hosting (Vercel or GitHub Pages) | `npm run build` → `dist/` |
| Relayer + match server process | Node 24 host (Railway or Fly.io) | `npm start --prefix relayer`, needs a small persistent volume for `relayer/data/` |

## 2. Cost estimate [from `scripts/deploy.ts --dry-run`, testnet-measured gas]
| Item | NEAR |
|---|---|
| Contract account funding (code storage 3.53 + state headroom 0.96) | 4.50 |
| Server account (settle gas) | 1.00 |
| Relayer account (guest accounts, storage deposits, relayed gas) | 4.00 |
| Deploy gas upper bound | 0.05 |
| **Total from the root account** | **≈ 9.55** |
| Ongoing: per new guest | ≈ 0.024 (0.003 account + 0.02 storage deposit + gas) |
| Ongoing: per match | ≈ 0.001 start (relayer) + 0.001–0.007 settle (server) |
| Example: 300 guests × 3 matches | ≈ 7.2 + 3.6 ≈ **11 NEAR** extra relayer/server budget |
Plus the root account itself (a named `.near` account the owner creates and funds in their own wallet).

## 3. Steps (owner does the key steps; Claude never sees seed phrases)
1. **Owner:** create/fund a mainnet root account (e.g. `bountyroyale.near`) in your own wallet with ≥ 21 NEAR (9.55 deploy + ~11 operating buffer).
2. **Owner:** import that key into the NEAR CLI legacy keychain yourself (`near account import-account …`) — only after saying "yes" to the deploy. Tell Claude when done (Claude checks only that the file exists, never prints it).
3. **Claude:** build the wasm (`cargo near build non-reproducible-wasm` today; a reproducible NEP-330 build needs Docker + `[package.metadata.near.reproducible_build]` in `contracts/royale/Cargo.toml` — not configured yet [verified], recommended before mainnet), then the guarded deploy: `BR_MAINNET_YES=yes node scripts/deploy.ts --network mainnet --root <root>.near` — creates the contract, bots, server and relayer accounts; writes `scripts/deployments/mainnet.json` (accounts + tx hashes, no keys); new server/relayer keys go only to a local `.env.mainnet` (gitignored) for the hosting step.
4. **Claude:** read-only checks — `npm run verify` against mainnet (contract exists, 9 bots keyless, config), one smoke match settled by the server.
5. **Owner "yes" for hosting:** Claude deploys the frontend (Vercel/GitHub Pages) and the relayer (Railway/Fly.io) with keys pasted by the owner into the host's secret env vars (Claude provides the exact variable names; it does not upload keys itself).
6. **Before submission (owner decides):** optionally delete the root's full-access key from the contract account to make the rules final (no more upgrades), as the brief allows "contract keys are removed only right before submission".

## 4. Risks and how they're handled
| Risk | Mitigation |
|---|---|
| Relayer drained by fake guests | per-IP + global hourly guest caps, gas budgets per sender, signature + key-owner checks before spending, one storage subsidy per account (refunds go back to the relayer) |
| Server key compromise → fake settlements | server can only call `settle_match`; every settled match stores its input-log hash and anyone can re-verify offline (`npm run verify-match`); owner can rotate the server account (`set_server`) |
| Token treated as an investment | $BOUNTY is a game token: no sale, no swap, no NEAR→$BOUNTY purchase in the app; guests earn zero |
| Block randomness | seed is fixed by `random_seed` in a later block; documented as not validator-proof |
| Real players' first $BOUNTY | **owner decision pending** (welcome stake vs earned qualification); `house_grant` is testnet-only tooling |

## 5. Open decisions for the owner
1. "Yes" to mainnet deploy (steps 1–4) and the root account name.
2. "Yes" to hosting (step 5) and which hosts.
3. First $BOUNTY for real players: welcome stake or earned qualification.
4. Multi-wallet sign-in via `@hot-labs/near-connect` 0.12.0 (today: MyNearWallet redirect only).
5. Whether to lock the contract (remove keys) before submission.
