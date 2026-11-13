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

/** A real player's sponsorship of a bot (player-owned market). */
export interface Sponsorship {
  bot: string; // bot account
  botName: string;
  stake: number; // $BOUNTY staked (part of the bot's bankroll; lost if the bot retires broke)
  share: number; // fraction 0..1 of the bot's sponsor pool owned by this player
  earned: number; // $BOUNTY received from the bot's winnings so far
}

export interface BotMarket {
  bot: string;
  totalStake: number;
  sponsors: number;
  /** share of every prize/bounty the bot wins that goes to its sponsors (pro rata) */
  sponsorCut: number;
}

export interface Progress {
  xp: number;
  level: number;
  nextLevelXp: number;
  /** what the player's fighter brings into a match at this level */
  upgrades: { weaponTier: number; armor: number; skin: number };
  unlocks: string[]; // human-readable ("Shotgun tier 2", "Armor 1")
}

export interface LeaderRow {
  account: string;
  name: string;
  bot: boolean;
  wins: number;
  kills: number;
  earnings: number;
  matches: number;
}

export interface FighterEvent {
  match: string;
  at: number; // unix ms
  kind: "win" | "kill" | "death" | "bounty" | "upgrade" | "retired" | "rookie" | "sponsored";
  text: string; // ready to show ("Bought armor 1 for 90 $BOUNTY")
  tx?: string;
}

export interface GameClient {
  /** "chain" when the relayer + contract are reachable; "offline" = local-only play (still fully playable). */
  readonly mode: "chain" | "offline";
  /** Why the client is offline (e.g. "sim_version_mismatch", "relayer_unreachable"), for a friendly UI hint. */
  readonly offlineReason?: string;
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

/** T3 additions. Agent C implements them on the same client object; UI checks `"signIn" in client`. */
export interface GameClientT3 extends GameClient {
  /** Sign in with a NEAR wallet (real account: can earn $BOUNTY, sponsor, keeps progress). One wallet popup, then gasless again. */
  signIn(): Promise<string>;
  signOut(): Promise<void>;
  /** $BOUNTY balance of the current account (0 for guests). */
  balance(): Promise<number>;
  progress(): Promise<Progress>;
  market(): Promise<BotMarket[]>;
  mySponsorships(): Promise<Sponsorship[]>;
  sponsor(bot: string, amount: number): Promise<{ tx: string | null }>;
  unsponsor(bot: string): Promise<{ tx: string | null; returned: number }>;
  leaderboard(kind: "bots" | "players"): Promise<LeaderRow[]>;
  history(account: string): Promise<FighterEvent[]>;
  /** Remaining one-time welcome entry credit (real accounts only; never transferable). */
  welcomeCredit(): Promise<number>;
  /** Claim the welcome credit later if the daily cap was full at registration; returns the credit granted. */
  claimWelcome(): Promise<number>;
}

/** Implemented by Agent C in src/net/client.ts. */
export type CreateGameClient = (opts?: { relayer?: string; rpc?: string; contract?: string }) => Promise<GameClient>;
