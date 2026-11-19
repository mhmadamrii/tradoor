//! The order system's signer in the browser, behind the plain interface Frost
//! Script's module has: the trade worker writes bytes into this module's
//! memory, calls one function, and reads the answer from `tr_out`. It imports
//! nothing, so it cannot reach the page, the network or storage.
//!
//! A key handed in is overwritten with zeros as soon as it has been read, so it
//! lies in this memory no longer than one call.
//!
//! - `tr_keccak(data, len)`: the Keccak-256 of the bytes, 32 bytes out.
//! - `tr_address(key)`: the address a key signs as, 20 bytes out; 0 for no key.
//! - `tr_sign(digest, key)`: `r`, `s`, `v` of a 32-byte digest, 65 bytes out.
//! - `tr_hl_sign(action, len, nonce, vault, expires, mainnet, key)`: a
//!   Hyperliquid action, packed as MessagePack, signed as its SDK signs it;
//!   `vault` null for none, `expires` below zero for none.

use std::cell::UnsafeCell;

use tradoor_trade::{address, hyperliquid, keccak, sign};

struct Out(UnsafeCell<[u8; 65]>);
// One thread in a browser module: nothing else reads or writes it.
unsafe impl Sync for Out {}
static OUT: Out = Out(UnsafeCell::new([0; 65]));

fn put(bytes: &[u8]) {
    // SAFETY: one thread, and no reference to OUT is held across calls.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), OUT.0.get().cast::<u8>(), bytes.len().min(65)) }
}

/// The key, read and then wiped where the caller wrote it.
unsafe fn take_key(key: *mut u8) -> [u8; 32] {
    let mut k = [0u8; 32];
    // SAFETY: the caller hands 32 bytes it allocated with `tr_alloc`.
    unsafe {
        std::ptr::copy_nonoverlapping(key, k.as_mut_ptr(), 32);
        std::ptr::write_bytes(key, 0, 32);
    }
    k
}

#[unsafe(no_mangle)]
pub extern "C" fn tr_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` from one `tr_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tr_free(ptr: *mut u8, len: usize) {
    // SAFETY: as allocated by `tr_alloc`, with nothing in it to drop.
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) }
}

#[unsafe(no_mangle)]
pub extern "C" fn tr_out() -> *const u8 {
    OUT.0.get() as *const u8
}

/// # Safety
/// `len` bytes at `data`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tr_keccak(data: *const u8, len: usize) {
    // SAFETY: as the caller says.
    let bytes = unsafe { std::slice::from_raw_parts(data, len) };
    put(&keccak(bytes));
}

/// # Safety
/// 32 bytes at `key`, which are wiped.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tr_address(key: *mut u8) -> u32 {
    let mut k = unsafe { take_key(key) };
    let a = address(&k);
    k.fill(0);
    match a {
        Some(a) => {
            put(&a);
            1
        }
        None => 0,
    }
}

/// # Safety
/// 32 bytes at `digest` and at `key`, which are wiped.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tr_sign(digest: *const u8, key: *mut u8) -> u32 {
    let mut k = unsafe { take_key(key) };
    let mut d = [0u8; 32];
    // SAFETY: as the caller says.
    unsafe { std::ptr::copy_nonoverlapping(digest, d.as_mut_ptr(), 32) };
    let s = sign(&d, &k);
    k.fill(0);
    match s {
        Some(s) => {
            put(&s);
            1
        }
        None => 0,
    }
}

/// # Safety
/// `len` bytes at `action`, 20 at `vault` unless it is null, 32 at `key`, which are wiped.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tr_hl_sign(action: *const u8, len: usize, nonce: f64, vault: *const u8, expires: f64, mainnet: u32, key: *mut u8) -> u32 {
    let mut k = unsafe { take_key(key) };
    // SAFETY: as the caller says.
    let packed = unsafe { std::slice::from_raw_parts(action, len) };
    let v = (!vault.is_null()).then(|| {
        let mut a = [0u8; 20];
        unsafe { std::ptr::copy_nonoverlapping(vault, a.as_mut_ptr(), 20) };
        a
    });
    let digest = hyperliquid::l1_digest(packed, nonce as u64, v.as_ref(), (expires >= 0.0).then_some(expires as u64), mainnet != 0);
    let s = sign(&digest, &k);
    k.fill(0);
    match s {
        Some(s) => {
            put(&s);
            1
        }
        None => 0,
    }
}
