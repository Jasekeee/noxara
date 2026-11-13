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

/// entry a genesis bot pays on its first match (progressive fee)
fn e0() -> u128 {
    entry_fee_for(STARTER)
}

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
    // most tests want Alice without credit (the welcome tests use fresh accounts)
    assert_eq!(c.welcome_credit(&acc(ALICE)), WELCOME_STAKE, "registering via the relayer brings the welcome credit");
    assert_eq!(c.balance(&acc(ALICE)), 0, "credit, not $BOUNTY");
    c.set_welcome_credit(&acc(ALICE), 0);
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
    let pot = 9 * e0() + POT_TOP_UP;
    assert_eq!(r.prize.0 + r.burned.0 + r.house_cut.0, pot);
    // the house (above its floor) paid the top-up itself: nothing minted
    assert_eq!(r.minted.0, 0);
    assert_eq!(c.balance(&c.house), house0 + pot - r.burned.0 - POT_TOP_UP);
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
    // the winner immediately buys weapon tier 1 (paid to the house)
    assert_eq!(bal(&c, &winner), STARTER - e0() + r.prize.0 - WEAPON_PRICES[0]);
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
    assert_eq!(c.balance(&c.house), house0 + r.prize.0 + r.house_cut.0 - POT_TOP_UP);
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
    let r = settle(&mut c, s.match_id, 5, Some(0), 210);
    assert!(r.bounty_amount.0 > 0);
    assert_eq!(r.bounty_to.as_ref(), Some(&c.house));
    assert_eq!(bal(&c, GUEST), 0);
    // + the winner's first upgrade
    assert_eq!(c.balance(&c.house), house0 + r.house_cut.0 + r.bounty_amount.0 + WEAPON_PRICES[0] - POT_TOP_UP);
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
    assert_eq!(c.pending_free.len(), 3, "three expired swept, one added");
    // the paid match (longer expiry) was not swept
    assert_eq!(c.pending_paid, 1);
    assert_supply(&c);
}

#[test]
fn a_bot_that_cannot_pay_retires_at_start_even_with_escrow() {
    // judge #2: a bot at ~0 must not play another match on money that sits in escrow elsewhere
    let mut c = setup();
    let pip = c.slots[2].clone();
    let house = c.house.clone();
    // Pip has played and is down to 1.5 entries
    let left = ENTRY_FEE + ENTRY_FEE / 2;
    c.move_tokens(&pip, &house, STARTER - left, "test");
    let mut f = c.load_fighter(&pip).unwrap();
    f.record.matches = 3;
    c.save_fighter(f);
    let s1 = start(&mut c, GUEST, 200); // Pip pays an entry, keeps half an entry
    assert_eq!(s1.roster[2].paid.0, ENTRY_FEE);
    let s2 = start(&mut c, ALICE, 205); // < entry: retires now, a rookie plays instead
    assert_ne!(c.slots[2], pip, "retired at start");
    assert_ne!(s2.roster[2].account, pip);
    assert_eq!(c.get_fighter(pip.clone()).unwrap().status, "retired");
    // its escrowed entry still settles normally (Pip appears in s1's records)
    settle(&mut c, s1.match_id, 4, None, 210);
    assert_eq!(c.load_fighter(&pip).unwrap().escrowed.0, 0);
    assert_eq!(c.load_fighter(&pip).unwrap().record.matches, 4);
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

#[test]
fn the_house_reinvests_above_its_floor_and_mints_below_it() {
    let mut c = setup();
    let supply0 = c.token.total_supply;
    let s = start(&mut c, GUEST, 200);
    let r = settle(&mut c, s.match_id, 4, None, 210);
    assert_eq!(r.minted.0, 0, "healthy house pays the top-up");
    assert_eq!(c.token.total_supply, supply0 - r.burned.0, "no inflation while the house is healthy");
    // drain the house below its floor (test only): now the top-up is minted
    let house = c.house.clone();
    let drain = c.balance(&house) - HOUSE_FLOOR;
    c.move_tokens(&house, &acc(ALICE), drain, "test");
    let supply1 = c.token.total_supply;
    let s = start(&mut c, GUEST, 220);
    let r = settle(&mut c, s.match_id, 4, None, 230);
    assert_eq!(r.minted.0, POT_TOP_UP);
    assert_eq!(c.token.total_supply, supply1 + POT_TOP_UP - r.burned.0);
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
fn no_sponsoring_or_withdrawing_while_the_bot_is_in_a_match() {
    let mut c = setup();
    grant(&mut c, ALICE, 50 * ONE);
    let bot = c.slots[0].clone();
    let s = start(&mut c, GUEST, 200); // every bot now has an entry in escrow
    ctx(ALICE, 201, NearToken::from_yoctonear(0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.sponsor(bot.clone(), U128(10 * ONE))));
    assert!(r.is_err(), "no front-running a pending match");
    settle(&mut c, s.match_id, 3, None, 210);
    sponsor(&mut c, ALICE, &bot, 10 * ONE, 211); // fine once settled
    let mut h = 220;
    for _ in 0..5 {
        let s = start(&mut c, GUEST, h);
        settle(&mut c, s.match_id, 3, None, h + 5);
        h += 10;
    }
    start(&mut c, GUEST, h); // pending again
    ctx(ALICE, h + 2, NearToken::from_yoctonear(0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.unsponsor(bot.clone())));
    assert!(r.is_err(), "no withdrawing while a match is pending");
}

#[test]
fn a_pool_closes_only_after_the_retired_bots_escrow_comes_back() {
    let mut c = setup();
    ctx(RELAY, 101, STORAGE_DEPOSIT);
    c.storage_deposit(Some(acc("g-2222.relay.test")), None);
    grant(&mut c, ALICE, 50 * ONE);
    let bot = c.slots[2].clone(); // idx 3
    sponsor(&mut c, ALICE, &bot, 20 * ONE, 150);
    // drain the bot (test only) so that after one entry it can't pay the next
    let house = c.house.clone();
    let keep = ENTRY_FEE + ENTRY_FEE / 2;
    let b = c.balance(&bot);
    c.move_tokens(&bot, &house, b - keep, "test");
    let mut f = c.load_fighter(&bot).unwrap();
    f.record.matches = 3;
    c.save_fighter(f);
    let s1 = start(&mut c, GUEST, 200); // pays an entry: escrow > 0, wallet < entry
    let _s2 = start(&mut c, "g-2222.relay.test", 201); // can't pay: retires, but its s1 entry is pending
    assert_ne!(c.slots[2], bot, "retired at start");
    assert!(c.sponsors.get(&bot).is_some(), "pool still open while s1 holds its entry");
    let alice0 = bal(&c, ALICE);
    // s1 settles and the retired bot WINS it: the prize, dividend and closing all reach the sponsor
    let r = settle(&mut c, s1.match_id, 3, None, 210);
    assert_eq!(r.prize_to, bot);
    assert!(c.sponsors.get(&bot).is_none(), "closed after the escrow came back");
    assert!(c.get_sponsorships(acc(ALICE)).is_empty());
    let got = bal(&c, ALICE) - alice0;
    assert!(got > r.prize.0 * crate::market::SPONSOR_CUT_BPS / 10_000, "dividend + share of the final bankroll: {got}");
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
    let s = start(&mut c, "dave.testnet", 600);
    assert_eq!(s.player_paid.0, 0, "plays free (and prize-ineligible) for now");
    assert_eq!(c.welcome_credit(&acc("dave.testnet")), WELCOME_STAKE, "credit untouched");
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
