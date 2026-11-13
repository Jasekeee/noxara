use super::*;
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const ME: &str = "royale.test";
const SERVER: &str = "server.test";
const RELAY: &str = "relay.test";
const GUEST: &str = "g-ab12.relay.test";
const ALICE: &str = "alice.test";
const BOB: &str = "bob.test";

fn m_now(c: &Contract) -> u128 {
    c.get_economy().m_bps as u128
}

/// entry a genesis bot pays on its first match (progressive fee)
fn e0() -> u128 {
    entry_fee_for(STARTER)
}

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

thread_local! {
    /// the contract's account id for `ctx` (the worst-case log tests use a 50-char one)
    static CUR: std::cell::RefCell<String> = std::cell::RefCell::new(ME.to_string());
}

fn ctx(pred: &str, height: u64, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(&CUR.with(|c| c.borrow().clone())))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .block_height(height)
        .attached_deposit(deposit)
        .account_balance(NearToken::from_near(50))
        .random_seed([(height % 251) as u8 + 1; 32]);
    testing_env!(b.build());
}

fn setup() -> Contract {
    ctx(ME, 100, NearToken::from_yoctonear(0));
    let mut c = Contract::new(acc("owner.test"), acc(SERVER), acc(RELAY), Some(acc("operator.test")), None);
    for who in [GUEST, ALICE] {
        ctx(RELAY, 101, STORAGE_DEPOSIT);
        c.storage_deposit(Some(acc(who)), None);
    }
    // most tests want Alice without credit (the welcome tests use fresh accounts)
    assert_eq!(c.welcome_credit(&acc(ALICE)), WELCOME_STAKE, "registering via the relayer brings the welcome credit");
    assert_eq!(c.balance(&acc(ALICE)), 0, "credit, not $BOUNTY");
    c.set_welcome_credit(&acc(ALICE), 0);
    c
}

/// start + resolve (the self-call) for `who`; returns the match id.
fn start(c: &mut Contract, who: &str, h: u64) -> MatchStart {
    // most tests start many matches quickly: lift the guests' one-free-match-a-minute cooldown here
    // (tested on its own in free_matches_have_a_cooldown_and_are_for_guests_only)
    let mut last = near_sdk::store::LookupMap::<AccountId, u64>::new(Key::LastFreeStart);
    last.remove(&acc(who));
    last.flush();
    ctx(who, h, NearToken::from_yoctonear(0));
    let _ = c.start_match();
    let id = c.next_match_id - 1;
    ctx(ME, h + 1, NearToken::from_yoctonear(0));
    c.resolve_start(U64(id))
}

/// placements with `winner` first, everyone else in idx order.
fn places(winner: usize) -> Vec<u8> {
    let mut v = vec![0u8; FIGHTERS];
    v[winner] = 1;
    let mut next = 2;
    for (i, p) in v.iter_mut().enumerate() {
        if i != winner {
            *p = next;
            next += 1;
        }
    }
    v
}

fn settle(c: &mut Contract, id: U64, winner: usize, bounty_killer: Option<u8>, h: u64) -> MatchResult {
    ctx(SERVER, h, NearToken::from_yoctonear(0));
    let mut kills = vec![0u8; FIGHTERS];
    kills[winner] = 3;
    c.settle_match(id, places(winner), kills, bounty_killer, "ab".repeat(32), Some("deadbeef".into()))
}

fn bal(c: &Contract, a: &str) -> u128 {
    c.ft_balance_of(acc(a)).0
}

fn slot_acc(c: &Contract, slot: usize) -> String {
    c.slots[slot].to_string()
}

/// Every token is accounted for: sum of all known balances == total supply == minted - burned.
fn assert_supply(c: &Contract) {
    assert_supply_seen(c, &mut std::collections::BTreeSet::new());
}

/// `seen` accumulates every bot ever in a slot (retired bots keep their dust).
fn assert_supply_seen(c: &Contract, seen: &mut std::collections::BTreeSet<AccountId>) {
    let mut sum = bal(c, ME) + c.balance(&c.house) + bal(c, GUEST) + bal(c, ALICE) + bal(c, BOB) + c.balance(&c.dividends_account());
    seen.extend(c.slots.iter().cloned());
    seen.extend(c.get_retired().into_iter().map(|f| f.fighter.account));
    for a in seen.iter() {
        sum += c.balance(a);
    }
    assert_eq!(sum, c.token.total_supply, "sum of balances");
    assert_eq!(c.total_minted - c.total_burned, c.token.total_supply, "minted - burned");
}

#[test]
fn genesis() {
    let c = setup();
    let fs = c.get_fighters();
    assert_eq!(fs.len(), BOTS);
    assert!(fs.iter().all(|f| f.balance.0 == STARTER && f.status == "active" && f.fighter.generation == 0));
    assert_eq!(fs[0].fighter.account.as_str(), "brindle.royale.test");
    assert_eq!(fs[0].fighter.upgrades.skin, 1, "skins match t1Roster");
    assert_eq!(c.balance(&c.house), HOUSE_GENESIS);
    assert_eq!(c.token.total_supply, HOUSE_GENESIS + 9 * STARTER);
    assert!(c.is_guest(&acc(GUEST)));
    assert!(!c.is_guest(&acc(ALICE)));
    assert!(!c.is_guest(&acc("x.g-ab.relay.test")));
    assert_supply(&c);
}

#[test]
fn start_escrows_entries_and_fixes_seed_later() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    assert!(s.seed > 0);
    assert_eq!(s.roster.len(), BOTS);
    assert_eq!(s.roster[0].idx, 1);
    assert!(s.guest);
    assert_eq!(s.player_paid.0, 0, "guests pay nothing");
    assert_eq!(bal(&c, ME), 9 * e0());
    assert_eq!(s.pot.0, 9 * e0());
    assert_eq!(e0(), ENTRY_FEE + (STARTER - RESERVE) * ENTRY_WEALTH_BPS / 10_000, "progressive entry");
    // all equal -> the first richest slot carries the bounty
    assert_eq!(s.bounty_idx, Some(1));
    assert!(s.roster[0].bounty && s.roster.iter().filter(|r| r.bounty).count() == 1);
    let m = c.get_match(s.match_id).unwrap();
    assert_eq!(m.seed, s.seed);
    assert_eq!(m.status, MatchStatus::Pending);
    assert_eq!(c.get_player(acc(GUEST)).unwrap().pending, Some(s.match_id));
    assert_supply(&c);
}

#[test]
#[should_panic(expected = "stale")]
fn seed_cannot_be_rerolled() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    ctx(ME, 205, NearToken::from_yoctonear(0));
    c.resolve_start(s.match_id);
}

#[test]
#[should_panic(expected = "register first")]
fn unregistered_players_cannot_start() {
    let mut c = setup();
    ctx("bob.test", 200, NearToken::from_yoctonear(0));
    let _ = c.start_match();
}

#[test]
#[should_panic(expected = "only the match server")]
fn only_the_server_settles() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    ctx(GUEST, 210, NearToken::from_yoctonear(0));
    c.settle_match(s.match_id, places(0), vec![0; FIGHTERS], None, "h".into(), None);
}

#[test]
#[should_panic(expected = "duplicate placement")]
fn bad_placements_rejected() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    ctx(SERVER, 210, NearToken::from_yoctonear(0));
    c.settle_match(s.match_id, vec![1, 1, 2, 3, 4, 5, 6, 7, 8, 9], vec![0; FIGHTERS], None, "h".into(), None);
}

#[test]
fn guest_win_goes_to_the_house() {
    let mut c = setup();
    let house0 = c.balance(&c.house);
    let s = start(&mut c, GUEST, 200);
    let r = settle(&mut c, s.match_id, 0, None, 210);
    assert_eq!(r.winner, Some(0));
    assert_eq!(r.prize_to, c.house);
    assert_eq!(bal(&c, GUEST), 0, "guests earn zero");
    // economy v2: entries + the House's top-up == entry burn + pot burn + house cut + prize; nothing minted
    // (the deflation brake sends the unburnt part of each burn to the House: supply is just below genesis)
    let top_up = econ::BASE_TOP_UP * m_now(&c) / 10_000;
    let total = 9 * e0() + top_up;
    let accounted = r.prize.0 + r.burned.0 + r.house_cut.0;
    assert!(accounted <= total && total - accounted < total / 100, "{accounted} vs {total}");
    assert_eq!(r.minted.0, 0);
    assert_eq!(c.balance(&c.house), house0 - top_up + r.house_cut.0 + r.prize.0 + (total - accounted));
    let p = c.get_player(acc(GUEST)).unwrap();
    assert_eq!((p.matches, p.wins, p.kills, p.earnings.0, p.pending), (1, 1, 3, 0, None));
    assert_eq!(c.get_leaderboard().players[0].account.as_str(), GUEST, "guests still get leaderboards");
    assert_eq!(bal(&c, ME), 0, "escrow emptied");
    assert_eq!(c.get_match(s.match_id).unwrap().status, MatchStatus::Settled);
    assert_supply(&c);
}

#[test]
fn bot_win_pays_the_bot_wallet() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    let r = settle(&mut c, s.match_id, 4, None, 210);
    let winner = slot_acc(&c, 3);
    assert_eq!(r.prize_to.as_str(), winner);
    // upkeep on the windfall, then the winner buys weapon tier 1 (half burned, half to the House)
    let w = STARTER - e0() + r.prize.0;
    assert_eq!(bal(&c, &winner), w - econ::upkeep(w) - WEAPON_PRICES[0]);
    let f = c.get_fighter(acc(&winner)).unwrap();
    assert_eq!(f.fighter.upgrades.weapon_tier, 1);
    assert_eq!((f.fighter.record.wins, f.fighter.record.kills, f.fighter.record.matches), (1, 3, 1));
    assert_eq!(f.fighter.record.earnings, r.prize);
    let loser = c.get_fighter(c.slots[0].clone()).unwrap();
    assert_eq!((loser.fighter.record.deaths, loser.fighter.record.matches), (1, 1));
    assert_eq!(c.get_recent_matches(None).len(), 1);
    assert_supply(&c);
}

#[test]
fn real_player_pays_entry_and_wins_the_pot() {
    let mut c = setup();
    // alice gets some $BOUNTY from a bot win first: give her tokens via the house (test only)
    let house = c.house.clone();
    c.move_tokens(&house, &acc(ALICE), 50 * ONE, "test");
    let s = start(&mut c, ALICE, 200);
    assert_eq!(s.player_paid.0, ENTRY_FEE);
    assert!(!s.guest);
    let r = settle(&mut c, s.match_id, 0, None, 210);
    assert_eq!(r.prize_to.as_str(), ALICE);
    assert_eq!(bal(&c, ALICE), 50 * ONE - ENTRY_FEE + r.prize.0);
    assert_eq!(c.get_player(acc(ALICE)).unwrap().earnings, r.prize);
    assert_supply(&c);
}

#[test]
fn a_real_account_without_funds_cannot_take_a_free_slot() {
    // audit #3: free matches are for the relayer's guests only (24 throwaway accounts can't lock them)
    let mut c = setup();
    ctx(ALICE, 200, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.start_match(); })).is_err());
    assert!(c.pending_free.is_empty());
}

#[test]
fn bounty_is_paid_to_the_killer() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    let carrier = slot_acc(&c, 0); // idx 1
    let killer = slot_acc(&c, 1); // idx 2
    let before = bal(&c, &carrier);
    let r = settle(&mut c, s.match_id, 5, Some(2), 210);
    let taken = before * BOUNTY_BPS / 10_000;
    let bonus = econ::BOUNTY_BONUS * m_now(&c) / 10_000;
    assert_eq!(r.bounty_amount.0, taken + bonus, "the carrier's 15% + the House rule's bonus");
    assert_eq!(r.bounty_to.as_ref().map(|a| a.as_str()), Some(killer.as_str()));
    assert_eq!(bal(&c, &carrier), before - taken);
    // the killer may immediately spend its windfall on its first upgrade
    let k = STARTER - e0() + r.bounty_amount.0;
    let k = if k >= WEAPON_PRICES[0] + RESERVE { k - WEAPON_PRICES[0] } else { k };
    assert_eq!(bal(&c, &killer), k);
    assert_eq!(c.get_fighter(acc(&killer)).unwrap().fighter.record.earnings, r.bounty_amount);
    assert_supply(&c);
}

#[test]
fn guest_bounty_kill_feeds_the_house_not_the_guest() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    let house0 = c.balance(&c.house);
    let carrier0 = bal(&c, &slot_acc(&c, 0));
    let r = settle(&mut c, s.match_id, 5, Some(0), 210);
    assert!(r.bounty_amount.0 > 0);
    assert_eq!(r.bounty_to.as_ref(), Some(&c.house));
    assert_eq!(bal(&c, GUEST), 0);
    // no House bonus for a guest's kill; + half the winner's upkeep and half its first upgrade
    let w = STARTER - e0() + r.prize.0;
    let up = econ::upkeep(w);
    let upkeep_house = up * econ::UPKEEP_HOUSE_BPS / 10_000;
    let bought = w - up >= WEAPON_PRICES[0] + RESERVE;
    let upgrade_house = if bought { WEAPON_PRICES[0] - WEAPON_PRICES[0] * econ::UPGRADE_BURN_BPS / 10_000 } else { 0 };
    assert_eq!(r.bounty_amount.0, carrier0 * BOUNTY_BPS / 10_000, "a guest's kill: the carrier's 15% only");
    let floor = house0 - econ::BASE_TOP_UP * m_now(&c) / 10_000 + r.house_cut.0 + r.bounty_amount.0 + upkeep_house + upgrade_house;
    let h = c.balance(&c.house);
    assert!(h >= floor && h - floor < ONE, "house {h} vs {floor} (+ the brake's unburnt parts)");
    assert_supply(&c);
}

#[test]
fn no_bounty_if_the_carrier_won() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    let r = settle(&mut c, s.match_id, 1, Some(2), 210);
    assert_eq!(r.bounty_amount.0, 0);
    assert!(r.bounty_to.is_none());
}

#[test]
fn winners_buy_upgrades_in_order() {
    let mut c = setup();
    let ox = slot_acc(&c, 1); // idx 2
    let mut h = 200;
    let mut tiers = vec![];
    for _ in 0..6 {
        let s = start(&mut c, GUEST, h);
        settle(&mut c, s.match_id, 2, None, h + 5);
        h += 10;
        let f = c.get_fighter(acc(&ox)).unwrap();
        tiers.push((f.fighter.upgrades.weapon_tier, f.fighter.upgrades.armor));
        assert!(f.balance.0 >= RESERVE);
    }
    // 96 + prize ~61 per win: weapon 1 after the first win, weapon 2 then armor as money comes in
    assert_eq!(tiers[0], (1, 0), "{tiers:?}");
    assert!(tiers.last().unwrap().0 == 2 && tiers.last().unwrap().1 >= 1, "{tiers:?}");
    assert!(tiers.windows(2).all(|w| w[1] >= w[0]));
    assert_supply(&c);
}

