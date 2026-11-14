//! NOXARA mainnet anchor (option B). Append-only: one record per UTC day, written only by the contract
//! account itself (the match server holds a function-call key on it limited to `anchor`), never changed.
//!   anchor(input = "YYYY-MM-DD" ++ record bytes)   record: JSON written by scripts/anchor-daily.ts
//!   get(input = "YYYY-MM-DD") -> record bytes       (view; empty if none)
//!   last() -> "YYYY-MM-DD" of the latest record      (view; empty if none)
//! No near-sdk, no allocator, no JSON parsing: the contract stores bytes and enforces who/when/once.
//! "When": a record's day must be a real calendar date between (block day − 2) and the block day, so even a
//! leaked writer key can add at most one bogus record per real day and can never block future days.
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[allow(dead_code)]
extern "C" {
    fn input(register_id: u64);
    fn register_len(register_id: u64) -> u64;
    fn read_register(register_id: u64, ptr: u64);
    fn current_account_id(register_id: u64);
    fn predecessor_account_id(register_id: u64);
    fn attached_deposit(balance_ptr: u64);
    fn block_timestamp() -> u64;
    fn storage_write(key_len: u64, key_ptr: u64, value_len: u64, value_ptr: u64, register_id: u64) -> u64;
    fn storage_read(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
    fn storage_has_key(key_len: u64, key_ptr: u64) -> u64;
    fn value_return(value_len: u64, value_ptr: u64);
    fn panic_utf8(len: u64, ptr: u64) -> !;
}

const MAX: usize = 2048; // record size cap (bytes)
const DAY: usize = 10; // "YYYY-MM-DD"
static mut BUF: [u8; MAX + DAY] = [0; MAX + DAY];
static mut A: [u8; 64] = [0; 64];
static mut B: [u8; 64] = [0; 64];
const LAST: &[u8] = b"last";

fn fail(msg: &str) -> ! {
    unsafe { panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

/// Reads register 0 into `dst`, returns its length (fails if it doesn't fit).
unsafe fn reg(dst: *mut u8, cap: usize) -> usize {
    let n = register_len(0) as usize;
    if n > cap {
        fail("too long");
    }
    read_register(0, dst as u64);
    n
}

fn num(d: &[u8]) -> i64 {
    d.iter().fold(0i64, |a, c| a * 10 + (c - b'0') as i64)
}

/// "YYYY-MM-DD" -> days since 1970-01-01 (proleptic Gregorian; H. Hinnant's days_from_civil), None if not a real date.
fn day_number(d: &[u8]) -> Option<i64> {
    if d.len() != DAY || !d.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() }) {
        return None;
    }
    let (y, m, dd) = (num(&d[0..4]), num(&d[5..7]), num(&d[8..10]));
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&m) || dd < 1 || dd > dim[(m - 1) as usize] {
        return None;
    }
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + dd - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// How many days back a record may still be written (a missed day can be filled the next day).
const BACKFILL_DAYS: i64 = 2;

#[no_mangle]
pub extern "C" fn anchor() {
    unsafe {
        // only the contract account itself (its owner, or the server's function-call key on it)
        current_account_id(0);
        let na = reg(core::ptr::addr_of_mut!(A) as *mut u8, 64);
        predecessor_account_id(0);
        let nb = reg(core::ptr::addr_of_mut!(B) as *mut u8, 64);
        let a = &*core::ptr::addr_of!(A);
        let b = &*core::ptr::addr_of!(B);
        if na != nb || a[..na] != b[..nb] {
            fail("only the anchor account can write");
        }
        let mut dep = [0u8; 16];
        attached_deposit(dep.as_mut_ptr() as u64);
        if dep != [0u8; 16] {
            fail("no deposit");
        }
        input(0);
        let n = reg(core::ptr::addr_of_mut!(BUF) as *mut u8, MAX + DAY);
        let buf = &*core::ptr::addr_of!(BUF);
        if n <= DAY {
            fail("input: YYYY-MM-DD then the record");
        }
        // the day must be a real date, not in the future, and at most BACKFILL_DAYS old (tied to block time)
        let today = (block_timestamp() / 86_400_000_000_000) as i64;
        match day_number(&buf[..DAY]) {
            Some(d) if d <= today && d + BACKFILL_DAYS >= today => {}
            Some(_) => fail("day must be today or up to 2 days back"),
            None => fail("input: YYYY-MM-DD then the record"),
        }
        let key = &buf[..DAY];
        if storage_has_key(DAY as u64, key.as_ptr() as u64) == 1 {
            fail("this day is already anchored");
        }
        // days only move forward
        if storage_read(LAST.len() as u64, LAST.as_ptr() as u64, 1) == 1 {
            let mut prev = [0u8; DAY];
            read_register(1, prev.as_mut_ptr() as u64);
            if key <= &prev[..] {
                fail("days must increase");
            }
        }
        storage_write(DAY as u64, key.as_ptr() as u64, (n - DAY) as u64, buf[DAY..].as_ptr() as u64, 2);
        storage_write(LAST.len() as u64, LAST.as_ptr() as u64, DAY as u64, key.as_ptr() as u64, 2);
    }
}

#[no_mangle]
pub extern "C" fn get() {
    unsafe {
        input(0);
        let mut d = [0u8; DAY];
        if register_len(0) as usize != DAY {
            fail("input: YYYY-MM-DD");
        }
        read_register(0, d.as_mut_ptr() as u64);
        if storage_read(DAY as u64, d.as_ptr() as u64, 1) == 1 {
            let n = register_len(1) as usize;
            if n > MAX {
                fail("corrupt");
            }
            let buf = &mut *core::ptr::addr_of_mut!(BUF);
            read_register(1, buf.as_mut_ptr() as u64);
            value_return(n as u64, buf.as_ptr() as u64);
        }
    }
}

#[no_mangle]
pub extern "C" fn last() {
    unsafe {
        if storage_read(LAST.len() as u64, LAST.as_ptr() as u64, 1) == 1 {
            let mut d = [0u8; DAY];
            read_register(1, d.as_mut_ptr() as u64);
            value_return(DAY as u64, d.as_ptr() as u64);
        }
    }
}
