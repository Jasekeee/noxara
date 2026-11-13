# File ownership (parallel agents)

Each agent works in its own git worktree/branch and edits ONLY its files. Need a change elsewhere?
Write it in your final report; the lead integrates. Shared contract: `src/sim/types.ts` + `src/sim/fixed.ts` (lead only).

| Agent | Branch | Owns |
|---|---|---|
| Lead (integrator) | `main` | `src/sim/types.ts`, `src/sim/fixed.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `CLAUDE.md`, `README.md`, `docs/OWNERSHIP.md` |
| A — render / controls / juice | `agent/render` | `index.html`, `src/main.ts`, `src/style.css`, `src/render/**`, `src/input/**`, `src/ui/**`, `src/audio/**`, `public/**`, `docs/ART.md` |
| B — simulation + bot AI | `agent/sim` | `src/sim/**` except `types.ts` and `fixed.ts` (incl. `src/sim/*.test.ts`) |
| C — contract + relayer + wallets | `agent/chain` | `contracts/**`, `relayer/**`, `scripts/**`, `.env.example`, `docs/CHAIN.md` |
| D — balance + tests + Playwright | `agent/qa` | `tests/**`, `tools/**`, `playwright.config.ts`, `vitest.config.ts`, `docs/BALANCE.md`, `docs/QA.md` |

New dependencies: ask the lead (list them in your report with exact versions); don't edit `package.json` yourself.
