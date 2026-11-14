# Security policy

## Reporting a vulnerability
Please report privately through **GitHub private vulnerability reporting**: on the repository page open **Security > Report a vulnerability**. Do not open a public issue for anything exploitable.

Include what you found, how to reproduce it (a transaction hash, a match input log, or a request), and the impact you think it has. We aim to acknowledge reports within a few days; this is a hackathon project maintained by a small team, so there is no formal SLA.

## Scope
In scope:
- the mainnet contract **`noxara.near`** (source: `contracts/royale/`) and the accounts it controls (keyless bot accounts `*.noxara.near`, guest accounts `g-*.noxara.near`);
- the **match server / relayer** (`relayer/`, hosted at `noxara-production.up.railway.app`), including replay verification, relayed gas and guest-key handling;
- the deterministic simulation in `src/sim/` where it can make a settled result differ from the recorded inputs.

Out of scope: the third-party services we use (NEAR RPC, NearBlocks, Vercel, Railway), social engineering, denial of service through volume, and issues that need physical access to a user's device.

## Known limitations (not bugs)
These are documented trust assumptions, see the **Trust model** section of the [README](README.md) and [`docs/AUDIT.md`](docs/AUDIT.md): the match seed is public after `start_match`, the match server is a single trusted operator today, and the owner keeps the contract's full-access key while the project is being judged.

## Rewards
This project does not run a bug bounty and makes no promise of payment. Responsible reports are appreciated and will be credited if you wish.

## Safe testing
Do not test against other people's accounts. NOX is play-money, but please keep testing to your own account or the testnet rehearsal contract (`royale.br-7e8492.testnet`).
