//! End-to-end on a local sandbox node: start (next-block seed) -> settle by the match server ->
//! the bot economy. Build the wasm first: `cargo near build non-reproducible-wasm`.
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{network::Sandbox, Account, Contract, Worker};
use serde_json::{json, Value};

const WASM: &str = "target/near/royale.wasm";
use royale::{BOUNTY_BPS, ENTRY_FEE as E, ONE, POT_TOP_UP as T, RESERVE, STARTER, WEAPON_PRICES};

struct World {
    w: Worker<Sandbox>,
    c: Contract,
    owner: Account,
    server: Account,
    relay: Account,
}

async fn world() -> anyhow::Result<World> {
    let w = near_workspaces::sandbox().await?;
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

async fn start(p: &Account, c: &Contract) -> anyhow::Result<(Value, u64)> {
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
    assert_eq!(ft(c, c.id().as_str()).await?, 9 * E, "9 entries escrowed");
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
    assert_eq!(ft(c, house.as_str()).await?, house0 + (9 * E + T) * 98 / 100 - T, "the house paid the top-up and got the pot");
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
    let bounty = before * BOUNTY_BPS / 10_000;
    assert_eq!(r["bounty_amount"], bounty.to_string());
    assert_eq!(ft(c, &carrier).await?, before - bounty);
    let k = STARTER - E + bounty;
    let k = if k >= WEAPON_PRICES[0] + RESERVE { k - WEAPON_PRICES[0] } else { k };
    assert_eq!(ft(c, &killer).await?, k, "the killer may spend its windfall on a weapon right away");

    // Moss (idx 5) wins everything; the others lose 10 per match until they're broke
    let mut gas_max = 0;
    let pip = s["roster"][2]["account"].as_str().unwrap().to_string();
    for _ in 1..(STARTER / E) {
        let (s, _) = start(&g, c).await?;
        let (r, gas) = settle(&wd.server, c, &s["match_id"], 5, None).await?;
        r.map_err(anyhow::Error::msg)?;
        gas_max = gas_max.max(gas);
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

    // review fix #3: no $BOUNTY -> plays free but can't win: the pot goes to the house
    let (s, _) = start(&alice, c).await?;
    assert_eq!(s["player_paid"], "0");
    let (r, _) = settle(&wd.server, c, &s["match_id"], 0, None).await?;
    let r = r.map_err(anyhow::Error::msg)?;
    assert_eq!(r["prize_to"], house.as_str());
    assert_eq!(ft(c, alice.id().as_str()).await?, 0);

    // the on-ramp: the owner grants from the house treasury (no minting)
    wd.owner.call(c.id(), "house_grant").args_json(json!({"account_id": alice.id(), "amount": (30 * ONE).to_string()})).transact().await?.into_result()?;
    let (s, _) = start(&alice, c).await?;
    assert_eq!(s["player_paid"], E.to_string());
    let (r, _) = settle(&wd.server, c, &s["match_id"], 0, None).await?;
    let r = r.map_err(anyhow::Error::msg)?;
    let prize: u128 = r["prize"].as_str().unwrap().parse()?;
    assert_eq!(r["prize_to"], alice.id().as_str());
    assert_eq!(ft(c, alice.id().as_str()).await?, 30 * ONE - E + prize);

    // review fix #1: abandoning a seeded match forfeits the entry (bots are refunded)
    let (s1, _) = start(&alice, c).await?;
    let before_house = ft(c, &house).await?;
    let (s2, _) = start(&alice, c).await?;
    assert_ne!(s1["match_id"], s2["match_id"]);
    assert_eq!(ft(c, alice.id().as_str()).await?, 30 * ONE - 3 * E + prize, "two entries gone: one forfeited, one in escrow");
    assert_eq!(ft(c, &house).await?, before_house + E);
    let gone: Value = c.view("get_match").args_json(json!({"match_id": s1["match_id"]})).await?.json()?;
    assert_eq!(gone, Value::Null);
    let p: Value = c.view("get_player").args_json(json!({"account_id": alice.id()})).await?.json()?;
    assert_eq!(p["deaths"], 1, "the abandoned match counts as a loss");

    // and can tip a bot with a plain NEP-141 transfer
    let bot = s2["roster"][0]["account"].as_str().unwrap().to_string();
    alice
        .call(c.id(), "ft_transfer")
        .args_json(json!({"receiver_id": bot, "amount": ONE.to_string()}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let meta: Value = c.view("ft_metadata").await?.json()?;
    assert_eq!(meta["symbol"], "BOUNTY");
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