#[test]
fn broke_bots_retire_and_rookies_take_the_slot() {
    let mut c = setup();
    let pip = slot_acc(&c, 2); // idx 3, never wins
    let mut h = 200;
    let mut retired_at = None;
    for i in 0..40 {
        let s = start(&mut c, GUEST, h);
        settle(&mut c, s.match_id, 5, None, h + 5);
        h += 10;
        if c.slots[2].as_str() != pip {
            retired_at = Some(i);
            break;
        }
    }
    // losses in a row (progressive entries) until the wallet can't pay the base entry
    let (mut b, mut losses) = (STARTER, 0u32);
    while b >= ENTRY_FEE {
        b -= entry_fee_for(b);
        losses += 1;
    }
    assert_eq!(retired_at, Some(losses as usize - 1));
    let old = c.get_fighter(acc(&pip)).unwrap();
    assert_eq!(old.status, "retired");
    assert_eq!(old.fighter.record.matches, losses);
    let rookie = c.get_fighter(c.slots[2].clone()).unwrap();
    assert_eq!(rookie.status, "active");
    assert_eq!(rookie.fighter.generation, 1);
    assert_eq!(rookie.fighter.slot, 2);
    assert_eq!(rookie.balance.0, STARTER, "the house funds the rookie");
    assert!(rookie.fighter.account.as_str().ends_with("-3.royale.test"), "slots 0, 1, 2 retired in order: the third rookie");
    assert!(PERSONALITIES.contains(&rookie.fighter.personality.as_str()));
    assert_eq!(c.get_retired().len(), 8, "everyone but the winner went broke together");
    let mut names: Vec<String> = c.get_fighters().into_iter().map(|f| f.fighter.name).collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), BOTS, "rookies never share a name with an active fighter");
    assert_eq!(c.rookies, 8);
    assert_supply(&c);
}

#[test]
fn abandon_after_seed_forfeits_the_players_entry() {
    // review fix #1: no free option on a seed you didn't like
    let mut c = setup();
    let house = c.house.clone();
    c.move_tokens(&house, &acc(ALICE), 50 * ONE, "test");
    let house0 = c.balance(&c.house);
    let s1 = start(&mut c, ALICE, 200);
    assert_eq!(bal(&c, ALICE), 50 * ONE - ENTRY_FEE);
    let s2 = start(&mut c, ALICE, 210); // abandons s1 after its seed was fixed
    assert!(c.get_match(s1.match_id).is_none());
    assert_eq!(bal(&c, ALICE), 50 * ONE - 2 * ENTRY_FEE, "first entry forfeited, second paid");
    assert_eq!(c.balance(&c.house), house0 + ENTRY_FEE);
    assert_eq!(bal(&c, ME), ENTRY_FEE + 9 * e0(), "only s2 in escrow: bots were refunded for s1");
    let p = c.get_player(acc(ALICE)).unwrap();
    assert_eq!((p.matches, p.deaths, p.pending), (1, 1, Some(s2.match_id)), "the abandoned match counts as a loss");
    assert!(c.get_fighters().iter().all(|f| f.fighter.escrowed.0 == e0()));
    assert_supply(&c);
}

#[test]
fn abandon_before_the_seed_is_fixed_refunds_everything() {
    let mut c = setup();
    let house = c.house.clone();
    c.move_tokens(&house, &acc(ALICE), 50 * ONE, "test");
    ctx(ALICE, 200, NearToken::from_yoctonear(0));
    let _ = c.start_match(); // resolve_start never ran (e.g. the callback failed)
    assert_eq!(bal(&c, ALICE), 50 * ONE - ENTRY_FEE);
    start(&mut c, ALICE, 210);
    assert_eq!(bal(&c, ALICE), 50 * ONE - ENTRY_FEE, "the unseeded entry came back");
    assert_eq!(c.get_player(acc(ALICE)).unwrap().matches, 0);
    assert_supply(&c);
}

#[test]
fn expired_matches_are_swept_by_anyone() {
    let mut c = setup();
    let house = c.house.clone();
    c.move_tokens(&house, &acc(ALICE), 50 * ONE, "test");
    let house0 = c.balance(&c.house);
    let s = start(&mut c, ALICE, 200);
    ctx("anyone.test", 220, NearToken::from_yoctonear(0));
    assert!(!c.sweep_match(s.match_id), "too early");
    ctx("anyone.test", 200 + EXPIRY_BLOCKS + 1, NearToken::from_yoctonear(0));
    assert!(c.sweep_match(s.match_id));
    assert_eq!(bal(&c, ALICE), 50 * ONE - ENTRY_FEE, "seeded: the player's entry is forfeited");
    assert_eq!(c.balance(&c.house), house0 + ENTRY_FEE);
    assert_eq!(bal(&c, ME), 0);
    assert!(c.get_fighters().iter().all(|f| f.balance.0 == STARTER && f.fighter.escrowed.0 == 0));
    assert_eq!(c.get_player(acc(ALICE)).unwrap().pending, None);
    assert!(c.pending_free.is_empty() && c.pending_paid == 0);
    assert_supply(&c);
}

#[test]
fn free_matches_are_capped_and_lazily_swept_but_never_block_paid_play() {
    // review fixes #2 + DoS: free matches have their own capped pool with a short expiry
    let mut c = setup();
    ctx("owner.test", 150, NearToken::from_yoctonear(0));
    c.set_max_free(5);
    for i in 0..5 {
        let who = format!("g-{i:04}.relay.test");
        ctx(RELAY, 150, STORAGE_DEPOSIT);
        c.storage_deposit(Some(acc(&who)), None);
        start(&mut c, &who, 200);
    }
    assert_eq!(c.pending_free.len(), 5);
    ctx(RELAY, 150, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc("g-late.relay.test")), None);
    ctx("g-late.relay.test", 300, NearToken::from_yoctonear(0));
    let full = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.start_match();
    }));
    assert!(full.is_err(), "the free pool is full");
    // a paying player still gets in
    let house = c.house.clone();
    c.move_tokens(&house, &acc(ALICE), 50 * ONE, "test");
    let s = start(&mut c, ALICE, 301);
    assert_eq!(s.player_paid.0, ENTRY_FEE);
    assert_eq!(c.pending_paid, 1);
    // once the oldest free ones expire, the next free start sweeps them itself
    let s = start(&mut c, "g-late.relay.test", 200 + EXPIRY_FREE_BLOCKS + 1);
    assert!(s.seed > 0);
    assert_eq!(c.pending_free.len(), 5, "one expired swept per start (bounded), one added");
    // the paid match (longer expiry) was not swept
    assert_eq!(c.pending_paid, 1);
    assert_supply(&c);
}

#[test]
fn a_bot_short_only_because_of_escrow_blocks_free_matches_not_paid_ones() {
    // audit #2: retirement looks at wallet + escrow; concurrency is capped by the bots' wallets
    let mut c = setup();
    ctx(RELAY, 101, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc("g-2222.relay.test")), None);
    let pip = c.slots[2].clone();
    let house = c.house.clone();
    let left = ENTRY_FEE + ENTRY_FEE / 2;
    c.move_tokens(&pip, &house, STARTER - left, "test");
    let mut f = c.load_fighter(&pip).unwrap();
    f.record.matches = 3;
    c.save_fighter(f);
    let s1 = start(&mut c, GUEST, 200); // Pip pays an entry, keeps half an entry
    assert_eq!(s1.roster[2].paid.0, ENTRY_FEE);
    // a second FREE match would need Pip's escrowed money: refused, Pip is not retired
    ctx("g-2222.relay.test", 205, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.start_match(); })).is_err(), "island busy");
    assert_eq!(c.slots[2], pip);
    // a PAID match goes ahead; Pip plays for what it has
    grant(&mut c, ALICE, 50 * ONE);
    let s2 = start(&mut c, ALICE, 206);
    assert_eq!(s2.roster[2].paid.0, ENTRY_FEE / 2);
    assert_eq!(c.slots[2], pip, "not retired: its bankroll isn't empty");
    // both settle, Pip loses both: wallet + escrow empty -> it retires at settlement
    settle(&mut c, s1.match_id, 4, None, 210);
    assert_eq!(c.slots[2], pip, "s2 still holds its entry");
    settle(&mut c, s2.match_id, 4, None, 220);
    assert_ne!(c.slots[2], pip);
    assert_eq!(c.load_fighter(&pip).unwrap().escrowed.0, 0);
    assert_supply(&c);
}

#[test]
fn house_grant_is_owner_only_capped_and_never_to_guests() {
    let mut c = setup();
    ctx("owner.test", 200, NearToken::from_yoctonear(0));
    c.house_grant(acc(ALICE), U128(50 * ONE));
    assert_eq!(bal(&c, ALICE), 50 * ONE);
    for (who, to, amt) in [("owner.test", GUEST, ONE), ("owner.test", ALICE, MAX_GRANT + 1), (ALICE, ALICE, ONE), ("owner.test", "bob.test", ONE)] {
        ctx(who, 201, NearToken::from_yoctonear(0));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.house_grant(acc(to), U128(amt))));
        assert!(r.is_err(), "{who} -> {to} {amt}");
    }
    assert_supply(&c);
}

#[test]
#[should_panic(expected = "match already settled")]
fn cannot_settle_twice() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    settle(&mut c, s.match_id, 3, None, 210);
    settle(&mut c, s.match_id, 3, None, 211);
}

#[test]
fn recent_matches_are_bounded() {
    let mut c = setup();
    let mut h = 200;
    let mut first = None;
    for i in 0..(RECENT_MATCHES + 3) {
        let s = start(&mut c, GUEST, h);
        first.get_or_insert(s.match_id);
        settle(&mut c, s.match_id, 1 + i % 9, None, h + 5);
        h += 10;
    }
    assert_eq!(c.recent.len(), RECENT_MATCHES);
    assert!(c.get_match(first.unwrap()).is_none(), "pruned");
    assert_eq!(c.get_recent_matches(Some(5)).len(), 5);
    assert_supply(&c);
}

#[test]
fn storage_deposit_covers_a_player_and_a_pending_match() {
    // NEAR charges key + value + 40 bytes per storage record
    let rec = |key: usize, val: usize| key + val + 40;
    let mut c = setup();
    let who = "g-0123456789.relay-account-with-a-long-name.testnet";
    c.guest_parent = acc("relay-account-with-a-long-name.testnet");
    ctx(RELAY, 300, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc(who)), None);
    let s = start(&mut c, who, 301);
    let id_len = 4 + who.len();
    let p = borsh::to_vec(&VPlayer::V2(c.get_player(acc(who)).unwrap())).unwrap().len();
    let m = borsh::to_vec(&VMatch::V2(c.get_match(s.match_id).unwrap())).unwrap().len();
    // + what a real player can add on top: XP, and 3 sponsorships (one pool entry each + their list)
    let bot_id = 4 + "yarrow-1234.royale.br-7e8492.testnet".len();
    let entry = borsh::to_vec(&crate::SponsorEntry { sponsor: acc(who), shares: U128(u128::MAX), staked: U128(u128::MAX), earned: U128(u128::MAX), since_matches: 0 }).unwrap().len();
    // + the welcome record (a set entry) and the welcome credit (u128)
    let extra = rec(1 + id_len, 8) + 3 * entry + rec(1 + id_len, 4 + 3 * bot_id) + rec(1 + id_len, 0) + rec(1 + id_len, 16);
    let used = rec(1 + id_len, p) + rec(1 + 8, m) + rec(1 + id_len, 16) + extra;
    let cost = env::storage_byte_cost().as_yoctonear() * used as u128;
    println!("player {p} B + pending match {m} B + ft account + xp + 3 sponsorships ({extra} B): {used} bytes = {cost} yocto (deposit {})", STORAGE_DEPOSIT.as_yoctonear());
    assert!(cost < STORAGE_DEPOSIT.as_yoctonear(), "{used} bytes");
}

#[test]
fn storage_bounds_and_double_registration() {
    let mut c = setup();
    assert_eq!(c.storage_balance_bounds().min, STORAGE_DEPOSIT, "what a self-registering account pays");
    assert_eq!(c.storage_balance_bounds().max, Some(STORAGE_DEPOSIT));
    assert!(c.storage_balance_of(acc(GUEST)).is_some());
    assert!(c.storage_balance_of(acc("nobody.test")).is_none());
    ctx(RELAY, 300, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc(GUEST)), None); // refunded, no change
    assert_eq!(c.get_player(acc(GUEST)).unwrap().storage_paid.0, GUEST_STORAGE_DEPOSIT.as_yoctonear(), "guests pay the measured size");
    assert_eq!(c.get_player(acc(ALICE)).unwrap().storage_paid.0, STORAGE_DEPOSIT.as_yoctonear());
    // a real account can't register with the guest amount
    ctx(RELAY, 301, GUEST_STORAGE_DEPOSIT);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.storage_deposit(Some(acc("real.test")), None))).is_err());
}

#[test]
#[should_panic(expected = "attach the storage deposit")]
fn storage_deposit_too_small() {
    let mut c = setup();
    ctx(RELAY, 300, NearToken::from_millinear(1));
    c.storage_deposit(Some(acc("bob.test")), None);
}

#[test]
fn long_run_economy_keeps_supply_consistent() {
    let mut c = setup();
    let mut seen = std::collections::BTreeSet::new();
    let mut h = 200;
    for i in 0..120u64 {
        let who = GUEST;
        let s = start(&mut c, who, h);
        let x = (s.seed as u64 ^ i) as usize;
        let winner = x % FIGHTERS;
        let killer = if x % 4 == 0 { None } else { Some(((x / 7) % FIGHTERS) as u8) };
        assert_supply_seen(&c, &mut seen);
        settle(&mut c, s.match_id, winner, killer, h + 5);
        h += 10;
        assert_supply_seen(&c, &mut seen);
    }
    let cfg = c.get_config();
    println!(
        "after 120 matches: supply {} minted {} burned {} house {} rookies {}",
        cfg.total_supply.0 / ONE,
        cfg.total_minted.0 / ONE,
        cfg.total_burned.0 / ONE,
        cfg.house_balance.0 / ONE,
        cfg.rookies
    );
    assert!(c.get_fighters().iter().all(|f| f.status == "active"));
}

#[test]
fn v2_nothing_is_minted_even_below_the_floor() {
    let mut c = setup();
    let minted0 = c.total_minted;
    let s = start(&mut c, GUEST, 200);
    let r = settle(&mut c, s.match_id, 4, None, 210);
    assert_eq!(r.minted.0, 0, "a healthy House pays the top-up");
    // drain the House to its floor (test only): the top-up is simply 0, never minted
    let house = c.house.clone();
    let drain = c.balance(&house) - HOUSE_FLOOR;
    c.move_tokens(&house, &acc(ALICE), drain, "test");
    let supply1 = c.token.total_supply;
    let s = start(&mut c, GUEST, 220);
    let r = settle(&mut c, s.match_id, 4, None, 230);
    assert_eq!(r.minted.0, 0);
    assert_eq!(c.total_minted, minted0, "economy v2: no minting after genesis");
    assert!(c.token.total_supply <= supply1, "supply never grows");
    assert!(c.balance(&house) >= HOUSE_FLOOR, "the House never pays below its floor");
    assert_supply(&c);
}

// ---------------------------------------------------------------- T3: sponsorship, progression, history

fn grant(c: &mut Contract, who: &str, amount: u128) {
    let house = c.house.clone();
    c.move_tokens(&house, &acc(who), amount, "test");
}

fn sponsor(c: &mut Contract, who: &str, bot: &AccountId, amount: u128, h: u64) -> crate::SponsorshipView {
    ctx(who, h, NearToken::from_yoctonear(0));
    c.sponsor(bot.clone(), U128(amount))
}

/// sponsors' value + the bot's own part == bankroll (nothing created or lost by the share math)
fn assert_pool_consistent(c: &Contract, bot: &AccountId) {
    if let Some(pool) = c.sponsors.get(bot) {
        let s: u128 = pool.entries.iter().map(|e| e.shares.0).sum();
        assert!(s <= pool.total_shares.0);
    }
}

