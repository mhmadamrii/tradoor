/// <reference lib="webworker" />
/**
 * The trade worker: the one place trading keys are handled. It keeps every
 * account (as many as one likes, on Hyperliquid and Lighter, testnet first),
 * one hub per venue and network — one socket, however many accounts — and
 * signs what the page asks for after the guards have passed it. A key is
 * decrypted for a signature and wiped; with a passphrase on the keys they are
 * locked until it is given, and lock again after a while with no order.
 *
 * It signs only what it builds itself from a request: orders, cancels,
 * changes, leverage. There is no request that hands it something to sign, and
 * no venue code here builds a transfer or a withdrawal.
 */
import { API } from './hyperliquid';
import { Runner } from './algos';
import * as keys from './keystore';
import type { AccountRef, Activity, FromWorker, Network, ToWorker, Venue } from './protocol';
import { fromHex, loadSigner, toHex, type Signer } from './signer';
import type { Conn, Env, Hub } from './venues/common';
import { HlConn, HlHub } from './venues/hl';
import { LIGHTER, LighterConn, LighterHub } from './venues/lighter';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const say = (m: FromWorker) => scope.postMessage(m);

let urls = { hyperliquid: '', lighter: '', lighterGlue: '' };
let hlSigner: Promise<Signer> | null = null;
const signer = () => (hlSigner ??= loadSigner(urls.hyperliquid));

const hubs = new Map<string, Hub>();
const conns = new Map<string, Conn>();
const hubFor = (account: string) => {
  const c = conns.get(account);
  return c ? hubs.get(`${c.ref.venue}:${c.ref.network}`) : undefined;
};
const runner = new Runner(
  {
    conn: (id) => conns.get(id),
    books: (id) => hubFor(id)?.books ?? {},
    market: (id, coin) => hubFor(id)?.markets.get(coin),
    want: (id, owner, coins) => hubFor(id)?.want(owner, coins),
    candles: async (id, coin, tf, count) => (await hubFor(id)?.candles(coin, tf, count)) ?? [],
  },
  say,
);

// ---- the vault and its lock ---------------------------------------------------

let lockTimer = 0;
async function touch() {
  const v = await keys.vaultState();
  clearTimeout(lockTimer);
  if (v.kind === 'passphrase' && !v.locked && v.autoLock > 0)
    lockTimer = setTimeout(async () => {
      keys.lock();
      say({ t: 'vault', vault: await keys.vaultState() });
    }, v.autoLock * 60_000) as unknown as number;
}

let activityId = 0;
const env: Env = {
  say,
  async secret(account) {
    const s = await keys.readSecret(account);
    void touch();
    return s;
  },
  activity(account, what) {
    const id = ++activityId;
    const t0 = performance.now();
    return (state, detail, late) => say({ t: 'activity', activity: { id, account, at: Date.now(), what, state, detail, ms: Math.round(performance.now() - t0), ...(late ? { late } : {}) } satisfies Activity });
  },
};

// ---- hubs and accounts --------------------------------------------------------

