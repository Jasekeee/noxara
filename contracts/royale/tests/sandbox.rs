//! End-to-end on a local sandbox node: start (next-block seed) -> settle by the match server ->
//! the bot economy. Build the wasm first: `cargo near build non-reproducible-wasm`.
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{network::Sandbox, Account, Contract, Worker};
use serde_json::{json, Value};

const WASM: &str = "target/near/royale.wasm";
/// Same contract built with the sandbox-only `teardown-override` feature (an earlier teardown time):
/// `cargo near build non-reproducible-wasm --features teardown-override --out-dir target/near/override`
const WASM_OVERRIDE: &str = "target/near/override/royale.wasm";
use royale::{entry_fee_for, BOUNTY_BPS, ENTRY_FEE as E, ONE, POT_TOP_UP as T, RESERVE, STARTER, WEAPON_PRICES};

struct World {
    w: Worker<Sandbox>,
    c: Contract,
    owner: Account,
    server: Account,
    relay: Account,
}

async fn world() -> anyhow::Result<World> {
    let w = near_workspaces::sandbox().await?;
    WORKER.with(|x| *x.borrow_mut() = Some(w.clone()));
    let root = w.root_account()?;
    let mk = |n: &'static str, near: u128| {
        let root = root.clone();
        async move { root.create_subaccount(n).initial_balance(NearToken::from_near(near)).transact().await.unwrap().into_result().unwrap() }
    };
    let (owner, server, relay) = (mk("owner", 5).await, mk("server", 5).await, mk("relay", 10).await);
    let ca = mk("royale", 20).await;
    let c = ca.deploy(&std::fs::read(WASM)?).await?.into_result()?;
    let r = c
        .call("new")
        .args_json(json!({"owner": owner.id(), "server": server.id(), "guest_parent": relay.id()}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    println!("new(): {} Tgas", r.total_gas_burnt.as_tgas());
    r.into_result()?;
    Ok(World { w, c, owner, server, relay })
}

/// A guest the way the relayer makes one: `g-*.<relay>` + storage prepaid by the relayer.
async fn guest(wd: &World, name: &str) -> anyhow::Result<Account> {
    let g = wd.relay.create_subaccount(name).initial_balance(NearToken::from_millinear(500)).transact().await?.into_result()?;
    wd.relay
        .call(wd.c.id(), "storage_deposit")
        .args_json(json!({"account_id": g.id()}))
        .deposit(NearToken::from_millinear(20))
        .transact()
        .await?
        .into_result()?;
    Ok(g)
}

thread_local! {
    /// this test's sandbox (each #[tokio::test] runs on its own thread)
    static WORKER: std::cell::RefCell<Option<Worker<Sandbox>>> = const { std::cell::RefCell::new(None) };
}

/// Guests may start one free match per FREE_COOLDOWN_BLOCKS (100): move the sandbox past it first.
async fn start(p: &Account, c: &Contract) -> anyhow::Result<(Value, u64)> {
    if let Some(w) = WORKER.with(|w| w.borrow().clone()) {
        w.fast_forward(101).await?;
    }
    let r = p.call(c.id(), "start_match").gas(Gas::from_tgas(100)).transact().await?;
    let gas = r.total_gas_burnt.as_tgas();
    let v: Value = r.into_result().map_err(|e| anyhow::anyhow!("start_match: {e:?}"))?.json()?;
    Ok((v, gas))
}

fn places(winner: usize) -> Vec<u8> {
    let mut v = vec![0u8; 10];
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

async fn settle(who: &Account, c: &Contract, id: &Value, winner: usize, bounty_killer: Option<u8>) -> anyhow::Result<(Result<Value, String>, u64)> {
    let mut kills = vec![0u8; 10];
    kills[winner] = 2;
    let r = who
        .call(c.id(), "settle_match")
        .args_json(json!({
            "match_id": id, "placements": places(winner), "kills": kills, "bounty_killer": bounty_killer,
            "input_log_hash": "c0ffee".repeat(10), "result_hash": "abc123"
        }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?;
    let gas = r.total_gas_burnt.as_tgas();
    Ok((r.into_result().map_err(|e| format!("{e:?}")).and_then(|x| x.json().map_err(|e| e.to_string())), gas))
}

async fn ft(c: &Contract, a: &str) -> anyhow::Result<u128> {
    let v: String = c.view("ft_balance_of").args_json(json!({"account_id": a})).await?.json()?;
    Ok(v.parse()?)
}

async fn fighters(c: &Contract) -> anyhow::Result<Vec<Value>> {
    Ok(c.view("get_fighters").await?.json()?)
}

#[tokio::test]
async fn guest_match_end_to_end() -> anyhow::Result<()> {
    let wd = world().await?;
    let c = &wd.c;

    // the bots and the house are real accounts with NO access keys
    let fs = fighters(c).await?;
    assert_eq!(fs.len(), 9);
    for f in &fs {
        let id: near_workspaces::AccountId = f["account"].as_str().unwrap().parse()?;
        assert!(wd.w.view_account(&id).await.is_ok(), "{id} exists");
        assert_eq!(wd.w.view_access_keys(&id).await?.len(), 0, "{id} has no keys");
        assert_eq!(f["balance"], STARTER.to_string());
    }
    let house: near_workspaces::AccountId = format!("house.{}", c.id()).parse()?;
    assert_eq!(wd.w.view_access_keys(&house).await?.len(), 0);

    let g = guest(&wd, "g-ab12").await?;
    let (s, gas_start) = start(&g, c).await?;
    println!("start_match + resolve_start: {gas_start} Tgas -> match {} seed {}", s["match_id"], s["seed"]);
    assert!(s["seed"].as_u64().unwrap() > 0);
    assert_eq!(s["guest"], true);
    assert_eq!(s["roster"].as_array().unwrap().len(), 9);
    assert_eq!(s["roster"][0]["upgrades"]["weaponTier"], 0);
    assert_eq!(ft(c, c.id().as_str()).await?, 9 * entry_fee_for(STARTER), "9 entries escrowed");
    let id = s["match_id"].clone();

    // only the server may settle
    let (r, _) = settle(&g, c, &id, 0, None).await?;
    assert!(r.unwrap_err().contains("only the match server"));

    let house0 = ft(c, house.as_str()).await?;
    let (r, gas_settle) = settle(&wd.server, c, &id, 0, None).await?;
    let r = r.map_err(anyhow::Error::msg)?;
    println!("settle_match (guest won): {gas_settle} Tgas");
    assert_eq!(r["prize_to"], house.as_str(), "a guest's pot goes to the house");
    assert_eq!(ft(c, g.id().as_str()).await?, 0, "guests earn zero");
    // economy v2: the House paid the top-up (25 x m, from its own NOX) and got the guest's pot; nothing minted
    let econ: Value = c.view("get_economy").await?.json()?;
    let m: u128 = econ["m_bps"].as_u64().unwrap() as u128;
    let top_up = 25 * ONE * m / 10_000;
    let prize: u128 = r["prize"].as_str().unwrap().parse()?;
    let cut: u128 = r["house_cut"].as_str().unwrap().parse()?;
    let h1 = ft(c, house.as_str()).await?;
    let low = house0 - top_up + prize + cut;
    assert!(h1 >= low && h1 - low < ONE, "house {h1} vs {low} (+ the deflation brake's unburnt part)");
    assert_eq!(econ["minted"], econ["genesis"], "nothing minted after genesis");
    let _ = T;
    let p: Value = c.view("get_player").args_json(json!({"account_id": g.id()})).await?.json()?;
    assert_eq!(p["wins"], 1);
    assert_eq!(p["pending"], Value::Null);
    let m: Value = c.view("get_match").args_json(json!({"match_id": id})).await?.json()?;
    assert_eq!(m["status"], "Settled");
    assert_eq!(m["result"]["input_log_hash"], "c0ffee".repeat(10));

    // settled once
    let (r, _) = settle(&wd.server, c, &id, 3, None).await?;
    assert!(r.unwrap_err().contains("already settled"));

    // a second match: a bot wins and buys its first upgrade right away
    let (s, _) = start(&g, c).await?;
    let (r, gas_settle2) = settle(&wd.server, c, &s["match_id"], 4, None).await?;
    r.map_err(anyhow::Error::msg)?;
    println!("settle_match (bot won + upgrade): {gas_settle2} Tgas");
    let fs = fighters(c).await?;
    assert_eq!(fs[3]["upgrades"]["weaponTier"], 1);
    assert_eq!(fs[3]["record"]["wins"], 1);
    let recent: Vec<Value> = c.view("get_recent_matches").args_json(json!({"n": 5})).await?.json()?;
    assert_eq!(recent.len(), 2);
    Ok(())
}

#[tokio::test]
async fn bounty_retirement_and_rookies() -> anyhow::Result<()> {
    let wd = world().await?;
    let c = &wd.c;
    let g = guest(&wd, "g-cd34").await?;

    // match 1: Ox (idx 2) kills the bounty carrier (Bramble, idx 1, first of the equally rich)
    let (s, _) = start(&g, c).await?;
    assert_eq!(s["bounty_idx"], 1);
    let carrier = s["roster"][0]["account"].as_str().unwrap().to_string();
    let killer = s["roster"][1]["account"].as_str().unwrap().to_string();
    let before = ft(c, &carrier).await?;
    let (r, gas) = settle(&wd.server, c, &s["match_id"], 5, Some(2)).await?;
    let r = r.map_err(anyhow::Error::msg)?;
    println!("settle_match with bounty: {gas} Tgas");
    let taken = before * BOUNTY_BPS / 10_000;
    let bounty: u128 = r["bounty_amount"].as_str().unwrap().parse()?;
    assert!(bounty > taken, "the carrier's 15% + the House rule's bonus");
    assert_eq!(ft(c, &carrier).await?, before - taken);
    let k = STARTER - entry_fee_for(STARTER) + bounty;
    let k = if k >= WEAPON_PRICES[0] + RESERVE { k - WEAPON_PRICES[0] } else { k };
    assert_eq!(ft(c, &killer).await?, k, "the killer may spend its windfall on a weapon right away");

    // Moss (idx 5) wins everything; the others lose 10 per match until they're broke
    let mut gas_max = 0;
    let pip = s["roster"][2]["account"].as_str().unwrap().to_string();
    for _ in 1..40 {
        let (s, _) = start(&g, c).await?;
        let (r, gas) = settle(&wd.server, c, &s["match_id"], 5, None).await?;
        r.map_err(anyhow::Error::msg)?;
        gas_max = gas_max.max(gas);
        if fighters(c).await?[2]["account"] != pip.as_str() {
            break;
        }
    }
    println!("settle_match with retirements + rookies: up to {gas_max} Tgas");
    let fs = fighters(c).await?;
    let retired: Vec<Value> = c.view("get_retired").await?.json()?;
    assert!(retired.iter().any(|f| f["account"] == pip.as_str() && f["status"] == "retired"), "Pip retired broke");
    let rookie = &fs[2];
    assert_eq!(rookie["generation"], 1);
    assert_eq!(rookie["status"], "active");
    assert_eq!(rookie["balance"], STARTER.to_string(), "the house funded the rookie");
    let rid: near_workspaces::AccountId = rookie["account"].as_str().unwrap().parse()?;
    assert!(wd.w.view_account(&rid).await.is_ok(), "the rookie got a real account");
    assert_eq!(wd.w.view_access_keys(&rid).await?.len(), 0, "with no keys");
    // the winner kept upgrading
    assert_eq!(fs[4]["upgrades"]["weaponTier"], 2);
    assert!(fs[4]["bounty"].as_bool().unwrap(), "the richest bot carries the next bounty");
    let cfg: Value = c.view("get_config").await?.json()?;
    println!("config after 10 matches: {cfg}");
    // supply = minted - burned
    let minted: u128 = cfg["total_minted"].as_str().unwrap().parse()?;
    let burned: u128 = cfg["total_burned"].as_str().unwrap().parse()?;
    let supply: String = c.view("ft_total_supply").await?.json()?;
    assert_eq!(supply.parse::<u128>()?, minted - burned);
    Ok(())
}

#[tokio::test]
async fn real_player_pays_and_earns() -> anyhow::Result<()> {
    let wd = world().await?;
    let c = &wd.c;
    let house = format!("house.{}", c.id());
    let alice = wd.w.root_account()?.create_subaccount("alice").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    // not registered yet
    let r = alice.call(c.id(), "start_match").gas(Gas::from_tgas(100)).transact().await?;
    assert!(format!("{:?}", r.into_result().unwrap_err()).contains("register first"));
    alice.call(c.id(), "storage_deposit").args_json(json!({})).deposit(NearToken::from_millinear(20)).transact().await?.into_result()?;
    // owner decision: a real account's registration brings a one-time WELCOME CREDIT (not $BOUNTY)
    let welcome: u128 = 30 * ONE;
    assert_eq!(ft(c, alice.id().as_str()).await?, 0);
    let credit: String = c.view("get_welcome_credit").args_json(json!({"account_id": alice.id()})).await?.json()?;
    assert_eq!(credit, welcome.to_string());
    // it can't be transferred
    let r = alice.call(c.id(), "ft_transfer").args_json(json!({"receiver_id": house, "amount": ONE.to_string()})).deposit(NearToken::from_yoctonear(1)).transact().await?;
    assert!(r.into_result().is_err());

    // a real account with neither credit nor $NOX can't take a free slot (free matches are for guests)
    // (bob was registered by a third party: no credit)
    let bob = wd.w.root_account()?.create_subaccount("bob").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    wd.owner.call(c.id(), "storage_deposit").args_json(json!({"account_id": bob.id()})).deposit(NearToken::from_millinear(20)).transact().await?.into_result()?;
    let r = bob.call(c.id(), "start_match").gas(Gas::from_tgas(100)).transact().await?;
    assert!(format!("{:?}", r.into_result().unwrap_err()).contains("you need $NOX"));

    // alice's credit pays her entry (the house funds it), so she can win real $BOUNTY
    let (s, _) = start(&alice, c).await?;
    assert_eq!(s["player_paid"], E.to_string());
    let (r, _) = settle(&wd.server, c, &s["match_id"], 0, None).await?;
    let r = r.map_err(anyhow::Error::msg)?;
    let prize: u128 = r["prize"].as_str().unwrap().parse()?;
    assert_eq!(r["prize_to"], alice.id().as_str());
    assert_eq!(ft(c, alice.id().as_str()).await?, prize, "winnings are normal $BOUNTY");
    let credit: String = c.view("get_welcome_credit").args_json(json!({"account_id": alice.id()})).await?.json()?;
    assert_eq!(credit, (welcome - E).to_string());

    // review fix #1: abandoning a seeded match forfeits the entry (bots are refunded)
    let (s1, _) = start(&alice, c).await?;
    let before_house = ft(c, &house).await?;
    let (s2, _) = start(&alice, c).await?;
    assert_ne!(s1["match_id"], s2["match_id"]);
    assert_eq!(ft(c, alice.id().as_str()).await?, prize, "entries came from the credit, not her $BOUNTY");
    let credit: String = c.view("get_welcome_credit").args_json(json!({"account_id": alice.id()})).await?.json()?;
    assert_eq!(credit, (welcome - 3 * E).to_string(), "two more entries: one forfeited, one in escrow");
    assert_eq!(ft(c, &house).await?, before_house - E + E, "the house funded the new entry and got the forfeit");
    let gone: Value = c.view("get_match").args_json(json!({"match_id": s1["match_id"]})).await?.json()?;
    assert_eq!(gone, Value::Null);
    let p: Value = c.view("get_player").args_json(json!({"account_id": alice.id()})).await?.json()?;
    assert_eq!(p["deaths"], 1, "the abandoned match counts as a loss");

    // but game wallets refuse plain NEP-141 transfers (audit #2: no inflating a bot for one receipt)
    let bot = s2["roster"][0]["account"].as_str().unwrap().to_string();
    let r = alice.call(c.id(), "ft_transfer").args_json(json!({"receiver_id": bot, "amount": ONE.to_string()})).deposit(NearToken::from_yoctonear(1)).transact().await?;
    assert!(r.into_result().is_err());
    let meta: Value = c.view("ft_metadata").await?.json()?;
    assert_eq!(meta["symbol"], "NOX");
    assert_eq!(meta["name"], "Nox");
    Ok(())
}

#[tokio::test]
async fn full_free_pool_never_blocks_a_paying_player() -> anyhow::Result<()> {
    let wd = world().await?;
    let c = &wd.c;
    wd.owner.call(c.id(), "set_max_free").args_json(json!({"max_free": 2})).transact().await?.into_result()?;
    let g1 = guest(&wd, "g-0001").await?;
    let g2 = guest(&wd, "g-0002").await?;
    let g3 = guest(&wd, "g-0003").await?;
    start(&g1, c).await?;
    start(&g2, c).await?;
    let r = g3.call(c.id(), "start_match").gas(Gas::from_tgas(100)).transact().await?;
    assert!(format!("{:?}", r.into_result().unwrap_err()).contains("free island is full"));
    // a paying player is unaffected
    let alice = wd.w.root_account()?.create_subaccount("alice").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    alice.call(c.id(), "storage_deposit").args_json(json!({})).deposit(NearToken::from_millinear(20)).transact().await?.into_result()?;
    wd.owner.call(c.id(), "house_grant").args_json(json!({"account_id": alice.id(), "amount": (20 * ONE).to_string()})).transact().await?.into_result()?;
    let (s, _) = start(&alice, c).await?;
    assert_eq!(s["player_paid"], E.to_string());
    let cfg: Value = c.view("get_config").await?.json()?;
    assert_eq!((cfg["pending_free"].as_u64(), cfg["pending_paid"].as_u64()), (Some(2), Some(1)));
    // settling a free match frees its slot
    let (r, _) = settle(&wd.server, c, &json!("1"), 3, None).await?;
    r.map_err(anyhow::Error::msg)?;
    start(&g3, c).await?;
    Ok(())
}

async fn registered_real(wd: &World, name: &str, grant: u128) -> anyhow::Result<Account> {
    let a = wd.w.root_account()?.create_subaccount(name).initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    a.call(wd.c.id(), "storage_deposit").args_json(json!({})).deposit(NearToken::from_millinear(20)).transact().await?.into_result()?;
    wd.owner.call(wd.c.id(), "house_grant").args_json(json!({"account_id": a.id(), "amount": grant.to_string()})).transact().await?.into_result()?;
    Ok(a)
}

#[tokio::test]
async fn shares_profit_from_winners_and_go_to_zero_on_retirement() -> anyhow::Result<()> {
    let wd = world().await?;
    let c = &wd.c;
    let g = guest(&wd, "g-5p0n").await?;
    let alice = registered_real(&wd, "alice", 100 * ONE).await?;
    let bob = registered_real(&wd, "bob", 100 * ONE).await?;
    let fs = fighters(c).await?;
    let winner = fs[1]["account"].as_str().unwrap().to_string(); // idx 2 wins every match
    let loser = fs[4]["account"].as_str().unwrap().to_string(); // idx 5 never wins
    for (who, bot) in [(&alice, &winner), (&bob, &loser)] {
        let r = who.call(c.id(), "buy_ipo").args_json(json!({"bot": bot, "shares": 300})).gas(Gas::from_tgas(50)).transact().await?;
        println!("buy_ipo: {} Tgas", r.total_gas_burnt.as_tgas());
        r.into_result()?;
    }
    // a guest can't hold shares
    let r = g.call(c.id(), "buy_ipo").args_json(json!({"bot": winner, "shares": 1})).transact().await?;
    assert!(r.into_result().is_err());
    let market: Vec<Value> = c.view("get_shares_market").await?.json()?;
    assert_eq!(market[1]["sold"], 300);
    assert_eq!(market[1]["holders"], 1);
    // play until the loser retires broke
    let mut n = 0;
    loop {
        let (s, _) = start(&g, c).await?;
        settle(&wd.server, c, &s["match_id"], 2, None).await?.0.map_err(anyhow::Error::msg)?;
        n += 1;
        if fighters(c).await?[4]["account"] != loser.as_str() || n > 40 {
            break;
        }
    }
    println!("loser retired after {n} matches");
    // alice: dividends from the winner's profit
    let h: Vec<Value> = c.view("get_holdings").args_json(json!({"account_id": alice.id()})).await?.json()?;
    let owed: u128 = h[0]["claimable"].as_str().unwrap().parse()?;
    assert!(owed > 0, "dividends from profit");
    let a0 = ft(c, alice.id().as_str()).await?;
    let r = alice.call(c.id(), "claim_dividends").args_json(json!({"bot": winner})).gas(Gas::from_tgas(50)).transact().await?;
    println!("claim_dividends: {} Tgas", r.total_gas_burnt.as_tgas());
    r.into_result()?;
    assert_eq!(ft(c, alice.id().as_str()).await?, a0 + owed);
    // bob: the bot went bankrupt -> shares are worth zero; leftovers go to the House via close_retired
    let bal: String = c.view("mt_balance_of").args_json(json!({"account_id": bob.id(), "token_id": loser})).await?.json()?;
    assert_eq!(bal, "0", "shares of a bankrupt bot go to zero");
    let r = g.call(c.id(), "close_retired").args_json(json!({"bot": loser})).gas(Gas::from_tgas(50)).transact().await?;
    println!("close_retired: {} Tgas", r.total_gas_burnt.as_tgas());
    r.into_result()?;
    let hist: Vec<Value> = c.view("get_history").args_json(json!({"account_id": loser})).await?.json()?;
    assert_eq!(hist[0]["kind"], "retired");
    // progression: the guest earned XP every match
    let p: Value = c.view("get_progress").args_json(json!({"account_id": g.id()})).await?.json()?;
    assert!(p["xp"].as_u64().unwrap() > 0 && p["level"].as_u64().unwrap() >= 2, "{p}");
    let (s, _) = start(&g, c).await?;
    assert_eq!(s["player_level"], p["level"]);
    assert_eq!(s["player_upgrades"], p["upgrades"]);
    let top: Vec<Value> = c.view("get_top").args_json(json!({"kind": "bots", "by": "wins"})).await?.json()?;
    assert_eq!(top[0]["account"], winner.as_str());
    Ok(())
}

#[tokio::test]
async fn migrates_from_the_v1_contract() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let root = w.root_account()?;
    let mk = |n: &'static str| {
        let root = root.clone();
        async move { root.create_subaccount(n).initial_balance(NearToken::from_near(10)).transact().await.unwrap().into_result().unwrap() }
    };
    let (owner, server, relay, ca) = (mk("owner").await, mk("server").await, mk("relay").await, mk("royale").await);
    let c = ca.deploy(&std::fs::read("tests/fixtures/royale_v1_eedaf34.wasm")?).await?.into_result()?;
    c.call("new").args_json(json!({"owner": owner.id(), "server": server.id(), "guest_parent": relay.id()})).gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    let g = relay.create_subaccount("g-0ld").initial_balance(NearToken::from_millinear(500)).transact().await?.into_result()?;
    relay.call(c.id(), "storage_deposit").args_json(json!({"account_id": g.id()})).deposit(NearToken::from_millinear(20)).transact().await?.into_result()?;
    // a settled and a pending V1 match
    let r: Value = g.call(c.id(), "start_match").gas(Gas::from_tgas(100)).transact().await?.into_result()?.json()?;
    settle(&server, &c, &r["match_id"], 3, None).await?.0.map_err(anyhow::Error::msg)?;
    let pending: Value = g.call(c.id(), "start_match").gas(Gas::from_tgas(100)).transact().await?.into_result()?.json()?;
    let supply: String = c.view("ft_total_supply").await?.json()?;
    // upgrade: new code + migrate
    let r = ca.batch(c.id()).deploy(&std::fs::read(WASM)?).call(near_workspaces::operations::Function::new("migrate").gas(Gas::from_tgas(100))).transact().await?;
    println!("deploy + migrate V1 -> V2: {} Tgas", r.total_gas_burnt.as_tgas());
    r.into_result()?;
    let cfg: Value = c.view("get_config").await?.json()?;
    assert_eq!(cfg["version"], 2);
    let supply2: String = c.view("ft_total_supply").await?.json()?;
    assert_eq!(supply, supply2);
    // the V1 pending match settles under V2 (player upgrades default to base)
    let m: Value = c.view("get_match").args_json(json!({"match_id": pending["match_id"]})).await?.json()?;
    assert_eq!(m["player_level"], 1);
    settle(&server, &c, &pending["match_id"], 0, None).await?.0.map_err(anyhow::Error::msg)?;
    let fs: Vec<Value> = c.view("get_fighters").await?.json()?;
    assert_eq!(fs.len(), 9);
    Ok(())
}

#[tokio::test]
async fn a_relayer_paid_deposit_goes_back_to_the_relayer() -> anyhow::Result<()> {
    let wd = world().await?;
    let c = &wd.c;
    let eve = wd.w.root_account()?.create_subaccount("eve").initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
    let relay0 = wd.relay.view_account().await?.balance;
    wd.relay.call(c.id(), "storage_deposit").args_json(json!({"account_id": eve.id()})).deposit(NearToken::from_millinear(20)).transact().await?.into_result()?;
    let eve0 = eve.view_account().await?.balance;
    eve.call(c.id(), "storage_unregister").args_json(json!({"force": true})).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    let eve1 = eve.view_account().await?.balance;
    let relay1 = wd.relay.view_account().await?.balance;
    assert!(eve1 < eve0, "eve gains nothing (pays only gas)");
    // the relayer got its 0.02 back: net cost ≈ gas only
    let spent = relay0.as_yoctonear() - relay1.as_yoctonear();
    assert!(spent < NearToken::from_millinear(5).as_yoctonear(), "relayer spent {spent} yocto");
    Ok(())
}

/// The mainnet topology: the contract on the root account itself, the relayer is also the match
/// server, the owner is a separate account. Play one match, drop the root's full-access key, then
/// the owner's time-locked teardown deletes the root and returns its NEAR.
#[tokio::test]
async fn contract_on_root_relay_as_server_and_teardown() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    WORKER.with(|x| *x.borrow_mut() = Some(w.clone()));
    let top = w.root_account()?;
    let root = top.create_subaccount("noxara").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let owner = top.create_subaccount("boss").initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
    let relay = root.create_subaccount("relay").initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
    let c = root.deploy(&std::fs::read(WASM_OVERRIDE)?).await?.into_result()?;
    // the season ends 15 minutes from now (sandbox time; fast_forward moves the clock); teardown is locked until then
    let now_ms = w.view_block().await?.timestamp() / 1_000_000;
    let season_end = now_ms + 900_000;
    c.call("new")
        .args_json(json!({"owner": owner.id(), "server": relay.id(), "guest_parent": relay.id(), "teardown_beneficiary": owner.id(), "teardown_after_ms": season_end.to_string()}))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    let fs: Vec<Value> = c.view("get_fighters").await?.json()?;
    assert_eq!(fs[0]["account"], format!("brindle.{}", root.id()), "bots are sub-accounts of the root");
    // a guest match, settled by the relay account acting as the match server
    let g = relay.create_subaccount("g-0001").initial_balance(NearToken::from_millinear(500)).transact().await?.into_result()?;
    relay.call(c.id(), "storage_deposit").args_json(json!({"account_id": g.id()})).deposit(NearToken::from_millinear(20)).transact().await?.into_result()?;
    let (s, _) = start(&g, &c).await?;
    settle(&relay, &c, &s["match_id"], 3, None).await?.0.map_err(anyhow::Error::msg)?;
    // remove every full-access key of the root: only the contract's own rules remain
    let keys = w.view_access_keys(root.id()).await?;

    for k in keys {
        let r = root.batch(root.id()).delete_key(k.public_key).transact().await;
        println!("delete key: {:?}", r.as_ref().map(|x| x.is_success()).map_err(|e| e.to_string()));
    }
    assert_eq!(w.view_access_keys(root.id()).await?.len(), 0);
    // locked before the season's end; a griefer's pending match won't block it after
    let r = owner.call(c.id(), "teardown").transact().await?;
    assert!(format!("{:?}", r.into_result().unwrap_err()).contains("locked"));
    w.fast_forward(101).await?;
    let pending: Value = g.call(c.id(), "start_match").gas(Gas::from_tgas(100)).transact().await?.into_result()?.json()?;
    while w.view_block().await?.timestamp() / 1_000_000 < season_end {
        w.fast_forward(500).await?;
    }
    let r = g.call(c.id(), "start_match").gas(Gas::from_tgas(100)).transact().await?;
    assert!(format!("{:?}", r.into_result().unwrap_err()).contains("season is over"));
    let r = g.call(c.id(), "teardown").transact().await?;
    assert!(r.into_result().is_err(), "a stranger can't");
    let _ = pending;
    let root_bal = w.view_account(root.id()).await?.balance;
    let owner0 = owner.view_account().await?.balance;
    let r = owner.call(c.id(), "teardown").gas(Gas::from_tgas(50)).transact().await?;
    println!("teardown: {} Tgas, failures {:?}", r.total_gas_burnt.as_tgas(), r.receipt_failures().len());
    r.into_result()?;
    assert!(w.view_account(root.id()).await.is_err(), "the root account is gone");
    let owner1 = owner.view_account().await?.balance;
    let back = owner1.as_yoctonear() as f64 / 1e24 - owner0.as_yoctonear() as f64 / 1e24;
    println!("root held {:.4} NEAR, the owner got back {back:.4} NEAR", root_bal.as_yoctonear() as f64 / 1e24);
    assert!(back > root_bal.as_yoctonear() as f64 / 1e24 - 0.01);
    Ok(())
}

#[tokio::test]
async fn teardown_refused_before_the_lock() -> anyhow::Result<()> {
    let wd = world().await?; // default lock: 2026-11-25 00:00 UTC
    let r = wd.owner.call(wd.c.id(), "teardown").transact().await?;
    let e = format!("{:?}", r.into_result().unwrap_err());
    assert!(e.contains("locked until 2026-11-25"), "{e}");
    let t: String = wd.c.view("get_teardown_after").await?.json()?;
    assert_eq!(t, "1795564800000");
    Ok(())
}

#[tokio::test]
async fn release_build_ignores_an_earlier_teardown_time_and_init_is_private() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let root = w.root_account()?;
    let ca = root.create_subaccount("game").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let mallory = root.create_subaccount("mallory").initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
    let c = ca.deploy(&std::fs::read(WASM)?).await?.into_result()?;
    // a foreign init (front-running between deploy and init) is refused
    let r = mallory.call(c.id(), "new").args_json(json!({"owner": mallory.id(), "server": mallory.id(), "guest_parent": mallory.id()})).gas(Gas::from_tgas(150)).transact().await?;
    assert!(format!("{:?}", r.into_result().unwrap_err()).contains("private"));
    // the account itself can, but a release build ignores teardown_after_ms
    c.call("new").args_json(json!({"owner": root.id(), "server": root.id(), "guest_parent": root.id(), "teardown_after_ms": "1"})).gas(Gas::from_tgas(150)).transact().await?.into_result()?;
    let t: String = c.view("get_teardown_after").await?.json()?;
    assert_eq!(t, "1795564800000", "release builds can't move the lock");
    // a second init fails
    let r = c.call("new").args_json(json!({"owner": root.id(), "server": root.id(), "guest_parent": root.id()})).gas(Gas::from_tgas(150)).transact().await?;
    assert!(r.into_result().is_err());
    Ok(())
}

