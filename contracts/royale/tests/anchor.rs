// Option B mainnet anchor (contracts/anchor): append-only daily records, writable only by the anchor account itself.
use near_workspaces::types::NearToken;

const WASM: &str = "../anchor/anchor.wasm";

#[tokio::test]
async fn anchor_is_append_only_and_owner_written() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let root = w.root_account()?;
    let wasm = std::fs::read(WASM)?;
    assert!(wasm.len() < 2048, "anchor wasm stays tiny: {} B", wasm.len());
    let anchor = root.create_subaccount("anchor").initial_balance(NearToken::from_near(1)).transact().await?.into_result()?;
    let c = anchor.deploy(&wasm).await?.into_result()?;
    let rec = br#"{"matches":12,"root":"ab12","testnet":"royale.br-7e8492.testnet","supply":"2933","house":"712"}"#;
    let mut arg = b"2026-11-14".to_vec();
    arg.extend_from_slice(rec);

    // someone else can't write
    let eve = root.create_subaccount("eve").initial_balance(NearToken::from_near(1)).transact().await?.into_result()?;
    let r = eve.call(c.id(), "anchor").args(arg.clone()).transact().await?;
    assert!(r.is_failure(), "a stranger must not write");

    // the anchor account writes once
    anchor.call(c.id(), "anchor").args(arg.clone()).transact().await?.into_result()?;
    let got = c.view("get").args(b"2026-11-14".to_vec()).await?;
    assert_eq!(got.result, rec.to_vec());
    let last = c.view("last").args(vec![]).await?;
    assert_eq!(last.result, b"2026-11-14".to_vec());

    // never overwritten, never backdated, bad input refused, deposits refused
    assert!(anchor.call(c.id(), "anchor").args(arg.clone()).transact().await?.is_failure(), "no overwrite");
    let mut old = b"2026-11-13".to_vec();
    old.extend_from_slice(b"{}");
    assert!(anchor.call(c.id(), "anchor").args(old).transact().await?.is_failure(), "no backdating");
    assert!(anchor.call(c.id(), "anchor").args(b"not-a-day{}".to_vec()).transact().await?.is_failure(), "bad day");
    let mut next = b"2026-11-15".to_vec();
    next.extend_from_slice(b"{}");
    assert!(anchor.call(c.id(), "anchor").args(next.clone()).deposit(NearToken::from_yoctonear(1)).transact().await?.is_failure(), "no deposit");
    let big = [b"2026-11-15".to_vec(), vec![b'x'; 2049]].concat();
    assert!(anchor.call(c.id(), "anchor").args(big).transact().await?.is_failure(), "size cap");
    anchor.call(c.id(), "anchor").args(next).transact().await?.into_result()?;
    assert_eq!(c.view("last").args(vec![]).await?.result, b"2026-11-15".to_vec());
    assert!(c.view("get").args(b"2026-01-01".to_vec()).await?.result.is_empty());

    // storage actually used by one record (for the cost table)
    let st = anchor.view_account().await?.storage_usage;
    println!("anchor storage after 2 records: {st} bytes");
    Ok(())
}
