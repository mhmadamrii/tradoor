//! Signing for tradoor's order system.
//!
//! An order on Hyperliquid (and on Aster, whose API wallets work the same way)
//! is a message signed with a trading key — an "agent" key the account's owner
//! approved once in their own wallet, which can trade but cannot withdraw. This
//! crate does the cryptography of that and nothing more: Keccak-256, a
//! secp256k1 signature with its recovery id, the address a key signs as, and
//! the EIP-712 digest Hyperliquid has an order's hash signed as.
//!
//! It holds no key between calls and reaches nothing: the page's trade worker
//! hands it a key and the bytes to sign, and gets a signature back.

use k256::ecdsa::SigningKey;
use sha3::{Digest, Keccak256};

pub mod hyperliquid;

/// Keccak-256, the hash Ethereum and Hyperliquid sign with.
pub fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// Keccak-256 of several parts one after another.
pub fn keccak_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Keccak256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// The address a private key signs as: the last 20 bytes of the Keccak-256 of
/// its public key, uncompressed and without its leading byte. `None` for a key
/// that is not one (zero, or past the curve's order).
pub fn address(key: &[u8; 32]) -> Option<[u8; 20]> {
    let signer = SigningKey::from_slice(key).ok()?;
    let point = signer.verifying_key().to_encoded_point(false);
    let hash = keccak(&point.as_bytes()[1..]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&hash[12..]);
    Some(out)
}

/// A signature of a 32-byte digest: `r`, `s` (the low one, as Ethereum wants)
/// and `v`, 27 or 28. Deterministic (RFC 6979), so the same digest and key give
/// the same signature, which is what lets it be checked against Hyperliquid's own.
pub fn sign(digest: &[u8; 32], key: &[u8; 32]) -> Option<[u8; 65]> {
    let signer = SigningKey::from_slice(key).ok()?;
    let (sig, recovery) = signer.sign_prehash_recoverable(digest).ok()?;
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = 27 + recovery.to_byte();
    Some(out)
}

/// A number as EIP-712 encodes it: 32 bytes, big-endian.
pub fn word(n: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&n.to_be_bytes());
    out
}

/// The digest EIP-712 has signed: `0x19 0x01`, the domain's separator, the message's hash.
pub fn typed_digest(domain: &[u8; 32], message: &[u8; 32]) -> [u8; 32] {
    keccak_parts(&[&[0x19, 0x01], domain, message])
}

/// The separator of a domain named, with a version, a chain and the zero address
/// as its contract — the only kind Hyperliquid and Aster sign with.
pub fn domain(name: &str, version: &str, chain: u64) -> [u8; 32] {
    let ty = keccak(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    keccak_parts(&[&ty, &keccak(name.as_bytes()), &keccak(version.as_bytes()), &word(chain), &[0u8; 32]])
}

#[cfg(test)]
mod tests;
