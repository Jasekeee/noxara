// SHARED CONTRACT between the chain glue (Agent C implements src/net/client.ts) and the UI (Agent A
// calls it). Owned by the lead. Amounts are already converted to display numbers (NOX, 2 dp).
import type { MatchConfig, MatchRecord, Personality } from "../sim/types";

export interface FighterInfo {
  slot: number; // 0..8 = sim fighter idx slot+1
  account: string; // NEAR account (keyless sub-account)
  name: string;
  personality: Personality;
  balance: number; // NOX in its wallet
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
  pot: number; // NOX in the pot (entries + house top-up)
  entries?: number; // the entry fees inside `pot` (pot - entries = the House top-up); absent offline / mock
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
  stake: number; // NOX staked (part of the bot's bankroll; lost if the bot retires broke)
  share: number; // fraction 0..1 of the bot's sponsor pool owned by this player
  earned: number; // NOX received from the bot's winnings so far
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
  text: string; // ready to show ("Bought armor 1 for 90 NOX")
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
  /** Sign in with a NEAR wallet (real account: can earn NOX, sponsor, keeps progress). One wallet popup, then gasless again. */
  signIn(): Promise<string>;
  signOut(): Promise<void>;
  /** NOX balance of the current account (0 for guests). */
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

// ------------------------------------------------------------------ Economy v2 (docs/ECONOMY.md)
/** One point of the on-chain economy history (the contract keeps the last 64 settles). */
export interface EconomySnapshot {
  match: string;
  at: number; // unix ms
  supply: number;
  burned: number; // cumulative
  house: number;
  m: number; // reward multiplier at that settle
}

/** `get_economy`: the House rule and the money supply, live. All amounts in NOX. */
export interface EconomyInfo {
  supply: number;
  genesis: number; // 2,900
  minted: number; // == genesis (nothing is minted after genesis)
  burned: number;
  house: number;
  houseEma: number; // the moving average the rule uses
  floor: number;
  target: number;
  m: number; // reward multiplier 0..1.5
  houseShare: number; // fraction of every pot kept by the House (0.05..0.15)
  burnShare: number; // fraction of every pot burned (0.01..0.04)
  brake: number; // s: fraction of every burn that really burns (0..1)
  topUp: number; // current pot top-up from the House (25 × m)
  season: number;
  seasonEndsAt: number; // unix ms
  seasonBurned: number;
  seasonRewards: number; // paid out of the House this season (top-ups + bounty bonuses + rookie grants)
  snapshots: EconomySnapshot[];
}

/** A bot's shares (NEP-245 token_id = bot account). */
export interface ShareMarketRow {
  bot: string;
  name: string;
  status: "active" | "retired";
  sharesSold: number; // of 1,000 (IPO block is 300)
  ipoLeft: number; // IPO shares still for sale at ipoPrice
  ipoPrice: number; // NOX per share
  lastPrice: number | null; // last trade, NOX per share
  dividendsPaid: number; // lifetime NOX paid to holders
  holders: number;
  wallet: number; // the bot's NOX (a share's book value = wallet / 1,000)
  seasonPnl: number;
}

export interface Holding {
  bot: string;
  name: string;
  shares: number;
  claimable: number; // dividends waiting for claimDividends
  value: number; // shares × book value
}

export interface Listing {
  id: string;
  seller: string;
  bot: string;
  name: string;
  shares: number;
  pricePerShare: number;
  expiresAt?: number; // unix ms (48 h TTL); expired listings are hidden
}

export interface SeasonRow {
  bot: string;
  name: string;
  points: number; // 10 per win + 2 per kill
  wins: number;
  kills: number;
  income: number; // prizes + bounties
  costs: number; // entries + upkeep + upgrades + cosmetics
  pnl: number; // income − costs
}

/** Economy v2 calls. Views work for everyone; writes need a signed-in real account (guests can't hold shares). */
export interface GameClientEcon {
  economy(): Promise<EconomyInfo>;
  sharesMarket(): Promise<ShareMarketRow[]>;
  myShares(): Promise<Holding[]>;
  listings(bot?: string): Promise<Listing[]>;
  seasonStandings(season?: number): Promise<SeasonRow[]>;
  buyIpo(bot: string, shares: number): Promise<{ tx: string | null }>;
  claimDividends(bot: string): Promise<{ tx: string | null; claimed: number }>;
  listShares(bot: string, shares: number, pricePerShare: number): Promise<{ tx: string | null; id: string }>;
  cancelListing(id: string): Promise<{ tx: string | null }>;
  buyListing(id: string): Promise<{ tx: string | null }>;
  buyCosmetic(id: number): Promise<{ tx: string | null }>;
}

// ------------------------------------------------------------------ Daily check-in + quests (contract daily.rs)
export interface QuestInfo {
  id: number;
  title: string;
  progress: number;
  goal: number;
  done: boolean;
  claimed: boolean;
  reward: number; // NOX at today's House multiplier
}
export interface DailyInfo {
  streak: number;
  checkedInToday: boolean;
  canCheckIn: boolean;
  whyNot: string | null;
  nextReward: number;
  quests: QuestInfo[];
}
export interface GameClientDaily {
  daily(): Promise<DailyInfo>;
  checkIn(): Promise<{ tx: string | null; paid: number }>;
  claimQuest(id: number): Promise<{ tx: string | null; paid: number }>;
}

/** Implemented by Agent C in src/net/client.ts. */
export type CreateGameClient = (opts?: { relayer?: string; rpc?: string; contract?: string }) => Promise<GameClient>;