async function hubOf(venue: Venue, network: Network): Promise<Hub> {
  const key = `${venue}:${network}`;
  let hub = hubs.get(key);
  if (!hub) {
    hub = venue === 'hyperliquid' ? new HlHub(network, env, signer) : new LighterHub(network, env, () => ({ wasm: urls.lighter, glue: urls.lighterGlue }));
    hubs.set(key, hub);
    try {
      await hub.start();
    } catch (e) {
      // Not kept: a hub that never read its markets would leave every account on it waiting for good.
      hubs.delete(key);
      say({ t: 'venueDown', venue, network, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    say({ t: 'venueDown', venue, network, error: null });
  }
  return hub;
}

/** An account attached, or tried again every 15 s while its exchange will not start. */
function attachSoon(a: AccountRef): void {
  void attach(a).catch((e) => {
    say({ t: 'error', message: `${a.label}: ${e instanceof Error ? e.message : e}` });
    setTimeout(() => attachSoon(a), 15_000);
  });
}

async function attach(ref: AccountRef) {
  const hub = await hubOf(ref.venue, ref.network);
  const old = conns.get(ref.id);
  if (old) hub.remove(ref.id);
  const conn = ref.venue === 'hyperliquid' ? new HlConn(ref, hub as HlHub) : new LighterConn(ref, hub as LighterHub);
  conns.set(ref.id, conn);
  hub.add(conn);
  say({ t: 'state', account: ref.id, state: conn.state });
}

async function sayAccounts() {
  say({ t: 'accounts', accounts: await keys.listAccounts() });
}

/** The same account once: a key added to a watched account takes its place. */
async function sameAs(ref: Omit<AccountRef, 'id' | 'created'>): Promise<AccountRef | undefined> {
  return (await keys.listAccounts()).find((a) => a.venue === ref.venue && a.network === ref.network && a.owner === ref.owner && (a.accountIndex ?? null) === (ref.accountIndex ?? null));
}

async function keep(ref: Omit<AccountRef, 'id' | 'created'>, secret?: Uint8Array): Promise<string | null> {
  const same = await sameAs(ref);
  const full: AccountRef = { ...ref, id: same?.id ?? crypto.randomUUID(), created: same?.created ?? Date.now() };
  const no = await keys.saveAccount(full, secret);
  if (no) return no;
  await attach(full);
  await sayAccounts();
  return null;
}

const isAddress = (v: string) => /^0x[0-9a-f]{40}$/.test(v);

async function lighterMaster(network: Network, owner: string): Promise<number> {
  const res = await fetch(`${LIGHTER[network].http}/api/v1/accountsByL1Address?l1_address=${owner}`);
  const r = await res.json();
  if (r.code === 21100 || !r.sub_accounts?.length) throw new Error('No Lighter account for this address yet: deposit on Lighter first');
  const master = (r.sub_accounts as { account_type: number; index: number }[]).find((a) => a.account_type === 0) ?? r.sub_accounts[0];
  return master.index;
}

// ---- Hyperliquid's trading keys ------------------------------------------------

/** Keys made and waiting for the owner's wallet, by the request that made them. */
const pending = new Map<string, Uint8Array>();

async function hlNewAgent(network: Network, owner: string): Promise<{ agent: string }> {
  const s = await signer();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const address = s.address(key);
  if (!address) throw new Error('No key was made: try again');
  const agent = `0x${toHex(address)}`;
  pending.get(`${network}:${owner}`)?.fill(0);
  pending.set(`${network}:${owner}`, key);
  return { agent };
}

async function hlApprove(m: Extract<ToWorker, { t: 'approveAgent' }>): Promise<string | null> {
  const key = pending.get(`${m.network}:${m.owner}`);
  if (!key) return 'The trading key was not kept: start again';
  const res = await fetch(`${API[m.network].http}/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: m.action, nonce: m.nonce, signature: m.signature, vaultAddress: null, expiresAfter: null }) });
  const reply = await res.json().catch(() => ({ status: 'err', response: `Hyperliquid answered ${res.status}` }));
  if (reply.status !== 'ok') return typeof reply.response === 'string' ? reply.response : 'Refused';
  const validUntil = Number(/valid_until (\d+)/.exec(String((m.action as { agentName?: string }).agentName))?.[1] ?? 0);
  try {
    return await keep({ venue: 'hyperliquid', network: m.network, owner: m.owner, label: m.label, mode: 'trade', agent: m.agent, validUntil }, key);
  } finally {
    key.fill(0);
    pending.delete(`${m.network}:${m.owner}`);
  }
}

async function hlImport(network: Network, owner: string, label: string, keyHex: string): Promise<string | null> {
  let key: Uint8Array;
  try {
    key = fromHex(keyHex.trim());
  } catch {
    return 'That is not a private key (64 hex characters)';
  }
  try {
    if (key.length !== 32) return 'That is not a private key (64 hex characters)';
    const address = (await signer()).address(key);
    if (!address) return 'That is not a private key';
    const agent = `0x${toHex(address)}`;
    const res = await fetch(`${API[network].http}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'userRole', user: agent }) });
    const role = (await res.json()) as { role?: string; data?: { user?: string } };
    if (role.role !== 'agent' || role.data?.user?.toLowerCase() !== owner) return `That key is not a trading key of ${owner.slice(0, 6)}…${owner.slice(-4)} on Hyperliquid ${network}`;
    return await keep({ venue: 'hyperliquid', network, owner, label, mode: 'trade', agent, validUntil: 0 }, key);
  } finally {
    key.fill(0);
  }
}

// ---- Lighter's API keys --------------------------------------------------------

const lighterPending = new Map<string, { privateKey: string; publicKey: string; txType: number; txInfo: string }>();

async function lighterHub(network: Network) {
  return (await hubOf('lighter', network)) as LighterHub;
}

