// Option B mainnet anchor (contracts/anchor): append-only daily records, writable only by the anchor account itself,
// only for real dates between (block day - 2) and the block day.
use near_workspaces::types::NearToken;

const WASM: &str = "../anchor/target/near/anchor.wasm";

/// "YYYY-MM-DD" for `days` since 1970-01-01 (civil_from_days).
fn ymd(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

#[tokio::test]
async fn anchor_is_append_only_owner_written_and_tied_to_block_time() -> anyhow::Result<()> {
    let w = near_workspaces::sandbox().await?;
    let root = w.root_account()?;
    let wasm = std::fs::read(WASM)?;
    assert!(wasm.len() < 4096, "anchor wasm stays tiny: {} B", wasm.len());
    let anchor = root.create_subaccount("anchor").initial_balance(NearToken::from_near(1)).transact().await?.into_result()?;
    let c = anchor.deploy(&wasm).await?.into_result()?;
    let now_ns = w.view_block().await?.timestamp();
    let today = (now_ns / 86_400_000_000_000) as i64;
    let (d0, d1, d2, dfut, dold) = (ymd(today - 1), ymd(today), ymd(today + 1), ymd(today + 400), ymd(today - 3));
    let with = |d: &str, rec: &[u8]| [d.as_bytes(), rec].concat();
    let rec = br#"{"matches":12,"root":"ab12","testnet":"royale.br-7e8492.testnet","supply":"2933","house":"712"}"#;

    // a stranger can't write
    let eve = root.create_subaccount("eve").initial_balance(NearToken::from_near(1)).transact().await?.into_result()?;
    assert!(eve.call(c.id(), "anchor").args(with(&d0, rec)).transact().await?.is_failure(), "a stranger must not write");

    // time rules: no future day, no far-future bricking, no stale day, no fake dates
    for bad in [d2.clone(), dfut.clone(), "9999-12-31".into(), dold.clone(), "2026-02-30".into(), "2026-13-01".into(), "not-a-day!".into()] {
        assert!(anchor.call(c.id(), "anchor").args(with(&bad, b"{}")).transact().await?.is_failure(), "must refuse {bad}");
    }

    // yesterday (backfill) then today; read back
    anchor.call(c.id(), "anchor").args(with(&d0, rec)).transact().await?.into_result()?;
    assert_eq!(c.view("get").args(d0.as_bytes().to_vec()).await?.result, rec.to_vec());
    anchor.call(c.id(), "anchor").args(with(&d1, b"{}")).transact().await?.into_result()?;
    assert_eq!(c.view("last").args(vec![]).await?.result, d1.as_bytes().to_vec());

    // never overwritten or backdated; deposits and oversize refused
    assert!(anchor.call(c.id(), "anchor").args(with(&d1, rec)).transact().await?.is_failure(), "no overwrite");
    assert!(anchor.call(c.id(), "anchor").args(with(&d0, b"{}")).transact().await?.is_failure(), "no backdating");
    assert!(anchor.call(c.id(), "anchor").args(with(&d1, b"{}")).deposit(NearToken::from_yoctonear(1)).transact().await?.is_failure(), "no deposit");
    assert!(anchor.call(c.id(), "anchor").args(with(&d1, &[b'x'; 2049])).transact().await?.is_failure(), "size cap");
    assert!(c.view("get").args(b"2026-01-01".to_vec()).await?.result.is_empty());

    println!("anchor storage after 2 records: {} bytes", anchor.view_account().await?.storage_usage);
    Ok(())
}