// ============================================================ audit #2 (sandbox): the exploits fail

fn receipt_logs(r: &near_workspaces::result::ExecutionFinalResult) -> usize {
    r.receipt_outcomes().iter().map(|o| o.logs.iter().map(|l| l.len()).sum::<usize>()).max().unwrap_or(0)
}

/// CRITICAL: [ft_transfer_call(bot, D), unsponsor(bot)] in ONE batch used to value the stake on a
/// temporarily inflated wallet. Now the transfer into a game wallet is refused, so the batch fails.
#[tokio::test]
async fn audit2_sponsor_drain_via_transfer_call_fails() -> anyhow::Result<()> {
    let wd = world().await?;
    let c = &wd.c;
    let fs = fighters(c).await?;
    let bot = fs[1]["account"].as_str().unwrap().to_string();
    let a = wd.w.root_account()?.create_subaccount("attacker").initial_balance(NearToken::from_near(3)).transact().await?.into_result()?;
    a.call(c.id(), "storage_deposit").args_json(json!({})).deposit(NearToken::from_millinear(20)).transact().await?.into_result()?;
    for _ in 0..3 {
        wd.owner.call(c.id(), "house_grant").args_json(json!({"account_id": a.id(), "amount": (100 * ONE).to_string()})).transact().await?.into_result()?;
    }
    a.call(c.id(), "buy_ipo").args_json(json!({"bot": bot, "shares": 300})).gas(Gas::from_tgas(50)).transact().await?.into_result()?;
    let g = guest(&wd, "g-0d1a").await?;
    for _ in 0..5 {
        let (s, _) = start(&g, c).await?;
        settle(&wd.server, c, &s["match_id"], 5, None).await?.0.map_err(anyhow::Error::msg)?;
    }
    let a0 = ft(c, a.id().as_str()).await?;
    let bot0 = ft(c, &bot).await?;
    let r = a
        .batch(c.id())
        .call(near_workspaces::operations::Function::new("ft_transfer_call").args_json(json!({"receiver_id": bot, "amount": a0.to_string(), "msg": ""})).deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(100)))
        .call(near_workspaces::operations::Function::new("claim_dividends").args_json(json!({"bot": bot})).gas(Gas::from_tgas(50)))
        .transact()
        .await?;
    let e = format!("{:?}", r.into_result().unwrap_err());
    assert!(e.contains("game wallets only receive"), "{e}");
    assert_eq!(ft(c, a.id().as_str()).await?, a0, "nothing moved");
    assert_eq!(ft(c, &bot).await?, bot0);
    let h: Vec<Value> = c.view("get_holdings").args_json(json!({"account_id": a.id()})).await?.json()?;
    assert_eq!(h[0]["shares"], 300, "the shares are untouched");
    // the house too
    let house = format!("house.{}", c.id());
    let r = a.call(c.id(), "ft_transfer_call").args_json(json!({"receiver_id": house, "amount": ONE.to_string(), "msg": ""})).deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(100)).transact().await?;
    assert!(r.into_result().is_err());
    Ok(())
}

