/**
 * Where trading accounts and their keys live: this browser's IndexedDB, read
 * and written only by the trade worker. Nothing here is sent anywhere.
 *
 * Nothing of a key ever leaves this browser: not to tradoor's server, which
 * has no way to take one, nor anywhere else. Each is kept under three layers:
 *
 *   1. its own key: the secret (an API key, a wallet-approved trading key) is
 *      encrypted with an AES-256-GCM key made for it alone;
 *   2. this browser's key: that key is encrypted with an AES-256-GCM key the
 *      browser cannot give out (WebCrypto, `extractable: false`), so the
 *      stored bytes are of no use copied to another machine;
 *   3. the passphrase, when one is set: encrypted once more with a key worked
 *      out from it (PBKDF2-SHA-256, 600,000 rounds), held in the worker's
 *      memory only while unlocked and dropped when it locks — by hand, or
 *      after a while with no order.
 *
 * A key is decrypted for one signature and wiped after it, its own key too.
 */
import type { AccountRef, VaultState } from './protocol';

const DB = 'tradoor-trade';
const VERSION = 2;
const WRAP = 'wrap';
const ACCOUNTS = 'accounts';
const SECRETS = 'secrets';
const META = 'meta';
const ROUNDS = 600_000;

interface Sealed {
  iv: Uint8Array;
  data: Uint8Array;
}

/** A secret under its own key (`inner`), that key under the browser's and the passphrase's (`key`). */
interface Layered {
  v: 3;
  key: Sealed;
  inner: Sealed;
}

const isLayered = (x: Sealed | Layered): x is Layered => (x as Layered).v === 3;

interface VaultMeta {
  kind: 'device' | 'passphrase';
  salt?: Uint8Array;
  /** "tradoor" sealed with the passphrase's key: whether a passphrase is the right one. */
  check?: Sealed;
  autoLock: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [WRAP, ACCOUNTS, SECRETS, META]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      // The first preview kept one account in a store of its own: gone, it held testnet keys only.
      if (db.objectStoreNames.contains('agents')) db.deleteObjectStore('agents');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const bytes = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

async function seal(key: CryptoKey, plain: Uint8Array): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, data: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes(plain))) };
}

async function unseal(key: CryptoKey, s: Sealed): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(s.iv) }, key, bytes(s.data)));
}

/** This device's key, made the first time. */
async function deviceKey(): Promise<CryptoKey> {
  const have = await tx<CryptoKey | undefined>(WRAP, 'readonly', (s) => s.get('k'));
  if (have) return have;
  const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await tx(WRAP, 'readwrite', (s) => s.put(k, 'k'));
  return k;
}

async function passKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(salt), iterations: ROUNDS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const meta = async (): Promise<VaultMeta> => (await tx<VaultMeta | undefined>(META, 'readonly', (s) => s.get('vault'))) ?? { kind: 'device', autoLock: 0 };
const writeMeta = (m: VaultMeta) => tx(META, 'readwrite', (s) => s.put(m, 'vault'));

/** The passphrase's key while unlocked; null when locked, or with no passphrase. */
let unlocked: CryptoKey | null = null;

export async function vaultState(): Promise<VaultState> {
  const m = await meta();
  return { kind: m.kind, locked: m.kind === 'passphrase' && !unlocked, autoLock: m.autoLock };
}

/**
 * Every account's key sealed anew (`each`), then written with the vault's new
 * settings in one transaction: a failure part way leaves them all as they were.
 */
async function reseal(each: (plain: Uint8Array) => Promise<Layered>, next: VaultMeta) {
  const fresh = new Map<string, Layered>();
  for (const a of await listAccounts()) {
    const plain = await readSecret(a.id);
    if (!plain) continue;
    try {
      fresh.set(a.id, await each(plain));
    } finally {
      plain.fill(0);
    }
  }
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction([SECRETS, META], 'readwrite');
      for (const [id, sealed] of fresh) t.objectStore(SECRETS).put(sealed, id);
      t.objectStore(META).put(next, 'vault');
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function unlock(passphrase: string): Promise<string | null> {
  const m = await meta();
  if (m.kind !== 'passphrase' || !m.salt || !m.check) return null;
  const k = await passKey(passphrase, m.salt);
  try {
    await unseal(k, m.check);
  } catch {
    return 'Wrong passphrase';
  }
  unlocked = k;
  return null;
}

export function lock(): void {
  unlocked = null;
}

/** The outer layers, as the vault has them: the browser's key, and the passphrase's on top when set. */
async function outer(m: VaultMeta, pass: CryptoKey | null): Promise<(raw: Uint8Array) => Promise<Sealed>> {
  const device = await deviceKey();
  if (m.kind !== 'passphrase') return (raw) => seal(device, raw);
  if (!pass) throw new Error('locked');
  return async (raw) => seal(pass, encode(await seal(device, raw)));
}

/** A secret in three layers (two with no passphrase): a key of its own, made here and wiped once used. */
async function layer(secret: Uint8Array, wrap: (raw: Uint8Array) => Promise<Sealed>): Promise<Layered> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    const own = await crypto.subtle.importKey('raw', bytes(raw), 'AES-GCM', false, ['encrypt']);
    return { v: 3, key: await wrap(raw), inner: await seal(own, secret) };
  } finally {
    raw.fill(0);
  }
}

