# Challenge a friend + Daily tournament

Decisions 7 and 8 in `docs/DECISIONS.md`. No chain, no tokens, no contract changes: everything is the
shared simulation (`src/sim`) replayed by the relayer (`relayer/src/social*.ts`, `challenge.ts`, `tournament.ts`).

## Endpoints (relayer, same port as the rest)
| Method + path | What |
|---|---|
| `POST /api/challenge` `{record, simVersion, name, game?}` | replays the record (`replayRecord` hash must match), stores `{cfg, result}` in `relayer/data/challenges/<id>.json`, returns `{id, path:"/c/<id>", result}`. 20 per IP per hour |
| `GET /api/challenge/<id>` | exact `cfg` (seed + roster, fighter 0 = "You") + a one-time `token` (HMAC, anchors the real-time check) |
| `GET /api/challenge/<id>/results` | original run + up to 20 answers |
| `POST /api/challenge/<id>/answer` `{record, token, simVersion, name}` | replay-verified, real-time checked (run must take at least 90 % of `ticksTotal / 20` s since the token), returns both runs and the verdict. 40 per IP per hour, 20 answers max |
| `GET /c/<id>` | HTML with `og:title` ("Placed 2/10 with 4 kills — can you beat it? NOXARA"), `og:description`, `og:image` = `<PUBLIC_URL or request host>/og.png`, then redirects to `<game>?challenge=<id>` |
| `GET /api/daily` | `{day, seed, roster, endsAt, token, players}` |
| `POST /api/daily/submit` | replay + real-time + identity (below); best run per player kept |
| `GET /api/daily/leaderboard?day=` | top 50 |

Env: `PUBLIC_URL` (frontend origin for og:image), `GAME_URL` (redirect target when the poster's origin is not on the CORS list), `SOCIAL_SECRET` (HMAC secret; else generated into `relayer/data/social.secret`), `CORS_ORIGINS` (also the allow-list for the redirect target, so `/c/<id>` can't be an open redirect).

## Daily rules
- seed = first 4 bytes (big endian) of `sha256("noxara-daily-" + YYYY-MM-DD)`, `1` if zero. Roster = `t1Roster()` with base upgrades (reproducible offline from the date; no chain snapshot, so no chain dependency).
- Score: placement, then kills, then ticks survived. Token: single use (spent and persisted before any await), valid 45 min, only on the day it was issued; submissions at or after 00:00 UTC are refused (no grace).
- Identity: a signed-in account signs `sha256("noxara:daily:<day>:<input log hash>")` with its function-call key; the server checks the signature and that the key belongs to the account (RPC `view_access_key`, same `KeyOwners` as `/api/settle`). Valid = `real` (prize-eligible). `g-*.<relayer>` accounts = `guest`, earns 0. A claim that doesn't verify = `unverified` ("NO PRIZE"), earns 0. No account = `Guest xxxx` from a random id kept in localStorage, earns 0.
- Prizes are never automatic: `node scripts/daily-prizes.ts [day]` prints the top 3 verified real accounts and the `near contract call-function ... house_grant` testnet commands (100/50/25 NOX, play-money). Dry run only; the contract enforces owner-only, the 100 NOX cap and the House floor.

## Honest limits
- The server verifies consistency, not that a human played: the seed is public and the sim deterministic, so a bot can produce a valid record. The real-time check only stops instant offline searching.
- A challenge creator's roster is taken from the posted record (shape-checked and replayed, not compared with any chain); stakes don't exist, so a hand-made roster only affects that challenge.
- Rate limits and used-token lists are per relayer process / data directory.
- The browser only reaches this through the relayer URL (`VITE_RELAYER_URL`); with it unreachable the DAILY page and the challenge button say so and offline practice is untouched.