#[test]
fn a_sponsor_profits_from_a_winning_bot() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let camper = c.slots[1].clone(); // idx 2
    let v = sponsor(&mut c, ALICE, &camper, 20 * ONE, 150);
    assert_eq!(v.staked.0, 20 * ONE);
    assert_eq!(bal(&c, ALICE), 80 * ONE);
    assert_eq!(c.balance(&camper), STARTER + 20 * ONE, "the stake funds the bot's bankroll");
    assert_eq!(c.get_market()[1].sponsors, 1);
    let mut h = 200;
    let mut earned_seen = 0;
    for i in 0..6 {
        let s = start(&mut c, GUEST, h);
        let r = settle(&mut c, s.match_id, if i % 2 == 0 { 2 } else { 5 }, None, h + 5);
        h += 10;
        if r.winner == Some(2) {
            let now = c.get_sponsorships(acc(ALICE))[0].earned.0;
            assert!(now > earned_seen, "a win pays a dividend");
            earned_seen = now;
        }
        assert_pool_consistent(&c, &camper);
        assert_supply(&c);
    }
    let v = &c.get_sponsorships(acc(ALICE))[0];
    assert_eq!(v.cooldown_left, 0);
    // cash received so far + what the stake is worth now beats the stake
    assert!(v.earned.0 + v.value.0 > v.staked.0, "{} + {} > {}", v.earned.0, v.value.0, v.staked.0);
    let before = bal(&c, ALICE);
    ctx(ALICE, h, NearToken::from_yoctonear(0));
    let back = c.unsponsor(camper.clone());
    assert_eq!(bal(&c, ALICE), before + back.0);
    assert!(bal(&c, ALICE) > 100 * ONE, "the sponsor ended up with more than they started with");
    assert!(c.get_sponsorships(acc(ALICE)).is_empty());
    assert!(c.get_history(camper.clone()).iter().any(|e| e.kind == "dividend"));
    assert_supply(&c);
}

#[test]
fn audit3_a_small_stake_earns_a_proportional_cut() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let camper = c.slots[1].clone(); // idx 2
    sponsor(&mut c, ALICE, &camper, 10 * ONE, 150); // MIN_STAKE: ~9% of a 110 bankroll
    let pool = c.sponsors.get(&camper).cloned().unwrap();
    let s: u128 = pool.entries.iter().map(|e| e.shares.0).sum();
    let mut h = 200;
    for _ in 0..12 {
        let before = c.get_sponsorships(acc(ALICE))[0].earned.0;
        let st = start(&mut c, GUEST, h);
        let r = settle(&mut c, st.match_id, 2, None, h + 5);
        h += 10;
        if r.winner != Some(2) { continue; }
        let got = c.get_sponsorships(acc(ALICE))[0].earned.0 - before;
        assert_eq!(r.prize_to, camper);
        let prize = r.prize.0; // the dividend base is at most the prize (free matches: entries share only)
        let full = prize * crate::market::SPONSOR_CUT_BPS / 10_000;
        let t = c.sponsors.get(&camper).unwrap().total_shares.0;
        let fair = full * s * 10_000 / (t * crate::market::SPONSOR_MAX_BPS);
        assert!(got <= fair + 1, "cut scales with ownership: got {got}, fair {fair}, full {full}");
        assert!(got < full, "a minority stake never collects the whole 10%");
        assert_supply(&c);
        return;
    }
    panic!("the camper never won in 12 matches");
}

#[test]
fn a_sponsor_loses_when_the_bot_retires_broke() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let coward = c.slots[4].clone(); // idx 5, never wins here
    sponsor(&mut c, ALICE, &coward, 30 * ONE, 150);
    let mut h = 200;
    for _ in 0..60 {
        let s = start(&mut c, GUEST, h);
        settle(&mut c, s.match_id, 2, None, h + 5);
        h += 10;
        if c.slots[4] != coward {
            break;
        }
    }
    assert_ne!(c.slots[4], coward, "the coward went broke");
    assert!(!c.get_sponsorships(acc(ALICE)).is_empty(), "open until close_retired");
    ctx("anyone.test", h, NearToken::from_yoctonear(0));
    c.close_retired(coward.clone());
    assert!(c.get_sponsorships(acc(ALICE)).is_empty(), "the pool closed");
    assert!(c.sponsors.get(&coward).is_none());
    assert!(bal(&c, ALICE) < 100 * ONE, "the stake is gone: {}", bal(&c, ALICE));
    assert!(c.get_history(coward.clone()).iter().any(|e| e.kind == "retired"));
    assert_supply(&c);
}

#[test]
fn sponsorship_rules() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let bot = c.slots[0].clone();
    let fails = |c: &mut Contract, who: &str, bot: &AccountId, amount: u128| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sponsor(c, who, bot, amount, 150))).is_err()
    };
    assert!(fails(&mut c, GUEST, &bot, 10 * ONE), "guests can't sponsor");
    assert!(fails(&mut c, ALICE, &bot, ONE), "minimum stake");
    assert!(fails(&mut c, ALICE, &bot, 50 * ONE), "30% cap: 50 into a 100 bankroll would be 33%");
    assert_eq!(c.get_market()[0].capacity.0 / ONE, 42, "cap room = 100 * 0.3 / 0.7");
    assert!(fails(&mut c, ALICE, &acc("nobody.royale.test"), 10 * ONE), "only active fighters");
    sponsor(&mut c, ALICE, &bot, 40 * ONE, 150);
    // cooldown
    ctx(ALICE, 160, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.unsponsor(bot.clone()))).is_err(), "cooldown");
    // at most 3 bots per player
    let (b1, b2, b3) = (c.slots[1].clone(), c.slots[2].clone(), c.slots[3].clone());
    sponsor(&mut c, ALICE, &b1, 10 * ONE, 150);
    sponsor(&mut c, ALICE, &b2, 10 * ONE, 150);
    assert!(fails(&mut c, ALICE, &b3, 10 * ONE), "max 3 bots");
    assert_eq!(c.get_sponsorships(acc(ALICE)).len(), 3);
    assert_supply(&c);
}

#[test]
fn xp_progression_and_level_upgrades_in_the_roster() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    assert_eq!((s.player_level, s.player_upgrades.clone()), (1, Upgrades::default()));
    // guest wins with 3 kills: 100 + 45
    settle(&mut c, s.match_id, 0, None, 210);
    let p = c.get_progress(acc(GUEST));
    assert_eq!((p.xp, p.level, p.next_level_xp), (145, 2, Some(200)));
    // level 2 -> skin 10, still base weapon
    let s = start(&mut c, GUEST, 220);
    assert_eq!(s.player_level, 2);
    assert_eq!(s.player_upgrades, Upgrades { weapon_tier: 0, armor: 0, skin: 10 });
    assert_eq!(c.get_match(s.match_id).unwrap().player_upgrades.skin, 10);
    // a high-level player brings weapon tier 2 + armor 1 (never above the best bot)
    c.xp.insert(acc(ALICE), 2_000);
    grant(&mut c, ALICE, 10 * ONE);
    let s = start(&mut c, ALICE, 230);
    assert_eq!((s.player_level, s.player_upgrades.clone()), (10, Upgrades { weapon_tier: 2, armor: 1, skin: 14 }));
}

#[test]
fn history_is_a_bounded_ring() {
    let mut c = setup();
    let ox = c.slots[1].clone();
    let mut h = 200;
    for _ in 0..30 {
        let s = start(&mut c, GUEST, h);
        settle(&mut c, s.match_id, 2, None, h + 5);
        h += 10;
    }
    let hist = c.get_history(ox.clone());
    assert_eq!(hist.len(), crate::market::HISTORY_LEN);
    assert!(hist[0].match_id.0 >= hist[hist.len() - 1].match_id.0, "newest first");
    assert!(hist.iter().any(|e| e.kind == "win" && e.detail.starts_with("1:")));
    let all_upgrades = c.history.get(&ox).unwrap().iter().filter(|e| e.kind == "upgrade").count();
    let _ = all_upgrades;
    let top = c.get_top("bots".into(), "wins".into(), Some(3));
    assert_eq!(top[0].account, ox);
    let players = c.get_top("players".into(), "earnings".into(), None);
    assert_eq!(players[0].account.as_str(), GUEST);
}

#[test]
fn duplicate_names_are_renamed() {
    let mut c = setup();
    let a = c.slots[2].clone();
    let mut f = c.load_fighter(&a).unwrap();
    f.name = c.slot_fighter(5).name;
    c.save_fighter(f);
    c.dedupe_names();
    let mut names: Vec<String> = c.get_fighters().into_iter().map(|f| f.fighter.name.to_ascii_lowercase()).collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), BOTS);
}

#[test]
fn migrate_from_state_v1() {
    let mut c = setup();
    c.fighters.flush();
    c.players.flush();
    c.matches.flush();
    let fighter0 = c.slots[0].clone();
    let supply = c.token.total_supply;
    let v1 = ContractV1 {
        version: 1,
        owner: c.owner,
        server: c.server,
        guest_parent: c.guest_parent,
        house: c.house,
        token: c.token,
        fighters: c.fighters,
        slots: c.slots,
        retired: c.retired,
        players: c.players,
        matches: c.matches,
        recent: c.recent,
        pending_free: c.pending_free,
        max_free: c.max_free,
        pending_paid: c.pending_paid,
        leaderboard: c.leaderboard,
        next_match_id: c.next_match_id,
        matches_settled: c.matches_settled,
        rookies: c.rookies,
        total_minted: c.total_minted,
        total_burned: c.total_burned,
    };
    env::state_write(&v1);
    ctx(ME, 400, NearToken::from_yoctonear(0));
    let m = Contract::migrate();
    assert_eq!(m.version, STATE_VERSION);
    assert_eq!(m.slots[0], fighter0);
    assert_eq!(m.token.total_supply, supply);
    assert!(m.get_market().iter().all(|e| e.sponsors == 0));
}

// ---------------------------------------------------------------- review fixes (sponsorship)

#[test]
fn unregister_needs_closed_sponsorships_and_cleans_xp() {
    let mut c = setup();
    grant(&mut c, ALICE, 30 * ONE);
    let bot = c.slots[0].clone();
    sponsor(&mut c, ALICE, &bot, 10 * ONE, 150);
    c.xp.insert(acc(ALICE), 500);
    ctx(ALICE, 160, NearToken::from_yoctonear(1));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.storage_unregister(Some(true))));
    assert!(r.is_err(), "open sponsorship blocks unregister");
    // the bot plays its cooldown, alice withdraws, then leaves cleanly
    let mut h = 200;
    for _ in 0..5 {
        let s = start(&mut c, GUEST, h);
        settle(&mut c, s.match_id, 3, None, h + 5);
        h += 10;
    }
    ctx(ALICE, h, NearToken::from_yoctonear(0));
    c.unsponsor(bot);
    ctx(ALICE, h + 1, NearToken::from_yoctonear(1));
    assert!(c.storage_unregister(Some(true)));
    assert!(c.xp.get(&acc(ALICE)).is_none(), "xp removed");
    assert!(c.sponsoring.get(&acc(ALICE)).is_none());
    assert!(c.load_player(&acc(ALICE)).is_none());
}

#[test]
fn no_buying_in_during_a_match_but_withdrawing_is_never_blocked() {
    let mut c = setup();
    grant(&mut c, ALICE, 50 * ONE);
    let bot = c.slots[0].clone();
    let s = start(&mut c, GUEST, 200); // every bot now has an entry in escrow
    ctx(ALICE, 201, NearToken::from_yoctonear(0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.sponsor(bot.clone(), U128(10 * ONE))));
    assert!(r.is_err(), "no buying in on a known outcome");
    settle(&mut c, s.match_id, 3, None, 210);
    sponsor(&mut c, ALICE, &bot, 10 * ONE, 211);
    let mut h = 220;
    for _ in 0..5 {
        let s = start(&mut c, GUEST, h);
        settle(&mut c, s.match_id, 3, None, h + 5);
        h += 10;
    }
    start(&mut c, GUEST, h); // pending again
    let wallet = c.balance(&bot);
    let pool = c.sponsors.get(&bot).unwrap().clone();
    let expect = pool.entries[0].shares.0 * wallet / pool.total_shares.0;
    ctx(ALICE, h + 2, NearToken::from_yoctonear(0));
    let got = c.unsponsor(bot.clone());
    assert_eq!(got.0, expect, "audit #4: valued on the wallet only, never locked by pending matches");
}

#[test]
fn a_retired_bot_is_settled_by_a_separate_bounded_call() {
    // audit #1: pools are never closed inside start/settle; close_retired does it (one event)
    let mut c = setup();
    grant(&mut c, ALICE, 50 * ONE);
    let bot = c.slots[2].clone();
    sponsor(&mut c, ALICE, &bot, 20 * ONE, 150);
    let house = c.house.clone();
    let keep = ENTRY_FEE + ENTRY_FEE / 2;
    let b = c.balance(&bot);
    c.move_tokens(&bot, &house, b - keep, "test");
    let mut f = c.load_fighter(&bot).unwrap();
    f.record.matches = 3;
    c.save_fighter(f);
    let s1 = start(&mut c, GUEST, 200);
    settle(&mut c, s1.match_id, 4, None, 210); // it loses: wallet < entry, nothing in escrow -> retires
    assert_ne!(c.slots[2], bot, "retired at settlement");
    assert!(c.sponsors.get(&bot).is_some(), "the pool is NOT closed inside settle");
    let alice0 = bal(&c, ALICE);
    let house0 = c.balance(&house);
    let wallet = c.balance(&bot);
    // anyone settles it
    ctx("anyone.test", 220, NearToken::from_yoctonear(0));
    let to_house = c.close_retired(bot.clone());
    assert!(c.sponsors.get(&bot).is_none());
    assert!(c.get_sponsorships(acc(ALICE)).is_empty());
    assert_eq!(c.balance(&bot), 0, "nothing stranded in the keyless retired account");
    assert_eq!(bal(&c, ALICE) - alice0 + to_house.0, wallet);
    assert_eq!(c.balance(&house), house0 + to_house.0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.close_retired(c.slots[0].clone()))).is_err(), "active bots can't be closed");
    assert_supply(&c);
}

#[test]
fn a_subsidised_deposit_is_refunded_to_its_payer_not_the_account() {
    // review (HIGH): register via the relayer -> unregister -> the 0.02 NEAR must go back to the relayer
    let mut c = setup();
    ctx(RELAY, 300, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc("bob.test")), None);
    assert_eq!(c.get_player(acc("bob.test")).unwrap().deposit_payer, Some(acc(RELAY)));
    ctx("bob.test", 301, NearToken::from_yoctonear(1));
    assert!(c.storage_unregister(Some(true)), "burns the welcome stake");
    let receipts = near_sdk::test_utils::get_created_receipts();
    let refund = receipts.iter().rev().find(|r| r.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::Transfer { .. }))).expect("a refund");
    assert_eq!(refund.receiver_id, acc(RELAY), "refund goes to the payer");
    // a self-paid registration refunds the account itself
    ctx("carol.test", 302, STORAGE_DEPOSIT);
    c.storage_deposit(None, None);
    assert_eq!(c.get_player(acc("carol.test")).unwrap().deposit_payer, None);
    ctx("carol.test", 303, NearToken::from_yoctonear(1));
    assert!(c.storage_unregister(Some(true)));
    let receipts = near_sdk::test_utils::get_created_receipts();
    let refund = receipts.iter().rev().find(|r| r.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::Transfer { .. }))).unwrap();
    assert_eq!(refund.receiver_id, acc("carol.test"));
}

#[test]
fn a_migrated_v1_non_guest_refunds_the_relayer() {
    // review: V1 records don't know who paid -> fail closed to the relayer
    let mut c = setup();
    let old = PlayerV1 { guest: false, storage_paid: U128(STORAGE_DEPOSIT.as_yoctonear()), ..Default::default() };
    c.players.insert(acc("old.test"), VPlayer::V1(old));
    c.ensure_registered(&acc("old.test"));
    assert_eq!(c.get_player(acc("old.test")).unwrap().deposit_payer, Some(acc(RELAY)));
    ctx("old.test", 300, NearToken::from_yoctonear(1));
    assert!(c.storage_unregister(None));
    let receipts = near_sdk::test_utils::get_created_receipts();
    let refund = receipts.iter().rev().find(|r| r.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::Transfer { .. }))).unwrap();
    assert_eq!(refund.receiver_id, acc(RELAY));
}

