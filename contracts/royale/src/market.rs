//! The sponsorship market (real players back bots) and per-fighter history.
//!
//! Sponsorship = shares of the bot's bankroll (its $BOUNTY wallet + entries in escrow):
//! * `sponsor(bot, amount)` moves the stake INTO the bot's wallet (it really funds entries and
//!   upgrades) and mints pool shares at the current share price. The bot itself owns the rest of the
//!   pool; sponsors together may own at most `SPONSOR_MAX_BPS` (30%) of it.
//! * Every prize or bounty the bot collects pays `SPONSOR_CUT_BPS` (10%) of it to its sponsors IN CASH,
//!   split by their shares. A sponsor's stake value moves with the bankroll: prizes grow it; entries,
//!   upgrades and the cash cut itself shrink it.
//! * `unsponsor(bot)` after `SPONSOR_COOLDOWN` bot matches pays out the stake's CURRENT value (can be
//!   less than staked). If the bot retires broke, the pool closes: sponsors get their share of the
//!   dust and lose the rest.
//! * Storage: at most `MAX_SPONSORSHIPS_PER_PLAYER` per player and `MAX_SPONSORS_PER_BOT` per bot;
//!   covered by the player's NEP-145 deposit (measured in the unit tests).
use crate::progression::{level_for_xp, upgrades_for_level, LEVELS, MAX_LEVEL};
use crate::{event, Contract, ContractExt, Upgrades, ONE};
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId};

