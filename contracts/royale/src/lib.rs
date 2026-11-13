//! BOUNTY ROYALE (royale): nine persistent bot fighters with their own NEAR accounts and $BOUNTY
//! wallets, a pot per match, a bounty on the richest bot and a bot economy that evolves on its own.
//!
//! Flow (see docs/CHAIN.md):
//! * `start_match` (the player, usually a guest via the relayer): every active bot pays its entry
//!   into the pot (escrowed on this contract's own token balance), a real player pays too if they
//!   can. The seed is fixed in a LATER block by `resolve_start` (self-call), so nobody can shop for
//!   seeds. The tx's final value is a `MatchStart` `{match_id, seed, roster, ...}`.
//! * The match is played off-chain with the deterministic TS simulation (`src/sim`).
//! * `settle_match` (ONLY the match-server account, after it re-ran the recorded match): pays the
//!   pot, the bounty, updates records, then runs the bot economy (upgrades, retirements, rookies).
//! * Lazy expiry: a match never settled can be swept by anyone after its expiry (`EXPIRY_BLOCKS`
//!   for paid matches, the shorter `EXPIRY_FREE_BLOCKS` for free ones; start_match also sweeps the
//!   oldest expired free ones). Starting a new match abandons the player's previous one.
//!   Bots' entries are always refunded; once the seed is fixed the PLAYER's entry is forfeited to
//!   the house and the match counts as a loss (no free option on a seed you didn't like).
//! * One unsettled match per player. Free matches (guests, players without $BOUNTY) share a capped
//!   pool (`max_free`, default `MAX_PENDING_FREE`) so they can't lock anyone out of paid play; paid
//!   matches have their own, much larger cap (`MAX_PENDING_PAID`) and cost the player an entry.
//!   A bot whose wallet is low only because its entries sit in escrow is never retired for it.
//! * Only a real (non-guest) player who paid the entry can win the pot or a bounty; otherwise that
//!   share goes to the house.
//!
//! $BOUNTY supply rules (NEP-141 inside this contract, see token.rs):
//! * minted ONLY (a) once in `new()` (bot starter wallets + the house reserve) and (b) as the
//!   fixed `POT_TOP_UP` added to every SETTLED match's pot — and only when the house can't pay it:
//!   while the house holds more than `HOUSE_FLOOR`, it reinvests its income as the top-up instead,
//!   so the supply stops growing once the house is healthy;
//! * burned: `BURN_BPS` of every pot;
//! * everything else (entries, prizes, bounties, upgrades, rookie grants) moves existing tokens.
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::FungibleToken;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LazyOption, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};

mod market;
pub mod progression;
mod token;

pub use market::{BotPool, HistEntry, MarketEntry, SponsorEntry, SponsorshipView};

pub const STATE_VERSION: u16 = 2;
/// Fighters per match: idx 0 = the player, idx 1..=9 = bot slots 0..=8.
pub const FIGHTERS: usize = 10;
pub const BOTS: usize = 9;

/// 1 $BOUNTY (18 decimals).
pub const ONE: u128 = 1_000_000_000_000_000_000;
// Economy constants tuned with scripts/econ-sim.ts against docs/balance.json (200 matches: ~1
// retirement per 17-25 matches, the strongest bot reaches weapon tier 2 around match 10-13).
pub const ENTRY_FEE: u128 = 4 * ONE;
/// Progressive entry (anti rich-get-richer): + ENTRY_WEALTH_BPS of the wallet above `RESERVE`,
/// up to `MAX_ENTRY` in total.
pub const ENTRY_WEALTH_BPS: u128 = 200;
pub const MAX_ENTRY: u128 = 16 * ONE;
pub const POT_TOP_UP: u128 = 30 * ONE;
/// The house keeps this much for rookie grants; above it, the house funds the pot top-up itself.
pub const HOUSE_FLOOR: u128 = 1_000 * ONE;
pub const BURN_BPS: u128 = 200; // 2% of every pot is burned
pub const HOUSE_BPS: u128 = 500; // 5% of every pot goes to the house treasury
pub const BOUNTY_BPS: u128 = 1_500; // killing the bounty carrier takes 15% of its wallet
pub const STARTER: u128 = 100 * ONE; // genesis wallet of each bot; rookie grant (from the house)
pub const HOUSE_GENESIS: u128 = 2_000 * ONE;
/// A bot only buys an upgrade if it keeps at least this much afterwards.
pub const RESERVE: u128 = 50 * ONE;
pub const WEAPON_PRICES: [u128; 2] = [60 * ONE, 120 * ONE];
pub const ARMOR_PRICES: [u128; 2] = [90 * ONE, 180 * ONE];
pub const SKIN_PRICE: u128 = 150 * ONE;
pub const SKINS: u8 = 12;

/// ~12-20 minutes (testnet blocks are ~0.6-1 s); a match lasts 3 minutes.
pub const EXPIRY_BLOCKS: u64 = 1_200;
/// Free matches recycle faster (a match is 3 minutes of play).
pub const EXPIRY_FREE_BLOCKS: u64 = 500;
/// Default cap on unsettled FREE matches (guests / players who paid nothing); owner-adjustable.
pub const MAX_PENDING_FREE: u32 = 24;
/// Cap on unsettled PAID matches (each one costs its player an entry that is forfeited if abandoned).
pub const MAX_PENDING_PAID: u32 = 1_000;
/// Most the owner can hand out from the house treasury per `house_grant` call.
pub const MAX_GRANT: u128 = 100 * ONE;
/// Owner decision: a real NEAR account's first stake is a one-time WELCOME CREDIT. It is not $BOUNTY:
/// it can only pay match entries (the house funds each entry when it is used), can't be transferred,
/// sponsored with or withdrawn. Winnings from those matches are normal $BOUNTY.
pub const WELCOME_STAKE: u128 = 30 * ONE;
/// Part of the player's storage deposit kept for the permanent "welcomed" record (it outlives unregister).
pub const WELCOME_RECORD_NEAR: NearToken = NearToken::from_millinear(1);
/// Abuse brake: at most this many welcome credits per UTC day.
pub const WELCOME_DAILY_CAP: u32 = 50;
const WELCOME_DAY_KEY: &[u8] = b"welcome_day";
/// The owner may delete the whole contract account (deposits back) only after this: 2026-11-25 00:00 UTC.
pub const TEARDOWN_AFTER_MS: u64 = 1_795_564_800_000;
const TEARDOWN_KEY: &[u8] = b"teardown_after";
pub const RECENT_MATCHES: usize = 50;
pub const RETIRED_SHOWN: usize = 30;
pub const LEADERBOARD_SIZE: usize = 50;
pub const MAX_HASH_LEN: usize = 128;
/// NEP-145 deposit per player (guests: prepaid by the relayer). Covers the FT account, the player
/// record and one pending match (measured in the unit tests).
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
/// NEAR given to every bot / house sub-account the contract creates (they have NO access keys).
pub const NPC_NEAR: NearToken = NearToken::from_millinear(1);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);

pub const PERSONALITIES: [&str; 6] = ["aggressive", "camper", "sniper", "looter", "coward", "balanced"];
/// The genesis nine for a fresh deploy (= src/sim/roster.ts t1Roster(); skins slot + 1). The live
/// testnet contract was created with an earlier nine (Bramble, Ox, ...) and kept them on migration.
pub const GENESIS: [(&str, &str, &str); BOTS] = [
    ("brindle", "Brindle", "aggressive"),
    ("quillon", "Quillon", "camper"),
    ("vesper", "Vesper", "sniper"),
    ("magpie", "Magpie", "looter"),
    ("tallow", "Tallow", "coward"),
    ("dorrit", "Dorrit", "balanced"),
    ("zinnia", "Zinnia", "aggressive"),
    ("okapi", "Okapi", "camper"),
    ("fenwick", "Fenwick", "balanced"),
];
pub const ROOKIE_NAMES: [&str; 24] = [
    "ash", "bolt", "clove", "dash", "ember", "fizz", "gale", "hex", "ivy", "jinx", "kit", "lark", "nyx", "onyx", "pep",
    "quinn", "rune", "scout", "tansy", "umber", "wren", "yarrow", "zest", "flint",
];