// ---------------------------------------------------------------- welcome credit (owner decision)

fn register_as(c: &mut Contract, payer: &str, who: &str, day: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME)).predecessor_account_id(acc(payer)).signer_account_id(acc(payer)).block_height(500).attached_deposit(STORAGE_DEPOSIT).block_timestamp(day * 86_400_000_000_000 + 1);
    testing_env!(b.build());
    c.storage_deposit(Some(acc(who)), None);
}

fn day_count(day: u64) -> u32 {
    env::storage_read(b"welcome_day")
        .map(|v| if u64::from_le_bytes(v[0..8].try_into().unwrap()) == day { u32::from_le_bytes(v[8..12].try_into().unwrap()) } else { 0 })
        .unwrap_or(0)
}

#[test]
fn welcome_credit_once_per_real_account_never_guests() {
    let mut c = setup();
    register_as(&mut c, RELAY, "dave.testnet", 1);
    assert_eq!(c.get_welcome_credit(acc("dave.testnet")).0, WELCOME_STAKE);
    assert_eq!(bal(&c, "dave.testnet"), 0, "a credit, not $BOUNTY");
    register_as(&mut c, "self.testnet", "self.testnet", 1);
    assert_eq!(c.welcome_credit(&acc("self.testnet")), WELCOME_STAKE, "self-registration too");
    register_as(&mut c, RELAY, "g-77.relay.test", 1);
    assert_eq!(c.welcome_credit(&acc("g-77.relay.test")), 0, "never guests");
    ctx("g-77.relay.test", 600, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_welcome())).is_err());
    ctx("dave.testnet", 601, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_welcome())).is_err(), "second claim refused");
}

#[test]
fn the_credit_pays_entries_funded_by_the_house_and_wins_are_real() {
    let mut c = setup();
    register_as(&mut c, RELAY, "dave.testnet", 1);
    let house0 = c.balance(&c.house);
    let s = start(&mut c, "dave.testnet", 600);
    assert_eq!(s.player_paid.0, ENTRY_FEE, "paid -> prize-eligible");
    assert_eq!(c.welcome_credit(&acc("dave.testnet")), WELCOME_STAKE - ENTRY_FEE);
    assert_eq!(c.balance(&c.house), house0 - ENTRY_FEE, "the house funded the entry");
    let r = settle(&mut c, s.match_id, 0, None, 610);
    assert_eq!(r.prize_to.as_str(), "dave.testnet");
    assert_eq!(bal(&c, "dave.testnet"), r.prize.0, "winnings are normal $BOUNTY");
    assert_eq!(c.total_minted - c.total_burned, c.token.total_supply);
}

#[test]
fn the_credit_cannot_be_transferred_or_sponsored_with() {
    let mut c = setup();
    register_as(&mut c, RELAY, "dave.testnet", 1);
    let bot = c.slots[0].clone();
    ctx("dave.testnet", 600, NearToken::from_yoctonear(1));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.ft_transfer(acc(ALICE), U128(ONE), None)));
    assert!(r.is_err(), "nothing to transfer");
    ctx("dave.testnet", 601, NearToken::from_yoctonear(0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.sponsor(bot.clone(), U128(10 * ONE))));
    assert!(r.is_err(), "can't sponsor with credit");
    assert_eq!(c.welcome_credit(&acc("dave.testnet")), WELCOME_STAKE);
}

#[test]
fn an_unseeded_refund_returns_to_the_credit_and_the_house() {
    let mut c = setup();
    register_as(&mut c, RELAY, "dave.testnet", 1);
    let house0 = c.balance(&c.house);
    ctx("dave.testnet", 600, NearToken::from_yoctonear(0));
    let _ = c.start_match(); // seed never fixed
    start(&mut c, "dave.testnet", 610); // abandons the unseeded one
    assert_eq!(bal(&c, "dave.testnet"), 0, "the refund did not become $BOUNTY");
    assert_eq!(c.welcome_credit(&acc("dave.testnet")), WELCOME_STAKE - ENTRY_FEE, "refunded to the credit, then spent once");
    assert_eq!(c.balance(&c.house), house0 - ENTRY_FEE);
}

#[test]
fn below_the_house_floor_the_credit_waits() {
    let mut c = setup();
    register_as(&mut c, RELAY, "dave.testnet", 1);
    let house = c.house.clone();
    let spare = c.balance(&house) - HOUSE_FLOOR;
    c.move_tokens(&house, &acc(GUEST), spare, "test");
    ctx("dave.testnet", 600, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.start_match(); })).is_err(), "no free matches for real accounts");
    assert_eq!(c.welcome_credit(&acc("dave.testnet")), WELCOME_STAKE, "credit untouched, it waits for the house");
}

#[test]
fn third_parties_never_grant_or_touch_the_daily_cap() {
    let mut c = setup();
    for i in 0..100 {
        register_as(&mut c, "mallory.testnet", &format!("victim{i}.testnet"), 1);
    }
    assert_eq!(day_count(1), 0, "the cap is untouched");
    assert_eq!(c.welcome_credit(&acc("victim7.testnet")), 0);
    // the account itself can still claim later
    ctx("victim7.testnet", 600, NearToken::from_yoctonear(0));
    assert_eq!(c.claim_welcome().0, WELCOME_STAKE);
}

#[test]
fn the_daily_cap_and_a_later_self_claim() {
    let mut c = setup();
    for i in 0..WELCOME_DAILY_CAP {
        register_as(&mut c, RELAY, &format!("r{i}.testnet"), 1);
    }
    register_as(&mut c, RELAY, "late.testnet", 1);
    assert_eq!(c.welcome_credit(&acc("late.testnet")), 0, "the day is full");
    // next day: only the account itself can claim
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME)).predecessor_account_id(acc("late.testnet")).block_timestamp(2 * 86_400_000_000_000 + 5);
    testing_env!(b.build());
    assert_eq!(c.claim_welcome().0, WELCOME_STAKE);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.claim_welcome())).is_err(), "once");
}

#[test]
fn unregister_then_register_brings_no_new_credit_and_keeps_the_record_paid() {
    let mut c = setup();
    register_as(&mut c, "erin.testnet", "erin.testnet", 1);
    ctx("erin.testnet", 700, NearToken::from_yoctonear(1));
    assert!(c.storage_unregister(None));
    let receipts = near_sdk::test_utils::get_created_receipts();
    let refund = receipts.iter().rev().find_map(|r| r.actions.iter().find_map(|a| match a {
        near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(*deposit),
        _ => None,
    })).unwrap();
    assert_eq!(refund.as_yoctonear(), STORAGE_DEPOSIT.as_yoctonear() - WELCOME_RECORD_NEAR.as_yoctonear(), "the record's storage stays paid");
    register_as(&mut c, "erin.testnet", "erin.testnet", 2);
    assert_eq!(c.welcome_credit(&acc("erin.testnet")), 0);
    assert!(c.got_welcome(acc("erin.testnet")));
}

#[test]
fn teardown_is_owner_only_time_locked_and_pays_the_fixed_beneficiary() {
    let mut c = setup();
    assert_eq!(c.get_teardown_after().0, TEARDOWN_AFTER_MS);
    assert_eq!(c.get_teardown_beneficiary(), Some(acc("operator.test")));
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME)).predecessor_account_id(acc("owner.test")).block_timestamp((TEARDOWN_AFTER_MS - 1) * 1_000_000);
    testing_env!(b.build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.teardown(); })).is_err(), "locked");
    b.block_timestamp(TEARDOWN_AFTER_MS * 1_000_000).predecessor_account_id(acc(ALICE));
    testing_env!(b.build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.teardown(); })).is_err(), "owner only");
    // the beneficiary is fixed
    b.predecessor_account_id(acc("owner.test"));
    testing_env!(b.build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_teardown_beneficiary(acc("owner.test")))).is_err());
    let _ = c.teardown();
    let r = near_sdk::test_utils::get_created_receipts();
    let del = r.iter().find(|x| x.receiver_id == acc(ME) && x.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::DeleteAccount { .. }))).expect("delete");
    assert!(del.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::DeleteAccount { beneficiary_id, .. } if beneficiary_id == &acc("operator.test"))));
}

#[test]
fn a_griefer_cannot_block_teardown() {
    let mut c = setup();
    let house = c.house.clone();
    c.move_tokens(&house, &acc(ALICE), 50 * ONE, "test");
    let s1 = start(&mut c, GUEST, 200); // free, pending
    let s2 = start(&mut c, ALICE, 201); // paid, pending
    let mut b = VMContextBuilder::new();
    // the season is over: nobody can start another match
    b.current_account_id(acc(ME)).predecessor_account_id(acc(GUEST)).block_timestamp(TEARDOWN_AFTER_MS * 1_000_000);
    testing_env!(b.build());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.start_match(); })).is_err(), "season over");
    // teardown closes what is still in flight, then deletes the account
    b.predecessor_account_id(acc("owner.test"));
    testing_env!(b.build());
    let _ = c.teardown();
    assert!(c.get_match(s1.match_id).is_none() && c.get_match(s2.match_id).is_none());
    assert_eq!(bal(&c, ALICE), 50 * ONE - ENTRY_FEE, "a seeded paid entry is forfeited per the abandon rules");
    assert!(c.get_fighters().iter().all(|f| f.fighter.escrowed.0 == 0), "bots got their entries back");
    let r = near_sdk::test_utils::get_created_receipts();
    assert!(r.iter().any(|x| x.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::DeleteAccount { .. }))));
}

#[test]
fn season_end_exit_works_even_with_a_match_pending() {
    let mut c = setup();
    grant(&mut c, ALICE, 50 * ONE);
    let bot = c.slots[0].clone();
    sponsor(&mut c, ALICE, &bot, 20 * ONE, 150);
    start(&mut c, GUEST, 200); // the bot now has an entry in escrow
    let wallet = c.balance(&bot);
    let pool = c.sponsors.get(&bot).unwrap().clone();
    let expect = pool.entries[0].shares.0 * wallet / pool.total_shares.0;
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME)).predecessor_account_id(acc(ALICE)).attached_deposit(NearToken::from_yoctonear(1)).block_timestamp(SEASON_END_MS * 1_000_000);
    testing_env!(b.build());
    let before = c.total_burned;
    assert!(c.storage_unregister(Some(true)), "never blocked by other people's matches");
    assert_eq!(c.token.total_supply + 0, c.total_minted - c.total_burned);
    assert_eq!(c.total_burned - before, 30 * ONE + expect, "valued on the wallet, then burned on leaving (force)");
}

#[test]
fn at_season_end_players_leave_with_open_sponsorships() {
    let mut c = setup();
    grant(&mut c, ALICE, 50 * ONE);
    let bot = c.slots[0].clone();
    sponsor(&mut c, ALICE, &bot, 20 * ONE, 150);
    // before the season end: refused
    ctx(ALICE, 160, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.storage_unregister(Some(true)))).is_err());
    // from 2026-11-20: the sponsorship is closed at its value and she can leave (deposit back to its payer)
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME)).predecessor_account_id(acc(ALICE)).attached_deposit(NearToken::from_yoctonear(1)).block_timestamp(SEASON_END_MS * 1_000_000);
    testing_env!(b.build());
    assert!(c.is_season_ending());
    assert!(c.storage_unregister(Some(true)));
    assert!(c.sponsors.get(&bot).unwrap().entries.is_empty());
    assert!(c.sponsoring.get(&acc(ALICE)).is_none());
}

#[test]
fn measure_guest_storage() {
    // a guest: player record + FT account + one pending match + XP (no sponsorships, no welcome)
    let rec = |key: usize, val: usize| key + val + 40;
    let mut c = setup();
    let who = "g-0123456789.relay.br-7e8492.testnet"; // 36 chars (mainnet relay.noxara.near guests: 30)
    c.guest_parent = acc("relay.br-7e8492.testnet");
    ctx("relay.br-7e8492.testnet", 300, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc(who)), None);
    let s = start(&mut c, who, 301);
    c.xp.insert(acc(who), 1);
    let id = 4 + who.len();
    let p = borsh::to_vec(&VPlayer::V2(c.get_player(acc(who)).unwrap())).unwrap().len();
    let m = borsh::to_vec(&VMatch::V2(c.get_match(s.match_id).unwrap())).unwrap().len();
    // worst-case roster names: 9 bots like "yarrow-1234.royale.br-7e8492.testnet" (36 chars)
    let roster_now: usize = s.roster.iter().map(|r| r.account.len()).sum();
    let m = m + 9 * 36 - roster_now;
    let bytes = rec(1 + id, p) + rec(1 + id, 16) + rec(1 + 8, m) + rec(1 + id, 8);
    let need = env::storage_byte_cost().as_yoctonear() * (bytes as u128 * 12 / 10);
    println!("GUEST: player {p} B + match {m} B + ft + xp = {bytes} bytes; +20% = {} yocto", need);
    assert!(need <= GUEST_STORAGE_DEPOSIT.as_yoctonear(), "GUEST_STORAGE_DEPOSIT too small: need {need}");
}


// ============================================================ audit PoCs: the exploits no longer work

fn guest_n(c: &mut Contract, i: usize) -> String {
    let g = format!("g-{i:010}.relay.test");
    ctx(RELAY, 150, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc(&g)), None);
    g
}

#[test]
fn audit_concurrent_free_matches_cannot_force_mass_retirement() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    settle(&mut c, s.match_id, 0, None, 205);
    let house0 = c.balance(&c.house);
    // throwaway non-guest accounts can't take free slots at all
    ctx("evil.test", 150, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc("att0.test")), None);
    ctx("att0.test", 300, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.start_match(); })).is_err());
    // 24 relayer guests all starting at once: once a bot's wallet can't fund another entry the island
    // says "busy" instead of retiring anyone
    let mut busy = 0;
    for i in 0..24 {
        let g = guest_n(&mut c, i);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| start(&mut c, &g, 300 + i as u64)));
        if r.is_err() {
            busy += 1;
        }
    }
    println!("24 concurrent guest starts: {busy} refused as busy, rookies {}", c.rookies);
    assert_eq!(c.rookies, 0, "nobody was force-retired");
    // everything expires and is swept: every bot gets its entries back, nothing stranded
    let ids: Vec<u64> = c.pending_free.clone();
    for id in ids {
        ctx("anyone.test", 300 + EXPIRY_FREE_BLOCKS + 50, NearToken::from_yoctonear(0));
        c.sweep_match(U64(id));
    }
    assert!(c.get_fighters().iter().all(|f| f.status == "active" && f.fighter.escrowed.0 == 0));
    assert_eq!(c.balance(&c.house), house0, "the house paid nothing");
    assert_supply(&c);
}

#[test]
fn audit_an_empty_house_does_not_churn_rookies() {
    let mut c = setup();
    let house = c.house.clone();
    let mut h = 200;
    for _ in 0..40 {
        let hb = c.balance(&house);
        c.move_tokens(&house, &acc(ALICE), hb, "keep the house empty");
        let s = start(&mut c, GUEST, h);
        settle(&mut c, s.match_id, 5, None, h + 5);
        h += 10;
    }
    assert_eq!(c.rookies, 0, "no unfunded rookies: broke bots keep their slot until the house can fund one");
    assert!(c.get_fighters().iter().all(|f| f.status == "active"));
}

