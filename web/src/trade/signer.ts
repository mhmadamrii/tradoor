/**
 * The order system's signer (crates/trade-wasm): Keccak-256, a key's address,
 * and secp256k1 signatures, in a module that imports nothing. A key handed to
 * it is copied into the module's memory and wiped there once read; what the
 * caller holds is the caller's to wipe.
 */
interface Exports {
  memory: WebAssembly.Memory;
  tr_alloc(len: number): number;
  tr_free(ptr: number, len: number): void;
  tr_out(): number;
  tr_keccak(data: number, len: number): void;
  tr_address(key: number): number;
  tr_sign(digest: number, key: number): number;
  tr_hl_sign(action: number, len: number, nonce: number, vault: number, expires: number, mainnet: number, key: number): number;
}

export interface Signature {
  r: Uint8Array;
  s: Uint8Array;
  v: number;
}

export interface Signer {
  keccak(data: Uint8Array): Uint8Array;
  /** The 20-byte address a key signs as; null for no key. */
  address(key: Uint8Array): Uint8Array | null;
  sign(digest: Uint8Array, key: Uint8Array): Signature | null;
  /** A Hyperliquid action, packed: signed as its SDK's `sign_l1_action`. */
  hyperliquid(packed: Uint8Array, nonce: number, vault: Uint8Array | null, expiresAfter: number | null, mainnet: boolean, key: Uint8Array): Signature | null;
}

/** The module, from its bytes or its address. */
export async function loadSigner(source: BufferSource | string | URL): Promise<Signer> {
  const instance =
    typeof source === 'string' || source instanceof URL
      ? (await WebAssembly.instantiateStreaming(fetch(source), {}).catch(async () => WebAssembly.instantiate(await (await fetch(source)).arrayBuffer(), {}))).instance
      : (await WebAssembly.instantiate(source, {})).instance;
  const x = instance.exports as unknown as Exports;
  const bytes = () => new Uint8Array(x.memory.buffer);
  /** Writes the parts into memory, runs, frees: the pointers in order. */
  const withBytes = <T>(parts: (Uint8Array | null)[], run: (ptrs: number[]) => T): T => {
    const ptrs = parts.map((p) => (p ? x.tr_alloc(p.length) : 0));
    try {
      parts.forEach((p, i) => p && bytes().set(p, ptrs[i]!));
      return run(ptrs);
    } finally {
      parts.forEach((p, i) => {
        if (p) {
          bytes().fill(0, ptrs[i]!, ptrs[i]! + p.length);
          x.tr_free(ptrs[i]!, p.length);
        }
      });
    }
  };
  const out = (n: number) => bytes().slice(x.tr_out(), x.tr_out() + n);
  const signature = (ok: number): Signature | null => {
    if (!ok) return null;
    const o = out(65);
    return { r: o.slice(0, 32), s: o.slice(32, 64), v: o[64]! };
  };
  return {
    keccak: (data) => withBytes([data], ([p]) => (x.tr_keccak(p!, data.length), out(32))),
    address: (key) => withBytes([key], ([k]) => (x.tr_address(k!) ? out(20) : null)),
    sign: (digest, key) => withBytes([digest, key], ([d, k]) => signature(x.tr_sign(d!, k!))),
    hyperliquid: (packed, nonce, vault, expiresAfter, mainnet, key) =>
      withBytes([packed, vault, key], ([a, v, k]) => signature(x.tr_hl_sign(a!, packed.length, nonce, v!, expiresAfter ?? -1, mainnet ? 1 : 0, k!))),
  };
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function fromHex(s: string): Uint8Array {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) throw new Error('not hex');
  return Uint8Array.from({ length: h.length / 2 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
}
