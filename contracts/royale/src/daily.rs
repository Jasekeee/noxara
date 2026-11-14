//! Daily check-in + daily in-game quests (docs/DECISIONS.md rows 4 and 6). Closed loop: every reward is paid
//! by the House from NOX it collected (never minted), scaled by the House rule's multiplier m and never below
//! the House floor. Real accounts only. Sybil cost: only matches paid from the player's OWN wallet count
//! (welcome-credit matches don't), and check-in needs such a match in the last 48 h.
use crate::econ::rule;
use crate::{event, Contract, ContractExt, Key, HOUSE_FLOOR, ONE};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap as StoreMap;
use near_sdk::{env, near, require, AccountId};

/// streak day 1..=7 pays these NOX (× m); day 7+ keeps paying the last value
pub const CHECKIN_REWARDS: [u128; 7] = [ONE, ONE, ONE, 2 * ONE, 2 * ONE, 2 * ONE, 3 * ONE];
pub const CHECKIN_DAILY_CAP: u32 = 100;
/// check-in needs this many wallet-paid matches in the account's lifetime (audit #6: cap reserved for real players)
pub const CHECKIN_MIN_LIFETIME_PAID: u32 = 3;
/// quests: (id, goal, reward NOX × m)
pub const QUESTS: [(&str, u32, u128); 3] = [("play 3 matches", 3, ONE), ("finish in the top 3", 1, ONE), ("take down the bounty carrier", 1, 2 * ONE)];
pub const QUEST_DAILY_CAP: u32 = 300;
/// Daily LOGIN reward (owner spec 2026-11-14): claimed on entering the game, no match needed. Paid by the House
/// (never minted) × min(m, 1), never below the floor, real accounts only, once per account per UTC day.
/// Sybil bound: a global daily cap (worst case LOGIN_DAILY_CAP × LOGIN_REWARD = 20 NOX a day, 2% of the
/// House target, and m shrinks it as the House empties) and an account must be registered on an EARLIER UTC
/// day (a fresh farm account waits a day; its 0.02 NEAR registration stays locked meanwhile). The bigger,
/// streak-growing `check_in` stays reserved for days with a match paid from the player's own NOX.
pub const LOGIN_REWARD: u128 = ONE / 2;
pub const LOGIN_DAILY_CAP: u32 = 40;
/// claimable from the UTC day `registered day + LOGIN_MIN_AGE_DAYS` (≥ 1: re-registering can't re-claim a day)
pub const LOGIN_MIN_AGE_DAYS: u32 = 1;
const LOGIN_COUNT_KEY: &[u8] = b"login_day_count";
const DAY_MS: u64 = 86_400_000;
const CHECKIN_COUNT_KEY: &[u8] = b"checkin_day_count";
const QUEST_COUNT_KEY: &[u8] = b"quest_day_count";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct PlayerDaily {
    /// last match paid from the player's own wallet (ms)
    pub last_paid_ms: u64,
    pub checkin_day: u32,
    pub streak: u32,
    pub quest_day: u32,
    /// progress per quest for `quest_day`
    pub progress: [u32; 3],
    /// bit i = quest i claimed on `quest_day`
    pub claimed: u8,
    /// wallet-paid matches ever
    pub lifetime_paid: u32,
}

/// Per-account login record. Like `PlayerDaily` it outlives `storage_unregister` (its bytes are kept from the
/// refund), so leaving and re-registering neither resets the registration day nor today's claim.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct LoginRow {
    /// UTC day the account first registered (0 = registered before the login reward existed)
    pub since_day: u32,
    /// UTC day of the last claim (0 = never)
    pub claimed_day: u32,
}

#[near(serializers = [json])]
pub struct LoginView {
    pub day: u32,
    pub claimed_today: bool,
    pub can_claim: bool,
    pub why_not: Option<String>,
    /// what a claim pays right now (× min(m, 1), never below the House floor)
    pub reward: U128,
    pub claims_today: u32,
    pub daily_cap: u32,
}

