# File ownership (parallel agents)

Each agent works in its own git worktree/branch and edits ONLY its files. Need a change elsewhere?
Write it in your final report; the lead integrates. Shared contract: `src/sim/types.ts` + `src/sim/fixed.ts` (lead only).

| Agent | Branch | Owns |
|---|---|---|
| Lead (integrator) | `main` | `src/sim/types.ts`, `src/sim/fixed.ts`, `src/net/api.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `CLAUDE.md`, `README.md`, `docs/OWNERSHIP.md` |
| A — render / controls / juice | `agent/render` | `index.html`, `src/main.ts`, `src/style.css`, `src/render/**`, `src/input/**`, `src/ui/**`, `src/audio/**`, `public/**`, `docs/ART.md` |
| B — simulation + bot AI | `agent/sim` | `src/sim/**` except `types.ts` and `fixed.ts` (incl. `src/sim/*.test.ts`) |
| C — contract + relayer + wallets | `agent/chain` | `contracts/**`, `relayer/**`, `scripts/**`, `.env.example`, `docs/CHAIN.md`, `src/net/**` except `src/net/api.ts` |
| D — balance + tests + Playwright | `agent/qa` | `tests/**`, `tools/**`, `playwright.config.ts`, `vitest.config.ts`, `docs/BALANCE.md`, `docs/QA.md` |

New dependencies: ask the lead (list them in your report with exact versions); don't edit `package.json` yourself.

## Cross-agent API (stable names; B implements, A/D call)
- `src/sim/match.ts` → `createMatch(cfg: MatchConfig): Match` (see `types.ts`).
- `src/sim/ai.ts` → `botInput(match: Match, idx: number): Input` — deterministic; the sim uses it for every non-human fighter, the client uses it for `?autoplay`.
- `src/sim/record.ts` → `class Recorder { push(tick, idx, input) }`, `replayRecord(cfg, inputs) → { hash, winner, placements }`.
- `src/sim/roster.ts` → `t1Roster(): FighterSpec[]` (10 entries; idx 0 = the human "You").

## Test hook (A implements, D uses)
With `?e2e` in the URL the client exposes `window.__br = { phase(): "title" | "playing" | "over", tick(): number, alive(): number, placement(): number | null, fps(): number }`.
`?autoplay` makes the human fighter play with `botInput` (inputs are still recorded). `?seed=N` fixes the match seed. `?bots=1` skips the title screen.
On match end the client also exposes `window.__br.record(): MatchRecord`.

## Chain API for the UI (C implements, A calls) — T2
- `src/net/api.ts` (lead) defines `GameClient`, `FighterInfo`, `StartResult`, `SettleResult`.
- `src/net/client.ts` (C) exports `createGameClient: CreateGameClient`. It must fall back to `mode: "offline"` (local seed + `t1Roster()`) when the relayer is unreachable, so the game is ALWAYS playable.
