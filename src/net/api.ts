// SHARED CONTRACT between the chain glue (Agent C implements src/net/client.ts) and the UI (Agent A
// calls it). Owned by the lead. Amounts are already converted to display numbers ($BOUNTY, 2 dp).
import type { MatchConfig, MatchRecord, Personality } from "../sim/types";

export interface FighterInfo {
  slot: number; // 0..8 = sim fighter idx slot+1
  account: string; // NEAR account (keyless sub-account)
  name: string;
  personality: Personality;
  balance: number; // $BOUNTY in its wallet
  upgrades: { weaponTier: number; armor: number; skin: number };
  record: { matches: number; wins: number; kills: number; deaths: number; earnings: number };
  bounty: boolean; // carries the bounty next match
  bountyValue: number; // what killing it pays right now
  generation: number; // 0 = genesis, n = n-th rookie in this slot
  status: "active" | "retired";
}

export interface StartResult {
  matchId: string;
  cfg: MatchConfig; // built with matchConfigFromChain — the sim MUST use exactly this
  pot: number; // $BOUNTY in the pot (entries + house top-up)
  bountyIdx: number | null; // sim fighter idx of the bounty carrier
  bountyValue: number;
  playerPaid: number; // 0 for guests (they can't win tokens)
  tx: string | null; // explorer tx hash of start_match
}

export interface Payout {
  account: string;
  name: string;
  amount: number;
  reason: "prize" | "bounty" | "house" | "burn" | "upgrade" | "entry";
}

export interface SettleResult {
  tx: string | null;
  verified: boolean; // the server re-ran the match from the input log and the hash matched
  winner: number | null;
  payouts: Payout[];
  retired: string[]; // names of bots that went broke and retired
  rookies: string[]; // names of rookies who took their slots
  upgrades: { name: string; what: string }[];
}

export interface GameClient {
  /** "chain" when the relayer + contract are reachable; "offline" = local-only play (still fully playable). */
  readonly mode: "chain" | "offline";
  /** Guest account id (created on first call, persisted in localStorage). */
  account(): Promise<string>;
  isGuest(): boolean;
  fighters(): Promise<FighterInfo[]>;
  /** Commit to a match; seed is fixed on chain in a later block. Falls back to a local seed offline. */
  startMatch(): Promise<StartResult>;
  /** Hand the finished match to the server, which re-verifies and settles it on chain. */
  settle(matchId: string, record: MatchRecord): Promise<SettleResult>;
  explorerTx(hash: string): string;
  explorerAccount(account: string): string;
}

/** Implemented by Agent C in src/net/client.ts. */
export type CreateGameClient = (opts?: { relayer?: string; rpc?: string; contract?: string }) => Promise<GameClient>;