/** A new API key made here, and its registration signed by it: the owner's wallet signs the message next. */
async function lighterKey(network: Network, owner: string, accountIndex: number, apiKeyIndex: number) {
  const hub = await lighterHub(network);
  const call = await hub.signer();
  const k = call({ op: 'generate' });
  if (k.error) throw new Error(k.error);
  const idx = accountIndex > 0 ? accountIndex : await lighterMaster(network, owner);
  const nonce = (await hub.get(`/api/v1/nextNonce?account_index=${idx}&api_key_index=${apiKeyIndex}`)).nonce;
  const tx = call({ op: 'changePubKey', key: k.privateKey, chain: LIGHTER[network].chain, account: idx, apiKey: apiKeyIndex, nonce, pubKey: k.publicKey });
  if (tx.error) throw new Error(tx.error);
  lighterPending.set(`${network}:${owner}:${idx}`, { privateKey: k.privateKey, publicKey: k.publicKey, txType: tx.txType, txInfo: tx.txInfo });
  return { messageToSign: tx.messageToSign as string, accountIndex: idx };
}

async function lighterRegister(m: Extract<ToWorker, { t: 'lighterRegister' }>): Promise<string | null> {
  const slot = `${m.network}:${m.owner}:${m.accountIndex}`;
  const p = lighterPending.get(slot);
  if (!p) return 'The API key was not kept: start again';
  const hub = await lighterHub(m.network);
  const info = JSON.parse(p.txInfo);
  info.L1Sig = m.l1Sig;
  const sent = await hub.sendTx([{ txType: p.txType, txInfo: JSON.stringify(info) }]);
  if (sent.error) return sent.error;
  // Accepted is not yet done: wait until the exchange lists the key.
  const want = p.publicKey.replace(/^0x/, '').toLowerCase();
  const until = Date.now() + 30_000;
  for (;;) {
    const r = await hub.get(`/api/v1/apikeys?account_index=${m.accountIndex}&api_key_index=${m.apiKeyIndex}`).catch(() => null);
    if (r?.api_keys?.[0]?.public_key?.toLowerCase() === want) break;
    if (Date.now() > until) return 'Lighter took the key but has not listed it yet: try connecting again in a minute';
    await new Promise((r) => setTimeout(r, 1000));
  }
  const secret = fromHex(p.privateKey);
  lighterPending.delete(slot);
  try {
    return await keep({ venue: 'lighter', network: m.network, owner: m.owner, label: m.label, mode: 'trade', agent: p.publicKey, accountIndex: m.accountIndex, apiKeyIndex: m.apiKeyIndex, validUntil: 0 }, secret);
  } finally {
    secret.fill(0);
  }
}

/** A key made on Lighter's own API page, pasted: kept once the exchange takes an auth token it signed. */
async function lighterImport(network: Network, owner: string, label: string, keyHex: string, accountIndex: number | undefined, apiKeyIndex: number): Promise<string | null> {
  const hub = await lighterHub(network);
  const call = await hub.signer();
  const idx = accountIndex && accountIndex > 0 ? accountIndex : await lighterMaster(network, owner);
  const hex = keyHex.trim().startsWith('0x') ? keyHex.trim() : `0x${keyHex.trim()}`;
  const r = call({ op: 'auth', key: hex, chain: LIGHTER[network].chain, account: idx, apiKey: apiKeyIndex, deadline: Math.floor(Date.now() / 1000) + 600 });
  if (r.error) return `That is not a Lighter API key: ${r.error}`;
  try {
    await hub.get(`/api/v1/accountLimits?account_index=${idx}`, r.authToken);
  } catch {
    return `That key is not registered at index ${apiKeyIndex} of account ${idx}`;
  }
  const secret = fromHex(hex);
  try {
    return await keep({ venue: 'lighter', network, owner, label, mode: 'trade', agent: null, accountIndex: idx, apiKeyIndex, validUntil: 0 }, secret);
  } finally {
    secret.fill(0);
  }
}

// ---- the page's asks --------------------------------------------------------

const conn = (id: string | null) => (id ? conns.get(id) : undefined);

/** One account's action: its refusal, null once done, or that the account is gone. (A bare `?? 'No such account'` read every success as missing.) */
const act = async (id: string | null, f: (c: Conn) => Promise<string | null>) => {
  const c = conn(id);
  return { error: c ? await f(c) : 'No such account' };
};