#[near(serializers = [json])]
pub struct QuestView {
    pub id: u8,
    pub title: String,
    pub progress: u32,
    pub goal: u32,
    pub done: bool,
    pub claimed: bool,
    pub reward: U128,
}

#[near(serializers = [json])]
pub struct DailyView {
    pub day: u32,
    pub streak: u32,
    pub checked_in_today: bool,
    pub can_check_in: bool,
    pub why_not: Option<String>,
    pub next_reward: U128,
    pub quests: Vec<QuestView>,
}

fn map() -> StoreMap<AccountId, PlayerDaily> {
    StoreMap::new(Key::PlayerDaily)
}
pub(crate) fn login_map() -> StoreMap<AccountId, LoginRow> {
    StoreMap::new(Key::LoginRow)
}
pub fn today() -> u32 {
    (env::block_timestamp_ms() / DAY_MS) as u32
}
fn day_count(key: &[u8], day: u32) -> u32 {
    env::storage_read(key).map(|b| {
        let d = u32::from_le_bytes(b[0..4].try_into().unwrap());
        if d == day { u32::from_le_bytes(b[4..8].try_into().unwrap()) } else { 0 }
    }).unwrap_or(0)
}
fn bump_day_count(key: &[u8], day: u32, cap: u32, what: &str) {
    let n = day_count(key, day);
    require!(n < cap, format!("today's {what} budget is used up: try again tomorrow"));
    env::storage_write(key, &[day.to_le_bytes(), (n + 1).to_le_bytes()].concat());
}

impl Contract {
    fn daily_of(&self, a: &AccountId) -> PlayerDaily {
        let mut d = map().get(a).cloned().unwrap_or_default();
        if d.quest_day != today() {
            d.quest_day = today();
            d.progress = [0; 3];
            d.claimed = 0;
        }
        d
    }
    fn save_daily(&mut self, a: &AccountId, d: PlayerDaily) {
        let mut m = map();
        m.insert(a.clone(), d);
        m.flush();
    }
    /// called at settle for a real player whose entry came from their own wallet
    pub(crate) fn record_daily(&mut self, player: &AccountId, placement: u8, bounty_kill: bool) {
        let mut d = self.daily_of(player);
        d.last_paid_ms = env::block_timestamp_ms();
        d.lifetime_paid = d.lifetime_paid.saturating_add(1);
        d.progress[0] += 1;
        if (1..=3).contains(&placement) {
            d.progress[1] += 1;
        }
        if bounty_kill {
            d.progress[2] += 1;
        }
        self.save_daily(player, d);
    }
    /// What the House pays for `base` right now: × m capped at 1.0 (audit #6: a daily reward never exceeds
    /// its base, which stays below the 4-NOX entry), never below the House floor.
    pub(crate) fn daily_amount(&self, base: u128) -> u128 {
        let (m, _, _) = rule(self.econ().ema);
        (base * m.min(10_000) / 10_000).min(self.balance(&self.house).saturating_sub(HOUSE_FLOOR))
    }
    fn house_reward(&mut self, to: &AccountId, amount: u128, memo: &str) {
        let house = self.house.clone();
        self.move_tokens_pub(&house, to, amount, memo);
        let mut e = self.econ();
        self.roll_season(&mut e);
        e.season_rewards += amount;
        self.save_econ(&e);
    }
    /// storage_deposit hook: remember the first registration day of a real account (kept on re-registering)
    pub(crate) fn note_registration(&mut self, a: &AccountId) {
        let mut m = login_map();
        if m.get(a).is_none() {
            m.insert(a.clone(), LoginRow { since_day: today(), claimed_day: 0 });
            m.flush();
        }
    }
    /// What `claim_login` would pay `a` now, or why it pays nothing.
    fn login_quote(&self, a: &AccountId) -> Result<u128, String> {
        let day = today();
        if self.load_player(a).is_none() {
            return Err("sign in with a NEAR account".into());
        }
        if self.is_guest(a) {
            return Err("guests earn no NOX: sign in with a NEAR account".into());
        }
        if self.is_game_wallet_pub(a) {
            return Err("game wallets earn no login reward".into());
        }
        let row = login_map().get(a).cloned().unwrap_or_default();
        if row.claimed_day == day {
            return Err("already claimed today".into());
        }
        if day < row.since_day.saturating_add(LOGIN_MIN_AGE_DAYS) {
            return Err("the login reward starts the day after you register".into());
        }
        if day_count(LOGIN_COUNT_KEY, day) >= LOGIN_DAILY_CAP {
            return Err("today's login rewards are all claimed: come back tomorrow".into());
        }
        let paid = self.daily_amount(LOGIN_REWARD);
        if paid == 0 {
            return Err("the House can't pay rewards right now".into());
        }
        Ok(paid)
    }
    fn reward_for_streak(streak: u32) -> u128 {
        CHECKIN_REWARDS[(streak.max(1) as usize - 1).min(CHECKIN_REWARDS.len() - 1)]
    }
}