#[test]
fn audit_a_pending_match_never_blocks_unsponsor() {
    let mut c = setup();
    grant(&mut c, ALICE, 50 * ONE);
    let bot = c.slots[0].clone();
    sponsor(&mut c, ALICE, &bot, 10 * ONE, 150);
    let mut h = 200;
    for _ in 0..5 {
        let s = start(&mut c, GUEST, h);
        settle(&mut c, s.match_id, 3, None, h + 5);
        h += 10;
    }
    let griefer = guest_n(&mut c, 77);
    start(&mut c, &griefer, h); // a match pending at all times
    ctx(ALICE, h + 3, NearToken::from_yoctonear(0));
    let back = c.unsponsor(bot.clone());
    assert!(back.0 > 0, "withdrawn while a match is pending");
}

/// Worst case for the 16 KiB log limit: a 50-char contract id (so 62-char rookie ids), 64-char sponsor
/// names on every bot, and ALL eight losing bots retiring + eight rookies in ONE settlement.
#[test]
fn audit_worst_case_logs_fit_in_16_kib() {
    const LONG: &str = "a-very-long-contract-name-for-the-log-test.testnet"; // 50 chars
    CUR.with(|c| *c.borrow_mut() = LONG.to_string());
    ctx(LONG, 100, NearToken::from_yoctonear(0));
    let mut c = Contract::new(acc("owner.test"), acc(SERVER), acc(RELAY), Some(acc("operator.test")), None);
    ctx(RELAY, 101, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc(GUEST)), None);
    // 3 sponsors with 64-char names on every bot
    for i in 0..27 {
        let who = format!("{:0>59}.test", i);
        ctx(&who, 120, STORAGE_DEPOSIT);
        c.storage_deposit(None, None);
        let house = c.house.clone();
        c.move_tokens(&house, &acc(&who), 10 * ONE, "test");
        let bot = c.slots[i % 9].clone();
        ctx(&who, 121, NearToken::from_yoctonear(0));
        c.sponsor(bot, U128(10 * ONE));
    }
    c.mint(&c.house.clone(), 20_000 * ONE, "test: enough to fund every rookie");
    let mut h = 200;
    let mut worst_settle = 0usize;
    let mut worst_start = 0usize;
    let mut retired_at_once = 0u32;
    for _ in 0..40 {
        let r0 = c.rookies;
        near_sdk::store::LookupMap::<AccountId, u64>::new(Key::LastFreeStart).remove(&acc(GUEST));
        ctx(GUEST, h, NearToken::from_yoctonear(0));
        let _ = c.start_match();
        worst_start = worst_start.max(near_sdk::test_utils::get_logs().iter().map(|l| l.len()).sum());
        let id = c.next_match_id - 1;
        ctx(LONG, h + 1, NearToken::from_yoctonear(0));
        c.resolve_start(U64(id));
        settle(&mut c, U64(id), 5, None, h + 5);
        worst_settle = worst_settle.max(near_sdk::test_utils::get_logs().iter().map(|l| l.len()).sum());
        retired_at_once = retired_at_once.max(c.rookies - r0);
        h += 10;
    }
    // and the separate pool closings, one bot each
    let mut worst_close = 0usize;
    for b in c.get_retired() {
        ctx("anyone.test", h, NearToken::from_yoctonear(0));
        c.close_retired(b.fighter.account.clone());
        worst_close = worst_close.max(near_sdk::test_utils::get_logs().iter().map(|l| l.len()).sum());
    }
    CUR.with(|c| *c.borrow_mut() = ME.to_string());
    println!("worst logs: start {worst_start} B, settle {worst_settle} B ({retired_at_once} retirements in one settle), close_retired {worst_close} B (limit 16384)");
    assert!(retired_at_once >= 8, "the wave happened");
    assert!(worst_settle < 16_384 && worst_start < 16_384 && worst_close < 16_384);
}

#[test]
fn free_matches_have_a_cooldown_and_are_for_guests_only() {
    let mut c = setup();
    ctx(GUEST, 200, NearToken::from_yoctonear(0));
    let _ = c.start_match();
    ctx(GUEST, 250, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.start_match(); })).is_err(), "one free match a minute");
    ctx(GUEST, 200 + FREE_COOLDOWN_BLOCKS, NearToken::from_yoctonear(0));
    let _ = c.start_match();
}

#[test]
fn sponsors_get_no_cut_of_the_house_top_up_in_free_matches() {
    // audit #5: a free match's pot is mostly the house's 30 top-up; dividends only on the entries part
    let mut c = setup();
    grant(&mut c, ALICE, 50 * ONE);
    let bot = c.slots[1].clone(); // idx 2
    sponsor(&mut c, ALICE, &bot, 20 * ONE, 150);
    let s = start(&mut c, GUEST, 200);
    let r = settle(&mut c, s.match_id, 2, None, 210);
    let earned = c.get_sponsorships(acc(ALICE))[0].earned.0;
    let entry_burn = s.pot.0 * econ::ENTRY_BURN_BPS / 10_000;
    let pot = r.prize.0 + r.house_cut.0 + (r.burned.0 - entry_burn);
    let entries_part = (r.prize.0 / 1_000_000_000_000) * s.pot.0 / pot * 1_000_000_000_000;
    // audit #3: the cut also scales with how much of the pool the sponsors own (full 10% only at 30%)
    let scale = |full: u128, c: &Contract| {
        let pool = c.sponsors.get(&bot).cloned().unwrap();
        let sh: u128 = pool.entries.iter().map(|e| e.shares.0).sum();
        full.min(full * sh * 10_000 / (pool.total_shares.0 * crate::market::SPONSOR_MAX_BPS))
    };
    let want = scale(entries_part * crate::market::SPONSOR_CUT_BPS / 10_000, &c);
    assert!(earned.abs_diff(want) <= want / 500, "{earned} vs {want} (pot inferred without the brake's unburnt part)");
    assert!(earned < r.prize.0 * crate::market::SPONSOR_CUT_BPS / 10_000);
    // in a PAID match sponsors share the whole prize
    let s = start(&mut c, ALICE, 220);
    let r = settle(&mut c, s.match_id, 2, None, 230);
    let earned2 = c.get_sponsorships(acc(ALICE))[0].earned.0 - earned;
    assert_eq!(earned2, scale(r.prize.0 * crate::market::SPONSOR_CUT_BPS / 10_000, &c));
}


// ============================================================ audit #2 PoCs: the exploits no longer work

#[test]
fn audit2_no_transfers_into_game_wallets() {
    // CRITICAL: [ft_transfer_call(bot | house, D), unsponsor | start_match] inflated a keyless game
    // wallet for one receipt. Game wallets now refuse any NEP-141 transfer.
    let mut c = setup();
    grant(&mut c, ALICE, 50 * ONE);
    let house = c.house.clone();
    let bot = c.slots[1].clone();
    let me = acc(ME);
    let future_rookie = acc(&format!("yarrow-99.{ME}"));
    for to in [house.clone(), bot.clone(), me.clone(), future_rookie.clone()] {
        ctx(ALICE, 200, NearToken::from_yoctonear(1));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.ft_transfer(to.clone(), U128(ONE), None)));
        assert!(r.is_err(), "ft_transfer into {to} refused");
        ctx(ALICE, 200, NearToken::from_yoctonear(1));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.ft_transfer_call(to.clone(), U128(ONE), None, String::new());
        }));
        assert!(r.is_err(), "ft_transfer_call into {to} refused");
    }
    assert_eq!(bal(&c, ALICE), 50 * ONE);
    // ordinary player-to-player transfers still work
    ctx(RELAY, 201, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc("bob.test")), None);
    ctx(ALICE, 202, NearToken::from_yoctonear(1));
    c.ft_transfer(acc("bob.test"), U128(ONE), None);
    assert_eq!(bal(&c, "bob.test"), ONE);
}

/// 12 sponsors with 64-char names on a bot that wins AND claims the bounty while `k` other bots go
/// broke in the same settlement, on the mainnet-length contract name "noxara.near".
fn audit2_settle_logs(k: usize) -> (usize, usize, u32) {
    const NAME: &str = "noxara.near";
    CUR.with(|c| *c.borrow_mut() = NAME.to_string());
    ctx(NAME, 100, NearToken::from_yoctonear(0));
    let mut c = Contract::new(acc("owner.near"), acc(SERVER), acc("relay.noxara.near"), None, None);
    let quillon = c.slots[1].clone();
    let brindle = c.slots[0].clone();
    c.mint(&brindle, 400 * ONE, "t");
    c.mint(&quillon, 250 * ONE, "t");
    for i in 0..12 {
        let who = format!("{:0>64x}", 0xabcdef00u64 + i);
        ctx(&who, 110, STORAGE_DEPOSIT);
        c.storage_deposit(None, None);
        c.mint(&acc(&who), 10 * ONE, "t");
        ctx(&who, 111, NearToken::from_yoctonear(0));
        c.sponsor(quillon.clone(), U128(10 * ONE));
    }
    for s in 2..2 + k {
        let a = c.slots[s].clone();
        let b = c.balance(&a);
        c.burn(&a, b - ENTRY_FEE, "t"); // exactly one entry left: broke after this match
        let mut f = c.load_fighter(&a).unwrap();
        f.record.matches = 3;
        c.save_fighter(f);
    }
    c.mint(&c.house.clone(), 20_000 * ONE, "t");
    let player = format!("{:0>64x}", 0x1234u64);
    ctx(&player, 120, STORAGE_DEPOSIT);
    c.storage_deposit(None, None);
    c.mint(&acc(&player), 10 * ONE, "t");
    let s = start(&mut c, &player, 200);
    assert_eq!(s.bounty_idx, Some(1));
    let r0 = c.rookies;
    let _ = settle(&mut c, s.match_id, 2, Some(2), 210);
    let logs = near_sdk::test_utils::get_logs();
    let bytes: usize = logs.iter().map(|l| l.len()).sum();
    CUR.with(|c| *c.borrow_mut() = ME.to_string());
    (bytes, logs.len(), c.rookies - r0)
}

fn audit2_check(k: usize) {
    let (b, n, rookies) = audit2_settle_logs(k);
    println!("k={k}: settle logs {b} B in {n} lines, {rookies} retirements");
    assert_eq!(rookies as usize, k, "the wave happened");
    assert!(b < 16_384 && n < 100, "k={k}: {b} B / {n} lines");
}
#[test]
fn audit2_settle_logs_k0() { audit2_check(0) }
#[test]
fn audit2_settle_logs_k1() { audit2_check(1) }
#[test]
fn audit2_settle_logs_k2() { audit2_check(2) }
#[test]
fn audit2_settle_logs_k3() { audit2_check(3) }
#[test]
fn audit2_settle_logs_k4() { audit2_check(4) }
#[test]
fn audit2_settle_logs_k5() { audit2_check(5) }
#[test]
fn audit2_settle_logs_k6() { audit2_check(6) }
#[test]
fn audit2_settle_logs_k7() { audit2_check(7) }

#[test]
fn audit2_teardown_closes_pending_matches_in_small_batches() {
    let mut c = setup();
    grant(&mut c, ALICE, 0);
    for i in 0..15 {
        let g = guest_n(&mut c, 500 + i);
        start(&mut c, &g, 200 + i as u64);
    }
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME)).predecessor_account_id(acc("owner.test")).block_timestamp(TEARDOWN_AFTER_MS * 1_000_000);
    let mut calls = 0;
    loop {
        testing_env!(b.build());
        let r = c.teardown();
        calls += 1;
        let bytes: usize = near_sdk::test_utils::get_logs().iter().map(|l| l.len()).sum();
        assert!(bytes < 16_384, "{bytes} B");
        if matches!(r, near_sdk::PromiseOrValue::Promise(_)) {
            break;
        }
        assert!(calls < 10);
    }
    assert_eq!(calls, 2, "15 pending matches: 8 + 7");
    assert!(c.pending_free.is_empty());
}

#[test]
fn audit2_house_grant_respects_the_floor_and_owner_change_is_two_step() {
    let mut c = setup();
    let house = c.house.clone();
    let spare = c.balance(&house) - HOUSE_FLOOR;
    c.move_tokens(&house, &acc(GUEST), spare, "test");
    ctx("owner.test", 300, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.house_grant(acc(ALICE), U128(ONE)))).is_err());
    ctx("owner.test", 301, NearToken::from_yoctonear(0));
    c.propose_owner(acc("new.test"));
    ctx("evil.test", 302, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.accept_owner())).is_err());
    ctx("new.test", 303, NearToken::from_yoctonear(0));
    c.accept_owner();
    assert_eq!(c.owner, acc("new.test"));
}

#[test]
fn audit2_free_start_markers_are_pruned() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    assert!(near_sdk::store::LookupMap::<AccountId, u64>::new(Key::LastFreeStart).get(&acc(GUEST)).is_some());
    settle(&mut c, s.match_id, 3, None, 200 + FREE_COOLDOWN_BLOCKS + 1);
    assert!(near_sdk::store::LookupMap::<AccountId, u64>::new(Key::LastFreeStart).get(&acc(GUEST)).is_none(), "pruned at settlement");
}

#[test]
fn audit2_self_registration_has_its_own_welcome_sub_cap() {
    let mut c = setup();
    for i in 0..(WELCOME_SELF_DAILY_CAP + 3) {
        let who = format!("sybil{i}.testnet");
        register_as(&mut c, &who, &who, 1);
    }
    let got = (0..(WELCOME_SELF_DAILY_CAP + 3)).filter(|i| c.welcome_credit(&acc(&format!("sybil{i}.testnet"))) > 0).count();
    assert_eq!(got as u32, WELCOME_SELF_DAILY_CAP, "self-registrations capped");
    register_as(&mut c, RELAY, "real.testnet", 1);
    assert_eq!(c.welcome_credit(&acc("real.testnet")), WELCOME_STAKE, "the relayer path still has room");
}

#[test]
fn audit2_teardown_clear_empties_state_in_bounded_batches() {
    let mut c = setup();
    let mut guests = vec![GUEST.to_string()];
    for i in 0..30 {
        let g = guest_n(&mut c, 900 + i);
        let s = start(&mut c, &g, 200 + i as u64 * 10);
        settle(&mut c, s.match_id, 5, None, 205 + i as u64 * 10);
        guests.push(g);
    }
    assert!(c.rookies > 0, "rookies to clear too");
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME)).predecessor_account_id(acc("owner.test")).block_timestamp(TEARDOWN_AFTER_MS * 1_000_000);
    testing_env!(b.build());
    let before_fighters = c.slots.clone();
    let mut calls = 0;
    loop {
        let batch: Vec<AccountId> = guests.drain(..guests.len().min(20)).map(|g| acc(&g)).collect();
        let p = c.teardown_clear(batch, Some(10), Some(3));
        calls += 1;
        let bytes: usize = near_sdk::test_utils::get_logs().iter().map(|l| l.len()).sum();
        assert!(bytes < 16_384);
        if p.done && guests.is_empty() {
            break;
        }
        assert!(calls < 20);
    }
    c.players.flush();
    c.matches.flush();
    c.fighters.flush();
    assert!(c.get_match(U64(1)).is_none() && c.get_match(U64(31)).is_none());
    assert!(before_fighters.iter().all(|f| c.fighters.get(f).is_none()), "fighter records gone");
    assert!(c.get_player(acc(GUEST)).is_none());
    println!("teardown_clear: {calls} calls");
}