#[near]
#[derive(BorshStorageKey)]
enum Key {
    Token,
    Fighters,
    Players,
    Matches,
    Leaderboard,
    Retired,
    // state V2
    Sponsors,
    Sponsoring,
    History,
    Xp,
    // no state fields: opened on demand, so adding them needed no state migration
    Welcomed,
    WelcomeCredit,
    CreditMatches,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Upgrades {
    /// 0..=2
    pub weapon_tier: u8,
    /// 0..=2
    pub armor: u8,
    /// cosmetic palette index
    pub skin: u8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Record {
    pub matches: u32,
    pub wins: u32,
    pub kills: u32,
    pub deaths: u32,
    /// prizes + bounties collected (gross, before upgrades)
    pub earnings: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct FighterV1 {
    pub account: AccountId,
    pub name: String,
    pub personality: String,
    pub slot: u8,
    pub upgrades: Upgrades,
    pub record: Record,
    pub active: bool,
    /// 0 for the genesis nine; a rookie is its slot predecessor's generation + 1.
    pub generation: u32,
    pub born_block: u64,
    pub retired_block: Option<u64>,
    /// entries this bot has in unsettled matches (refunded or spent at settlement)
    pub escrowed: U128,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub enum VFighter {
    V1(FighterV1),
}

/// Player layout V1 (decoded only; loads as PlayerV2).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct PlayerV1 {
    pub guest: bool,
    pub matches: u32,
    pub wins: u32,
    pub kills: u32,
    pub deaths: u32,
    pub earnings: U128,
    /// best placement ever (1 = won), 0 = never finished a match
    pub best_place: u8,
    pub pending: Option<U64>,
    /// NEAR locked for this player's storage (NEP-145)
    pub storage_paid: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct PlayerV2 {
    pub guest: bool,
    pub matches: u32,
    pub wins: u32,
    pub kills: u32,
    pub deaths: u32,
    pub earnings: U128,
    /// best placement ever (1 = won), 0 = never finished a match
    pub best_place: u8,
    pub pending: Option<U64>,
    /// NEAR locked for this player's storage (NEP-145)
    pub storage_paid: U128,
    /// who paid `storage_paid` when it wasn't the player (the relayer for guests / signed-in accounts):
    /// `storage_unregister` refunds THEM, so a subsidised deposit can't be farmed
    pub deposit_payer: Option<AccountId>,
}

impl From<PlayerV1> for PlayerV2 {
    fn from(p: PlayerV1) -> Self {
        // the payer is unknown here: `load_player` sets it (fail closed to the relayer)
        PlayerV2 {
            guest: p.guest,
            matches: p.matches,
            wins: p.wins,
            kills: p.kills,
            deaths: p.deaths,
            earnings: p.earnings,
            best_place: p.best_place,
            pending: p.pending,
            storage_paid: p.storage_paid,
            deposit_payer: None,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub enum VPlayer {
    V1(PlayerV1),
    V2(PlayerV2),
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RosterEntry {
    /// fighter idx in the simulation (1..=9)
    pub idx: u8,
    pub account: AccountId,
    pub name: String,
    pub personality: String,
    pub upgrades: Upgrades,
    pub bounty: bool,
    /// entry paid into the pot
    pub paid: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum MatchStatus {
    Pending,
    Settled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct MatchResult {
    /// by fighter idx: 1 = winner .. 10 = first out
    pub placements: Vec<u8>,
    pub kills: Vec<u8>,
    pub winner: Option<u8>,
    /// who received the prize (the house for a guest win or no winner)
    pub prize_to: AccountId,
    pub prize: U128,
    /// part of the top-up that was newly minted (0 when the house paid it)
    pub minted: U128,
    pub burned: U128,
    pub house_cut: U128,
    pub bounty_killer: Option<u8>,
    pub bounty_to: Option<AccountId>,
    pub bounty_amount: U128,
    /// sha256 of the recorded input log (re-verify offline with the match server's record)
    pub input_log_hash: String,
    /// the simulation's final state hash
    pub result_hash: Option<String>,
    pub settled_block: U64,
}

/// State-V1 match layout (only decoded; converted to `MatchV2` on load).
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct MatchV1 {
    pub id: U64,
    pub player: AccountId,
    pub guest: bool,
    pub player_paid: U128,
    pub seed: u32,
    pub status: MatchStatus,
    pub start_block: U64,
    pub start_ms: U64,
    pub roster: Vec<RosterEntry>,
    pub bounty_idx: Option<u8>,
    pub pot: U128,
    pub result: Option<MatchResult>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct MatchV2 {
    pub id: U64,
    pub player: AccountId,
    pub guest: bool,
    pub player_paid: U128,
    /// 0 until `resolve_start` fixes it in a later block
    pub seed: u32,
    pub status: MatchStatus,
    pub start_block: U64,
    pub start_ms: U64,
    pub roster: Vec<RosterEntry>,
    /// fighter idx carrying the bounty (the richest active bot at start)
    pub bounty_idx: Option<u8>,
    /// entries escrowed (the minted top-up is added at settlement)
    pub pot: U128,
    pub result: Option<MatchResult>,
    /// the player's fighter upgrades from their level (progression); fighter idx 0 uses exactly these
    pub player_upgrades: Upgrades,
    pub player_level: u8,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub enum VMatch {
    V1(MatchV1),
    V2(MatchV2),
}

impl From<VMatch> for MatchV2 {
    fn from(v: VMatch) -> Self {
        match v {
            VMatch::V2(m) => m,
            VMatch::V1(m) => MatchV2 {
                id: m.id,
                player: m.player,
                guest: m.guest,
                player_paid: m.player_paid,
                seed: m.seed,
                status: m.status,
                start_block: m.start_block,
                start_ms: m.start_ms,
                roster: m.roster,
                bounty_idx: m.bounty_idx,
                pot: m.pot,
                result: m.result,
                player_upgrades: Upgrades::default(),
                player_level: 1,
            },
        }
    }
}

#[near(serializers = [json])]
pub struct MatchStart {
    pub match_id: U64,
    pub seed: u32,
    pub player: AccountId,
    pub guest: bool,
    pub player_paid: U128,
    pub bounty_idx: Option<u8>,
    pub pot: U128,
    pub roster: Vec<RosterEntry>,
    /// fighter idx 0's upgrades (from the player's level)
    pub player_upgrades: Upgrades,
    pub player_level: u8,
}

#[near(serializers = [json])]
pub struct FighterView {
    #[serde(flatten)]
    pub fighter: FighterV1,
    pub status: String,
    pub balance: U128,
    pub bounty: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct LeaderEntry {
    pub account: AccountId,
    pub guest: bool,
    pub wins: u32,
    pub kills: u32,
    pub matches: u32,
    pub earnings: U128,
}

#[near(serializers = [json])]
pub struct Leaderboard {
    /// active + recently retired bots, highest career earnings first
    pub fighters: Vec<FighterView>,
    /// players (guests included: leaderboards are free, tokens aren't), most wins first
    pub players: Vec<LeaderEntry>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub version: u16,
    pub owner: AccountId,
    pub server: AccountId,
    pub guest_parent: AccountId,
    pub house: AccountId,
    pub house_balance: U128,
    pub escrow: U128,
    pub total_supply: U128,
    pub total_minted: U128,
    pub total_burned: U128,
    pub matches_started: u64,
    pub matches_settled: u64,
    pub rookies: u32,
    pub entry_fee: U128,
    pub entry_wealth_bps: u16,
    pub max_entry: U128,
    pub pot_top_up: U128,
    pub house_floor: U128,
    pub burn_bps: u16,
    pub house_bps: u16,
    pub bounty_bps: u16,
    pub starter: U128,
    pub reserve: U128,
    pub weapon_prices: Vec<U128>,
    pub armor_prices: Vec<U128>,
    pub skin_price: U128,
    pub expiry_blocks: u64,
    pub expiry_free_blocks: u64,
    pub pending_free: u32,
    pub max_free: u32,
    pub pending_paid: u32,
    pub max_paid: u32,
    pub storage_deposit: NearToken,
    pub block_height: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    version: u16,
    owner: AccountId,
    /// the match-server account: the only one allowed to settle
    server: AccountId,
    /// guests are `g-*.<guest_parent>` (created by the relayer)
    guest_parent: AccountId,
    house: AccountId,
    token: FungibleToken,
    fighters: LookupMap<AccountId, VFighter>,
    /// the current fighter in each of the 9 slots
    slots: Vec<AccountId>,
    retired: LazyOption<Vec<AccountId>>,
    players: LookupMap<AccountId, VPlayer>,
    matches: LookupMap<u64, VMatch>,
    /// settled match ids, oldest first (bounded: older settled matches are pruned)
    recent: Vec<u64>,
    /// unsettled FREE match ids, oldest first (at most `max_free`)
    pending_free: Vec<u64>,
    max_free: u32,
    /// number of unsettled PAID matches
    pending_paid: u32,
    leaderboard: LazyOption<Vec<LeaderEntry>>,
    next_match_id: u64,
    matches_settled: u64,
    rookies: u32,
    total_minted: u128,
    total_burned: u128,
    // ---- state V2
    /// sponsorship pool per bot (bounded: MAX_SPONSORS_PER_BOT entries)
    sponsors: LookupMap<AccountId, BotPool>,
    /// bots each player sponsors (bounded: MAX_SPONSORSHIPS_PER_PLAYER)
    sponsoring: LookupMap<AccountId, Vec<AccountId>>,
    /// recent events per fighter (ring of HISTORY_LEN)
    history: LookupMap<AccountId, Vec<HistEntry>>,
    /// progression XP per player (guests too)
    xp: LookupMap<AccountId, u64>,
}

/// State-V1 layout, read once by `migrate`.
#[near(serializers = [borsh])]
pub struct ContractV1 {
    version: u16,
    owner: AccountId,
    server: AccountId,
    guest_parent: AccountId,
    house: AccountId,
    token: FungibleToken,
    fighters: LookupMap<AccountId, VFighter>,
    slots: Vec<AccountId>,
    retired: LazyOption<Vec<AccountId>>,
    players: LookupMap<AccountId, VPlayer>,
    matches: LookupMap<u64, VMatch>,
    recent: Vec<u64>,
    pending_free: Vec<u64>,
    max_free: u32,
    pending_paid: u32,
    leaderboard: LazyOption<Vec<LeaderEntry>>,
    next_match_id: u64,
    matches_settled: u64,
    rookies: u32,
    total_minted: u128,
    total_burned: u128,
}

#[near]
impl Contract {
    /// Creates the house and the genesis nine as sub-accounts WITHOUT access keys (only this
    /// contract's rules move their $BOUNTY) and mints their starter wallets.
    #[init]
    /// `owner` must be an account the owner controls OTHER than this contract's account if its
    /// full-access keys are going to be removed (it is the only one who can `teardown`).
    /// `teardown_after_ms` defaults to TEARDOWN_AFTER_MS (tests pass an earlier time).
    pub fn new(owner: AccountId, server: AccountId, guest_parent: AccountId, teardown_after_ms: Option<U64>) -> Self {
        env::storage_write(TEARDOWN_KEY, &teardown_after_ms.map(|t| t.0).unwrap_or(TEARDOWN_AFTER_MS).to_le_bytes());
        let me = env::current_account_id();
        let house: AccountId = format!("house.{me}").parse().unwrap();
        let mut c = Self {
            version: STATE_VERSION,
            owner,
            server,
            guest_parent,
            house: house.clone(),
            token: FungibleToken::new(Key::Token),
            fighters: LookupMap::new(Key::Fighters),
            slots: vec![],
            retired: LazyOption::new(Key::Retired, Some(vec![])),
            players: LookupMap::new(Key::Players),
            matches: LookupMap::new(Key::Matches),
            recent: vec![],
            pending_free: vec![],
            max_free: MAX_PENDING_FREE,
            pending_paid: 0,
            leaderboard: LazyOption::new(Key::Leaderboard, Some(vec![])),
            next_match_id: 1,
            matches_settled: 0,
            rookies: 0,
            total_minted: 0,
            total_burned: 0,
            sponsors: LookupMap::new(Key::Sponsors),
            sponsoring: LookupMap::new(Key::Sponsoring),
            history: LookupMap::new(Key::History),
            xp: LookupMap::new(Key::Xp),
        };
        c.token.internal_register_account(&me); // the escrow for pots
        c.token.internal_register_account(&house);
        c.mint(&house, HOUSE_GENESIS, "house reserve (genesis)");
        create_npc_account(&house);
        for (slot, (id, name, personality)) in GENESIS.iter().enumerate() {
            let account: AccountId = format!("{id}.{me}").parse().unwrap();
            c.token.internal_register_account(&account);
            c.mint(&account, STARTER, "starter wallet (genesis)");
            c.save_fighter(FighterV1 {
                account: account.clone(),
                name: name.to_string(),
                personality: personality.to_string(),
                slot: slot as u8,
                upgrades: Upgrades { weapon_tier: 0, armor: 0, skin: slot as u8 + 1 },
                record: Record::default(),
                active: true,
                generation: 0,
                born_block: env::block_height(),
                retired_block: None,
                escrowed: U128(0),
            });
            c.slots.push(account.clone());
            create_npc_account(&account);
            event("fighter_born", &near_sdk::serde_json::json!({ "account": account, "name": name, "personality": personality, "slot": slot, "generation": 0 }));
        }
        c
    }

    // ------------------------------------------------------------------ match lifecycle

    /// Start a match. Bots pay their entries now; the seed is fixed by `resolve_start` in a later
    /// block. The final value of this tx is a `MatchStart`.
    pub fn start_match(&mut self) -> Promise {
        let id = env::predecessor_account_id();
        let mut p = self
            .load_player(&id)
            .unwrap_or_else(|| env::panic_str("register first: storage_deposit (guests: the relayer prepays it)"));
        self.sweep_expired(3);
        // one live match per player: starting again abandons the previous one (bots refunded; the
        // player's entry is forfeited once the seed was fixed)
        if let Some(old) = p.pending {
            self.close_unsettled(old.0, "abandoned");
            p = self.load_player(&id).unwrap();
        }
        let guest = self.is_guest(&id);
        let player_level = progression::level_for_xp(self.xp.get(&id).copied().unwrap_or(0) as i64);
        // free and paid matches have separate pools: free players can never crowd out paying ones
        // the welcome credit pays first (the house funds it while above its floor), else the wallet
        let house = self.house.clone();
        let use_credit = !guest && self.welcome_credit(&id) >= ENTRY_FEE && self.balance(&house) >= HOUSE_FLOOR + ENTRY_FEE;
        let will_pay = use_credit || (!guest && self.balance(&id) >= ENTRY_FEE);
        if will_pay {
            require!(self.pending_paid < MAX_PENDING_PAID, "too many paid matches in flight: try again in a minute");
        } else {
            require!((self.pending_free.len() as u32) < self.max_free, "the free island is full: try again in a minute");
        }
        let me = env::current_account_id();
        let entropy = env::random_seed_array();
        let mut pot = 0u128;
        // a real player pays the entry if they can (guests never pay and never win)
        let mut player_paid = 0u128;
        if use_credit {
            self.token.internal_transfer(&house, &me, ENTRY_FEE, Some("match entry (welcome credit)".into()));
            self.set_welcome_credit(&id, self.welcome_credit(&id) - ENTRY_FEE);
            near_sdk::store::LookupSet::<u64>::new(Key::CreditMatches).insert(self.next_match_id);
            player_paid = ENTRY_FEE;
            pot += ENTRY_FEE;
        } else if will_pay {
            self.token.internal_transfer(&id, &me, ENTRY_FEE, Some("match entry".into()));
            player_paid = ENTRY_FEE;
            pot += ENTRY_FEE;
        }
        let mut roster = Vec::with_capacity(BOTS);
        for slot in 0..BOTS {
            let mut f = self.slot_fighter(slot);
            // broke = can't pay the entry now (entries escrowed elsewhere don't count: a bot never plays
            // on money it doesn't have). Only a brand-new rookie the house couldn't fully fund is exempt.
            if self.balance(&f.account) < ENTRY_FEE && f.record.matches > 0 {
                self.retire(slot, "broke", self.next_match_id);
                let e = env::sha256_array(&[&entropy[..], &(slot as u64).to_le_bytes()].concat());
                f = self.spawn_rookie(slot, &e, self.next_match_id);
            }
            // progressive entry: rich bots pay more (a fresh rookie short of cash pays what it has)
            let bal = self.balance(&f.account);
            let paid = entry_fee_for(bal).min(bal);
            if paid > 0 {
                self.token.internal_transfer(&f.account, &me, paid, Some("match entry".into()));
                pot += paid;
                f.escrowed = U128(f.escrowed.0 + paid);
                self.save_fighter(f.clone());
            }
            roster.push(RosterEntry {
                idx: slot as u8 + 1,
                account: f.account.clone(),
                name: f.name.clone(),
                personality: f.personality.clone(),
                upgrades: f.upgrades.clone(),
                bounty: false,
                paid: U128(paid),
            });
        }
        let bounty_idx = self.richest_slot().map(|s| s as u8 + 1);
        if let Some(b) = bounty_idx {
            roster[b as usize - 1].bounty = true;
        }
        let match_id = self.next_match_id;
        self.next_match_id += 1;
        self.save_match(MatchV2 {
            id: U64(match_id),
            player: id.clone(),
            guest,
            player_paid: U128(player_paid),
            seed: 0,
            status: MatchStatus::Pending,
            start_block: U64(env::block_height()),
            start_ms: U64(env::block_timestamp_ms()),
            roster,
            bounty_idx,
            pot: U128(pot),
            result: None,
            player_upgrades: progression::upgrades_for_level(player_level as i64),
            player_level,
        });
        if will_pay {
            self.pending_paid += 1;
        } else {
            self.pending_free.push(match_id);
        }
        p.pending = Some(U64(match_id));
        self.save_player(&id, p);
        event("match_start", &near_sdk::serde_json::json!({ "match_id": U64(match_id), "player": id, "guest": guest, "pot": U128(pot), "bounty_idx": bounty_idx }));
        Promise::new(me).function_call(
            "resolve_start".to_string(),
            near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({ "match_id": U64(match_id) })).unwrap(),
            NearToken::from_yoctonear(0),
            GAS_RESOLVE,
        )
    }

    /// Next-block randomness: the seed did not exist when `start_match` was signed.
    #[private]
    pub fn resolve_start(&mut self, match_id: U64) -> MatchStart {
        let mut m = self.load_match(match_id.0).expect("no such match");
        require!(m.status == MatchStatus::Pending && m.seed == 0, "stale");
        let h = env::sha256_array(&[&env::random_seed_array()[..], &match_id.0.to_le_bytes(), m.player.as_bytes()].concat());
        let seed = u32::from_le_bytes(h[0..4].try_into().unwrap()).max(1);
        m.seed = seed;
        event("match_seed", &near_sdk::serde_json::json!({ "match_id": match_id, "seed": seed }));
        let out = MatchStart {
            match_id,
            seed,
            player: m.player.clone(),
            guest: m.guest,
            player_paid: m.player_paid,
            bounty_idx: m.bounty_idx,
            pot: m.pot,
            roster: m.roster.clone(),
            player_upgrades: m.player_upgrades.clone(),
            player_level: m.player_level,
        };
        self.save_match(m);
        out
    }

    /// The match server reports the result it re-computed from the recorded inputs. Only the
    /// configured server account may call this.
    pub fn settle_match(
        &mut self,
        match_id: U64,
        placements: Vec<u8>,
        kills: Vec<u8>,
        bounty_killer: Option<u8>,
        input_log_hash: String,
        result_hash: Option<String>,
    ) -> MatchResult {
        require!(env::predecessor_account_id() == self.server, "only the match server settles matches");
        let mut m = self.load_match(match_id.0).expect("no such match");
        require!(m.status == MatchStatus::Pending, "match already settled");
        require!(m.seed != 0, "match seed not fixed yet");
        require!(placements.len() == FIGHTERS && kills.len() == FIGHTERS, "placements and kills need one entry per fighter");
        require!(!input_log_hash.is_empty() && input_log_hash.len() <= MAX_HASH_LEN, "bad input log hash");
        require!(result_hash.as_ref().is_none_or(|h| h.len() <= MAX_HASH_LEN), "bad result hash");
        let mut seen = [false; FIGHTERS + 1];
        for &pl in &placements {
            require!(pl as usize <= FIGHTERS, "placement out of range");
            if pl > 0 {
                require!(!seen[pl as usize], "duplicate placement");
                seen[pl as usize] = true;
            }
        }
        require!(kills.iter().map(|&k| k as u32).sum::<u32>() < FIGHTERS as u32, "too many kills");
        let winner = placements.iter().position(|&p| p == 1).map(|i| i as u8);
        let me = env::current_account_id();
        self.release_escrow(&m);
        let roster_accounts: Vec<AccountId> = m.roster.iter().map(|r| r.account.clone()).collect();

        // ---- the pot: escrowed entries + the minted top-up
        let house = self.house.clone();
        let minted = if self.balance(&house) >= HOUSE_FLOOR + POT_TOP_UP {
            self.move_tokens(&house, &me, POT_TOP_UP, "pot top-up (the house reinvests)");
            0
        } else {
            self.mint(&me, POT_TOP_UP, "pot top-up");
            POT_TOP_UP
        };
        let pot = m.pot.0 + POT_TOP_UP;
        let burned = pot * BURN_BPS / 10_000;
        let house_cut = pot * HOUSE_BPS / 10_000;
        let prize = pot - burned - house_cut;
        let prize_to = winner.map(|w| self.payee(&m, w)).unwrap_or_else(|| self.house.clone());
        self.move_tokens(&me, &prize_to, prize, "match prize");
        self.move_tokens(&me, &house, house_cut, "house cut");
        self.burn(&me, burned, "pot burn");
        // a bot's sponsors take their part of the prize in cash
        if winner.is_some_and(|w| w > 0) {
            self.pay_dividends(&prize_to, prize, match_id.0);
        }
        event("match_prize", &near_sdk::serde_json::json!({ "match_id": match_id, "winner": winner, "to": prize_to, "prize": U128(prize), "burned": U128(burned), "house_cut": U128(house_cut) }));

        // ---- the bounty: the carrier's killer takes a share of the carrier's wallet
        let mut bounty_to = None;
        let mut bounty_amount = 0u128;
        if let (Some(k), Some(b)) = (bounty_killer, m.bounty_idx) {
            require!((k as usize) < FIGHTERS, "bad bounty killer");
            if k != b && placements[b as usize] != 1 {
                let carrier = m.roster[b as usize - 1].account.clone();
                let to = self.payee(&m, k);
                bounty_amount = self.balance(&carrier) * BOUNTY_BPS / 10_000;
                self.move_tokens(&carrier, &to, bounty_amount, "bounty");
                event("bounty_paid", &near_sdk::serde_json::json!({ "match_id": match_id, "carrier": carrier, "killer_idx": k, "to": to, "amount": U128(bounty_amount) }));
                self.push_history(&carrier, match_id.0, "bounty", bounty_amount, "lost");
                if k > 0 {
                    self.push_history(&to, match_id.0, "bounty", bounty_amount, "collected");
                    self.pay_dividends(&to, bounty_amount, match_id.0);
                }
                bounty_to = Some(to);
            }
        }

        // ---- records
        for i in 0..FIGHTERS {
            let won = winner == Some(i as u8);
            let paid_out = i > 0 || player_eligible(&m); // guests and non-payers earn zero
            let mut earned = if won && paid_out { prize } else { 0 };
            if bounty_killer == Some(i as u8) && bounty_to.is_some() && paid_out {
                earned += bounty_amount;
            }
            if i == 0 {
                let mut p = self.load_player(&m.player).expect("player record");
                p.matches += 1;
                p.wins += won as u32;
                p.deaths += (!won) as u32;
                p.kills += kills[0] as u32;
                p.earnings = U128(p.earnings.0 + earned);
                if placements[0] > 0 && (p.best_place == 0 || placements[0] < p.best_place) {
                    p.best_place = placements[0];
                }
                if p.pending == Some(match_id) {
                    p.pending = None;
                }
                let lb = LeaderEntry { account: m.player.clone(), guest: p.guest, wins: p.wins, kills: p.kills, matches: p.matches, earnings: p.earnings };
                let who = m.player.clone();
                self.save_player(&who, p);
                self.update_leaderboard(lb);
                // progression (guests too): mirrors src/sim/progression.ts
                let gained = progression::xp_for_match(placements[0] as i64, kills[0] as i64, bounty_killer == Some(0) && bounty_to.is_some());
                let before = self.xp.get(&who).copied().unwrap_or(0);
                self.xp.insert(who.clone(), before + gained);
                let (l0, l1) = (progression::level_for_xp(before as i64), progression::level_for_xp((before + gained) as i64));
                event("xp", &near_sdk::serde_json::json!({ "player": who, "gained": gained, "xp": before + gained, "level": l1, "level_up": l1 > l0 }));
            } else {
                let acct = m.roster[i - 1].account.clone();
                let mut f = self.load_fighter(&acct).expect("fighter");
                f.record.matches += 1;
                f.record.wins += won as u32;
                f.record.deaths += (!won) as u32;
                f.record.kills += kills[i] as u32;
                f.record.earnings = U128(f.record.earnings.0 + earned);
                self.save_fighter(f);
                let kind = if won { "win" } else { "death" };
                self.push_history(&acct, match_id.0, kind, earned, &format!("{}:{}", placements[i], kills[i]));
            }
        }

        // ---- the bot economy: deterministic, no dev patch
        let entropy = env::sha256_array(&[&m.seed.to_le_bytes()[..], &match_id.0.to_le_bytes()].concat());
        self.run_economy(&entropy, match_id.0);

        let result = MatchResult {
            placements,
            kills,
            winner,
            prize_to,
            prize: U128(prize),
            minted: U128(minted),
            burned: U128(burned),
            house_cut: U128(house_cut),
            bounty_killer,
            bounty_to,
            bounty_amount: U128(bounty_amount),
            input_log_hash,
            result_hash,
            settled_block: U64(env::block_height()),
        };
        event("match_settled", &near_sdk::serde_json::json!({ "match_id": match_id, "winner": winner, "input_log_hash": result.input_log_hash, "result_hash": result.result_hash }));
        m.status = MatchStatus::Settled;
        m.result = Some(result.clone());
        self.unlist_pending(&m);
        self.save_match(m);
        self.matches_settled += 1;
        near_sdk::store::LookupSet::<u64>::new(Key::CreditMatches).remove(&match_id.0);
        self.finish_retired_pools(&roster_accounts, match_id.0);
        self.recent.push(match_id.0);
        if self.recent.len() > RECENT_MATCHES {
            let old = self.recent.remove(0);
            self.matches.remove(&old);
        }
        result
    }

    /// Anyone may sweep a match that was never settled within `EXPIRY_BLOCKS`: the bots' entries
    /// are refunded, the player's is forfeited to the house if the seed was fixed, nothing is minted.
    pub fn sweep_match(&mut self, match_id: U64) -> bool {
        let Some(m) = self.load_match(match_id.0) else { return false };
        if m.status != MatchStatus::Pending || env::block_height() <= m.start_block.0 + expiry_of(&m) {
            return false;
        }
        self.close_unsettled(match_id.0, "expired");
        true
    }

    /// The owner can hand $BOUNTY from the house treasury to a registered real player (the
    /// on-ramp for real accounts: no minting, capped per call, never to guests).
    pub fn house_grant(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(amount.0 > 0 && amount.0 <= MAX_GRANT, "grant out of range");
        require!(!self.is_guest(&account_id), "guests can't hold $NOX");
        require!(self.load_player(&account_id).is_some(), "not a registered player");
        let house = self.house.clone();
        self.move_tokens(&house, &account_id, amount.0, "house grant");
        event("house_grant", &near_sdk::serde_json::json!({ "account": account_id, "amount": amount }));
    }

    // ------------------------------------------------------------------ admin

    /// Owner: size of the free-match pool (paid matches are never affected).
    pub fn set_max_free(&mut self, max_free: u32) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(max_free <= MAX_PENDING_FREE * 4, "too large");
        self.max_free = max_free;
    }

    /// Owner: hand ownership to another account (e.g. before removing this account's full-access keys).
    pub fn set_owner(&mut self, owner: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        event("owner_changed", &near_sdk::serde_json::json!({ "from": self.owner, "to": owner }));
        self.owner = owner;
    }

    /// Owner, after the time lock: delete this contract's own account and send its whole NEAR balance
    /// (storage deposits included) to `beneficiary`. Works without any full-access key on the account.
    /// Bot / house / rookie sub-accounts are keyless and can't be deleted: their ~0.001 NEAR each stays.
    pub fn teardown(&mut self, beneficiary: AccountId) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        let after = env::storage_read(TEARDOWN_KEY).map(|v| u64::from_le_bytes(v[0..8].try_into().unwrap())).unwrap_or(TEARDOWN_AFTER_MS);
        require!(env::block_timestamp_ms() >= after, "teardown is locked until 2026-11-25 00:00 UTC");
        require!(beneficiary != env::current_account_id(), "pick another beneficiary");
        event("teardown", &near_sdk::serde_json::json!({ "beneficiary": beneficiary, "at_ms": U64(env::block_timestamp_ms()) }));
        Promise::new(env::current_account_id()).delete_account(beneficiary)
    }

    pub fn get_teardown_after(&self) -> U64 {
        U64(env::storage_read(TEARDOWN_KEY).map(|v| u64::from_le_bytes(v[0..8].try_into().unwrap())).unwrap_or(TEARDOWN_AFTER_MS))
    }

    pub fn set_server(&mut self, server: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.server = server;
    }

    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        // V2 state is a superset of V1: try V2 first (code-only upgrade), else convert V1
        // `version` is the first field of every layout: peek at it before choosing one
        let raw = env::storage_read(b"STATE").expect("no state");
        let v = u16::from_le_bytes([raw[0], raw[1]]);
        if v == STATE_VERSION {
            return env::state_read::<Contract>().expect("state");
        }
        let o: ContractV1 = env::state_read().expect("no state");
        require!(o.version <= STATE_VERSION, "downgrade");
        let mut c = Contract {
            version: STATE_VERSION,
            owner: o.owner,
            server: o.server,
            guest_parent: o.guest_parent,
            house: o.house,
            token: o.token,
            fighters: o.fighters,
            slots: o.slots,
            retired: o.retired,
            players: o.players,
            matches: o.matches,
            recent: o.recent,
            pending_free: o.pending_free,
            max_free: o.max_free,
            pending_paid: o.pending_paid,
            leaderboard: o.leaderboard,
            next_match_id: o.next_match_id,
            matches_settled: o.matches_settled,
            rookies: o.rookies,
            total_minted: o.total_minted,
            total_burned: o.total_burned,
            sponsors: LookupMap::new(Key::Sponsors),
            sponsoring: LookupMap::new(Key::Sponsoring),
            history: LookupMap::new(Key::History),
            xp: LookupMap::new(Key::Xp),
        };
        c.dedupe_names();
        c
    }

    // ------------------------------------------------------------------ views

    /// The 9 active fighters in slot order (fighter idx = slot + 1).
    pub fn get_fighters(&self) -> Vec<FighterView> {
        let richest = self.richest_slot();
        (0..BOTS).map(|s| self.view_fighter(self.slot_fighter(s), richest == Some(s))).collect()
    }

    pub fn get_fighter(&self, account_id: AccountId) -> Option<FighterView> {
        let richest = self.richest_slot().map(|s| self.slots[s].clone());
        self.load_fighter(&account_id).map(|f| {
            let b = f.active && richest.as_ref() == Some(&f.account);
            self.view_fighter(f, b)
        })
    }

    /// Recently retired fighters, newest first.
    pub fn get_retired(&self) -> Vec<FighterView> {
        let ids = self.retired.get().clone().unwrap_or_default();
        ids.iter().rev().filter_map(|a| self.load_fighter(a)).map(|f| self.view_fighter(f, false)).collect()
    }

    pub fn get_match(&self, match_id: U64) -> Option<MatchV2> {
        self.load_match(match_id.0)
    }

    /// The newest settled matches first (at most `RECENT_MATCHES` are kept).
    pub fn get_recent_matches(&self, n: Option<u32>) -> Vec<MatchV2> {
        let n = n.unwrap_or(10).min(RECENT_MATCHES as u32) as usize;
        self.recent.iter().rev().take(n).filter_map(|id| self.load_match(*id)).collect()
    }

    pub fn get_player(&self, account_id: AccountId) -> Option<PlayerV2> {
        self.load_player(&account_id)
    }

    pub fn get_leaderboard(&self) -> Leaderboard {
        let mut fighters: Vec<FighterView> = self.get_fighters();
        fighters.extend(self.get_retired());
        fighters.sort_by(|a, b| b.fighter.record.earnings.0.cmp(&a.fighter.record.earnings.0));
        Leaderboard { fighters, players: self.leaderboard.get().clone().unwrap_or_default() }
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            version: self.version,
            owner: self.owner.clone(),
            server: self.server.clone(),
            guest_parent: self.guest_parent.clone(),
            house: self.house.clone(),
            house_balance: U128(self.balance(&self.house)),
            escrow: U128(self.balance(&env::current_account_id())),
            total_supply: U128(self.token.total_supply),
            total_minted: U128(self.total_minted),
            total_burned: U128(self.total_burned),
            matches_started: self.next_match_id - 1,
            matches_settled: self.matches_settled,
            rookies: self.rookies,
            entry_fee: U128(ENTRY_FEE),
            entry_wealth_bps: ENTRY_WEALTH_BPS as u16,
            max_entry: U128(MAX_ENTRY),
            pot_top_up: U128(POT_TOP_UP),
            house_floor: U128(HOUSE_FLOOR),
            burn_bps: BURN_BPS as u16,
            house_bps: HOUSE_BPS as u16,
            bounty_bps: BOUNTY_BPS as u16,
            starter: U128(STARTER),
            reserve: U128(RESERVE),
            weapon_prices: WEAPON_PRICES.iter().map(|p| U128(*p)).collect(),
            armor_prices: ARMOR_PRICES.iter().map(|p| U128(*p)).collect(),
            skin_price: U128(SKIN_PRICE),
            expiry_blocks: EXPIRY_BLOCKS,
            expiry_free_blocks: EXPIRY_FREE_BLOCKS,
            pending_free: self.pending_free.len() as u32,
            max_free: self.max_free,
            pending_paid: self.pending_paid,
            max_paid: MAX_PENDING_PAID,
            storage_deposit: STORAGE_DEPOSIT,
            block_height: U64(env::block_height()),
        }
    }

    /// Did this account already receive its one-time welcome credit?
    pub fn got_welcome(&self, account_id: AccountId) -> bool {
        self.is_welcomed(&account_id)
    }

    /// Welcome credit left (only pays match entries; not $BOUNTY).
    pub fn get_welcome_credit(&self, account_id: AccountId) -> U128 {
        U128(self.welcome_credit(&account_id))
    }

    /// For an account whose registration fell on a full day: claim the welcome credit yourself later.
    pub fn claim_welcome(&mut self) -> U128 {
        let id = env::predecessor_account_id();
        require!(self.load_player(&id).is_some(), "register first: storage_deposit");
        require!(!self.is_guest(&id), "guests play for free and earn no $NOX: sign in with a NEAR account");
        require!(!self.is_welcomed(&id), "you already got your welcome credit");
        require!(self.grant_welcome(&id), "today's welcome credits are gone: try again tomorrow");
        U128(WELCOME_STAKE)
    }

    pub fn is_guest_account(&self, account_id: AccountId) -> bool {
        self.is_guest(&account_id)
    }
}

// ---------------------------------------------------------------------- internals

impl Contract {
    pub(crate) fn load_player(&self, id: &AccountId) -> Option<PlayerV2> {
        self.players.get(id).map(|v| match v {
            VPlayer::V1(p) => {
                // fail closed: V1 didn't record who paid the deposit, and the relayer paid for guests
                // AND for signed-in accounts, so a V1 refund always goes to the relayer (a player who
                // really paid their own V1 deposit can ask the owner; 0.02 NEAR at most)
                let mut p2: PlayerV2 = p.clone().into();
                p2.deposit_payer = Some(self.guest_parent.clone());
                p2
            }
            VPlayer::V2(p) => p.clone(),
        })
    }
    pub(crate) fn save_player(&mut self, id: &AccountId, p: PlayerV2) {
        self.players.insert(id.clone(), VPlayer::V2(p));
    }
    fn load_fighter(&self, id: &AccountId) -> Option<FighterV1> {
        self.fighters.get(id).map(|VFighter::V1(f)| f.clone())
    }
    fn save_fighter(&mut self, f: FighterV1) {
        self.fighters.insert(f.account.clone(), VFighter::V1(f));
    }
    fn slot_fighter(&self, slot: usize) -> FighterV1 {
        self.load_fighter(&self.slots[slot]).expect("slot fighter")
    }
    fn load_match(&self, id: u64) -> Option<MatchV2> {
        self.matches.get(&id).map(|v| v.clone().into())
    }
    fn save_match(&mut self, m: MatchV2) {
        self.matches.insert(m.id.0, VMatch::V2(m));
    }

    pub(crate) fn balance(&self, a: &AccountId) -> u128 {
        self.token.accounts.get(a).unwrap_or(0)
    }

    fn view_fighter(&self, f: FighterV1, bounty: bool) -> FighterView {
        let balance = U128(self.balance(&f.account));
        let status = if f.active { "active" } else { "retired" }.to_string();
        FighterView { fighter: f, status, balance, bounty }
    }

    pub(crate) fn is_guest(&self, id: &AccountId) -> bool {
        id.as_str()
            .strip_suffix(self.guest_parent.as_str())
            .and_then(|s| s.strip_suffix('.'))
            .is_some_and(|local| local.starts_with("g-") && !local.contains('.'))
    }

    /// Who gets paid for fighter idx `i` of match `m`: the bot's own wallet, the real player who
    /// paid the entry, or the house (guests and players who paid nothing earn zero).
    fn payee(&self, m: &MatchV2, i: u8) -> AccountId {
        match i {
            0 if !player_eligible(m) => self.house.clone(),
            0 => m.player.clone(),
            i => m.roster[i as usize - 1].account.clone(),
        }
    }

    fn richest_slot(&self) -> Option<usize> {
        let mut best: Option<(usize, u128)> = None;
        for s in 0..BOTS {
            let b = self.balance(&self.slots[s]);
            if b > 0 && best.is_none_or(|(_, bb)| b > bb) {
                best = Some((s, b));
            }
        }
        best.map(|(s, _)| s)
    }

    fn mint(&mut self, to: &AccountId, amount: u128, memo: &str) {
        if amount == 0 {
            return;
        }
        self.token.internal_deposit(to, amount);
        self.total_minted += amount;
        FtMint { owner_id: to, amount: U128(amount), memo: Some(memo) }.emit();
    }

    pub(crate) fn burn(&mut self, from: &AccountId, amount: u128, memo: &str) {
        if amount == 0 {
            return;
        }
        self.token.internal_withdraw(from, amount);
        self.total_burned += amount;
        FtBurn { owner_id: from, amount: U128(amount), memo: Some(memo) }.emit();
    }

    fn move_tokens(&mut self, from: &AccountId, to: &AccountId, amount: u128, memo: &str) {
        if amount == 0 || from == to {
            return;
        }
        self.ensure_registered(to);
        self.token.internal_transfer(from, to, amount, Some(memo.to_string()));
    }

    /// Bots' escrowed entries of `m` are no longer in escrow (refunded or paid into the pot).
    fn release_escrow(&mut self, m: &MatchV2) {
        for r in &m.roster {
            if r.paid.0 == 0 {
                continue;
            }
            if let Some(mut f) = self.load_fighter(&r.account) {
                f.escrowed = U128(f.escrowed.0.saturating_sub(r.paid.0));
                self.save_fighter(f);
            }
        }
    }

    /// Retired bots whose last escrowed entry just came back (refund or settlement): close their
    /// sponsorship pool now, with everything they will ever get back.
    fn finish_retired_pools(&mut self, accounts: &[AccountId], match_id: u64) {
        for a in accounts {
            if let Some(f) = self.load_fighter(a) {
                if !f.active && f.escrowed.0 == 0 && self.sponsors.get(a).is_some() {
                    self.close_pool(a, match_id);
                }
            }
        }
    }

    /// End a match that will never be settled (abandoned or expired): bots get their entries
    /// back; the player's entry is refunded only if the seed was never fixed, otherwise it goes to
    /// the house and the match counts as a loss.
    fn close_unsettled(&mut self, match_id: u64, why: &str) {
        let Some(m) = self.load_match(match_id) else { return };
        if m.status != MatchStatus::Pending {
            return;
        }
        let me = env::current_account_id();
        self.release_escrow(&m);
        for r in &m.roster {
            self.move_tokens(&me, &r.account, r.paid.0, "entry refund");
        }
        let seeded = m.seed != 0;
        // an entry paid with the welcome credit goes back to the house, and (unseeded) to the credit
        let by_credit = near_sdk::store::LookupSet::<u64>::new(Key::CreditMatches).remove(&match_id);
        let to = if seeded || by_credit { self.house.clone() } else { m.player.clone() };
        self.move_tokens(&me, &to, m.player_paid.0, if seeded { "entry forfeited" } else { "entry refund" });
        if by_credit && !seeded {
            self.set_welcome_credit(&m.player, self.welcome_credit(&m.player) + m.player_paid.0);
        }
        if let Some(mut p) = self.load_player(&m.player) {
            if p.pending == Some(m.id) {
                p.pending = None;
            }
            if seeded {
                p.matches += 1;
                p.deaths += 1;
            }
            self.save_player(&m.player, p);
        }
        self.unlist_pending(&m);
        self.matches.remove(&match_id);
        let accts: Vec<AccountId> = m.roster.iter().map(|r| r.account.clone()).collect();
        self.finish_retired_pools(&accts, match_id);
        event("match_closed", &near_sdk::serde_json::json!({ "match_id": U64(match_id), "reason": why, "seeded": seeded, "player_forfeited": if seeded { m.player_paid } else { U128(0) } }));
    }

    fn unlist_pending(&mut self, m: &MatchV2) {
        if m.player_paid.0 > 0 {
            self.pending_paid = self.pending_paid.saturating_sub(1);
        } else {
            self.pending_free.retain(|x| *x != m.id.0);
        }
    }

    /// Lazy expiry: close up to `n` of the oldest unsettled FREE matches that have expired.
    fn sweep_expired(&mut self, n: usize) {
        for _ in 0..n {
            let Some(&id) = self.pending_free.first() else { return };
            match self.load_match(id) {
                Some(m) if env::block_height() <= m.start_block.0 + expiry_of(&m) => return,
                Some(_) => self.close_unsettled(id, "expired"),
                None => {
                    self.pending_free.remove(0);
                }
            }
        }
    }

    /// After every settled match, in slot order: each bot buys at most one upgrade it can afford
    /// while keeping `RESERVE` (weapon tier, then armor, then a new skin; the price goes to the
    /// house), then a bot that can't pay the next entry retires and a rookie takes the slot.
    fn run_economy(&mut self, entropy: &[u8; 32], match_id: u64) {
        let house = self.house.clone();
        for slot in 0..BOTS {
            let mut f = self.slot_fighter(slot);
            let bal = self.balance(&f.account);
            let (what, price) = if f.upgrades.weapon_tier < 2 {
                ("weapon", WEAPON_PRICES[f.upgrades.weapon_tier as usize])
            } else if f.upgrades.armor < 2 {
                ("armor", ARMOR_PRICES[f.upgrades.armor as usize])
            } else {
                ("skin", SKIN_PRICE)
            };
            if bal >= price + RESERVE {
                let acct = f.account.clone();
                self.move_tokens(&acct, &house, price, &format!("upgrade: {what}"));
                match what {
                    "weapon" => f.upgrades.weapon_tier += 1,
                    "armor" => f.upgrades.armor += 1,
                    _ => f.upgrades.skin = (f.upgrades.skin + 1 + entropy[slot] % (SKINS - 1)) % SKINS,
                }
                event("upgrade", &near_sdk::serde_json::json!({ "account": f.account, "what": what, "price": U128(price), "upgrades": f.upgrades }));
                let label = match what {
                    "weapon" => format!("weapon {}", f.upgrades.weapon_tier),
                    "armor" => format!("armor {}", f.upgrades.armor),
                    _ => format!("skin {}", f.upgrades.skin),
                };
                self.push_history(&acct, match_id, "upgrade", price, &label);
                self.save_fighter(f.clone());
            }
            if self.balance(&f.account) < ENTRY_FEE && f.escrowed.0 == 0 {
                self.retire(slot, "broke", match_id);
                let e = env::sha256_array(&[&entropy[..], &(slot as u64).to_le_bytes()].concat());
                self.spawn_rookie(slot, &e, match_id);
            }
        }
        if let Some(s) = self.richest_slot() {
            event("new_bounty", &near_sdk::serde_json::json!({ "account": self.slots[s], "idx": s + 1, "balance": U128(self.balance(&self.slots[s])) }));
        }
    }

    fn retire(&mut self, slot: usize, why: &str, match_id: u64) {
        let mut f = self.slot_fighter(slot);
        f.active = false;
        f.retired_block = Some(env::block_height());
        event("retire", &near_sdk::serde_json::json!({ "account": f.account, "slot": slot, "reason": why, "record": f.record, "balance": U128(self.balance(&f.account)) }));
        let acct = f.account.clone();
        // the pool closes once none of the bot's entries are left in escrow (pending matches may still
        // refund or pay it): see finish_retired_pools
        if f.escrowed.0 == 0 {
            self.close_pool(&acct, match_id);
        }
        let left = self.balance(&acct);
        self.push_history(&acct, match_id, "retired", left, why);
        let mut list = self.retired.get().clone().unwrap_or_default();
        list.push(acct);
        if list.len() > RETIRED_SHOWN {
            // bounded: the oldest shown retiree's history goes (its record stays)
            let old = list.remove(0);
            self.history.remove(&old);
        }
        self.retired.set(Some(list));
        self.save_fighter(f);
    }

    /// A rookie gets a fresh sub-account (no access keys), a name and a play style drawn from
    /// `entropy`, and a starter grant from the house (whatever the house can afford).
    fn spawn_rookie(&mut self, slot: usize, entropy: &[u8; 32], match_id: u64) -> FighterV1 {
        let prev = self.slot_fighter(slot);
        self.rookies += 1;
        let n = self.rookies;
        // a name no active fighter is using (the pool is larger than the roster)
        let taken: Vec<String> = (0..BOTS).filter(|s| *s != slot).map(|s| self.slot_fighter(s).name.to_ascii_lowercase()).collect();
        let base = (0..ROOKIE_NAMES.len())
            .map(|k| ROOKIE_NAMES[(entropy[0] as usize + k) % ROOKIE_NAMES.len()])
            .find(|n| !taken.iter().any(|t| t == n))
            .unwrap_or(ROOKIE_NAMES[entropy[0] as usize % ROOKIE_NAMES.len()]);
        let personality = PERSONALITIES[entropy[1] as usize % PERSONALITIES.len()];
        let account: AccountId = format!("{base}-{n}.{}", env::current_account_id()).parse().unwrap();
        let mut name = base.to_string();
        name[..1].make_ascii_uppercase();
        let f = FighterV1 {
            account: account.clone(),
            name: name.clone(),
            personality: personality.to_string(),
            slot: slot as u8,
            upgrades: Upgrades { weapon_tier: 0, armor: 0, skin: entropy[2] % SKINS },
            record: Record::default(),
            active: true,
            generation: prev.generation + 1,
            born_block: env::block_height(),
            retired_block: None,
            escrowed: U128(0),
        };
        self.ensure_registered(&account);
        let house = self.house.clone();
        let grant = STARTER.min(self.balance(&house));
        self.move_tokens(&house, &account, grant, "rookie grant");
        self.save_fighter(f.clone());
        self.slots[slot] = account.clone();
        create_npc_account(&account);
        event("fighter_born", &near_sdk::serde_json::json!({ "account": account, "name": name, "personality": personality, "slot": slot, "generation": f.generation, "replaces": prev.account, "grant": U128(grant) }));
        self.push_history(&account, match_id, "rookie", grant, &prev.name);
        f
    }

    /// Grant the one-time welcome credit (real accounts only, at most WELCOME_DAILY_CAP per UTC day).
    /// Recorded forever (survives unregister). Returns whether it was granted now.
    pub(crate) fn grant_welcome(&mut self, account: &AccountId) -> bool {
        if self.is_guest(account) || self.fighters.get(account).is_some() || account == &self.house || account == &env::current_account_id() {
            return false;
        }
        let mut welcomed = near_sdk::store::LookupSet::<AccountId>::new(Key::Welcomed);
        if welcomed.contains(account) {
            return false;
        }
        let day = env::block_timestamp_ms() / 86_400_000;
        let (d, n) = env::storage_read(WELCOME_DAY_KEY)
            .map(|v| (u64::from_le_bytes(v[0..8].try_into().unwrap()), u32::from_le_bytes(v[8..12].try_into().unwrap())))
            .unwrap_or((day, 0));
        let n = if d == day { n } else { 0 };
        if n >= WELCOME_DAILY_CAP {
            return false;
        }
        env::storage_write(WELCOME_DAY_KEY, &[&day.to_le_bytes()[..], &(n + 1).to_le_bytes()].concat());
        welcomed.insert(account.clone());
        self.set_welcome_credit(account, WELCOME_STAKE);
        event("welcome", &near_sdk::serde_json::json!({ "account": account, "credit": U128(WELCOME_STAKE), "today": n + 1 }));
        true
    }

    pub(crate) fn welcome_credit(&self, account: &AccountId) -> u128 {
        near_sdk::store::LookupMap::<AccountId, u128>::new(Key::WelcomeCredit).get(account).copied().unwrap_or(0)
    }

    pub(crate) fn set_welcome_credit(&mut self, account: &AccountId, v: u128) {
        let mut m = near_sdk::store::LookupMap::<AccountId, u128>::new(Key::WelcomeCredit);
        if v == 0 {
            m.remove(account);
        } else {
            m.insert(account.clone(), v);
        }
        m.flush();
    }

    pub(crate) fn is_welcomed(&self, account: &AccountId) -> bool {
        near_sdk::store::LookupSet::<AccountId>::new(Key::Welcomed).contains(account)
    }

    /// Legacy fix (migration to V2): active fighters with the same display name get unused names.
    fn dedupe_names(&mut self) {
        let mut seen: Vec<String> = vec![];
        for slot in 0..BOTS {
            let mut f = self.slot_fighter(slot);
            if seen.iter().any(|n| n.eq_ignore_ascii_case(&f.name)) {
                let all: Vec<String> = (0..BOTS).map(|s| self.slot_fighter(s).name.to_ascii_lowercase()).collect();
                if let Some(base) = ROOKIE_NAMES.iter().find(|n| !all.iter().any(|a| a == *n) && !seen.iter().any(|s| s.eq_ignore_ascii_case(n))) {
                    let mut name = base.to_string();
                    name[..1].make_ascii_uppercase();
                    event("renamed", &near_sdk::serde_json::json!({ "account": f.account, "from": f.name, "to": name }));
                    f.name = name;
                    self.save_fighter(f.clone());
                }
            }
            seen.push(f.name.clone());
        }
    }

    fn update_leaderboard(&mut self, e: LeaderEntry) {
        let mut lb = self.leaderboard.get().clone().unwrap_or_default();
        lb.retain(|x| x.account != e.account);
        lb.push(e);
        lb.sort_by(|a, b| b.wins.cmp(&a.wins).then(b.kills.cmp(&a.kills)).then(a.matches.cmp(&b.matches)));
        lb.truncate(LEADERBOARD_SIZE);
        self.leaderboard.set(Some(lb));
    }
}

fn expiry_of(m: &MatchV2) -> u64 {
    if m.player_paid.0 > 0 { EXPIRY_BLOCKS } else { EXPIRY_FREE_BLOCKS }
}

/// A bot's entry for this match: the base fee + 2% of its wallet above the reserve, capped.
pub fn entry_fee_for(balance: u128) -> u128 {
    (ENTRY_FEE + balance.saturating_sub(RESERVE) * ENTRY_WEALTH_BPS / 10_000).min(MAX_ENTRY)
}

/// Only a real (non-guest) player who paid the entry can win the pot or a bounty.
fn player_eligible(m: &MatchV2) -> bool {
    !m.guest && m.player_paid.0 > 0
}

/// A keyless sub-account of this contract (fire and forget: the $BOUNTY ledger lives here anyway).
fn create_npc_account(id: &AccountId) {
    let _ = Promise::new(id.clone()).create_account().transfer(NPC_NEAR);
}

fn event(name: &str, data: &near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({ "standard": "bountyroyale", "version": "1.0.0", "event": name, "data": [data] })
    ));
}

#[cfg(test)]
mod tests;
