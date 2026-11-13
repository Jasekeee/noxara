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

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(pred: &str, height: u64, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(ME))
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
    let mut c = Contract::new(acc("owner.test"), acc(SERVER), acc(RELAY));
    for who in [GUEST, ALICE] {
        ctx(RELAY, 101, STORAGE_DEPOSIT);
        c.storage_deposit(Some(acc(who)), None);
    }
    c
}

/// start + resolve (the self-call) for `who`; returns the match id.
fn start(c: &mut Contract, who: &str, h: u64) -> MatchStart {
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
    let mut sum = bal(c, ME) + c.balance(&c.house) + bal(c, GUEST) + bal(c, ALICE);
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
    assert_eq!(fs[0].fighter.account.as_str(), "bramble.royale.test");
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
    assert_eq!(bal(&c, ME), 9 * ENTRY_FEE);
    assert_eq!(s.pot.0, 9 * ENTRY_FEE);
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
    let s = start(&mut c, ALICE, 200);
    ctx(ALICE, 210, NearToken::from_yoctonear(0));
    c.settle_match(s.match_id, places(0), vec![0; FIGHTERS], None, "h".into(), None);
}

#[test]
#[should_panic(expected = "duplicate placement")]
fn bad_placements_rejected() {
    let mut c = setup();
    let s = start(&mut c, ALICE, 200);
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
    let pot = 9 * ENTRY_FEE + POT_TOP_UP;
    assert_eq!(r.prize.0 + r.burned.0 + r.house_cut.0, pot);
    assert_eq!(c.balance(&c.house), house0 + pot - r.burned.0);
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
    // 90 + 102.3 >= 120 + reserve: the winner immediately buys weapon tier 1 (paid to the house)
    assert_eq!(bal(&c, &winner), STARTER - ENTRY_FEE + r.prize.0 - WEAPON_PRICES[0]);
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
fn real_player_who_paid_nothing_wins_nothing() {
    // review fix #3: no entry paid -> prize-ineligible exactly like a guest
    let mut c = setup();
    let house0 = c.balance(&c.house);
    let s = start(&mut c, ALICE, 200);
    assert_eq!(s.player_paid.0, 0);
    let r = settle(&mut c, s.match_id, 0, None, 210);
    assert_eq!(r.prize_to, c.house);
    assert_eq!(bal(&c, ALICE), 0);
    assert_eq!(c.get_player(acc(ALICE)).unwrap().earnings.0, 0);
    assert_eq!(c.balance(&c.house), house0 + r.prize.0 + r.house_cut.0);
    // and a bounty kill by a non-payer also feeds the house
    let s = start(&mut c, ALICE, 220);
    let r = settle(&mut c, s.match_id, 5, Some(0), 230);
    assert_eq!(r.bounty_to.as_ref(), Some(&c.house));
    assert_eq!(bal(&c, ALICE), 0);
    assert_supply(&c);
}

#[test]
fn bounty_is_paid_to_the_killer() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    let carrier = slot_acc(&c, 0); // idx 1
    let killer = slot_acc(&c, 1); // idx 2
    let before = bal(&c, &carrier);
    let r = settle(&mut c, s.match_id, 5, Some(2), 210);
    assert_eq!(r.bounty_amount.0, before * BOUNTY_BPS / 10_000);
    assert_eq!(r.bounty_to.as_ref().map(|a| a.as_str()), Some(killer.as_str()));
    assert_eq!(bal(&c, &carrier), before - r.bounty_amount.0);
    assert_eq!(bal(&c, &killer), STARTER - ENTRY_FEE + r.bounty_amount.0);
    assert_eq!(c.get_fighter(acc(&killer)).unwrap().fighter.record.earnings, r.bounty_amount);
    assert_supply(&c);
}

#[test]
fn guest_bounty_kill_feeds_the_house_not_the_guest() {
    let mut c = setup();
    let s = start(&mut c, GUEST, 200);
    let house0 = c.balance(&c.house);
    let r = settle(&mut c, s.match_id, 5, Some(0), 210);
    assert!(r.bounty_amount.0 > 0);
    assert_eq!(r.bounty_to.as_ref(), Some(&c.house));
    assert_eq!(bal(&c, GUEST), 0);
    // + the winner's first upgrade
    assert_eq!(c.balance(&c.house), house0 + r.house_cut.0 + r.bounty_amount.0 + WEAPON_PRICES[0]);
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
    // 90 + prize ~102 per win: weapon 1 after the first win, weapon 2 then armor as money comes in
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
    for i in 0..12 {
        let s = start(&mut c, GUEST, h);
        settle(&mut c, s.match_id, 5, None, h + 5);
        h += 10;
        if c.slots[2].as_str() != pip {
            retired_at = Some(i);
            break;
        }
    }
    // 100 starter / 10 entry: broke after the 10th loss
    assert_eq!(retired_at, Some(9));
    let old = c.get_fighter(acc(&pip)).unwrap();
    assert_eq!(old.status, "retired");
    assert_eq!(old.fighter.record.matches, 10);
    let rookie = c.get_fighter(c.slots[2].clone()).unwrap();
    assert_eq!(rookie.status, "active");
    assert_eq!(rookie.fighter.generation, 1);
    assert_eq!(rookie.fighter.slot, 2);
    assert_eq!(rookie.balance.0, STARTER, "the house funds the rookie");
    assert!(rookie.fighter.account.as_str().ends_with("-3.royale.test"), "slots 0, 1, 2 retired in order: the third rookie");
    assert!(PERSONALITIES.contains(&rookie.fighter.personality.as_str()));
    assert_eq!(c.get_retired().len(), 8, "everyone but the winner went broke together");
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
    assert_eq!(bal(&c, ALICE), 40 * ONE);
    let s2 = start(&mut c, ALICE, 210); // abandons s1 after its seed was fixed
    assert!(c.get_match(s1.match_id).is_none());
    assert_eq!(bal(&c, ALICE), 30 * ONE, "first entry forfeited, second paid");
    assert_eq!(c.balance(&c.house), house0 + ENTRY_FEE);
    assert_eq!(bal(&c, ME), 10 * ENTRY_FEE, "only s2 in escrow: bots were refunded for s1");
    let p = c.get_player(acc(ALICE)).unwrap();
    assert_eq!((p.matches, p.deaths, p.pending), (1, 1, Some(s2.match_id)), "the abandoned match counts as a loss");
    assert!(c.get_fighters().iter().all(|f| f.fighter.escrowed.0 == ENTRY_FEE));
    assert_supply(&c);
}