async function handle(m: ToWorker): Promise<{ error: string | null; data?: unknown } | void> {
  switch (m.t) {
    case 'start': {
      urls = m.signers;
      say({ t: 'vault', vault: await keys.vaultState() });
      const list = await keys.listAccounts();
      say({ t: 'accounts', accounts: list });
      for (const a of list) attachSoon(a);
      return;
    }
    case 'addWatch': {
      const owner = m.owner.trim().toLowerCase();
      if (!isAddress(owner)) return { error: 'An address is 0x and 40 hex characters' };
      const accountIndex = m.venue === 'lighter' ? (m.accountIndex && m.accountIndex > 0 ? m.accountIndex : await lighterMaster(m.network, owner)) : undefined;
      return { error: await keep({ venue: m.venue, network: m.network, owner, label: m.label, mode: 'watch', agent: null, ...(accountIndex ? { accountIndex } : {}), validUntil: 0 }) };
    }
    case 'newAgent':
      return { error: null, data: await hlNewAgent(m.network, m.owner) };
    case 'approveAgent':
      return { error: await hlApprove(m) };
    case 'importKey':
      return { error: m.venue === 'hyperliquid' ? await hlImport(m.network, m.owner.toLowerCase(), m.label, m.key) : await lighterImport(m.network, m.owner.toLowerCase(), m.label, m.key, m.accountIndex, m.apiKeyIndex ?? 128) };
    case 'lighterKey':
      return { error: null, data: await lighterKey(m.network, m.owner, m.accountIndex, m.apiKeyIndex) };
    case 'lighterRegister':
      return { error: await lighterRegister(m) };
    case 'rename': {
      const a = (await keys.listAccounts()).find((x) => x.id === m.account);
      if (a) await keys.saveAccount({ ...a, label: m.label.slice(0, 40) || a.label });
      return void (await sayAccounts());
    }
    case 'remove': {
      const c = conns.get(m.account);
      if (c) hubs.get(`${c.ref.venue}:${c.ref.network}`)?.remove(m.account);
      conns.delete(m.account);
      await keys.deleteAccount(m.account);
      return void (await sayAccounts());
    }
    case 'removeAll': {
      for (const [id, c] of conns) hubs.get(`${c.ref.venue}:${c.ref.network}`)?.remove(id);
      conns.clear();
      await keys.deleteAll();
      say({ t: 'vault', vault: await keys.vaultState() });
      return void (await sayAccounts());
    }
    case 'vault': {
      let error: string | null = null;
      if (m.op === 'unlock') error = await keys.unlock(m.passphrase ?? '');
      else if (m.op === 'lock') keys.lock();
      else if (m.op === 'set') error = await keys.setPassphrase(m.passphrase ?? '', m.autoLock ?? 15);
      else if (m.op === 'clear') error = await keys.clearPassphrase();
      if (m.autoLock !== undefined && m.op !== 'set' && !error) await keys.setAutoLock(m.autoLock);
      say({ t: 'vault', vault: await keys.vaultState() });
      void touch();
      return { error };
    }
    case 'follow': {
      const hub = hubs.get(`${m.venue}:${m.network}`);
      hub?.follow(m.coins, m.tickets, m.ladders);
      return;
    }
    case 'order':
      // A reduce-only with nothing to reduce: Lighter takes it and drops it without a word, so it is refused here.
      return act(m.account, async (c) => (m.req.reduceOnly && !c.state.positions.some((p) => p.coin === m.req.coin && (m.req.buy ? p.size < 0 : p.size > 0)) ? `Reduce only: no ${m.req.coin} ${m.req.buy ? 'short' : 'long'} to reduce` : c.place(m.req)));
    case 'cancel':
      return act(m.account, (c) => c.cancel(m.orders));
    case 'move':
      return act(m.account, (c) => c.move(m.order, m.price));
    case 'leverage':
      return act(m.account, (c) => c.leverage(m.coin, m.leverage, m.cross));
    case 'exits':
      return act(m.account, (c) => c.exits(m.coin, m.tp, m.sl));
    case 'flatten': {
      // One account, or the kill switch: every account that trades. Its algos stop first.
      if (!m.coin) await runner.stopAccount(m.account);
      const targets = m.account ? [conn(m.account)].filter(Boolean) : [...conns.values()].filter((c) => c.ref.mode === 'trade');
      const errors = (await Promise.all(targets.map((c) => c!.flatten(m.coin, m.guards)))).filter(Boolean);
      return { error: errors.length ? errors.join('; ') : null };
    }
    case 'history': {
      const c = conn(m.account);
      return { error: null, data: c ? await c.history() : [] };
    }
    case 'algo':
      return { error: runner.start(m.spec, m.guards) };
    case 'algoStop':
      return void (await runner.stop(m.algo));
  }
}

scope.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  const id = 'id' in m ? m.id : 0;
  try {
    const r = await handle(m);
    if (id && r) say({ t: 'reply', id, error: r.error, data: r.data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (id) say({ t: 'reply', id, error: message });
    else say({ t: 'error', message });
  }
};
