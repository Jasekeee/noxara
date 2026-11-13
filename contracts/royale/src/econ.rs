//! Economy v2 (docs/ECONOMY.md): the House rule, sinks, progressive upkeep, bot P&L + seasons, and bot shares
//! (NEP-245 subset) with profit-only dividends and a fixed-price market. Every number is in
//! scripts/econ-params.json, which `econ_params_match_the_simulator` checks against these constants.
//!
//! All v2 state lives in its own storage keys (opened on demand), so upgrading a live contract needs no state
//! migration: a bot or holder that has no v2 record yet gets one the first time it is touched.
use crate::{event, Contract, ContractExt, Key, BOTS, HOUSE_FLOOR, HOUSE_GENESIS, ONE, STARTER};
use near_contract_standards::fungible_token::events::FtBurn;
use near_sdk::borsh::{self, BorshDeserialize};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap as StoreMap;
use near_sdk::{env, near, require, AccountId};

// ---------------------------------------------------------------- parameters (== scripts/econ-params.json)
pub const ENTRY_BURN_BPS: u128 = 1_000;
pub const BASE_TOP_UP: u128 = 25 * ONE;
pub const BOUNTY_BONUS: u128 = 5 * ONE;
pub const BASE_BURN_BPS: u128 = 100;
pub const MAX_BURN_BPS: u128 = 400;
pub const BASE_HOUSE_BPS: u128 = 500;
pub const MAX_HOUSE_BPS: u128 = 1_500;
pub const M_MAX_BPS: u128 = 15_000;
pub const HOUSE_TARGET: u128 = 1_000 * ONE;
pub const S_TARGET: u128 = 2_900 * ONE;
pub const S_MIN: u128 = 2_300 * ONE;
pub const EMA_DIV: u128 = 16;
/// progressive upkeep: (wallet threshold, marginal bps above it)
pub const UPKEEP: [(u128, u128); 3] = [(150 * ONE, 100), (300 * ONE, 200), (600 * ONE, 400)];
pub const UPKEEP_HOUSE_BPS: u128 = 5_000;
pub const UPGRADE_BURN_BPS: u128 = 5_000;
pub const SHARES_PER_BOT: u32 = 1_000;
pub const IPO_SHARES: u32 = 300;
/// 0.1 NOX per IPO share
pub const IPO_PRICE: u128 = ONE / 10;
pub const DIVIDEND_BPS: u128 = 2_000;
pub const TRADE_TAX_BPS: u128 = 200;
pub const DAILY_FULL_WINS: u32 = 3;
pub const DAILY_HALF_WINS: u32 = 3;
pub const SEASON_MS: u64 = 172_800_000;
pub const SEASON_EPOCH_MS: u64 = 1_794_614_400_000;
pub const COSMETIC_PRICES: [u128; 3] = [50 * ONE, 100 * ONE, 200 * ONE];
pub const SNAPSHOTS: usize = 64;
pub const SEASONS_KEPT: usize = 8;
/// bounded per account: bots held, open listings; and open listings overall
pub const MAX_HOLDINGS: usize = 3;
pub const MAX_LISTINGS_PER_SELLER: usize = 2;
pub const MAX_LISTINGS: usize = 200;
pub const MAX_LISTINGS_PER_BOT: usize = 20;
/// a listing offers at least this many shares (raises the cost of filling a bot's book with dust)
pub const MIN_LISTING_SHARES: u32 = 10;
/// listings expire (anyone can prune expired ones, and those of bankrupt bots)
pub const LISTING_TTL_MS: u64 = 172_800_000;
/// a share price may not exceed this (keeps u128 math far from overflow; 1,000 NOX per share)
pub const MAX_SHARE_PRICE: u128 = 1_000 * ONE;
const ECON_KEY: &[u8] = b"econ_v2";
const SEASONS_KEY: &[u8] = b"econ_seasons";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub match_id: U64,
    pub at_ms: U64,
    pub supply: U128,
    pub burned: U128,
    pub house: U128,
    pub m_bps: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct EconState {
    pub ema: u128,
    pub season: u32,
    pub season_burned: u128,
    pub season_rewards: u128,
    pub snapshots: Vec<Snapshot>,
    pub next_listing: u64,
    pub listings: Vec<u64>,
}

