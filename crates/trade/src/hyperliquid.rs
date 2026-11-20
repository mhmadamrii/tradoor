//! Hyperliquid's "L1 actions" — orders, cancels, changes, leverage — signed as
//! its own SDK signs them (hyperliquid-python-sdk `sign_l1_action`).
//!
//! The action is packed as MessagePack by the caller, then hashed with the
//! nonce after it (8 bytes, big-endian), a vault's address or a zero byte, and
//! an expiry if there is one. That hash is the `connectionId` of a "phantom
//! agent", `source` "a" on mainnet and "b" on testnet, signed as EIP-712 in the
//! domain `Exchange`, version 1, chain 1337.

use crate::{domain, keccak, keccak_parts, typed_digest};

/// The hash of a packed action, its nonce, a vault it acts for, and an expiry.
pub fn action_hash(packed: &[u8], nonce: u64, vault: Option<&[u8; 20]>, expires_after: Option<u64>) -> [u8; 32] {
    let mut data = Vec::with_capacity(packed.len() + 38);
    data.extend_from_slice(packed);
    data.extend_from_slice(&nonce.to_be_bytes());
    match vault {
        None => data.push(0),
        Some(v) => {
            data.push(1);
            data.extend_from_slice(v);
        }
    }
    if let Some(t) = expires_after {
        data.push(0);
        data.extend_from_slice(&t.to_be_bytes());
    }
    keccak(&data)
}

/// What a trading key signs for an action of that hash.
pub fn agent_digest(connection: &[u8; 32], mainnet: bool) -> [u8; 32] {
    let ty = keccak(b"Agent(string source,bytes32 connectionId)");
    let source = keccak(if mainnet { b"a" } else { b"b" });
    let message = keccak_parts(&[&ty, &source, connection]);
    typed_digest(&domain("Exchange", "1", 1337), &message)
}

/// The digest to sign for a packed action: its hash, then as the phantom agent.
pub fn l1_digest(packed: &[u8], nonce: u64, vault: Option<&[u8; 20]>, expires_after: Option<u64>, mainnet: bool) -> [u8; 32] {
    agent_digest(&action_hash(packed, nonce, vault, expires_after), mainnet)
}