pub const SPONSOR_MAX_BPS: u128 = 3_000;
/// Part of every prize/bounty a sponsored bot wins that is paid to its sponsors in cash.
pub const SPONSOR_CUT_BPS: u128 = 1_000;
pub const MIN_STAKE: u128 = 10 * ONE;
pub const SPONSOR_COOLDOWN: u32 = 5;
pub const MAX_SPONSORS_PER_BOT: usize = 12;
pub const MAX_SPONSORSHIPS_PER_PLAYER: usize = 3;
pub const HISTORY_LEN: usize = 24;
/// One pool share = 0.001 $BOUNTY of bankroll at pool creation (keeps share math far from u128 overflow).
pub const SHARE_UNIT: u128 = ONE / 1_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct SponsorEntry {
    pub sponsor: AccountId,
    pub shares: U128,
    /// total $BOUNTY put in
    pub staked: U128,
    /// cash received from the bot's prizes and bounties
    pub earned: U128,
    /// the bot's match count when this stake was (last) added: unsponsor after + SPONSOR_COOLDOWN
    pub since_matches: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct BotPool {
    /// all shares of the bankroll (the bot owns total - sum(sponsor shares))
    pub total_shares: U128,
    pub entries: Vec<SponsorEntry>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct HistEntry {
    pub match_id: U64,
    pub at_ms: U64,
    /// win | death | bounty | upgrade | retired | rookie | sponsored | unsponsored | dividend
    pub kind: String,
    pub amount: U128,
    /// kind-specific: "placement:kills" for win/death, "collected"/"lost" for bounty, the upgrade, a sponsor...
    pub detail: String,
}

#[near(serializers = [json])]
pub struct MarketEntry {
    pub bot: AccountId,
    pub name: String,
    pub bankroll: U128,
    /// sum of what sponsors put in
    pub total_stake: U128,
    /// what sponsors' shares are worth now
    pub sponsor_value: U128,
    pub sponsors: u32,
    /// part of each prize/bounty paid to sponsors in cash, basis points (1000 when it has sponsors)
    pub sponsor_cut_bps: u32,
    /// part of the bankroll sponsors own, basis points (capped at 3000)
    pub sponsor_owned_bps: u32,
    /// how much more can be staked before sponsors hit the 30% cap
    pub capacity: U128,
}

#[near(serializers = [json])]
pub struct SponsorshipView {
    pub bot: AccountId,
    pub bot_name: String,
    pub bot_active: bool,
    pub staked: U128,
    pub value: U128,
    pub earned: U128,
    /// part of the bot's sponsor pool owned by this player, basis points
    pub pool_bps: u32,
    /// matches the bot still has to play before `unsponsor` is allowed
    pub cooldown_left: u32,
}

#[near(serializers = [json])]
pub struct ProgressView {
    pub xp: u64,
    pub level: u8,
    pub level_xp: u64,
    pub next_level_xp: Option<u64>,
    pub upgrades: Upgrades,
}

#[near(serializers = [json])]
pub struct TopRow {
    pub account: AccountId,
    pub name: String,
    pub bot: bool,
    pub active: bool,
    pub wins: u32,
    pub kills: u32,
    pub matches: u32,
    pub earnings: U128,
}

#[near]
impl Contract {
    /// Back an active bot with `amount` $BOUNTY (real players only). Returns the sponsorship.
    pub fn sponsor(&mut self, bot: AccountId, amount: U128) -> SponsorshipView {
        let who = env::predecessor_account_id();
        require!(!self.is_guest(&who), "guests can't sponsor: sign in with a NEAR account");
        require!(self.load_player(&who).is_some(), "register first: storage_deposit");
        require!(amount.0 >= MIN_STAKE, "stake at least 10 $BOUNTY");
        require!(self.balance(&who) >= amount.0, "not enough $BOUNTY");
        let f = self.load_fighter(&bot).filter(|f| f.active).unwrap_or_else(|| env::panic_str("not an active fighter"));
        let bankroll = self.bankroll(&bot);
        require!(bankroll > 0, "this bot is broke");
        let mut pool = self.sponsors.get(&bot).cloned().unwrap_or_default();
        if pool.total_shares.0 == 0 {
            pool.total_shares = U128((bankroll / SHARE_UNIT).max(1)); // the bot owns its whole bankroll
        }
        let new_shares = amount.0 * pool.total_shares.0 / bankroll;
        require!(new_shares > 0, "stake too small");
        let sponsor_shares: u128 = pool.entries.iter().map(|e| e.shares.0).sum::<u128>() + new_shares;
        require!(sponsor_shares * 10_000 <= (pool.total_shares.0 + new_shares) * SPONSOR_MAX_BPS, "sponsors may own at most 30% of a bot");
        let mut mine = self.sponsoring.get(&who).cloned().unwrap_or_default();
        match pool.entries.iter_mut().find(|e| e.sponsor == who) {
            Some(e) => {
                e.shares = U128(e.shares.0 + new_shares);
                e.staked = U128(e.staked.0 + amount.0);
                e.since_matches = f.record.matches;
            }
            None => {
                require!(pool.entries.len() < MAX_SPONSORS_PER_BOT, "this bot has all the sponsors it can take");
                require!(mine.len() < MAX_SPONSORSHIPS_PER_PLAYER, "you can back at most 3 bots");
                pool.entries.push(SponsorEntry { sponsor: who.clone(), shares: U128(new_shares), staked: amount, earned: U128(0), since_matches: f.record.matches });
                mine.push(bot.clone());
                self.sponsoring.insert(who.clone(), mine);
            }
        }
        pool.total_shares = U128(pool.total_shares.0 + new_shares);
        self.sponsors.insert(bot.clone(), pool);
        self.move_tokens(&who, &bot, amount.0, "sponsorship stake");
        self.push_history(&bot, 0, "sponsored", amount.0, who.as_str());
        event("sponsor", &near_sdk::serde_json::json!({ "sponsor": who, "bot": bot, "amount": amount, "shares": U128(new_shares) }));
        self.sponsorship_view(&bot, &who).expect("just created")
    }

    /// Withdraw from a bot after the cooldown: pays the stake's CURRENT value. Returns the amount.
    pub fn unsponsor(&mut self, bot: AccountId) -> U128 {
        let who = env::predecessor_account_id();
        let mut pool = self.sponsors.get(&bot).cloned().unwrap_or_else(|| env::panic_str("you don't sponsor this bot"));
        let i = pool.entries.iter().position(|e| e.sponsor == who).unwrap_or_else(|| env::panic_str("you don't sponsor this bot"));
        let f = self.load_fighter(&bot).expect("fighter");
        let e = pool.entries[i].clone();
        require!(f.record.matches >= e.since_matches + SPONSOR_COOLDOWN, "this bot must play 5 matches after your stake before you can withdraw");
        let value = e.shares.0 * self.bankroll(&bot) / pool.total_shares.0;
        let pay = value.min(self.balance(&bot));
        pool.total_shares = U128(pool.total_shares.0 - e.shares.0);
        pool.entries.remove(i);
        self.sponsors.insert(bot.clone(), pool);
        self.forget_sponsoring(&who, &bot);
        self.move_tokens(&bot, &who, pay, "sponsorship withdrawn");
        self.push_history(&bot, 0, "unsponsored", pay, who.as_str());
        event("unsponsor", &near_sdk::serde_json::json!({ "sponsor": who, "bot": bot, "returned": U128(pay), "staked": e.staked, "earned": e.earned }));
        U128(pay)
    }

    // ------------------------------------------------------------------ views

    /// Every active bot with its sponsorship pool.
    pub fn get_market(&self) -> Vec<MarketEntry> {
        self.slots
            .iter()
            .map(|bot| {
                let f = self.load_fighter(bot).expect("fighter");
                let pool = self.sponsors.get(bot).cloned().unwrap_or_default();
                let bankroll = self.bankroll(bot);
                let s: u128 = pool.entries.iter().map(|e| e.shares.0).sum();
                let t = pool.total_shares.0;
                let (value, bps) = if t > 0 { (s * bankroll / t, (s * 10_000 / t) as u32) } else { (0, 0) };
                // max a: (s + a*t/b) / (t + a*t/b) <= cap  =>  room (in shares) = (cap*t - s*1e4) / (1e4 - cap)
                let tt = if t == 0 { (bankroll / SHARE_UNIT).max(1) } else { t };
                let room = (SPONSOR_MAX_BPS * tt).saturating_sub(s * 10_000) / (10_000 - SPONSOR_MAX_BPS);
                let capacity = room * bankroll / tt;
                MarketEntry {
                    bot: bot.clone(),
                    name: f.name,
                    bankroll: U128(bankroll),
                    total_stake: U128(pool.entries.iter().map(|e| e.staked.0).sum()),
                    sponsor_value: U128(value),
                    sponsors: pool.entries.len() as u32,
                    sponsor_cut_bps: if pool.entries.is_empty() { 0 } else { SPONSOR_CUT_BPS as u32 },
                    sponsor_owned_bps: bps,
                    capacity: U128(capacity),
                }
            })
            .collect()
    }

    pub fn get_sponsorships(&self, account_id: AccountId) -> Vec<SponsorshipView> {
        self.sponsoring.get(&account_id).cloned().unwrap_or_default().iter().filter_map(|b| self.sponsorship_view(b, &account_id)).collect()
    }

    /// Recent events of a fighter, newest first.
    pub fn get_history(&self, account_id: AccountId) -> Vec<HistEntry> {
        let mut v = self.history.get(&account_id).cloned().unwrap_or_default();
        v.reverse();
        v
    }

    pub fn get_progress(&self, account_id: AccountId) -> ProgressView {
        let xp = self.xp.get(&account_id).copied().unwrap_or(0);
        let level = level_for_xp(xp as i64);
        ProgressView {
            xp,
            level,
            level_xp: LEVELS[level as usize - 1],
            next_level_xp: (level < MAX_LEVEL).then(|| LEVELS[level as usize]),
            upgrades: upgrades_for_level(level as i64),
        }
    }

    /// Leaderboards: kind "bots" (active + recently retired) or "players" (the top 50 kept on chain),
    /// sorted by "earnings" | "wins" | "kills".
    pub fn get_top(&self, kind: String, by: String, n: Option<u32>) -> Vec<TopRow> {
        let mut rows: Vec<TopRow> = if kind == "bots" {
            let mut ids = self.slots.clone();
            ids.extend(self.retired.get().clone().unwrap_or_default());
            ids.iter()
                .filter_map(|a| self.load_fighter(a))
                .map(|f| TopRow { account: f.account.clone(), name: f.name, bot: true, active: f.active, wins: f.record.wins, kills: f.record.kills, matches: f.record.matches, earnings: f.record.earnings })
                .collect()
        } else {
            self.leaderboard
                .get()
                .clone()
                .unwrap_or_default()
                .into_iter()
                .map(|e| TopRow { name: e.account.to_string(), account: e.account, bot: false, active: true, wins: e.wins, kills: e.kills, matches: e.matches, earnings: e.earnings })
                .collect()
        };
        match by.as_str() {
            "wins" => rows.sort_by(|a, b| b.wins.cmp(&a.wins).then(b.kills.cmp(&a.kills))),
            "kills" => rows.sort_by(|a, b| b.kills.cmp(&a.kills).then(b.wins.cmp(&a.wins))),
            _ => rows.sort_by(|a, b| b.earnings.0.cmp(&a.earnings.0).then(b.wins.cmp(&a.wins))),
        }
        rows.truncate(n.unwrap_or(20).min(50) as usize);
        rows
    }
}

impl Contract {
    /// A bot's bankroll: its wallet + its entries sitting in escrow.
    pub(crate) fn bankroll(&self, bot: &AccountId) -> u128 {
        self.balance(bot) + self.load_fighter(bot).map(|f| f.escrowed.0).unwrap_or(0)
    }

    fn sponsorship_view(&self, bot: &AccountId, who: &AccountId) -> Option<SponsorshipView> {
        let f = self.load_fighter(bot)?;
        let pool = self.sponsors.get(bot)?;
        let e = pool.entries.iter().find(|e| &e.sponsor == who)?;
        let s: u128 = pool.entries.iter().map(|e| e.shares.0).sum();
        Some(SponsorshipView {
            bot: bot.clone(),
            bot_name: f.name.clone(),
            bot_active: f.active,
            staked: e.staked,
            value: U128(e.shares.0 * self.bankroll(bot) / pool.total_shares.0.max(1)),
            earned: e.earned,
            pool_bps: (e.shares.0 * 10_000 / s.max(1)) as u32,
            cooldown_left: (e.since_matches + SPONSOR_COOLDOWN).saturating_sub(f.record.matches),
        })
    }

    fn forget_sponsoring(&mut self, who: &AccountId, bot: &AccountId) {
        let mut mine = self.sponsoring.get(who).cloned().unwrap_or_default();
        mine.retain(|b| b != bot);
        if mine.is_empty() {
            self.sponsoring.remove(who);
        } else {
            self.sponsoring.insert(who.clone(), mine);
        }
    }

    /// The bot just collected `amount` (prize or bounty): its sponsors get `SPONSOR_CUT_BPS` of it in
    /// cash, split by shares. Returns what was paid out.
    pub(crate) fn pay_dividends(&mut self, bot: &AccountId, amount: u128, match_id: u64) -> u128 {
        let Some(mut pool) = self.sponsors.get(bot).cloned() else { return 0 };
        let s: u128 = pool.entries.iter().map(|e| e.shares.0).sum();
        if s == 0 || amount == 0 {
            return 0;
        }
        let total = (amount * SPONSOR_CUT_BPS / 10_000).min(self.balance(bot));
        let mut paid = 0u128;
        let mut payouts = vec![];
        for e in pool.entries.iter_mut() {
            let d = total * e.shares.0 / s;
            if d == 0 {
                continue;
            }
            e.earned = U128(e.earned.0 + d);
            paid += d;
            payouts.push((e.sponsor.clone(), d));
        }
        self.sponsors.insert(bot.clone(), pool);
        for (sp, d) in payouts {
            self.move_tokens(bot, &sp, d, "sponsor cut");
            event("dividend", &near_sdk::serde_json::json!({ "bot": bot, "sponsor": sp, "amount": U128(d), "match_id": U64(match_id) }));
        }
        if paid > 0 {
            self.push_history(bot, match_id, "dividend", paid, "");
        }
        paid
    }

    /// A retiring bot's pool closes: sponsors split what's left by share; the rest of their stake is lost.
    pub(crate) fn close_pool(&mut self, bot: &AccountId, match_id: u64) {
        let Some(pool) = self.sponsors.remove(bot) else { return };
        let b = self.balance(bot);
        let t = pool.total_shares.0.max(1);
        for e in pool.entries {
            let back = e.shares.0 * b / t;
            self.move_tokens(bot, &e.sponsor, back, "sponsorship closed: bot retired");
            self.forget_sponsoring(&e.sponsor, bot);
            event("sponsor_lost", &near_sdk::serde_json::json!({ "bot": bot, "sponsor": e.sponsor, "staked": e.staked, "returned": U128(back), "earned": e.earned, "match_id": U64(match_id) }));
        }
    }

    pub(crate) fn push_history(&mut self, acct: &AccountId, match_id: u64, kind: &str, amount: u128, detail: &str) {
        let mut v = self.history.get(acct).cloned().unwrap_or_default();
        v.push(HistEntry { match_id: U64(match_id), at_ms: U64(env::block_timestamp_ms()), kind: kind.to_string(), amount: U128(amount), detail: detail.to_string() });
        if v.len() > HISTORY_LEN {
            v.remove(0);
        }
        self.history.insert(acct.clone(), v);
    }
}