/// One bot's v2 record: shares outstanding, dividend accumulator, season P&L.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct BotEcon {
    /// high-water mark of the wallet: dividends only on profit above it
    pub hwm: U128,
    /// shares held by players (the bot holds the rest of SHARES_PER_BOT)
    pub sold: u32,
    /// IPO shares still for sale at IPO_PRICE
    pub ipo_left: u32,
    /// dividends per share ever paid (yocto NOX per share)
    pub acc: U128,
    pub dividends_paid: U128,
    pub holders: u32,
    pub last_price: Option<U128>,
    /// shares went to zero (bankrupt)
    pub bankrupt: bool,
    pub season: u32,
    pub income: U128,
    pub costs: U128,
    pub points: u32,
    pub wins: u32,
    pub kills: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Holding {
    pub shares: u32,
    /// shares locked in open listings
    pub locked: u32,
    /// the bot's `acc` when this holding last settled
    pub debt: U128,
    /// dividends owed, waiting for claim_dividends
    pub claimable: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ListingView {
    pub id: U64,
    pub seller: AccountId,
    pub bot: AccountId,
    pub shares: u32,
    pub price_per_share: U128,
    pub expires_ms: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct SeasonRow {
    pub bot: AccountId,
    pub name: String,
    pub points: u32,
    pub wins: u32,
    pub kills: u32,
    pub income: U128,
    pub costs: U128,
}

#[near(serializers = [json])]
pub struct EconomyView {
    pub supply: U128,
    pub genesis: U128,
    pub minted: U128,
    pub burned: U128,
    pub house: U128,
    pub house_ema: U128,
    pub floor: U128,
    pub target: U128,
    pub m_bps: u32,
    pub house_bps: u32,
    pub burn_bps: u32,
    pub brake_bps: u32,
    pub top_up: U128,
    pub season: u32,
    pub season_ends_ms: U64,
    pub season_burned: U128,
    pub season_rewards: U128,
    pub snapshots: Vec<Snapshot>,
}

#[near(serializers = [json])]
pub struct ShareMarketRow {
    pub bot: AccountId,
    pub name: String,
    pub status: String,
    pub sold: u32,
    pub ipo_left: u32,
    pub ipo_price: U128,
    pub last_price: Option<U128>,
    pub dividends_paid: U128,
    pub holders: u32,
    pub wallet: U128,
    pub season_income: U128,
    pub season_costs: U128,
}

#[near(serializers = [json])]
pub struct HoldingView {
    pub bot: AccountId,
    pub shares: u32,
    pub locked: u32,
    pub claimable: U128,
}

/// The House rule as bps: (m, house share of a pot, burned share of a pot), from the treasury's moving average.
pub fn rule(ema: u128) -> (u128, u128, u128) {
    let r = if ema > HOUSE_FLOOR { (ema - HOUSE_FLOOR) * 10_000 / (HOUSE_TARGET - HOUSE_FLOOR) } else { 0 };
    let m = r.min(M_MAX_BPS);
    let below = 10_000 - r.min(10_000);
    (m, BASE_HOUSE_BPS + (MAX_HOUSE_BPS - BASE_HOUSE_BPS) * below / 10_000, BASE_BURN_BPS + (MAX_BURN_BPS - BASE_BURN_BPS) * below / 10_000)
}

/// Deflation brake in bps: the share of every burn that really burns (the rest goes to the House).
pub fn brake(supply: u128) -> u128 {
    if supply <= S_MIN {
        0
    } else {
        ((supply - S_MIN) * 10_000 / (S_TARGET - S_MIN)).min(10_000)
    }
}

/// Progressive upkeep on a bot's wallet (marginal brackets, like income tax).
pub fn upkeep(bal: u128) -> u128 {
    let mut u = 0;
    for (i, (lo, bps)) in UPKEEP.iter().enumerate() {
        let hi = UPKEEP.get(i + 1).map(|x| x.0).unwrap_or(u128::MAX);
        if bal > *lo {
            u += (bal.min(hi) - lo) * bps / 10_000;
        }
    }
    u
}

/// A player's paid win number `n` of the UTC day pays this share of the prize (bps).
pub fn daily_factor_bps(n: u32) -> u128 {
    if n < DAILY_FULL_WINS {
        10_000
    } else if n < DAILY_FULL_WINS + DAILY_HALF_WINS {
        5_000
    } else {
        2_500
    }
}

pub fn season_of(ms: u64) -> u32 {
    (ms.saturating_sub(SEASON_EPOCH_MS) / SEASON_MS) as u32
}

fn bot_map() -> StoreMap<AccountId, BotEcon> {
    StoreMap::new(Key::BotEcon)
}
fn holding_map() -> StoreMap<(AccountId, AccountId), Holding> {
    StoreMap::new(Key::Holdings)
}
fn holdings_of_map() -> StoreMap<AccountId, Vec<AccountId>> {
    StoreMap::new(Key::HoldingsOf)
}
fn listing_map() -> StoreMap<u64, ListingView> {
    StoreMap::new(Key::Listings)
}
fn listings_of_map() -> StoreMap<AccountId, Vec<u64>> {
    StoreMap::new(Key::ListingsOf)
}
fn daily_map() -> StoreMap<AccountId, (u32, u32)> {
    StoreMap::new(Key::DailyWins)
}
fn cosmetics_map() -> StoreMap<AccountId, Vec<u8>> {
    StoreMap::new(Key::Cosmetics)
}

thread_local! {
    /// economy burns and House transfers of the current call, emitted as ONE log line each by
    /// `flush_econ_logs` (the 16 KiB log budget per receipt)
    static BURNS: std::cell::RefCell<Vec<(AccountId, u128)>> = const { std::cell::RefCell::new(Vec::new()) };
    static XFERS: std::cell::RefCell<Vec<(AccountId, AccountId, u128)>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn note_xfer(from: &AccountId, to: &AccountId, amount: u128) {
    if amount == 0 {
        return;
    }
    XFERS.with(|x| {
        let mut x = x.borrow_mut();
        match x.iter_mut().find(|(a, b, _)| a == from && b == to) {
            Some(e) => e.2 += amount,
            None => x.push((from.clone(), to.clone(), amount)),
        }
    });
}

fn mt_event(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", near_sdk::serde_json::json!({ "standard": "nep245", "version": "1.0.0", "event": event, "data": [data] })));
}

impl Contract {
    // ---------------------------------------------------------------- state
    pub(crate) fn econ(&self) -> EconState {
        match env::storage_read(ECON_KEY) {
            Some(b) => EconState::try_from_slice(&b).unwrap_or_else(|_| env::panic_str("econ state")),
            None => EconState { ema: self.balance(&self.house), season: season_of(env::block_timestamp_ms()), next_listing: 1, ..Default::default() },
        }
    }
    pub(crate) fn save_econ(&mut self, e: &EconState) {
        env::storage_write(ECON_KEY, &borsh::to_vec(e).unwrap());
    }

    pub(crate) fn dividends_account(&self) -> AccountId {
        format!("dividends.{}", env::current_account_id()).parse().unwrap()
    }

    /// A bot's v2 record (created on first touch: genesis/live bots float their IPO block then), rolled to the
    /// current season.
    pub(crate) fn bot_econ(&self, bot: &AccountId) -> BotEcon {
        let season = season_of(env::block_timestamp_ms());
        let mut b = bot_map().get(bot).cloned().unwrap_or_else(|| BotEcon { hwm: U128(self.bankroll(bot)), ipo_left: IPO_SHARES, season, ..Default::default() });
        if b.season != season {
            b.season = season;
            b.income = U128(0);
            b.costs = U128(0);
            b.points = 0;
            b.wins = 0;
            b.kills = 0;
        }
        b
    }
    pub(crate) fn save_bot_econ(&mut self, bot: &AccountId, b: BotEcon) {
        let mut m = bot_map();
        m.insert(bot.clone(), b);
        m.flush();
    }

    /// Burn `amount` from `from`, scaled by the deflation brake; the unburnt part goes to the House.
    pub(crate) fn econ_burn(&mut self, from: &AccountId, amount: u128, memo: &str, e: &mut EconState) {
        if amount == 0 {
            return;
        }
        let _ = memo;
        let real = amount * brake(self.token.total_supply) / 10_000;
        if real > 0 {
            self.token.internal_withdraw(from, real);
            self.total_burned += real;
            BURNS.with(|b| {
                let mut b = b.borrow_mut();
                match b.iter_mut().find(|(a, _)| a == from) {
                    Some(e) => e.1 += real,
                    None => b.push((from.clone(), real)),
                }
            });
        }
        e.season_burned += real;
        let house = self.house.clone();
        self.move_quiet(from, &house, amount - real);
        note_xfer(from, &house, amount - real);
    }

    /// Emit this call's economy burns and House transfers: one FtBurn line, one FtTransfer line.
    pub(crate) fn flush_econ_logs(&self) {
        let burns = BURNS.with(|b| std::mem::take(&mut *b.borrow_mut()));
        if !burns.is_empty() {
            let ev: Vec<FtBurn> = burns.iter().map(|(a, v)| FtBurn { owner_id: a, amount: U128(*v), memo: Some("economy") }).collect();
            FtBurn::emit_many(&ev);
        }
        let xfers = XFERS.with(|x| std::mem::take(&mut *x.borrow_mut()));
        crate::emit_transfers(&xfers, "economy");
    }

    pub(crate) fn add_income(&mut self, bot: &AccountId, amount: u128) {
        if amount == 0 || self.load_fighter_pub(bot).is_none() {
            return;
        }
        let mut b = self.bot_econ(bot);
        b.income = U128(b.income.0 + amount);
        self.save_bot_econ(bot, b);
    }
    pub(crate) fn add_cost(&mut self, bot: &AccountId, amount: u128) {
        if amount == 0 || self.load_fighter_pub(bot).is_none() {
            return;
        }
        let mut b = self.bot_econ(bot);
        b.costs = U128(b.costs.0 + amount);
        self.save_bot_econ(bot, b);
    }

    /// The daily-diminishing share (bps) of a prize for a real player's next paid win today.
    /// NEAR kept from an unregistering account's refund for its daily-wins row (it outlives the account)
    pub(crate) fn daily_row_near(&self, id: &AccountId) -> u128 {
        let a = if daily_map().get(id).is_some() { 40 + 8 + id.len() as u128 + 8 } else { 0 };
        // the check-in/quest row also outlives the account (re-registering must not reset today's claims)
        let b = if StoreMap::<AccountId, crate::daily::PlayerDaily>::new(Key::PlayerDaily).get(id).is_some() { 40 + 4 + id.len() as u128 + 30 } else { 0 };
        (a + b) * env::storage_byte_cost().as_yoctonear()
    }

    pub(crate) fn player_prize_bps(&mut self, player: &AccountId) -> u128 {
        let day = (env::block_timestamp_ms() / 86_400_000) as u32;
        let mut m = daily_map();
        let (d, n) = m.get(player).copied().unwrap_or((day, 0));
        let n = if d == day { n } else { 0 };
        m.insert(player.clone(), (day, n + 1));
        m.flush();
        daily_factor_bps(n)
    }

    /// After a settle, for one bot: profit-only dividends, then progressive upkeep. Upgrades follow in
    /// `run_economy`; afterwards `lower_hwm` drops the mark to the wallet (spending/losses lower it).
    pub(crate) fn settle_bot_econ(&mut self, bot: &AccountId, e: &mut EconState) {
        let mut b = self.bot_econ(bot);
        // audit #4 H-1: profit is measured on the BANKROLL (wallet + entries in other pending matches), so
        // refunds of abandoned/expired matches never count as profit; the payout comes from the wallet
        let bal = self.bankroll(bot);
        if bal > b.hwm.0 && b.sold > 0 && !b.bankrupt {
            // the cut is paid from the wallet; if the wallet can't cover it now (most of the bankroll sits in
            // other matches), the mark only moves by the profit actually distributed, so holders get the
            // rest at a later settle (review: no profit is skipped)
            let full = (bal - b.hwm.0) * DIVIDEND_BPS / 10_000;
            let per_share = full.min(self.balance(bot)) / SHARES_PER_BOT as u128;
            let total = per_share * b.sold as u128;
            if total > 0 {
                let d = self.dividends_account();
                self.ensure_registered(&d);
                self.move_quiet(bot, &d, total);
                note_xfer(bot, &d, total);
                b.acc = U128(b.acc.0 + per_share);
                b.dividends_paid = U128(b.dividends_paid.0 + total);
                b.costs = U128(b.costs.0 + total);
            }
            let distributed_profit = per_share * SHARES_PER_BOT as u128 * 10_000 / DIVIDEND_BPS;
            b.hwm = U128(if per_share * (SHARES_PER_BOT as u128) < full { b.hwm.0 + distributed_profit } else { b.hwm.0.max(self.bankroll(bot)) });
        } else {
            b.hwm = U128(b.hwm.0.max(self.bankroll(bot)));
        }
        self.save_bot_econ(bot, b);
        // rookie protection: no upkeep in a rookie's first matches
        let protected = self.load_fighter_pub(bot).is_some_and(|f| crate::daily::is_protected_rookie(f.generation, f.record.matches));
        let u = if protected { 0 } else { upkeep(self.balance(bot)) };
        if u > 0 {
            let to_house = u * UPKEEP_HOUSE_BPS / 10_000;
            let house = self.house.clone();
            self.move_quiet(bot, &house, to_house);
            note_xfer(bot, &house, to_house);
            self.econ_burn(bot, u - to_house, "upkeep", e);
            self.add_cost(bot, u);
        }
    }

    pub(crate) fn lower_hwm(&mut self, bot: &AccountId) {
        let mut b = self.bot_econ(bot);
        b.hwm = U128(b.hwm.0.min(self.bankroll(bot)));
        self.save_bot_econ(bot, b);
    }

    /// A bankrupt bot's shares go to zero (dividends already owed stay claimable).
    pub(crate) fn bankrupt_shares(&mut self, bot: &AccountId) {
        let mut b = self.bot_econ(bot);
        if b.bankrupt {
            return;
        }
        mt_event("mt_burn", near_sdk::serde_json::json!({ "owner_id": bot, "token_ids": [bot], "amounts": [SHARES_PER_BOT.to_string()], "memo": "bankrupt: every share goes to zero (holders included)" }));
        b.bankrupt = true;
        b.ipo_left = 0;
        self.save_bot_econ(bot, b);
    }

    /// Credit a holding with the dividends paid since it last settled. A bankrupt bot's shares vanish here.
    fn settle_holding(&self, holder: &AccountId, bot: &AccountId, b: &BotEcon) -> Holding {
        let mut h = holding_map().get(&(holder.clone(), bot.clone())).cloned().unwrap_or_default();
        h.claimable = U128(h.claimable.0 + h.shares as u128 * b.acc.0.saturating_sub(h.debt.0));
        h.debt = b.acc;
        if b.bankrupt {
            h.shares = 0;
            h.locked = 0;
        }
        h
    }

    /// Store a holding, keeping holders counts and the holder's bot list (bounded) right.
    fn put_holding(&mut self, holder: &AccountId, bot: &AccountId, before_shares: u32, h: Holding) {
        if (before_shares == 0) != (h.shares == 0) {
            let mut b = self.bot_econ(bot);
            if h.shares > 0 {
                b.holders += 1;
            } else {
                b.holders = b.holders.saturating_sub(1);
            }
            self.save_bot_econ(bot, b);
        }
        let mut hm = holding_map();
        let mut of = holdings_of_map();
        let mut mine = of.get(holder).cloned().unwrap_or_default();
        if h.shares == 0 && h.claimable.0 == 0 {
            hm.remove(&(holder.clone(), bot.clone()));
            mine.retain(|x| x != bot);
        } else {
            if !mine.contains(bot) {
                require!(mine.len() < MAX_HOLDINGS, "you can hold shares of at most 3 bots");
                mine.push(bot.clone());
            }
            hm.insert((holder.clone(), bot.clone()), h);
        }
        if mine.is_empty() {
            of.remove(holder);
        } else {
            of.insert(holder.clone(), mine);
        }
        hm.flush();
        of.flush();
    }

    /// Shares are for registered, real (non-guest) players only - never guests or game wallets.
    pub(crate) fn require_shareholder(&self, a: &AccountId) {
        require!(self.load_player(a).is_some(), "register first (storage_deposit)");
        require!(!self.is_guest(a), "guests can't hold shares: sign in with a NEAR wallet");
        require!(!self.is_game_wallet_pub(a), "game wallets can't hold shares");
    }

    fn active_bot(&self, bot: &AccountId) -> BotEcon {
        let f = self.load_fighter_pub(bot).unwrap_or_else(|| env::panic_str("not a fighter"));
        require!(f.active, "this bot has retired");
        self.bot_econ(bot)
    }
}

#[near]
impl Contract {
    // ---------------------------------------------------------------- shares: IPO, dividends, market
    /// Buy `shares` of a bot's IPO block at 0.1 NOX each. The NOX goes into the bot's own wallet (capital,
    /// not profit: it raises the high-water mark so it never comes back as a dividend).
    pub fn buy_ipo(&mut self, bot: AccountId, shares: u32) -> U128 {
        let me = env::predecessor_account_id();
        self.require_shareholder(&me);
        let mut b = self.active_bot(&bot);
        require!(shares > 0 && shares <= b.ipo_left, "not that many IPO shares left");
        let cost = shares as u128 * IPO_PRICE;
        require!(self.balance(&me) >= cost, "not enough NOX");
        self.move_tokens(&me, &bot, cost, "IPO");
        b.ipo_left -= shares;
        b.sold += shares;
        b.hwm = U128(b.hwm.0 + cost);
        self.save_bot_econ(&bot, b.clone());
        let mut h = self.settle_holding(&me, &bot, &b);
        let before = h.shares;
        h.shares += shares;
        self.put_holding(&me, &bot, before, h);
        mt_event("mt_transfer", near_sdk::serde_json::json!({ "old_owner_id": bot, "new_owner_id": me, "token_ids": [bot], "amounts": [shares.to_string()], "memo": "IPO" }));
        event("ipo", &near_sdk::serde_json::json!({ "buyer": me, "bot": bot, "shares": shares, "cost": U128(cost) }));
        U128(cost)
    }

    /// Pay out the dividends a holding has earned.
    pub fn claim_dividends(&mut self, bot: AccountId) -> U128 {
        let me = env::predecessor_account_id();
        require!(self.load_fighter_pub(&bot).is_some(), "not a fighter");
        require!(self.load_player(&me).is_some(), "register first (storage_deposit)");
        if holding_map().get(&(me.clone(), bot.clone())).is_none() {
            return U128(0); // nothing held: write nothing
        }
        let b = self.bot_econ(&bot);
        let mut h = self.settle_holding(&me, &bot, &b);
        let before = holding_map().get(&(me.clone(), bot.clone())).map(|x| x.shares).unwrap_or(0);
        let amount = h.claimable.0;
        h.claimable = U128(0);
        self.put_holding(&me, &bot, before, h);
        if amount > 0 {
            let d = self.dividends_account();
            self.move_tokens(&d, &me, amount, "dividends");
            event("dividends_claimed", &near_sdk::serde_json::json!({ "holder": me, "bot": bot, "amount": U128(amount) }));
        }
        U128(amount)
    }

    /// Offer `shares` of a bot at a fixed price (NOX per share). The shares stay yours (and keep earning)
    /// but are locked until sold, cancelled or expired (48 h). Needs a full wallet signature (1 yocto): a
    /// leaked in-game key must not be able to list your shares cheaply for an accomplice.
    #[payable]
    pub fn list_shares(&mut self, bot: AccountId, shares: u32, price_per_share: U128) -> U64 {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        self.prune_listings(Some(3));
        self.require_shareholder(&me);
        let b = self.active_bot(&bot);
        require!(price_per_share.0 > 0 && price_per_share.0 <= MAX_SHARE_PRICE, "price out of range");
        let mut h = self.settle_holding(&me, &bot, &b);
        require!(shares >= MIN_LISTING_SHARES, "list at least 10 shares");
        require!(h.shares - h.locked >= shares, "not enough unlocked shares");
        let mut e = self.econ();
        require!(e.listings.len() < MAX_LISTINGS, "the market is full: try again later");
        // a full book for this bot: a cheaper offer displaces the most expensive one (its shares unlock)
        let lm0 = listing_map();
        let book: Vec<ListingView> = e.listings.iter().filter_map(|i| lm0.get(i).cloned()).filter(|l| l.bot == bot).collect();
        if book.len() >= MAX_LISTINGS_PER_BOT {
            let top = book.iter().max_by_key(|l| l.price_per_share.0).cloned().unwrap();
            require!(price_per_share.0 < top.price_per_share.0, "this bot's order book is full: offer a lower price than the most expensive listing");
            self.drop_listing(&top);
            event("unlisted", &near_sdk::serde_json::json!({ "id": top.id, "reason": "displaced by a cheaper offer" }));
            e = self.econ();
            h = self.settle_holding(&me, &bot, &self.bot_econ(&bot));
        }
        let mut of = listings_of_map();
        let mut mine = of.get(&me).cloned().unwrap_or_default();
        require!(mine.len() < MAX_LISTINGS_PER_SELLER, "at most 2 open listings per player");
        let id = e.next_listing.max(1);
        e.next_listing = id + 1;
        e.listings.push(id);
        self.save_econ(&e);
        mine.push(id);
        of.insert(me.clone(), mine);
        of.flush();
        let mut lm = listing_map();
        lm.insert(id, ListingView { id: U64(id), seller: me.clone(), bot: bot.clone(), shares, price_per_share, expires_ms: U64(env::block_timestamp_ms() + LISTING_TTL_MS) });
        lm.flush();
        let before = h.shares;
        h.locked += shares;
        self.put_holding(&me, &bot, before, h);
        event("listed", &near_sdk::serde_json::json!({ "id": U64(id), "seller": me, "bot": bot, "shares": shares, "price_per_share": price_per_share }));
        U64(id)
    }

    /// Anyone may remove expired listings and those of bankrupt/retired bots (bounded: `max`, default 20).
    pub fn prune_listings(&mut self, max: Option<u32>) -> u32 {
        let now = env::block_timestamp_ms();
        let lm = listing_map();
        let dead: Vec<ListingView> = self
            .econ()
            .listings
            .iter()
            .filter_map(|i| lm.get(i).cloned())
            .filter(|l| now >= l.expires_ms.0 || self.bot_econ(&l.bot).bankrupt || self.load_fighter_pub(&l.bot).is_none_or(|f| !f.active) || self.load_player(&l.seller).is_none())
            .take(max.unwrap_or(20).min(50) as usize)
            .collect();
        for l in &dead {
            self.drop_listing(l);
        }
        dead.len() as u32
    }

    pub fn cancel_listing(&mut self, id: U64) {
        let l = listing_map().get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such listing"));
        require!(env::predecessor_account_id() == l.seller, "only the seller can cancel");
        self.drop_listing(&l);
        event("unlisted", &near_sdk::serde_json::json!({ "id": id }));
    }

    /// Buy a whole listing. 2% of the price is burned (deflation brake applies); the seller gets the rest.
    /// Needs a full wallet signature (1 yocto): a leaked in-game key must not be able to spend your NOX on
    /// an accomplice's overpriced listing.
    #[payable]
    pub fn buy_listing(&mut self, id: U64) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        self.require_shareholder(&me);
        let l = listing_map().get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such listing"));
        require!(env::block_timestamp_ms() < l.expires_ms.0, "this listing has expired");
        require!(l.seller != me, "that's your own listing");
        require!(self.load_player(&l.seller).is_some(), "the seller has left: this listing is void (anyone can prune it)");
        let mut b = self.active_bot(&l.bot);
        let cost = l.shares as u128 * l.price_per_share.0;
        require!(self.balance(&me) >= cost, "not enough NOX");
        let tax = cost * TRADE_TAX_BPS / 10_000;
        let mut e = self.econ();
        self.move_tokens(&me, &l.seller, cost - tax, "share sale");
        self.econ_burn(&me, tax, "share trade tax", &mut e);
        self.save_econ(&e);
        self.flush_econ_logs();
        self.drop_listing(&l);
        // move the shares
        let hs = self.settle_holding(&l.seller, &l.bot, &b);
        let before_s = hs.shares;
        let mut hs = hs;
        hs.shares -= l.shares;
        self.put_holding(&l.seller, &l.bot, before_s, hs);
        let hb = self.settle_holding(&me, &l.bot, &b);
        let before_b = hb.shares;
        let mut hb = hb;
        hb.shares += l.shares;
        self.put_holding(&me, &l.bot, before_b, hb);
        b = self.bot_econ(&l.bot);
        b.last_price = Some(l.price_per_share);
        self.save_bot_econ(&l.bot, b);
        mt_event("mt_transfer", near_sdk::serde_json::json!({ "old_owner_id": l.seller, "new_owner_id": me, "token_ids": [l.bot], "amounts": [l.shares.to_string()], "memo": "market" }));
        event("share_trade", &near_sdk::serde_json::json!({ "id": id, "buyer": me, "seller": l.seller, "bot": l.bot, "shares": l.shares, "price_per_share": l.price_per_share, "tax": U128(tax) }));
    }

    /// NEP-245 transfer between real players (1 yocto, so it needs a full wallet signature). 2% of the
    /// shares (rounded up) are burned as the transfer tax. `mt_transfer_call` is deliberately not offered:
    /// shares never leave this contract.
    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: AccountId, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        require!(approval.is_none(), "approvals are not supported");
        let me = env::predecessor_account_id();
        require!(me != receiver_id, "can't transfer to yourself");
        self.require_shareholder(&receiver_id);
        let n: u32 = amount.0.try_into().unwrap_or_else(|_| env::panic_str("amount too large"));
        let mut b = self.active_bot(&token_id);
        let hs = self.settle_holding(&me, &token_id, &b);
        require!(n > 0 && hs.shares - hs.locked >= n, "not enough unlocked shares");
        let tax = ((n as u128 * TRADE_TAX_BPS).div_ceil(10_000)) as u32;
        let before_s = hs.shares;
        let mut hs = hs;
        hs.shares -= n;
        self.put_holding(&me, &token_id, before_s, hs);
        let hr = self.settle_holding(&receiver_id, &token_id, &b);
        let before_r = hr.shares;
        let mut hr = hr;
        hr.shares += n - tax;
        self.put_holding(&receiver_id, &token_id, before_r, hr);
        b = self.bot_econ(&token_id);
        b.sold -= tax; // burned shares return to the bot
        self.save_bot_econ(&token_id, b);
        mt_event("mt_transfer", near_sdk::serde_json::json!({ "old_owner_id": me, "new_owner_id": receiver_id, "token_ids": [token_id], "amounts": [(n - tax).to_string()], "memo": memo }));
        if tax > 0 {
            mt_event("mt_transfer", near_sdk::serde_json::json!({ "old_owner_id": me, "new_owner_id": token_id, "token_ids": [token_id], "amounts": [tax.to_string()], "memo": "transfer tax (shares return to the bot)" }));
        }
    }

    /// Players' cosmetics (looks only, no power): the whole price is burned (deflation brake applies).
    pub fn buy_cosmetic(&mut self, id: u8) {
        let me = env::predecessor_account_id();
        self.require_shareholder(&me);
        let price = *COSMETIC_PRICES.get(id as usize).unwrap_or_else(|| env::panic_str("no such cosmetic"));
        let mut owned = cosmetics_map().get(&me).cloned().unwrap_or_default();
        require!(!owned.contains(&id), "you already own it");
        require!(self.balance(&me) >= price, "not enough NOX");
        let mut e = self.econ();
        self.econ_burn(&me, price, "cosmetic", &mut e);
        self.save_econ(&e);
        self.flush_econ_logs();
        owned.push(id);
        let mut cm = cosmetics_map();
        cm.insert(me.clone(), owned);
        cm.flush();
        event("cosmetic", &near_sdk::serde_json::json!({ "player": me, "id": id, "price": U128(price) }));
    }

    // ---------------------------------------------------------------- views
    pub fn get_economy(&self) -> EconomyView {
        let e = self.econ();
        let (m, hb, bb) = rule(e.ema);
        let house = self.balance(&self.house);
        let top_up = (BASE_TOP_UP * m / 10_000).min(house.saturating_sub(HOUSE_FLOOR));
        let season = season_of(env::block_timestamp_ms());
        EconomyView {
            supply: U128(self.token.total_supply),
            genesis: U128(HOUSE_GENESIS + STARTER * BOTS as u128),
            minted: U128(self.total_minted),
            burned: U128(self.total_burned),
            house: U128(house),
            house_ema: U128(e.ema),
            floor: U128(HOUSE_FLOOR),
            target: U128(HOUSE_TARGET),
            m_bps: m as u32,
            house_bps: hb as u32,
            burn_bps: bb as u32,
            brake_bps: brake(self.token.total_supply) as u32,
            top_up: U128(top_up),
            season,
            season_ends_ms: U64(SEASON_EPOCH_MS + (season as u64 + 1) * SEASON_MS),
            season_burned: U128(if e.season == season { e.season_burned } else { 0 }),
            season_rewards: U128(if e.season == season { e.season_rewards } else { 0 }),
            snapshots: e.snapshots,
        }
    }

    pub fn get_shares_market(&self) -> Vec<ShareMarketRow> {
        self.slots
            .iter()
            .map(|a| {
                let f = self.load_fighter_pub(a).unwrap();
                let b = self.bot_econ(a);
                ShareMarketRow {
                    bot: a.clone(),
                    name: f.name,
                    status: if f.active { "active" } else { "retired" }.into(),
                    sold: b.sold,
                    ipo_left: b.ipo_left,
                    ipo_price: U128(IPO_PRICE),
                    last_price: b.last_price,
                    dividends_paid: b.dividends_paid,
                    holders: b.holders,
                    wallet: U128(self.balance(a)),
                    season_income: b.income,
                    season_costs: b.costs,
                }
            })
            .collect()
    }

    pub fn get_bot_econ(&self, bot: AccountId) -> BotEcon {
        self.bot_econ(&bot)
    }

    pub fn get_holdings(&self, account_id: AccountId) -> Vec<HoldingView> {
        holdings_of_map()
            .get(&account_id)
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|bot| {
                let b = self.bot_econ(bot);
                let h = self.settle_holding(&account_id, bot, &b);
                HoldingView { bot: bot.clone(), shares: h.shares, locked: h.locked, claimable: h.claimable }
            })
            .collect()
    }

    pub fn get_listings(&self, bot: Option<AccountId>) -> Vec<ListingView> {
        let lm = listing_map();
        self.econ().listings.iter().filter_map(|id| lm.get(id).cloned()).filter(|l| bot.as_ref().is_none_or(|b| &l.bot == b)).collect()
    }

    /// Standings of the current season (live), or a past one (kept for SEASONS_KEPT seasons).
    pub fn get_season_standings(&self, season: Option<u32>) -> Vec<SeasonRow> {
        let now = season_of(env::block_timestamp_ms());
        if season.is_none_or(|s| s == now) {
            let mut rows: Vec<SeasonRow> = self
                .slots
                .iter()
                .map(|a| {
                    let b = self.bot_econ(a);
                    let f = self.load_fighter_pub(a).unwrap();
                    SeasonRow { bot: a.clone(), name: f.name, points: b.points, wins: b.wins, kills: b.kills, income: b.income, costs: b.costs }
                })
                .collect();
            rows.sort_by(|x, y| y.points.cmp(&x.points));
            return rows;
        }
        let hist: Vec<(u32, Vec<SeasonRow>)> = env::storage_read(SEASONS_KEY).map(|b| borsh::from_slice(&b).unwrap()).unwrap_or_default();
        hist.into_iter().find(|(s, _)| Some(*s) == season).map(|(_, r)| r).unwrap_or_default()
    }

    pub fn get_cosmetics(&self, account_id: AccountId) -> Vec<u8> {
        cosmetics_map().get(&account_id).cloned().unwrap_or_default()
    }

    // NEP-245 views (token_id = bot account; the bot itself holds the unsold shares)
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: AccountId) -> U128 {
        let b = self.bot_econ(&token_id);
        if b.bankrupt {
            return U128(0);
        }
        if account_id == token_id {
            return U128((SHARES_PER_BOT - b.sold) as u128);
        }
        U128(self.settle_holding(&account_id, &token_id, &b).shares as u128)
    }
    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<AccountId>) -> Vec<U128> {
        require!(token_ids.len() <= 20, "at most 20 token ids");
        token_ids.into_iter().map(|t| self.mt_balance_of(account_id.clone(), t)).collect()
    }
    pub fn mt_supply(&self, token_id: AccountId) -> Option<U128> {
        self.load_fighter_pub(&token_id).map(|_| U128(if self.bot_econ(&token_id).bankrupt { 0 } else { SHARES_PER_BOT as u128 }))
    }
}