#[near]
impl Contract {
    /// Once per UTC day: pays the streak reward (× m) from the House. Real accounts with a match paid from
    /// their own wallet in the last 48 h.
    pub fn check_in(&mut self) -> U128 {
        let me = env::predecessor_account_id();
        self.require_shareholder(&me); // registered, not a guest, not a game wallet
        let mut d = self.daily_of(&me);
        let day = today();
        require!(d.checkin_day != day || d.streak == 0, "already checked in today");
        // one wallet-paid match TODAY per check-in (audit #6: no idle farming), and a few in the account's life
        require!(d.last_paid_ms >= day as u64 * DAY_MS, "play a match paid from your own NOX today first");
        require!(d.lifetime_paid >= CHECKIN_MIN_LIFETIME_PAID, "check-in unlocks after 3 matches paid from your own NOX");
        let streak = if d.checkin_day + 1 == day { d.streak + 1 } else { 1 };
        let paid = self.daily_amount(Self::reward_for_streak(streak));
        require!(paid > 0, "the House can't pay rewards right now: try again later");
        bump_day_count(CHECKIN_COUNT_KEY, day, CHECKIN_DAILY_CAP, "check-in");
        d.streak = streak;
        d.checkin_day = day;
        self.save_daily(&me, d);
        self.house_reward(&me, paid, "daily check-in");
        event("check_in", &near_sdk::serde_json::json!({ "player": me, "streak": streak, "paid": U128(paid) }));
        U128(paid)
    }

    /// Claim a finished daily quest (0..=2) once per UTC day; paid by the House (× m).
    pub fn claim_quest(&mut self, quest: u8) -> U128 {
        let me = env::predecessor_account_id();
        self.require_shareholder(&me);
        let (_, goal, reward) = *QUESTS.get(quest as usize).unwrap_or_else(|| env::panic_str("no such quest"));
        let mut d = self.daily_of(&me);
        require!(d.claimed & (1 << quest) == 0, "already claimed today");
        require!(d.progress[quest as usize] >= goal, "quest not finished yet");
        let paid = self.daily_amount(reward);
        require!(paid > 0, "the House can't pay rewards right now: try again later");
        bump_day_count(QUEST_COUNT_KEY, today(), QUEST_DAILY_CAP, "quest");
        d.claimed |= 1 << quest;
        self.save_daily(&me, d);
        self.house_reward(&me, paid, "daily quest");
        event("quest", &near_sdk::serde_json::json!({ "player": me, "quest": quest, "paid": U128(paid) }));
        U128(paid)
    }