/// MEDIUM: 12 sponsors with 64-char names on a bot that wins AND claims the bounty.
#[tokio::test]
async fn audit2_settle_with_double_dividends_fits_the_log_limit() -> anyhow::Result<()> {
    let wd = world().await?;
    let c = &wd.c;
    let top = wd.w.root_account()?;
    let fs = fighters(c).await?;
    let quillon = fs[1]["account"].as_str().unwrap().to_string();
    // NEP-141 transfers into bots are refused now, so a bot's bankroll only grows by playing: with the
    // 30% cap, a 100-NOX bot takes 4 sponsors of 10 (the 12-sponsor worst case is the unit test
    // audit2_settle_logs_k*, which funds the bot directly)
    for i in 0..4 {
        let name = format!("{i:02}{}", "s".repeat(52)); // 64 chars with ".test.near"
        let s = top.create_subaccount(&name).initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
        wd.relay.call(c.id(), "storage_deposit").args_json(json!({"account_id": s.id()})).deposit(NearToken::from_millinear(20)).transact().await?.into_result()?;
        wd.owner.call(c.id(), "house_grant").args_json(json!({"account_id": s.id(), "amount": (10 * ONE).to_string()})).transact().await?.into_result()?;
        s.call(c.id(), "buy_ipo").args_json(json!({"bot": quillon, "shares": 75})).gas(Gas::from_tgas(50)).transact().await?.into_result()?;
    }
    let g = guest(&wd, "g-d1v1").await?;
    let (s, _) = start(&g, c).await?;
    let mut kills = vec![0u8; 10];
    kills[2] = 2;
    let bk = s["bounty_idx"].as_u64().map(|b| if b == 2 { 1 } else { 2 });
    let killer_is_quillon = s["bounty_idx"] != 2;
    let r = wd
        .server
        .call(c.id(), "settle_match")
        .args_json(json!({"match_id": s["match_id"], "placements": places(2), "kills": kills, "bounty_killer": if killer_is_quillon { Some(2u8) } else { bk.map(|x| x as u8) }, "input_log_hash": "c0ffee".repeat(10), "result_hash": "abc123"}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let logs = receipt_logs(&r);
    println!("settle with 4 long-named sponsors (prize + bounty dividends): {} Tgas, {logs} B of logs in the largest receipt", r.total_gas_burnt.as_tgas());
    r.into_result()?;
    assert!(logs < 16_384);
    Ok(())
}

/// LOW: teardown with many pending matches now closes them in batches of 8 (call again).
#[tokio::test]
async fn audit2_teardown_with_many_pending_matches() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    WORKER.with(|x| *x.borrow_mut() = Some(w.clone()));
    let top = w.root_account()?;
    let root = top.create_subaccount("noxara").initial_balance(NearToken::from_near(30)).transact().await?.into_result()?;
    let owner = top.create_subaccount("boss").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let relay = root.create_subaccount("relay").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let c = root.deploy(&std::fs::read(WASM_OVERRIDE)?).await?.into_result()?;
    let season_end = w.view_block().await?.timestamp() / 1_000_000 + 900_000;
    c.call("new")
        .args_json(json!({"owner": owner.id(), "server": relay.id(), "guest_parent": relay.id(), "teardown_beneficiary": owner.id(), "teardown_after_ms": season_end.to_string()}))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    for i in 0..15 {
        let g = relay.create_subaccount(&format!("g-{i:04}")).initial_balance(NearToken::from_millinear(200)).transact().await?.into_result()?;
        relay.call(c.id(), "storage_deposit").args_json(json!({"account_id": g.id()})).deposit(NearToken::from_millinear(20)).transact().await?.into_result()?;
        g.call(c.id(), "start_match").gas(Gas::from_tgas(150)).transact().await?.into_result()?;
    }
    while w.view_block().await?.timestamp() / 1_000_000 < season_end {
        w.fast_forward(500).await?;
    }
    let mut calls = 0;
    while w.view_account(c.id()).await.is_ok() {
        let r = owner.call(c.id(), "teardown").gas(Gas::from_tgas(300)).transact().await?;
        calls += 1;
        println!("teardown call {calls}: {} Tgas, {} B of logs", r.total_gas_burnt.as_tgas(), receipt_logs(&r));
        assert!(receipt_logs(&r) < 16_384);
        r.into_result()?;
        assert!(calls <= 3);
    }
    assert_eq!(calls, 2, "8 + 7 pending matches, then the account is deleted");
    Ok(())
}

/// HIGH: a large state blocks DeleteAccount; teardown_clear shrinks it in batches, then teardown works.
#[tokio::test]
async fn audit2_large_state_cleared_then_deleted() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    WORKER.with(|x| *x.borrow_mut() = Some(w.clone()));
    let top = w.root_account()?;
    let root = top.create_subaccount("noxara").initial_balance(NearToken::from_near(60)).transact().await?.into_result()?;
    let owner = top.create_subaccount("boss").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let relay = root.create_subaccount("relay").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    let c = root.deploy(&std::fs::read(WASM_OVERRIDE)?).await?.into_result()?;
    let code_len = std::fs::read(WASM_OVERRIDE)?.len() as u64;
    let season_end = w.view_block().await?.timestamp() / 1_000_000 + 1_800_000;
    c.call("new")
        .args_json(json!({"owner": owner.id(), "server": relay.id(), "guest_parent": relay.id(), "teardown_beneficiary": owner.id(), "teardown_after_ms": season_end.to_string()}))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?
        .into_result()?;
    // grow the state: 60 guests, one settled match each
    let mut guests = vec![];
    for i in 0..60 {
        let g = relay.create_subaccount(&format!("g-{i:04}")).initial_balance(NearToken::from_millinear(200)).transact().await?.into_result()?;
        relay.call(c.id(), "storage_deposit").args_json(json!({"account_id": g.id()})).deposit(NearToken::from_millinear(20)).transact().await?.into_result()?;
        let v: Value = g.call(c.id(), "start_match").gas(Gas::from_tgas(150)).transact().await?.into_result()?.json()?;
        settle(&relay, &c, &v["match_id"], 5, None).await?.0.map_err(anyhow::Error::msg)?;
        guests.push(g.id().to_string());
    }
    let state = w.view_account(c.id()).await?.storage_usage - code_len;
    println!("state: {state} bytes (+ {code_len} code)");
    assert!(state >= 60_000, "{state}");
    while w.view_block().await?.timestamp() / 1_000_000 < season_end {
        w.fast_forward(500).await?;
    }
    // deleting right away fails (large state) and loses nothing
    let r = owner.call(c.id(), "teardown").gas(Gas::from_tgas(300)).transact().await?;
    let still_there = w.view_account(c.id()).await.is_ok();
    println!("teardown with {state} B of state: deleted = {}, failures {}", !still_there, r.receipt_failures().len());
    assert!(still_there, "NEAR refuses to delete an account with a large state");
    // the fallback works meanwhile
    let o0 = owner.view_account().await?.balance.as_yoctonear();
    owner.call(c.id(), "withdraw_excess").args_json(json!({"amount": NearToken::from_near(1).as_yoctonear().to_string()})).gas(Gas::from_tgas(30)).transact().await?.into_result()?;
    assert!(owner.view_account().await?.balance.as_yoctonear() > o0 + NearToken::from_millinear(990).as_yoctonear());
    // clear in batches (players from the chain's storage_deposit history: here, the guests)
    let mut calls = 0;
    loop {
        let batch: Vec<String> = guests.drain(..guests.len().min(40)).collect();
        let r = owner.call(c.id(), "teardown_clear").args_json(json!({"players": batch, "max_matches": 60, "max_rookies": 8})).gas(Gas::from_tgas(300)).transact().await?;
        calls += 1;
        println!("teardown_clear {calls}: {} Tgas, {} B logs", r.total_gas_burnt.as_tgas(), receipt_logs(&r));
        let p: Value = r.into_result()?.json()?;
        if p["done"] == true && guests.is_empty() {
            break;
        }
        assert!(calls < 10);
    }
    let state = w.view_account(c.id()).await?.storage_usage - code_len;
    println!("state after clearing: {state} bytes");
    let root_bal = w.view_account(c.id()).await?.balance.as_yoctonear();
    let o1 = owner.view_account().await?.balance.as_yoctonear();
    owner.call(c.id(), "teardown").gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    assert!(w.view_account(c.id()).await.is_err(), "deleted");
    let got = owner.view_account().await?.balance.as_yoctonear() - o1;
    println!("the beneficiary got {:.4} of {:.4} NEAR", got as f64 / 1e24, root_bal as f64 / 1e24);
    assert!(got + NearToken::from_millinear(10).as_yoctonear() > root_bal);
    Ok(())
}