/** A passphrase put on the keys, or changed: every key sealed again with it. */
export async function setPassphrase(passphrase: string, autoLock: number): Promise<string | null> {
  if (passphrase.length < 8) return 'A passphrase of 8 characters at least';
  const m = await meta();
  if (m.kind === 'passphrase' && !unlocked) return 'Unlock first';
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await passKey(passphrase, salt);
  const device = await deviceKey();
  // Decrypted with what they are sealed with now, each sealed again in its three layers, the new passphrase outermost.
  await reseal(async (plain) => layer(plain, async (raw) => seal(k, encode(await seal(device, raw)))), { kind: 'passphrase', salt, check: await seal(k, new TextEncoder().encode('tradoor')), autoLock });
  unlocked = k;
  return null;
}

/** The passphrase taken off: the keys kept by this device alone again. */
export async function clearPassphrase(): Promise<string | null> {
  const m = await meta();
  if (m.kind !== 'passphrase') return null;
  if (!unlocked) return 'Unlock first';
  const device = await deviceKey();
  await reseal((plain) => layer(plain, (raw) => seal(device, raw)), { kind: 'device', autoLock: 0 });
  unlocked = null;
  return null;
}

export async function setAutoLock(minutes: number): Promise<void> {
  await writeMeta({ ...(await meta()), autoLock: Math.max(0, Math.round(minutes)) });
}

/** Two sealed parts as one: iv, then the data. */
const encode = (s: Sealed) => {
  const out = new Uint8Array(12 + s.data.length);
  out.set(s.iv);
  out.set(s.data, 12);
  return out;
};
const decode = (b: Uint8Array): Sealed => ({ iv: b.slice(0, 12), data: b.slice(12) });

export const listAccounts = async (): Promise<AccountRef[]> => ((await tx<AccountRef[]>(ACCOUNTS, 'readonly', (s) => s.getAll())) ?? []).sort((a, b) => a.created - b.created);

export async function saveAccount(ref: AccountRef, secret?: Uint8Array): Promise<string | null> {
  if (secret) {
    const m = await meta();
    if (m.kind === 'passphrase' && !unlocked) return 'Unlock the keys first';
    const sealed = await layer(secret, await outer(m, unlocked));
    await tx(SECRETS, 'readwrite', (s) => s.put(sealed, ref.id));
  }
  await tx(ACCOUNTS, 'readwrite', (s) => s.put(ref, ref.id));
  return null;
}

export async function deleteAccount(id: string): Promise<void> {
  await tx(SECRETS, 'readwrite', (s) => s.delete(id));
  await tx(ACCOUNTS, 'readwrite', (s) => s.delete(id));
}

/** Every account and key in this browser, gone. The device's own key stays: it guards nothing then. */
export async function deleteAll(): Promise<void> {
  await tx(SECRETS, 'readwrite', (s) => s.clear());
  await tx(ACCOUNTS, 'readwrite', (s) => s.clear());
  await writeMeta({ kind: 'device', autoLock: 0 });
  unlocked = null;
}

/**
 * An account's key, for one use: the caller wipes it (`fill(0)`) when done.
 * Null when it has none; throws when the keys are locked.
 */
export async function readSecret(id: string): Promise<Uint8Array | null> {
  const sealed = await tx<Sealed | Layered | null | undefined>(SECRETS, 'readonly', (s) => s.get(id));
  if (!sealed) return null;
  const m = await meta();
  if (m.kind === 'passphrase' && !unlocked) throw new Error('locked');
  // The outer layers off: the passphrase's when set, then the browser's.
  const peel = async (s: Sealed) => {
    const device = await deviceKey();
    if (m.kind !== 'passphrase') return unseal(device, s);
    const mid = await unseal(unlocked!, s);
    try {
      return await unseal(device, decode(mid));
    } finally {
      mid.fill(0);
    }
  };
  if (!isLayered(sealed)) {
    // Kept before keys had a key of their own: read as it was, and kept in three layers from now on.
    const plain = await peel(sealed);
    const again = await layer(plain, await outer(m, unlocked));
    await tx(SECRETS, 'readwrite', (s) => s.put(again, id));
    return plain;
  }
  const raw = await peel(sealed.key);
  try {
    const own = await crypto.subtle.importKey('raw', bytes(raw), 'AES-GCM', false, ['decrypt']);
    return await unseal(own, sealed.inner);
  } finally {
    raw.fill(0);
  }
}