#[test]
fn teardown_clear_never_loses_escrow_or_credit_and_keeps_counters() {
    // review: clearing must wait for in-flight matches and keep the pending counters consistent
    let mut c = setup();
    register_as(&mut c, RELAY, "cred.testnet", 1); // credit-paid entries
    grant(&mut c, ALICE, 50 * ONE);
    let mut paid_players = vec![ALICE.to_string(), "cred.testnet".to_string()];
    for i in 0..6 {
        let who = format!("p{i}.testnet");
        ctx(&who, 140, STORAGE_DEPOSIT);
        c.storage_deposit(None, None);
        grant(&mut c, &who, 10 * ONE);
        paid_players.push(who);
    }
    let mut h = 200;
    for p in &paid_players {
        start(&mut c, p, h);
        h += 2;
    }
    for i in 0..6 {
        let g = guest_n(&mut c, 700 + i);
        start(&mut c, &g, h);
        h += 2;
    }
    assert_eq!(c.pending_paid as usize, paid_players.len());
    let check = |c: &Contract| {
        // escrow on the contract == the sum of what pending matches hold
        let held: u128 = c.pending_free.iter().chain(c.pending_paid_ids().iter()).filter_map(|id| c.load_match(*id)).map(|m| m.pot.0).sum();
        assert_eq!(c.balance(&acc(ME)), held, "escrow matches the pending matches");
        assert_eq!(c.pending_paid as usize, c.pending_paid_ids().len(), "counter == list");
        assert_eq!(c.total_minted - c.total_burned, c.token.total_supply);
    };
    check(&c);
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME)).predecessor_account_id(acc("owner.test")).block_timestamp(TEARDOWN_AFTER_MS * 1_000_000);
    let mut calls = 0;
    loop {
        testing_env!(b.build());
        let p = c.teardown_clear(vec![], Some(5), Some(2));
        calls += 1;
        check(&c);
        if p.done {
            break;
        }
        assert!(calls < 20);
    }
    assert!(c.pending_free.is_empty() && c.pending_paid == 0);
    assert_eq!(c.balance(&acc(ME)), 0, "every entry went back by the rules before any record was deleted");
    assert_eq!(c.welcome_credit(&acc("cred.testnet")), WELCOME_STAKE - ENTRY_FEE, "a seeded credit entry is forfeited to the house, never lost");
}

// ============================================================ economy v2 (docs/ECONOMY.md)

fn register(c: &mut Contract, who: &str) {
    ctx(RELAY, 101, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc(who)), None);
    c.set_welcome_credit(&acc(who), 0);
}

fn ctx_ts(pred: &str, height: u64, ms: u64, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(&CUR.with(|c| c.borrow().clone())))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .block_height(height)
        .block_timestamp(ms * 1_000_000)
        .attached_deposit(deposit)
        .account_balance(NearToken::from_near(50))
        .random_seed([(height % 251) as u8 + 1; 32]);
    testing_env!(b.build());
}

#[test]
fn econ_params_match_the_simulator() {
    let p: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(include_str!("../../../scripts/econ-params.json")).unwrap();
    let n = |k: &str| p[k].as_u64().unwrap_or_else(|| panic!("{k}")) as u128;
    assert_eq!(n("ENTRY") * ONE, ENTRY_FEE);
    assert_eq!(n("WEALTH_BPS"), ENTRY_WEALTH_BPS);
    assert_eq!(n("MAX_ENTRY") * ONE, MAX_ENTRY);
    assert_eq!(n("RESERVE") * ONE, RESERVE);
    assert_eq!(n("ENTRY_BURN_BPS"), econ::ENTRY_BURN_BPS);
    assert_eq!(n("BASE_TOP_UP") * ONE, econ::BASE_TOP_UP);
    assert_eq!(n("BASE_BURN_BPS"), econ::BASE_BURN_BPS);
    assert_eq!(n("MAX_BURN_BPS"), econ::MAX_BURN_BPS);
    assert_eq!(n("BASE_HOUSE_BPS"), econ::BASE_HOUSE_BPS);
    assert_eq!(n("MAX_HOUSE_BPS"), econ::MAX_HOUSE_BPS);
    assert_eq!(n("BOUNTY_BPS"), BOUNTY_BPS);
    assert_eq!(n("BOUNTY_BONUS") * ONE, econ::BOUNTY_BONUS);
    assert_eq!(n("M_MAX_BPS"), econ::M_MAX_BPS);
    assert_eq!(n("HOUSE_TARGET") * ONE, econ::HOUSE_TARGET);
    assert_eq!(n("HOUSE_FLOOR") * ONE, HOUSE_FLOOR);
    assert_eq!(n("HOUSE_GENESIS") * ONE, HOUSE_GENESIS);
    assert_eq!(n("STARTER") * ONE, STARTER);
    assert_eq!(n("S_TARGET") * ONE, econ::S_TARGET);
    assert_eq!(n("S_MIN") * ONE, econ::S_MIN);
    assert_eq!(n("EMA_DIV"), econ::EMA_DIV);
    let up = p["UPKEEP"].as_array().unwrap();
    for (i, (lo, bps)) in econ::UPKEEP.iter().enumerate() {
        assert_eq!(up[i][0].as_u64().unwrap() as u128 * ONE, *lo);
        assert_eq!(up[i][1].as_u64().unwrap() as u128, *bps);
    }
    assert_eq!(n("UPKEEP_HOUSE_BPS"), econ::UPKEEP_HOUSE_BPS);
    assert_eq!(p["WEAPON"][0].as_u64().unwrap() as u128 * ONE, WEAPON_PRICES[0]);
    assert_eq!(p["WEAPON"][1].as_u64().unwrap() as u128 * ONE, WEAPON_PRICES[1]);
    assert_eq!(p["ARMOR"][0].as_u64().unwrap() as u128 * ONE, ARMOR_PRICES[0]);
    assert_eq!(p["ARMOR"][1].as_u64().unwrap() as u128 * ONE, ARMOR_PRICES[1]);
    assert_eq!(n("SKIN") * ONE, SKIN_PRICE);
    assert_eq!(n("UPGRADE_BURN_BPS"), econ::UPGRADE_BURN_BPS);
    assert_eq!(n("SHARES_PER_BOT") as u32, econ::SHARES_PER_BOT);
    assert_eq!(n("IPO_SHARES") as u32, econ::IPO_SHARES);
    assert_eq!(n("IPO_PRICE_PER_SHARE_MILLI") * ONE / 1000, econ::IPO_PRICE);
    assert_eq!(n("DIVIDEND_BPS"), econ::DIVIDEND_BPS);
    assert_eq!(n("TRADE_TAX_BPS"), econ::TRADE_TAX_BPS);
    assert_eq!(n("DAILY_FULL_WINS") as u32, econ::DAILY_FULL_WINS);
    assert_eq!(n("DAILY_HALF_WINS") as u32, econ::DAILY_HALF_WINS);
    assert_eq!(n("WELCOME_CREDIT") * ONE, WELCOME_STAKE);
    assert_eq!(n("SEASON_MS") as u64, econ::SEASON_MS);
    assert_eq!(n("SEASON_EPOCH_MS") as u64, econ::SEASON_EPOCH_MS);
    for (i, r) in p["CHECKIN_REWARDS"].as_array().unwrap().iter().enumerate() {
        assert_eq!(r.as_u64().unwrap() as u128 * ONE, daily::CHECKIN_REWARDS[i]);
    }
    for (i, r) in p["QUEST_REWARDS"].as_array().unwrap().iter().enumerate() {
        assert_eq!(r.as_u64().unwrap() as u128 * ONE, daily::QUESTS[i].2);
        assert_eq!(p["QUEST_GOALS"][i].as_u64().unwrap() as u32, daily::QUESTS[i].1);
    }
    assert_eq!(n("ROOKIE_PROTECTED_MATCHES") as u32, daily::ROOKIE_PROTECTED_MATCHES);
    assert_eq!(n("CHECKIN_DAILY_CAP") as u32, daily::CHECKIN_DAILY_CAP);
    assert_eq!(n("QUEST_DAILY_CAP") as u32, daily::QUEST_DAILY_CAP);
}

#[test]
fn the_house_rule() {
    // m: 0 at the floor, 1 at target, capped at 1.5; pot shares rise as the House empties
    assert_eq!(econ::rule(HOUSE_FLOOR), (0, econ::MAX_HOUSE_BPS, econ::MAX_BURN_BPS));
    assert_eq!(econ::rule(0), (0, econ::MAX_HOUSE_BPS, econ::MAX_BURN_BPS));
    assert_eq!(econ::rule(econ::HOUSE_TARGET), (10_000, econ::BASE_HOUSE_BPS, econ::BASE_BURN_BPS));
    assert_eq!(econ::rule(10 * econ::HOUSE_TARGET).0, econ::M_MAX_BPS);
    let mid = (HOUSE_FLOOR + econ::HOUSE_TARGET) / 2;
    assert_eq!(econ::rule(mid), (5_000, 1_000, 250));
    // brake: full at genesis, none at S_MIN, linear between
    assert_eq!(econ::brake(econ::S_TARGET), 10_000);
    assert_eq!(econ::brake(econ::S_MIN), 0);
    assert_eq!(econ::brake((econ::S_MIN + econ::S_TARGET) / 2), 5_000);
    // progressive upkeep (marginal brackets)
    assert_eq!(econ::upkeep(150 * ONE), 0);
    assert_eq!(econ::upkeep(300 * ONE), 150 * ONE / 100);
    assert_eq!(econ::upkeep(1_000 * ONE), 150 * ONE / 100 + 300 * ONE * 2 / 100 + 400 * ONE * 4 / 100);
    assert_eq!(econ::daily_factor_bps(0), 10_000);
    assert_eq!(econ::daily_factor_bps(3), 5_000);
    assert_eq!(econ::daily_factor_bps(6), 2_500);
}

#[test]
fn v2_150_matches_no_minting_and_the_economy_holds() {
    let mut c = setup();
    let genesis = c.total_minted;
    let mut seen = std::collections::BTreeSet::new();
    let mut h = 200;
    for i in 0..150u64 {
        let s = start(&mut c, GUEST, h);
        let w = [3, 5, 1, 7, 2, 9, 4, 0, 6, 8][(i % 10) as usize];
        settle(&mut c, s.match_id, w, if i % 3 == 0 { Some(((w + 1) % 10) as u8) } else { None }, h + 5);
        h += 10;
        assert_supply_seen(&c, &mut seen);
        assert!(c.balance(&c.house) >= HOUSE_FLOOR, "the House never pays below its floor");
    }
    assert_eq!(c.total_minted, genesis, "nothing minted after genesis");
    let e = c.get_economy();
    assert_eq!(e.snapshots.len(), econ::SNAPSHOTS);
    assert!(e.m_bps <= econ::M_MAX_BPS as u32);
    assert!(e.burned.0 > 0 && e.supply.0 < genesis);
}

/// alice buys `n` IPO shares of slot `slot`'s bot
fn ipo(c: &mut Contract, who: &str, slot: usize, n: u32, h: u64) -> AccountId {
    let bot = c.slots[slot].clone();
    ctx(who, h, NearToken::from_yoctonear(0));
    c.buy_ipo(bot.clone(), n);
    bot
}

#[test]
fn ipo_funds_the_bot_and_dividends_come_only_from_profit() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let bot = ipo(&mut c, ALICE, 3, econ::IPO_SHARES, 150); // idx 4
    assert_eq!(bal(&c, ALICE), 100 * ONE - 30 * ONE);
    assert_eq!(c.balance(&bot), STARTER + 30 * ONE, "IPO money goes into the bot's wallet");
    assert_eq!(c.mt_balance_of(acc(ALICE), bot.clone()).0, econ::IPO_SHARES as u128);
    assert_eq!(c.mt_balance_of(bot.clone(), bot.clone()).0, (econ::SHARES_PER_BOT - econ::IPO_SHARES) as u128);
    // a loss: no dividend (the IPO capital is never paid back as a dividend)
    let s = start(&mut c, GUEST, 200);
    settle(&mut c, s.match_id, 5, None, 210);
    assert_eq!(c.get_holdings(acc(ALICE))[0].claimable.0, 0, "no profit, no dividend");
    // a win: 20% of the gain above the high-water mark, pro rata 300/1000
    let hwm = c.get_bot_econ(bot.clone()).hwm.0;
    let s = start(&mut c, GUEST, 220);
    let r = settle(&mut c, s.match_id, 4, None, 230);
    assert_eq!(r.prize_to, bot);
    let owed = c.get_holdings(acc(ALICE))[0].claimable.0;
    let per_share = (hwm.max(0) + 0, owed / econ::IPO_SHARES as u128).1;
    assert!(owed > 0 && per_share > 0);
    let gain_bound = r.prize.0; // the gain can't exceed what it won
    assert!(owed <= gain_bound * econ::DIVIDEND_BPS / 10_000 * econ::IPO_SHARES as u128 / econ::SHARES_PER_BOT as u128 + 1);
    // claim pays exactly once
    ctx(ALICE, 240, NearToken::from_yoctonear(0));
    let got = c.claim_dividends(bot.clone()).0;
    assert_eq!(got, owed);
    assert_eq!(bal(&c, ALICE), 70 * ONE + owed);
    ctx(ALICE, 241, NearToken::from_yoctonear(0));
    assert_eq!(c.claim_dividends(bot.clone()).0, 0, "no double claim");
    assert_eq!(bal(&c, ALICE), 70 * ONE + owed);
    assert_eq!(c.balance(&c.dividends_account()), 0, "the dividend escrow holds exactly what is owed");
    assert_supply(&c);
}

#[test]
fn bankruptcy_sends_shares_to_zero_and_owed_dividends_survive() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let bot = ipo(&mut c, ALICE, 3, 100, 150);
    let s = start(&mut c, GUEST, 200);
    settle(&mut c, s.match_id, 4, None, 210); // a win: dividends owed
    let owed = c.get_holdings(acc(ALICE))[0].claimable.0;
    assert!(owed > 0);
    // drain the bot (test only) -> it retires at the next settle
    let drain = c.balance(&bot) - 1;
    c.move_tokens(&bot, &acc(BOB), drain, "test");
    let s = start(&mut c, GUEST, 220);
    settle(&mut c, s.match_id, 1, None, 230);
    assert!(!c.get_fighter(bot.clone()).unwrap().fighter.active, "retired broke");
    assert!(c.get_bot_econ(bot.clone()).bankrupt);
    assert_eq!(c.mt_balance_of(acc(ALICE), bot.clone()).0, 0, "shares go to zero");
    assert_eq!(c.mt_supply(bot.clone()).unwrap().0, 0);
    ctx(ALICE, 240, NearToken::from_yoctonear(0));
    assert_eq!(c.claim_dividends(bot.clone()).0, owed, "dividends already earned stay claimable");
    assert!(c.get_holdings(acc(ALICE)).is_empty(), "the dead holding is cleaned up");
    ctx(ALICE, 241, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.buy_ipo(bot.clone(), 1); })).is_err(), "no IPO in a retired bot");
    // its leftovers go to the House via close_retired
    let house0 = c.balance(&c.house);
    let left = c.balance(&bot);
    ctx(BOB, 250, NearToken::from_yoctonear(0));
    c.close_retired(bot.clone());
    assert_eq!(c.balance(&c.house), house0 + left);
    assert_supply(&c);
}