impl Contract {
    fn drop_listing(&mut self, l: &ListingView) {
        let mut lm = listing_map();
        lm.remove(&l.id.0);
        lm.flush();
        let mut e = self.econ();
        e.listings.retain(|x| *x != l.id.0);
        self.save_econ(&e);
        let mut of = listings_of_map();
        let mut mine = of.get(&l.seller).cloned().unwrap_or_default();
        mine.retain(|x| *x != l.id.0);
        if mine.is_empty() {
            of.remove(&l.seller);
        } else {
            of.insert(l.seller.clone(), mine);
        }
        of.flush();
        let b = self.bot_econ(&l.bot);
        // `before` = the STORED shares (settle_holding zeroes a bankrupt bot's shares; audit #4)
        let before = holding_map().get(&(l.seller.clone(), l.bot.clone())).map(|x| x.shares).unwrap_or(0);
        let mut h = self.settle_holding(&l.seller, &l.bot, &b);
        h.locked = h.locked.saturating_sub(l.shares);
        self.put_holding(&l.seller, &l.bot, before, h);
    }

    /// Before an account unregisters (audit #4 M-1): with `force`, owed dividends are paid to it (then burned
    /// with the rest of its NOX by the caller), its shares go back to their bots and every v2 row it owns is
    /// deleted; without `force`, it must hold no shares and have nothing to claim.
    pub(crate) fn release_player_econ(&mut self, id: &AccountId, force: bool) {
        let bots = holdings_of_map().get(id).cloned().unwrap_or_default();
        for l in listings_of_map().get(id).cloned().unwrap_or_default() {
            if let Some(v) = listing_map().get(&l).cloned() {
                self.drop_listing(&v);
            }
        }
        for bot in bots {
            if bot_map().get(&bot).is_none() {
                // the bot's record was cleared at teardown (audit #5): nothing left to settle, drop the row
                let mut hm = holding_map();
                hm.remove(&(id.clone(), bot.clone()));
                hm.flush();
                continue;
            }
            let mut b = self.bot_econ(&bot);
            let h = self.settle_holding(id, &bot, &b);
            require!(force || (h.shares == 0 && h.claimable.0 == 0), "sell or transfer your bot shares and claim your dividends first (or pass force=true to give them up)");
            if h.claimable.0 > 0 {
                let d = self.dividends_account();
                self.move_tokens(&d, id, h.claimable.0, "dividends");
            }
            if h.shares > 0 && !b.bankrupt {
                b.sold = b.sold.saturating_sub(h.shares);
                mt_event("mt_transfer", near_sdk::serde_json::json!({ "old_owner_id": id, "new_owner_id": bot, "token_ids": [bot], "amounts": [h.shares.to_string()], "memo": "unregistered" }));
            }
            let stored = holding_map().get(&(id.clone(), bot.clone())).map(|x| x.shares).unwrap_or(0);
            if stored > 0 {
                b.holders = b.holders.saturating_sub(1);
            }
            self.save_bot_econ(&bot, b);
            let mut hm = holding_map();
            hm.remove(&(id.clone(), bot.clone()));
            hm.flush();
        }
        let mut of = holdings_of_map();
        of.remove(id);
        of.flush();
        let mut lo = listings_of_map();
        lo.remove(id);
        lo.flush();
        // the daily-wins counter is kept (tiny, fixed-size): unregister + register must not reset the
        // diminishing-rewards day (review); teardown_clear removes it
        let mut cm = cosmetics_map();
        cm.remove(id);
        cm.flush();
    }

