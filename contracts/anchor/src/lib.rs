//! NOXARA mainnet anchor (option B). Append-only: one record per UTC day, written only by the contract
//! account itself (the match server holds a function-call key on it limited to `anchor`), never changed.
//!   anchor(input = "YYYY-MM-DD" ++ record bytes)   record: JSON written by scripts/anchor-daily.ts
//!   get(input = "YYYY-MM-DD") -> record bytes       (view; empty if none)
//!   last() -> "YYYY-MM-DD" of the latest record      (view; empty if none)
//! No near-sdk, no allocator, no JSON parsing: the contract stores bytes and enforces who/when/once.
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

fn valid_day(d: &[u8]) -> bool {
    d.len() == DAY
        && d.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

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
        if n <= DAY || !valid_day(&buf[..DAY]) {
            fail("input: YYYY-MM-DD then the record");
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