#[test]
fn the_share_market_burns_a_two_percent_tax() {
    let mut c = setup();
    register(&mut c, BOB);
    grant(&mut c, ALICE, 100 * ONE);
    grant(&mut c, BOB, 100 * ONE);
    let bot = ipo(&mut c, ALICE, 2, 200, 150);
    ctx(ALICE, 159, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.list_shares(bot.clone(), 100, U128(ONE / 5)); })).is_err(), "a wallet signature (1 yocto) is required");
    ctx(ALICE, 160, NearToken::from_yoctonear(1));
    let id = c.list_shares(bot.clone(), 100, U128(ONE / 5)); // 0.2 NOX/share
    assert_eq!(c.get_holdings(acc(ALICE))[0].locked, 100);
    ctx(ALICE, 161, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.list_shares(bot.clone(), 101, U128(ONE)); })).is_err(), "locked shares can't be listed twice");
    let supply0 = c.token.total_supply;
    let (a0, b0) = (bal(&c, ALICE), bal(&c, BOB));
    ctx(BOB, 169, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.buy_listing(id); })).is_err(), "a wallet signature (1 yocto) is required");
    ctx(BOB, 170, NearToken::from_yoctonear(1));
    c.buy_listing(id);
    let cost = 100 * ONE / 5;
    let tax = cost * econ::TRADE_TAX_BPS / 10_000;
    assert_eq!(bal(&c, BOB), b0 - cost);
    assert_eq!(bal(&c, ALICE), a0 + cost - tax);
    assert!(c.token.total_supply < supply0 && supply0 - c.token.total_supply <= tax, "the tax burns (brake applies)");
    assert_eq!(c.mt_balance_of(acc(BOB), bot.clone()).0, 100);
    assert_eq!(c.mt_balance_of(acc(ALICE), bot.clone()).0, 100);
    assert_eq!(c.get_bot_econ(bot.clone()).last_price, Some(U128(ONE / 5)));
    assert_eq!(c.get_bot_econ(bot.clone()).holders, 2);
    assert!(c.get_listings(None).is_empty());
    ctx(BOB, 171, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.buy_listing(id); })).is_err(), "a listing sells once");
    assert_supply(&c);
}

#[test]
fn mt_transfer_needs_a_wallet_signature_and_burns_two_percent_of_the_shares() {
    let mut c = setup();
    register(&mut c, BOB);
    grant(&mut c, ALICE, 100 * ONE);
    let bot = ipo(&mut c, ALICE, 1, 100, 150);
    ctx(ALICE, 160, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.mt_transfer(acc(BOB), bot.clone(), U128(50), None, None); })).is_err(), "1 yocto required");
    ctx(ALICE, 161, NearToken::from_yoctonear(1));
    c.mt_transfer(acc(BOB), bot.clone(), U128(50), None, None);
    assert_eq!(c.mt_balance_of(acc(ALICE), bot.clone()).0, 50);
    assert_eq!(c.mt_balance_of(acc(BOB), bot.clone()).0, 49, "2% of 50 rounded up = 1 share burned");
    assert_eq!(c.get_bot_econ(bot.clone()).sold, 99);
    // guests and game wallets can't receive shares; amounts beyond u32 are refused
    ctx(ALICE, 162, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.mt_transfer(acc(GUEST), bot.clone(), U128(1), None, None); })).is_err());
    ctx(ALICE, 163, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.mt_transfer(acc(BOB), bot.clone(), U128(u128::MAX), None, None); })).is_err());
    ctx(ALICE, 164, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.mt_transfer(acc(BOB), bot.clone(), U128(51), None, None); })).is_err(), "can't send more than you hold");
    assert_supply(&c);
}

#[test]
fn guests_and_overflowing_inputs_are_refused() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let bot = c.slots[0].clone();
    ctx(GUEST, 150, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.buy_ipo(bot.clone(), 1); })).is_err(), "guests can't hold shares");
    ctx(ALICE, 151, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.buy_ipo(bot.clone(), u32::MAX); })).is_err(), "more than the IPO block");
    ctx(ALICE, 152, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.buy_ipo(bot.clone(), 0); })).is_err());
    ipo(&mut c, ALICE, 0, 10, 153);
    ctx(ALICE, 1530, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.list_shares(bot.clone(), 9, U128(ONE)); })).is_err(), "at least 10 shares");
    ctx(ALICE, 154, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.list_shares(bot.clone(), 5, U128(u128::MAX)); })).is_err(), "price cap");
    ctx(ALICE, 155, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.list_shares(bot.clone(), 10, U128(0)); })).is_err());
    // at most 3 bots held
    ipo(&mut c, ALICE, 1, 1, 156);
    ipo(&mut c, ALICE, 2, 1, 157);
    ctx(ALICE, 158, NearToken::from_yoctonear(0));
    let b4 = c.slots[3].clone();
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.buy_ipo(b4.clone(), 1); })).is_err(), "MAX_HOLDINGS");
    assert_supply(&c);
}

#[test]
fn a_real_players_wins_diminish_over_the_day() {
    let mut c = setup();
    grant(&mut c, ALICE, 200 * ONE);
    let mut h = 200;
    let mut shares = vec![];
    for _ in 0..4 {
        let b0 = bal(&c, ALICE);
        let s = start(&mut c, ALICE, h);
        let paid = s.player_paid.0;
        let r = settle(&mut c, s.match_id, 0, None, h + 5);
        h += 10;
        shares.push((bal(&c, ALICE) + paid - b0, r.prize.0));
    }
    // (got, full prize): the first 3 paid wins of the UTC day pay in full, the 4th pays half
    for (got, full) in &shares[..3] {
        assert_eq!(got, full, "{shares:?}");
    }
    assert_eq!(shares[3].0, shares[3].1 / 2, "{shares:?}");
    assert_eq!(c.player_prize_bps(&acc(ALICE)), 5_000, "wins 4-6 of the day pay half");
    c.player_prize_bps(&acc(ALICE));
    assert_eq!(c.player_prize_bps(&acc(ALICE)), 2_500, "from the 7th, a quarter");
    assert_supply(&c);
}

#[test]
fn bronze_bracket_caps_bot_upgrades_for_new_players_only() {
    let mut c = setup();
    // give slot 0's bot maxed upgrades (test only)
    let mut f = c.slot_fighter(0);
    f.upgrades.weapon_tier = 2;
    f.upgrades.armor = 2;
    c.save_fighter(f);
    let s = start(&mut c, GUEST, 200);
    assert_eq!((s.roster[0].upgrades.weapon_tier, s.roster[0].upgrades.armor), (1, 1), "guests play bronze");
    settle(&mut c, s.match_id, 3, None, 210);
    grant(&mut c, ALICE, 100 * ONE);
    c.xp.insert(acc(ALICE), 1_000_000); // a veteran (test only)
    let s = start(&mut c, ALICE, 220);
    assert_eq!((s.roster[0].upgrades.weapon_tier, s.roster[0].upgrades.armor), (2, 2), "veterans face the full roster");
}

#[test]
fn players_pay_a_progressive_entry() {
    let mut c = setup();
    grant(&mut c, ALICE, 500 * ONE);
    let s = start(&mut c, ALICE, 200);
    assert_eq!(s.player_paid.0, entry_fee_for(500 * ONE));
    assert_eq!(s.player_paid.0, 13 * ONE, "4 + 2% of the 450 above the reserve");
    grant(&mut c, ALICE, 1_000 * ONE);
    settle(&mut c, s.match_id, 3, None, 210);
    let s = start(&mut c, ALICE, 220);
    assert_eq!(s.player_paid.0, MAX_ENTRY, "capped at 16");
}

#[test]
fn seasons_roll_lazily_and_are_archived() {
    let mut c = setup();
    let t0 = econ::SEASON_EPOCH_MS + 1_000;
    let bot = c.slots[4].clone();
    // season 0: idx 5 wins
    {
        let mut last = near_sdk::store::LookupMap::<AccountId, u64>::new(Key::LastFreeStart);
        last.remove(&acc(GUEST));
        last.flush();
    }
    ctx_ts(GUEST, 200, t0, NearToken::from_yoctonear(0));
    let _ = c.start_match();
    let id = c.next_match_id - 1;
    ctx_ts(ME, 201, t0, NearToken::from_yoctonear(0));
    c.resolve_start(U64(id));
    ctx_ts(SERVER, 205, t0, NearToken::from_yoctonear(0));
    let mut kills = vec![0u8; FIGHTERS];
    kills[5] = 2;
    c.settle_match(U64(id), places(5), kills, None, "ab".repeat(32), None);
    let row = c.get_season_standings(None).into_iter().find(|r| r.bot == bot).unwrap();
    assert_eq!((row.points, row.wins, row.kills), (14, 1, 2));
    // next season: standings reset lazily, the old one is archived at the next settle
    let t1 = t0 + econ::SEASON_MS;
    {
        let mut last = near_sdk::store::LookupMap::<AccountId, u64>::new(Key::LastFreeStart);
        last.remove(&acc(GUEST));
        last.flush();
    }
    ctx_ts(GUEST, 300, t1, NearToken::from_yoctonear(0));
    let _ = c.start_match();
    let id = c.next_match_id - 1;
    ctx_ts(ME, 301, t1, NearToken::from_yoctonear(0));
    c.resolve_start(U64(id));
    ctx_ts(SERVER, 305, t1, NearToken::from_yoctonear(0));
    c.settle_match(U64(id), places(1), vec![0; FIGHTERS], None, "ab".repeat(32), None);
    let now = c.get_season_standings(None);
    assert_eq!(now.iter().find(|r| r.bot == bot).unwrap().points, 0, "a new season starts at zero");
    let old = c.get_season_standings(Some(0));
    assert_eq!(old.iter().find(|r| r.bot == bot).unwrap().points, 14, "the finished season is kept");
    assert_eq!(c.get_fighter(bot).unwrap().fighter.record.wins, 1, "career history stays");
}

#[test]
fn cosmetics_burn_their_price() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let burned0 = c.total_burned;
    let house0 = c.balance(&c.house);
    ctx(ALICE, 150, NearToken::from_yoctonear(0));
    c.buy_cosmetic(0);
    assert_eq!(bal(&c, ALICE), 50 * ONE);
    assert_eq!(c.total_burned - burned0 + (c.balance(&c.house) - house0), 50 * ONE, "burned (+ the brake's unburnt part to the House)");
    assert_eq!(c.get_cosmetics(acc(ALICE)), vec![0]);
    ctx(ALICE, 151, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.buy_cosmetic(0); })).is_err(), "once");
    ctx(GUEST, 152, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.buy_cosmetic(1); })).is_err(), "not guests");
    assert_supply(&c);
}

#[test]
fn new_sponsorships_are_closed_in_release_builds() {
    // in unit tests the legacy path stays callable (exit/migration tests); release builds refuse it
    assert!(crate::market::LEGACY_SPONSOR_IN_TESTS);
}

#[test]
fn v2_worst_case_settle_logs_fit_in_16_kib() {
    // every bot rich (upkeep in every bracket + an upgrade each), 3 IPO holders with 64-char names per bot
    // (dividends on the winner), a bounty with the House bonus, legacy sponsors too, 50-char contract name
    const LONG: &str = "a-very-long-contract-name-for-the-log-test.testnet";
    CUR.with(|c| *c.borrow_mut() = LONG.to_string());
    ctx(LONG, 100, NearToken::from_yoctonear(0));
    let mut c = Contract::new(acc("owner.test"), acc(SERVER), acc(RELAY), Some(acc("operator.test")), None);
    ctx(RELAY, 101, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc(GUEST)), None);
    for i in 0..27 {
        let who = format!("{:0>59}.test", i);
        ctx(&who, 120, STORAGE_DEPOSIT);
        c.storage_deposit(None, None);
        let house = c.house.clone();
        c.move_tokens(&house, &acc(&who), 20 * ONE, "test");
        let bot = c.slots[i % 9].clone();
        ctx(&who, 121, NearToken::from_yoctonear(0));
        c.buy_ipo(bot.clone(), 100);
        ctx(&who, 122, NearToken::from_yoctonear(0));
        c.sponsor(bot, U128(10 * ONE));
    }
    for s in 0..BOTS {
        let b = c.slots[s].clone();
        c.mint(&b, 900 * ONE, "test: rich bots");
    }
    c.mint(&c.house.clone(), 5_000 * ONE, "test");
    let mut worst = 0usize;
    let mut h = 200;
    for w in 1..=9usize {
        let s = start(&mut c, GUEST, h);
        settle(&mut c, s.match_id, w, Some(((w % 9) + 1) as u8), h + 5);
        worst = worst.max(near_sdk::test_utils::get_logs().iter().map(|l| l.len()).sum());
        h += 10;
    }
    println!("v2 worst settle logs: {worst} B (limit 16384)");
    assert!(worst < 14_000, "{worst} B leaves too little margin under 16 KiB");
    CUR.with(|c| *c.borrow_mut() = ME.to_string());
}

#[test]
fn listings_expire_and_dead_ones_are_pruned_and_claims_write_nothing() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let bot = ipo(&mut c, ALICE, 2, 100, 150);
    ctx_ts(ALICE, 160, 1_000, NearToken::from_yoctonear(1));
    c.list_shares(bot.clone(), 10, U128(ONE));
    assert_eq!(c.get_listings(None).len(), 1);
    ctx_ts(BOB, 161, 1_000 + econ::LISTING_TTL_MS, NearToken::from_yoctonear(0));
    assert_eq!(c.prune_listings(None), 1, "anyone prunes an expired listing");
    assert!(c.get_listings(None).is_empty());
    assert_eq!(c.get_holdings(acc(ALICE))[0].locked, 0, "its shares are unlocked again");
    // claiming on a bot you don't hold / a non-fighter writes nothing
    register(&mut c, BOB);
    ctx(BOB, 170, NearToken::from_yoctonear(0));
    let used = env::storage_usage(); // (measured in the same mocked context as the call)
    assert_eq!(c.claim_dividends(c.slots[5].clone()).0, 0);
    assert_eq!(env::storage_usage(), used, "no storage written");
    ctx(BOB, 171, NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.claim_dividends(acc("random.test")); })).is_err());
}

#[test]
fn a_full_order_book_takes_a_cheaper_offer() {
    let mut c = setup();
    let bot = c.slots[6].clone();
    // 10 sellers x 2 listings fill the bot's book (20) at a high price
    for i in 0..10 {
        let who = format!("seller{i}.test");
        register(&mut c, &who);
        grant(&mut c, &who, 10 * ONE);
        ipo(&mut c, &who, 6, 20, 150);
        for k in 0..2 {
            ctx(&who, 160 + k, NearToken::from_yoctonear(1));
            c.list_shares(bot.clone(), 10, U128(5 * ONE));
        }
    }
    assert_eq!(c.get_listings(Some(bot.clone())).len(), econ::MAX_LISTINGS_PER_BOT);
    grant(&mut c, ALICE, 10 * ONE);
    ipo(&mut c, ALICE, 6, 10, 170);
    ctx(ALICE, 171, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.list_shares(bot.clone(), 10, U128(5 * ONE)); })).is_err(), "not cheaper: refused");
    ctx(ALICE, 172, NearToken::from_yoctonear(1));
    c.list_shares(bot.clone(), 10, U128(ONE));
    let book = c.get_listings(Some(bot.clone()));
    assert_eq!(book.len(), econ::MAX_LISTINGS_PER_BOT);
    assert!(book.iter().any(|l| l.seller == acc(ALICE)));
    let locked: u32 = (0..10).map(|i| c.get_holdings(acc(&format!("seller{i}.test")))[0].locked).sum();
    assert_eq!(locked, 190, "the displaced listing's shares are unlocked");
    assert_eq!(c.total_minted - c.total_burned, c.token.total_supply);
}

// ============================================================ audit #4 PoCs: the exploits no longer work

#[test]
fn audit4_refunded_entries_never_count_as_profit() {
    // H-1: entries refunded from swept matches used to raise the wallet above the high-water mark
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let bot = ipo(&mut c, ALICE, 3, econ::IPO_SHARES, 150); // idx 4
    let mut pend = vec![];
    for i in 0..6 {
        let g = guest_n(&mut c, 700 + i);
        pend.push(start(&mut c, &g, 200 + i as u64).match_id);
    }
    let s = start(&mut c, GUEST, 210);
    settle(&mut c, s.match_id, 6, None, 212); // idx 4 loses
    for id in &pend {
        ctx(BOB, 800, NearToken::from_yoctonear(0));
        assert!(c.sweep_match(*id));
    }
    let s = start(&mut c, GUEST, 810);
    settle(&mut c, s.match_id, 6, None, 812); // idx 4 loses again
    assert_eq!(c.get_holdings(acc(ALICE))[0].claimable.0, 0, "no phantom dividend from refunds");
    assert_eq!(c.get_bot_econ(bot).dividends_paid.0, 0);
    assert_supply(&c);
}

