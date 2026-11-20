//! Signatures checked against hyperliquid-python-sdk's own tests (tests/signing_test.py),
//! whose key and expected `r`, `s`, `v` are copied here.

use crate::hyperliquid::{action_hash, l1_digest};
use crate::{address, keccak, sign};

/// MessagePack as Python's `msgpack.packb` writes the few shapes an action has.
enum V<'a> {
    S(&'a str),
    U(u64),
    B(bool),
    A(Vec<V<'a>>),
    M(Vec<(&'a str, V<'a>)>),
}

fn pack(v: &V, out: &mut Vec<u8>) {
    match v {
        V::S(s) => {
            let n = s.len();
            if n < 32 {
                out.push(0xa0 | n as u8);
            } else {
                out.push(0xd9);
                out.push(n as u8);
            }
            out.extend_from_slice(s.as_bytes());
        }
        V::U(n) => match *n {
            0..=0x7f => out.push(*n as u8),
            0x80..=0xff => out.extend_from_slice(&[0xcc, *n as u8]),
            0x100..=0xffff => {
                out.push(0xcd);
                out.extend_from_slice(&(*n as u16).to_be_bytes());
            }
            0x1_0000..=0xffff_ffff => {
                out.push(0xce);
                out.extend_from_slice(&(*n as u32).to_be_bytes());
            }
            _ => {
                out.push(0xcf);
                out.extend_from_slice(&n.to_be_bytes());
            }
        },
        V::B(b) => out.push(if *b { 0xc3 } else { 0xc2 }),
        V::A(items) => {
            out.push(0x90 | items.len() as u8);
            for i in items {
                pack(i, out);
            }
        }
        V::M(entries) => {
            out.push(0x80 | entries.len() as u8);
            for (k, val) in entries {
                pack(&V::S(k), out);
                pack(val, out);
            }
        }
    }
}

fn packed(v: V) -> Vec<u8> {
    let mut out = Vec::new();
    pack(&v, &mut out);
    out
}

fn hex(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    let s = if s.len() % 2 == 1 { format!("0{s}") } else { s.to_string() };
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// A number written as hex with its leading zeros dropped, as `to_hex` gives it, back to 32 bytes.
fn word_of(s: &str) -> [u8; 32] {
    let b = hex(s);
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}

const KEY: &str = "0x0123456789012345678901234567890123456789012345678901234567890123";

fn key() -> [u8; 32] {
    word_of(KEY)
}

fn check(digest: [u8; 32], r: &str, s: &str, v: u8) {
    let sig = sign(&digest, &key()).expect("a key");
    assert_eq!(&sig[..32], &word_of(r), "r");
    assert_eq!(&sig[32..64], &word_of(s), "s");
    assert_eq!(sig[64], v, "v");
}

fn dummy() -> Vec<u8> {
    // {"type": "dummy", "num": float_to_int_for_hashing(1000)}
    packed(V::M(vec![("type", V::S("dummy")), ("num", V::U(100_000_000_000))]))
}

fn order(cloid: Option<&'static str>, trigger: bool) -> Vec<u8> {
    let t = if trigger { V::M(vec![("trigger", V::M(vec![("isMarket", V::B(true)), ("triggerPx", V::S("103")), ("tpsl", V::S("sl"))]))]) } else { V::M(vec![("limit", V::M(vec![("tif", V::S("Gtc"))]))]) };
    let mut wire = vec![("a", V::U(1)), ("b", V::B(true)), ("p", V::S("100")), ("s", V::S("100")), ("r", V::B(false)), ("t", t)];
    if let Some(c) = cloid {
        wire.push(("c", V::S(c)));
    }
    packed(V::M(vec![("type", V::S("order")), ("orders", V::A(vec![V::M(wire)])), ("grouping", V::S("na"))]))
}

#[test]
fn keccak_of_nothing() {
    assert_eq!(keccak(b"").to_vec(), hex("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"));
}

#[test]
fn the_address_a_key_signs_as() {
    // The first of the well-known development keys and its account.
    let k = word_of("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    assert_eq!(address(&k).unwrap().to_vec(), hex("f39fd6e51aad88f6f4ce6ab8827279cfffb92266"));
    assert!(address(&[0u8; 32]).is_none(), "zero is no key");
}

#[test]
fn an_action_signs_as_the_sdk_signs_it() {
    check(l1_digest(&dummy(), 0, None, None, true), "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298", "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8", 27);
    check(l1_digest(&dummy(), 0, None, None, false), "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510", "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613", 28);
}

#[test]
fn for_a_vault() {
    let mut vault = [0u8; 20];
    vault.copy_from_slice(&hex("1719884eb866cb12b2287399b15f7db5e7d775ea"));
    check(l1_digest(&dummy(), 0, Some(&vault), None, true), "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239", "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c", 28);
    check(l1_digest(&dummy(), 0, Some(&vault), None, false), "0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b", "0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60", 27);
}

#[test]
fn orders_limit_trigger_and_with_an_id() {
    check(l1_digest(&order(None, false), 0, None, None, true), "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e", "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e", 28);
    check(l1_digest(&order(None, false), 0, None, None, false), "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54", "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5", 27);
    let cloid = Some("0x00000000000000000000000000000001");
    check(l1_digest(&order(cloid, false), 0, None, None, true), "0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3", "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da", 27);
    check(l1_digest(&order(None, true), 0, None, None, true), "0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9", "0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405", 27);
    check(l1_digest(&order(None, true), 0, None, None, false), "0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4", "0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac", 28);
}

#[test]
fn the_hash_of_a_real_order() {
    // test_phantom_agent_creation_matches_production: 0.0147 ETH at 1670.1, IOC, asset 4.
    let wire = V::M(vec![("a", V::U(4)), ("b", V::B(true)), ("p", V::S("1670.1")), ("s", V::S("0.0147")), ("r", V::B(false)), ("t", V::M(vec![("limit", V::M(vec![("tif", V::S("Ioc"))]))]))]);
    let action = packed(V::M(vec![("type", V::S("order")), ("orders", V::A(vec![wire])), ("grouping", V::S("na"))]));
    assert_eq!(action_hash(&action, 1_677_777_606_040, None, None).to_vec(), hex("0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908"));
}

#[test]
fn a_named_action() {
    let action = packed(V::M(vec![("type", V::S("createSubAccount")), ("name", V::S("example"))]));
    check(l1_digest(&action, 0, None, None, true), "0x51096fe3239421d16b671e192f574ae24ae14329099b6db28e479b86cdd6caa7", "0xb71f7d293af92d3772572afb8b102d167a7cef7473388286bc01f52a5c5b423", 27);
    check(l1_digest(&action, 0, None, None, false), "0xa699e3ed5c2b89628c746d3298b5dc1cca604694c2c855da8bb8250ec8014a5b", "0x53f1b8153a301c72ecc655b1c315d64e1dcea3ee58921fd7507e35818fcc1584", 28);
}
