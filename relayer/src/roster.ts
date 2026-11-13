// Single source of truth lives with the browser client (src/net/roster.ts); the match server re-exports it.
export { matchConfigFromChain, configDiff } from "../../src/net/roster.ts";
export type { ChainMatch, ChainRosterEntry, ChainUpgrades, YouOptions } from "../../src/net/roster.ts";