    /// Daily login reward: call once when a signed-in real account enters the game. Pays LOGIN_REWARD × min(m, 1)
    /// from the House (never minted, never below its floor), once per account per UTC day, at most
    /// LOGIN_DAILY_CAP claims a day in total. Returns 0 and changes nothing when there is nothing to pay
    /// (guest, game wallet, already claimed, too new, cap reached, House at its floor): the reason is logged.
    pub fn claim_login(&mut self) -> U128 {
        let me = env::predecessor_account_id();
        let paid = match self.login_quote(&me) {
            Ok(p) => p,
            Err(why) => {
                env::log_str(&format!("no login reward: {why}"));
                return U128(0);
            }
        };
        let day = today();
        bump_day_count(LOGIN_COUNT_KEY, day, LOGIN_DAILY_CAP, "login reward");
        let mut m = login_map();
        let mut row = m.get(&me).cloned().unwrap_or_default();
        row.claimed_day = day;
        m.insert(me.clone(), row);
        m.flush();
        self.house_reward(&me, paid, "daily login");
        event("login_reward", &near_sdk::serde_json::json!({ "player": me, "paid": U128(paid), "today": day_count(LOGIN_COUNT_KEY, day) }));
        U128(paid)
    }

    pub fn get_login(&self, account_id: AccountId) -> LoginView {
        let day = today();
        let q = self.login_quote(&account_id);
        LoginView {
            day,
            claimed_today: login_map().get(&account_id).is_some_and(|r| r.claimed_day == day),
            can_claim: q.is_ok(),
            reward: U128(q.as_ref().copied().unwrap_or(0)),
            why_not: q.err(),
            claims_today: day_count(LOGIN_COUNT_KEY, day),
            daily_cap: LOGIN_DAILY_CAP,
        }
    }

    pub fn get_daily(&self, account_id: AccountId) -> DailyView {
        let d = self.daily_of(&account_id);
        let day = today();
        let checked = d.checkin_day == day && d.streak > 0;
        let next_streak = if checked { d.streak } else if d.checkin_day + 1 == day { d.streak + 1 } else { 1 };
        let why_not = if checked {
            Some("already checked in today".to_string())
        } else if self.load_player(&account_id).is_none() || self.is_guest(&account_id) {
            Some("sign in with a NEAR account".to_string())
        } else if d.lifetime_paid < CHECKIN_MIN_LIFETIME_PAID {
            Some(format!("unlocks after {CHECKIN_MIN_LIFETIME_PAID} matches paid from your own NOX ({}/{CHECKIN_MIN_LIFETIME_PAID})", d.lifetime_paid))
        } else if d.last_paid_ms < day as u64 * DAY_MS {
            Some("play a match paid from your own NOX today first".to_string())
        } else if self.daily_amount(Self::reward_for_streak(next_streak)) == 0 {
            Some("the House can't pay rewards right now".to_string())
        } else if day_count(CHECKIN_COUNT_KEY, day) >= CHECKIN_DAILY_CAP {
            Some("today's check-in budget is used up".to_string())
        } else {
            None
        };
        DailyView {
            day,
            streak: d.streak,
            checked_in_today: checked,
            can_check_in: why_not.is_none(),
            why_not,
            next_reward: U128(self.daily_amount(Self::reward_for_streak(next_streak))),
            quests: QUESTS
                .iter()
                .enumerate()
                .map(|(i, (t, goal, r))| QuestView {
                    id: i as u8,
                    title: t.to_string(),
                    progress: d.progress[i].min(*goal),
                    goal: *goal,
                    done: d.progress[i] >= *goal,
                    claimed: d.claimed & (1 << i) != 0,
                    reward: U128(self.daily_amount(*r)),
                })
                .collect(),
        }
    }
}

/// rookie protection (docs/DECISIONS.md row 9): a rookie's first matches
pub const ROOKIE_PROTECTED_MATCHES: u32 = 10;
pub fn is_protected_rookie(generation: u32, matches: u32) -> bool {
    generation > 0 && matches < ROOKIE_PROTECTED_MATCHES
}