    /// teardown_clear (audit #4 M-2): a fighter's v2 row
    pub(crate) fn clear_bot_econ(&mut self, a: &AccountId) {
        let mut m = bot_map();
        m.remove(a);
        m.flush();
    }

    /// teardown_clear: every v2 row of a player, and once everything else is cleared the global v2 keys
    pub(crate) fn clear_player_econ(&mut self, a: &AccountId) {
        let mut hm = holding_map();
        for bot in holdings_of_map().get(a).cloned().unwrap_or_default() {
            hm.remove(&(a.clone(), bot));
        }
        hm.flush();
        let mut lm = listing_map();
        for id in listings_of_map().get(a).cloned().unwrap_or_default() {
            lm.remove(&id);
        }
        lm.flush();
        let mut of = holdings_of_map();
        of.remove(a);
        of.flush();
        let mut lo = listings_of_map();
        lo.remove(a);
        lo.flush();
        let mut dm = daily_map();
        dm.remove(a);
        dm.flush();
        let mut cm = cosmetics_map();
        cm.remove(a);
        cm.flush();
        let mut pd = StoreMap::<AccountId, crate::daily::PlayerDaily>::new(Key::PlayerDaily);
        pd.remove(a);
        pd.flush();
    }

    pub(crate) fn clear_econ_globals(&mut self) {
        let mut lm = listing_map();
        for id in self.econ().listings {
            lm.remove(&id);
        }
        lm.flush();
        env::storage_remove(ECON_KEY);
        env::storage_remove(SEASONS_KEY);
        let d = self.dividends_account();
        self.token.accounts.remove(&d);
    }