#[test]
fn abandon_before_the_seed_is_fixed_refunds_everything() {
    let mut c = setup();
    let house = c.house.clone();
    c.move_tokens(&house, &acc(ALICE), 50 * ONE, "test");
    ctx(ALICE, 200, NearToken::from_yoctonear(0));
    let _ = c.start_match(); // resolve_start never ran (e.g. the callback failed)
    assert_eq!(bal(&c, ALICE), 40 * ONE);
    start(&mut c, ALICE, 210);
    assert_eq!(bal(&c, ALICE), 40 * ONE, "the unseeded entry came back");
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
    assert_eq!(bal(&c, ALICE), 40 * ONE, "seeded: the player's entry is forfeited");
    assert_eq!(c.balance(&c.house), house0 + ENTRY_FEE);
    assert_eq!(bal(&c, ME), 0);
    assert!(c.get_fighters().iter().all(|f| f.balance.0 == STARTER && f.fighter.escrowed.0 == 0));
    assert_eq!(c.get_player(acc(ALICE)).unwrap().pending, None);
    assert!(c.pending.is_empty());
    assert_supply(&c);
}

#[test]
fn pending_matches_are_capped_and_lazily_swept() {
    // review fix #2: unbounded pending matches can't drain the bots
    let mut c = setup();
    for i in 0..MAX_PENDING {
        let who = format!("g-{i:04}.relay.test");
        ctx(RELAY, 150, STORAGE_DEPOSIT);
        c.storage_deposit(Some(acc(&who)), None);
        start(&mut c, &who, 200);
    }
    assert_eq!(c.pending.len(), MAX_PENDING);
    ctx(RELAY, 150, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc("g-late.relay.test")), None);
    ctx("g-late.relay.test", 300, NearToken::from_yoctonear(0));
    let full = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.start_match();
    }));
    assert!(full.is_err(), "the island is full");
    // once the oldest expire, the next start sweeps them itself
    let s = start(&mut c, "g-late.relay.test", 200 + EXPIRY_BLOCKS + 1);
    assert!(s.seed > 0);
    assert_eq!(c.pending.len(), MAX_PENDING - 1, "two expired swept, one added");
    assert_supply(&c);
}

#[test]
fn bots_short_only_because_of_escrow_are_not_retired() {
    // review fix #2: escrowed entries are not "broke"
    let mut c = setup();
    let pip = c.slots[2].clone();
    let house = c.house.clone();
    // Pip has played and is down to 15
    c.move_tokens(&pip, &house, 85 * ONE, "test");
    let mut f = c.load_fighter(&pip).unwrap();
    f.record.matches = 3;
    c.save_fighter(f);
    let s1 = start(&mut c, GUEST, 200); // Pip pays 10, keeps 5, 10 in escrow
    assert_eq!(s1.roster[2].paid.0, ENTRY_FEE);
    let s2 = start(&mut c, ALICE, 205); // 5 < entry, but 10 in escrow: still plays (pays 5)
    assert_eq!(c.slots[2], pip, "not retired");
    assert_eq!(s2.roster[2].paid.0, 5 * ONE);
    assert_eq!(c.load_fighter(&pip).unwrap().escrowed.0, 15 * ONE);
    // s1 settles (Pip loses): escrow released, balance 0, but s2 still holds 5 -> stays
    settle(&mut c, s1.match_id, 4, None, 210);
    assert_eq!(c.slots[2], pip);
    // s2 settles: nothing left anywhere -> retires
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
    let p = borsh::to_vec(&VPlayer::V1(c.get_player(acc(who)).unwrap())).unwrap().len();
    let m = borsh::to_vec(&VMatch::V1(c.get_match(s.match_id).unwrap())).unwrap().len();
    let used = rec(1 + id_len, p) + rec(1 + 8, m) + rec(1 + id_len, 16);
    let cost = env::storage_byte_cost().as_yoctonear() * used as u128;
    println!("player {p} B + pending match {m} B + ft account: {used} bytes = {cost} yocto (deposit {})", STORAGE_DEPOSIT.as_yoctonear());
    assert!(cost < STORAGE_DEPOSIT.as_yoctonear(), "{used} bytes");
}

#[test]
fn storage_bounds_and_double_registration() {
    let mut c = setup();
    assert_eq!(c.storage_balance_bounds().min, STORAGE_DEPOSIT);
    assert!(c.storage_balance_of(acc(GUEST)).is_some());
    assert!(c.storage_balance_of(acc("nobody.test")).is_none());
    ctx(RELAY, 300, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc(GUEST)), None); // refunded, no change
    assert_eq!(c.get_player(acc(GUEST)).unwrap().storage_paid.0, STORAGE_DEPOSIT.as_yoctonear());
}

#[test]
#[should_panic(expected = "attach at least")]
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
        let who = if i % 3 == 0 { ALICE } else { GUEST };
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