#[test]
fn audit4_unregister_releases_shares_and_leaves_no_rows() {
    // M-1: unregister used to orphan holding/listing rows the contract then paid for
    let mut c = setup();
    register(&mut c, BOB);
    grant(&mut c, BOB, 2 * ONE);
    let bot = c.slots[2].clone();
    ctx(BOB, 150, NearToken::from_yoctonear(0));
    c.buy_ipo(bot.clone(), 20);
    ctx(BOB, 151, NearToken::from_yoctonear(1));
    let lid = c.list_shares(bot.clone(), 10, U128(ONE));
    ctx(BOB, 153, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.storage_unregister(None); })).is_err(), "shares held: refused without force");
    ctx(BOB, 154, NearToken::from_yoctonear(1));
    assert!(c.storage_unregister(Some(true)));
    assert!(c.get_holdings(acc(BOB)).is_empty(), "no holding rows left");
    assert!(c.get_listings(None).is_empty(), "its listing is gone");
    assert!(c.get_cosmetics(acc(BOB)).is_empty());
    assert_eq!(c.get_bot_econ(bot.clone()).sold, 0, "its shares went back to the bot");
    assert_eq!(c.get_bot_econ(bot.clone()).holders, 0);
    grant(&mut c, ALICE, 20 * ONE);
    ctx(ALICE, 160, NearToken::from_yoctonear(1));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.buy_listing(lid); })).is_err(), "the listing is gone");
    assert!(!c.token.accounts.contains_key(&acc(BOB)), "no FT account re-created at the contract's expense");
}

#[test]
fn audit4_teardown_clear_removes_the_economy_state() {
    // M-2: teardown_clear used to leave the v2 keys and maps (account deletion fails above ~10 KB)
    let mut c = setup();
    grant(&mut c, ALICE, 400 * ONE);
    let bot = ipo(&mut c, ALICE, 2, 100, 150);
    ctx(ALICE, 151, NearToken::from_yoctonear(0));
    c.buy_cosmetic(2);
    ctx(ALICE, 152, NearToken::from_yoctonear(1));
    c.list_shares(bot.clone(), 10, U128(ONE));
    let mut h = 200u64;
    for i in 0..30u64 {
        let ms = econ::SEASON_EPOCH_MS + i * (econ::SEASON_MS / 10) + 1;
        let mut last = near_sdk::store::LookupMap::<AccountId, u64>::new(Key::LastFreeStart);
        last.remove(&acc(GUEST));
        last.flush();
        ctx_ts(GUEST, h, ms, NearToken::from_yoctonear(0));
        let _ = c.start_match();
        let id = c.next_match_id - 1;
        ctx_ts(ME, h + 1, ms, NearToken::from_yoctonear(0));
        c.resolve_start(U64(id));
        ctx_ts(SERVER, h + 2, ms, NearToken::from_yoctonear(0));
        let w = [3, 5, 1, 7, 2, 9, 4, 6, 8][(i % 9) as usize];
        c.settle_match(U64(id), places(w), vec![0; FIGHTERS], None, "ab".repeat(32), None);
        h += 10;
    }
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME)).predecessor_account_id(acc("owner.test")).block_timestamp(TEARDOWN_AFTER_MS * 1_000_000);
    testing_env!(b.build());
    loop {
        let p = c.teardown_clear(vec![acc(GUEST), acc(ALICE)], Some(200), Some(20));
        if p.done {
            break;
        }
    }
    assert!(env::storage_read(b"econ_v2").is_none() && env::storage_read(b"econ_seasons").is_none(), "global v2 keys removed");
    assert!(c.get_holdings(acc(ALICE)).is_empty() && c.get_cosmetics(acc(ALICE)).is_empty());
    assert!(near_sdk::store::LookupMap::<AccountId, econ::BotEcon>::new(Key::BotEcon).get(&bot).is_none(), "bot rows removed");
}

#[test]
fn profit_the_wallet_cannot_pay_now_is_paid_later() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let bot = ipo(&mut c, ALICE, 3, econ::IPO_SHARES, 150);
    // fake a big profit while the wallet is nearly empty (test only): most of the bankroll "in escrow"
    let mut f = c.load_fighter_pub(&bot).unwrap();
    let hwm0 = c.get_bot_econ(bot.clone()).hwm.0;
    let wallet = c.balance(&bot);
    f.escrowed = U128(500 * ONE);
    c.save_fighter(f);
    let me = acc(ME);
    c.mint(&me, 500 * ONE, "test: the escrowed entries");
    let drain = wallet - ONE / 100; // leave 0.01 NOX in the wallet
    c.move_tokens(&bot, &me, drain, "test");
    let mut e = c.econ();
    c.settle_bot_econ(&bot, &mut e);
    let b = c.get_bot_econ(bot.clone());
    let profit = (wallet - drain + 500 * ONE).saturating_sub(hwm0);
    assert!(b.hwm.0 < hwm0 + profit, "the mark didn't jump past undistributed profit");
    // the money comes back to the wallet: the rest of the cut is paid
    let mut f = c.load_fighter_pub(&bot).unwrap();
    f.escrowed = U128(0);
    c.save_fighter(f);
    c.move_tokens(&me, &bot, 500 * ONE + drain, "test");
    let mut e = c.econ();
    c.settle_bot_econ(&bot, &mut e);
    let paid = c.get_bot_econ(bot.clone()).dividends_paid.0;
    let want = profit * econ::DIVIDEND_BPS / 10_000 * econ::IPO_SHARES as u128 / econ::SHARES_PER_BOT as u128;
    assert!(paid + ONE / 1000 >= want, "paid {paid} of {want}");
}

#[test]
fn unregister_does_not_reset_the_daily_wins() {
    let mut c = setup();
    let _ = c.player_prize_bps(&acc(ALICE));
    let _ = c.player_prize_bps(&acc(ALICE));
    let _ = c.player_prize_bps(&acc(ALICE));
    ctx(ALICE, 300, NearToken::from_yoctonear(1));
    assert!(c.storage_unregister(Some(true)));
    register(&mut c, ALICE);
    assert_eq!(c.player_prize_bps(&acc(ALICE)), 5_000, "the 4th win of the day still pays half");
}

#[test]
fn audit5_holders_can_still_leave_after_teardown_cleared_the_bots() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    let _bot = ipo(&mut c, ALICE, 3, 50, 150);
    let s = start(&mut c, GUEST, 200);
    settle(&mut c, s.match_id, 4, None, 210);
    assert!(c.get_holdings(acc(ALICE))[0].claimable.0 > 0);
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME)).predecessor_account_id(acc("owner.test")).block_timestamp(TEARDOWN_AFTER_MS * 1_000_000);
    testing_env!(b.build());
    let _ = c.teardown_clear(vec![], Some(200), Some(20));
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME)).predecessor_account_id(acc(ALICE)).attached_deposit(NearToken::from_yoctonear(1)).account_balance(NearToken::from_near(50)).block_timestamp(TEARDOWN_AFTER_MS * 1_000_000 + 1);
    testing_env!(b.build());
    assert!(c.storage_unregister(Some(true)), "unregister works after the bots were cleared");
    assert!(c.get_holdings(acc(ALICE)).is_empty());
}

// ============================================================ daily check-in, quests, rookie protection

fn day_ms(d: u64) -> u64 {
    d * 86_400_000 + 3_600_000
}

/// a wallet-paid ALICE match at day `d` (she wins with 1 kill of the bounty carrier when `bounty`)
fn alice_paid_match(c: &mut Contract, d: u64, h: u64, place_first: bool, bounty: bool) -> MatchResult {
    let mut last = near_sdk::store::LookupMap::<AccountId, u64>::new(Key::LastFreeStart);
    last.remove(&acc(ALICE));
    last.flush();
    ctx_ts(ALICE, h, day_ms(d), NearToken::from_yoctonear(0));
    let _ = c.start_match();
    let id = c.next_match_id - 1;
    ctx_ts(ME, h + 1, day_ms(d), NearToken::from_yoctonear(0));
    let s = c.resolve_start(U64(id));
    ctx_ts(SERVER, h + 2, day_ms(d), NearToken::from_yoctonear(0));
    let winner = if place_first { 0 } else { 5 };
    let bk = if bounty { Some(0u8) } else { None };
    let _ = s;
    c.settle_match(U64(id), places(winner), vec![0; FIGHTERS], bk, "ab".repeat(32), None)
}

#[test]
fn check_in_needs_a_wallet_paid_match_and_pays_a_growing_streak_from_the_house() {
    let mut c = setup();
    ctx_ts(ALICE, 150, day_ms(20_000), NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.check_in(); })).is_err(), "no paid match yet");
    grant(&mut c, ALICE, 100 * ONE);
    alice_paid_match(&mut c, 20_000, 200, false, false);
    ctx_ts(ALICE, 203, day_ms(20_000), NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.check_in(); })).is_err(), "unlocks after 3 wallet-paid matches");
    alice_paid_match(&mut c, 20_000, 210, false, false);
    alice_paid_match(&mut c, 20_000, 220, false, false);
    let minted0 = c.total_minted;
    let mut got = vec![];
    for d in 0..8u64 {
        if d > 0 {
            alice_paid_match(&mut c, 20_000 + d, 300 + d * 10, false, false); // stays active
        }
        ctx_ts(ALICE, 305 + d * 10, day_ms(20_000 + d), NearToken::from_yoctonear(0));
        got.push(c.check_in().0);
        ctx_ts(ALICE, 306 + d * 10, day_ms(20_000 + d), NearToken::from_yoctonear(0));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.check_in(); })).is_err(), "once a day");
    }
    let m = m_now(&c).min(10_000);
    assert_eq!(got[0], daily::CHECKIN_REWARDS[0] * m / 10_000, "m capped at 1.0 for dailies");
    assert!(got.iter().all(|g| *g < ENTRY_FEE), "a daily reward never exceeds the minimum entry");
    assert!(got[6] > got[0], "the streak grows: {got:?}");
    assert_eq!(got[7], got[6], "day 8+ keeps the top reward");
    assert_eq!(c.total_minted, minted0, "paid by the House, never minted");
    assert_eq!(c.get_daily(acc(ALICE)).streak, 8);
    // a missed day resets the streak
    alice_paid_match(&mut c, 20_009, 500, false, false);
    ctx_ts(ALICE, 505, day_ms(20_009), NearToken::from_yoctonear(0));
    c.check_in();
    assert_eq!(c.get_daily(acc(ALICE)).streak, 1);
    // guests can't
    ctx_ts(GUEST, 510, day_ms(20_009), NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.check_in(); })).is_err());
}

#[test]
fn welcome_credit_matches_do_not_count_for_check_in_or_quests() {
    let mut c = setup();
    c.set_welcome_credit(&acc(ALICE), WELCOME_STAKE);
    for k in 0..3 {
        alice_paid_match(&mut c, 20_000, 200 + k * 10, true, false);
    }
    let v = c.get_daily(acc(ALICE));
    assert!(!v.can_check_in && v.quests.iter().all(|q| q.progress == 0), "credit-paid matches don't count (sybil cost)");
}

#[test]
fn daily_quests_are_verified_from_settled_matches_and_claimed_once() {
    let mut c = setup();
    grant(&mut c, ALICE, 200 * ONE);
    alice_paid_match(&mut c, 20_000, 200, true, false); // a win (top 3)
    alice_paid_match(&mut c, 20_000, 210, false, true); // bounty kill
    ctx_ts(ALICE, 215, day_ms(20_000), NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.claim_quest(0); })).is_err(), "2 of 3 matches");
    alice_paid_match(&mut c, 20_000, 220, false, false);
    let b0 = bal(&c, ALICE);
    let mut paid = 0;
    for q in 0..3u8 {
        ctx_ts(ALICE, 230 + q as u64, day_ms(20_000), NearToken::from_yoctonear(0));
        paid += c.claim_quest(q).0;
        ctx_ts(ALICE, 240 + q as u64, day_ms(20_000), NearToken::from_yoctonear(0));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.claim_quest(q); })).is_err(), "once a day");
    }
    assert_eq!(bal(&c, ALICE), b0 + paid);
    assert!(paid > 0);
    // the next day the quests reset
    let v = c.get_daily(acc(ALICE));
    let _ = v;
    ctx_ts(ALICE, 300, day_ms(20_001), NearToken::from_yoctonear(0));
    assert!(c.get_daily(acc(ALICE)).quests.iter().all(|q| q.progress == 0 && !q.claimed));
    // unregister + register can't re-claim today's quests
    ctx_ts(ALICE, 301, day_ms(20_000), NearToken::from_yoctonear(1));
    assert!(c.storage_unregister(Some(true)));
    register(&mut c, ALICE);
    ctx_ts(ALICE, 302, day_ms(20_000), NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.claim_quest(1); })).is_err(), "claims survive re-registering");
}

#[test]
fn rookies_are_protected_in_their_first_matches() {
    let mut c = setup();
    // make slot 0 a rich rookie (test only)
    let mut f = c.slot_fighter(0);
    f.generation = 1;
    c.save_fighter(f);
    let b = c.slots[0].clone();
    c.mint(&b, 900 * ONE, "test: rich rookie");
    let s = start(&mut c, GUEST, 200);
    assert_eq!(s.roster[0].paid.0, ENTRY_FEE, "minimum entry");
    assert_ne!(s.bounty_idx, Some(1), "never the bounty carrier");
    let before = c.balance(&b);
    settle(&mut c, s.match_id, 5, None, 210);
    // no upkeep (it may still buy an upgrade: compare against the upgrade spend)
    let f = c.slot_fighter(0);
    let spent_upgrades: u128 = (f.upgrades.weapon_tier > 0) as u128 * WEAPON_PRICES[0];
    assert_eq!(c.balance(&b), before - spent_upgrades, "no upkeep for a protected rookie");
    // after 10 matches the protection ends
    let mut f = c.slot_fighter(0);
    f.record.matches = daily::ROOKIE_PROTECTED_MATCHES;
    c.save_fighter(f);
    let s = start(&mut c, GUEST, 300);
    assert!(s.roster[0].paid.0 > ENTRY_FEE);
}

#[test]
fn audit6_no_idle_check_in_farming_and_zero_payouts_consume_nothing() {
    let mut c = setup();
    grant(&mut c, ALICE, 100 * ONE);
    for k in 0..3 {
        alice_paid_match(&mut c, 20_000, 200 + k * 10, false, false);
    }
    ctx_ts(ALICE, 240, day_ms(20_000), NearToken::from_yoctonear(0));
    c.check_in();
    // the next day without a paid match: refused (one paid entry per check-in)
    ctx_ts(ALICE, 250, day_ms(20_001), NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.check_in(); })).is_err(), "no idle check-in");
    // the House at its floor: a reward of 0 is refused and consumes nothing
    alice_paid_match(&mut c, 20_001, 260, false, false);
    let house = c.house.clone();
    let drain = c.balance(&house) - HOUSE_FLOOR;
    c.move_tokens(&house, &acc(BOB), drain, "test");
    ctx_ts(ALICE, 270, day_ms(20_001), NearToken::from_yoctonear(0));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { c.check_in(); })).is_err(), "zero payout refused");
    let v = c.get_daily(acc(ALICE));
    assert!(!v.checked_in_today && v.streak == 1, "nothing consumed: {} {}", v.checked_in_today, v.streak);
}