    /// Season bookkeeping at a settle: when the season changed, archive the finished season's standings
    /// (bounded ring) and reset the season totals.
    pub(crate) fn roll_season(&mut self, e: &mut EconState) {
        let now = season_of(env::block_timestamp_ms());
        if e.season == now {
            return;
        }
        let rows: Vec<SeasonRow> = self
            .slots
            .iter()
            .filter_map(|a| {
                let b = bot_map().get(a).cloned()?;
                if b.season != e.season {
                    return None;
                }
                let f = self.load_fighter_pub(a)?;
                Some(SeasonRow { bot: a.clone(), name: f.name, points: b.points, wins: b.wins, kills: b.kills, income: b.income, costs: b.costs })
            })
            .collect();
        let mut hist: Vec<(u32, Vec<SeasonRow>)> = env::storage_read(SEASONS_KEY).map(|b| borsh::from_slice(&b).unwrap()).unwrap_or_default();
        hist.push((e.season, rows));
        while hist.len() > SEASONS_KEPT {
            hist.remove(0);
        }
        env::storage_write(SEASONS_KEY, &borsh::to_vec(&hist).unwrap());
        event("season_end", &near_sdk::serde_json::json!({ "season": e.season }));
        e.season = now;
        e.season_burned = 0;
        e.season_rewards = 0;
    }

    pub(crate) fn push_snapshot(&mut self, e: &mut EconState, match_id: u64) {
        let (m, _, _) = rule(e.ema);
        e.snapshots.push(Snapshot {
            match_id: U64(match_id),
            at_ms: U64(env::block_timestamp_ms()),
            supply: U128(self.token.total_supply),
            burned: U128(self.total_burned),
            house: U128(self.balance(&self.house)),
            m_bps: m as u32,
        });
        while e.snapshots.len() > SNAPSHOTS {
            e.snapshots.remove(0);
        }
    }
}
