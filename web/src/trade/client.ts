/**
 * The page's side of the trade worker: started on first use, then every
 * account it follows as signals for the panels, and the asks to it. Which
 * accounts there are lives in the worker's storage, never in the workspace or
 * on tradoor's server; this browser only counts them, to know whether to
 * start the worker on the next visit.
 */
import { createSignal } from 'solid-js';
import { parseMarket } from '../lib/markets';
import { readJson, writePref } from '../lib/prefs';
import { toast } from '../lib/toasts';
import lighterUrl from '../wasm/lighter/lighter.wasm?url';
import lighterGlueUrl from '../wasm/lighter/wasm_exec.js?url';
import signerUrl from '../wasm/trade/trade.wasm?url';
import { approveAgent, splitSignature } from './hyperliquid';
import { setTradeOn } from './present';
import { DEFAULT_GUARDS, type AccountRef, type AccountState, type Activity, type AlgoSpec, type AlgoState, type Books, type FromWorker, type Guards, type Link, type MarketInfo, type Network, type OpenOrder, type OrderRequest, type PastOrder, type Position, type ToWorker, type VaultState, type Venue } from './protocol';
import { personalSign, signTyped, walletAccount, walletById, walletError } from './wallet';

const COUNT_KEY = 'tradeAccounts';
const GUARDS_KEY = 'tradeGuards';

/** A venue on a network: `lighter:testnet`. */
export type Place = `${Venue}:${Network}`;
export const placeOf = (a: { venue: Venue; network: Network }): Place => `${a.venue}:${a.network}`;

const [accounts, setAccounts] = createSignal<AccountRef[]>([]);
const [states, setStates] = createSignal<Record<string, AccountState>>({});
const [links, setLinks] = createSignal<Partial<Record<Place, Link>>>({});
const [books, setBooks] = createSignal<Partial<Record<Place, Books>>>({});
const [markets, setMarkets] = createSignal<Partial<Record<Place, Map<string, MarketInfo>>>>({});
/** Why an exchange's markets have not come, by place, while it will not start. */
const [down, setDown] = createSignal<Partial<Record<Place, string>>>({});
const [activity, setActivity] = createSignal<Activity[]>([]);
const [vault, setVault] = createSignal<VaultState>({ kind: 'device', locked: false, autoLock: 0 });
const [guards, setGuardsSignal] = createSignal<Guards>(readGuards());
const [ready, setReady] = createSignal(false);
const [algos, setAlgos] = createSignal<AlgoState[]>([]);
/** Each ladder's book: its top levels, by place and coin. */
export type Depth = { bids: [number, number][]; asks: [number, number][] };
const [depths, setDepths] = createSignal<Partial<Record<Place, Record<string, Depth>>>>({});

function readGuards(): Guards {
  const g = readJson(GUARDS_KEY) as Partial<Guards> | null;
  const n = (v: unknown, d: number, max: number) => (typeof v === 'number' && v >= 0 && v <= max ? v : d);
  return { maxUsd: n(g?.maxUsd, DEFAULT_GUARDS.maxUsd, 1e9), band: n(g?.band, DEFAULT_GUARDS.band, 1), slippage: n(g?.slippage, DEFAULT_GUARDS.slippage, 0.5) };
}

let worker: Worker | null = null;
let replyId = 0;
const replies = new Map<number, (r: { error: string | null; data?: unknown }) => void>();

function post(m: ToWorker) {
  start().postMessage(m);
}

/** The worker, started the first time anything asks. */
export function start(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./trade-worker.ts', import.meta.url), { type: 'module', name: 'tradoor-trade' });
  // Keys bound to trading lines listen while the order system runs.
  if ((readJson('tradeBinds') as object | null) && Object.keys(readJson('tradeBinds') as object).length) void import('./hotkeys');
  // Its orders, positions and algorithms on the charts of their own exchange and coin.
  void import('./chart-live').then((m) => m.startChartLive());
  // Their trades in the journal, for a browser signed in with Telegram.
  void import('./journal-sync').then((m) => m.startJournalSync());
  const abs = (u: string) => new URL(u, location.href).href;
  worker.postMessage({ t: 'start', signers: { hyperliquid: abs(signerUrl), lighter: abs(lighterUrl), lighterGlue: abs(lighterGlueUrl) } } satisfies ToWorker);
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    switch (m.t) {
      case 'accounts':
        setAccounts(m.accounts);
        setReady(true);
        writePref(COUNT_KEY, String(m.accounts.length));
        setTradeOn(m.accounts.length > 0);
        sendFollow();
        return;
      case 'state':
        setStates((s) => ({ ...s, [m.account]: m.state }));
        return;
      case 'link':
        setLinks((l) => ({ ...l, [`${m.venue}:${m.network}`]: m.link }));
        return;
      case 'books':
        setBooks((b) => ({ ...b, [`${m.venue}:${m.network}`]: { ...m.books } }));
        return;
      case 'depth': {
        const p: Place = `${m.venue}:${m.network}`;
        setDepths((d) => ({ ...d, [p]: { ...d[p], [m.coin]: { bids: m.bids, asks: m.asks } } }));
        return;
      }
      case 'venueDown':
        setDown((d) => {
          const next = { ...d };
          if (m.error) next[`${m.venue}:${m.network}`] = m.error;
          else delete next[`${m.venue}:${m.network}`];
          return next;
        });
        return;
      case 'markets':
        setMarkets((x) => ({ ...x, [`${m.venue}:${m.network}`]: new Map(m.markets.map((mk) => [mk.coin, mk])) }));
        sendFollow();
        return;
      case 'activity':
        setActivity((list) => [m.activity, ...list.filter((a) => a.id !== m.activity.id)].slice(0, 200));
        if (m.activity.late) toast({ tone: 'warn', title: m.activity.what, body: m.activity.detail }, 8_000);
        return;
      case 'vault':
        setVault(m.vault);
        return;
      case 'algos': {
        // One that fails is said aloud: the ticket said it started, and the reason is only on its card.
        const was = new Map(algos().map((a) => [a.id, a.status]));
        for (const a of m.algos) if (a.status === 'failed' && was.get(a.id) !== 'failed') toast({ tone: 'warn', title: `${a.spec.kind[0]!.toUpperCase()}${a.spec.kind.slice(1)} failed`, body: a.detail }, 10_000);
        setAlgos(m.algos);
        return;
      }
      case 'reply':
        replies.get(m.id)?.({ error: m.error, data: m.data });
        replies.delete(m.id);
        return;
      case 'error':
        console.error('trade worker:', m.message);
        return;
    }
  };
  return worker;
}

/** Starts the worker on a visit when this browser has accounts. */
export function resume(): void {
  if (Number(readJson(COUNT_KEY)) > 0) start();
}

function ask<T = unknown>(make: (id: number) => ToWorker): Promise<{ error: string | null; data?: T }> {
  const id = ++replyId;
  return new Promise((resolve) => {
    replies.set(id, resolve as (r: { error: string | null; data?: unknown }) => void);
    post(make(id));
  });
}
const err = async (p: Promise<{ error: string | null }>) => (await p).error;

/** The networks one may trade on: testnet alone until the order system has been tried in full. */
export const NETWORKS: readonly Network[] = ['testnet'];
const allowed = (n: Network) => NETWORKS.includes(n);
const TESTNET_ONLY = 'Testnet only for now';

/** How long a Hyperliquid trading key is approved for, in days. */
export const KEY_DAYS = [7, 30, 90, 180] as const;

// ---- connecting -------------------------------------------------------------

export async function connectHyperliquid(network: Network, days: number, label: string, walletId?: string): Promise<string | null> {
  if (!allowed(network)) return TESTNET_ONLY;
  const w = await walletById(walletId);
  if (!w) return 'No browser wallet found: install MetaMask or Rabby, or paste an API wallet key';
  try {
    const { owner, chain } = await walletAccount(w.provider);
    const made = await ask<{ agent: string }>((id) => ({ t: 'newAgent', id, network, owner, validUntil: 0 }));
    if (made.error || !made.data) return made.error ?? 'No key was made';
    const validUntil = Date.now() + days * 86_400_000;
    const nonce = Date.now();
    const { typed, action } = approveAgent({ network, walletChain: chain, agent: made.data.agent, name: 'tradoor', validUntil, nonce });
    const sig = splitSignature(await signTyped(w.provider, owner, typed));
    return await err(ask((id) => ({ t: 'approveAgent', id, network, owner, label, agent: made.data!.agent, action, nonce, signature: sig.hex })));
  } catch (e) {
    return walletError(e);
  }
}

/** A Lighter API key made in this browser and registered with one signature of the owner's wallet. */
export async function connectLighter(network: Network, label: string, apiKeyIndex: number, accountIndex = 0, walletId?: string): Promise<string | null> {
  if (!allowed(network)) return TESTNET_ONLY;
  const w = await walletById(walletId);
  if (!w) return 'No browser wallet found: install MetaMask or Rabby, or paste an API key';
  try {
    const { owner } = await walletAccount(w.provider);
    const made = await ask<{ messageToSign: string; accountIndex: number }>((id) => ({ t: 'lighterKey', id, network, owner, accountIndex, apiKeyIndex }));
    if (made.error || !made.data) return made.error ?? 'No key was made';
    const l1Sig = await personalSign(w.provider, owner, made.data.messageToSign);
    return await err(ask((id) => ({ t: 'lighterRegister', id, network, owner, label, accountIndex: made.data!.accountIndex, apiKeyIndex, l1Sig })));
  } catch (e) {
    return walletError(e);
  }
}

export const importKey = (o: { venue: Venue; network: Network; owner: string; label: string; key: string; accountIndex?: number; apiKeyIndex?: number }) =>
  allowed(o.network) ? err(ask((id) => ({ t: 'importKey', id, ...o, owner: o.owner.trim().toLowerCase() }))) : Promise.resolve(TESTNET_ONLY);

export const addWatch = (o: { venue: Venue; network: Network; owner: string; label: string; accountIndex?: number }) => (allowed(o.network) ? err(ask((id) => ({ t: 'addWatch', id, ...o }))) : Promise.resolve(TESTNET_ONLY));

export const rename = (account: string, label: string) => post({ t: 'rename', account, label });
export const remove = (account: string) => post({ t: 'remove', account });
export const removeAll = () => post({ t: 'removeAll' });

// ---- the vault --------------------------------------------------------------

export const unlock = (passphrase: string) => err(ask((id) => ({ t: 'vault', id, op: 'unlock', passphrase })));
export const lock = () => err(ask((id) => ({ t: 'vault', id, op: 'lock' })));
export const setPassphrase = (passphrase: string, autoLock: number) => err(ask((id) => ({ t: 'vault', id, op: 'set', passphrase, autoLock })));
export const clearPassphrase = () => err(ask((id) => ({ t: 'vault', id, op: 'clear' })));

export function setGuards(g: Guards): void {
  setGuardsSignal(g);
  writePref(GUARDS_KEY, JSON.stringify(g));
}

// ---- trading ----------------------------------------------------------------

export const order = (account: string, req: Omit<OrderRequest, 'guards'>) => err(ask((id) => ({ t: 'order', id, account, req: { ...req, guards: guards() } })));
export const cancel = (account: string, orders: { coin: string; oid: number }[]) => err(ask((id) => ({ t: 'cancel', id, account, orders })));
export const move = (account: string, o: OpenOrder, price: number) => err(ask((id) => ({ t: 'move', id, account, order: o, price })));
export const leverage = (account: string, coin: string, lev: number, cross: boolean) => err(ask((id) => ({ t: 'leverage', id, account, coin, leverage: lev, cross })));
export const exits = (account: string, coin: string, tp: number | null, sl: number | null) => err(ask((id) => ({ t: 'exits', id, account, coin, tp, sl })));
/** One account's coin, one account, or with `account` null the kill switch: every account. */
export const flatten = (account: string | null, coin: string | null) => err(ask((id) => ({ t: 'flatten', id, account, coin, guards: guards() })));
/** Starts an algorithm; the reason it may not, or null. */
export const runAlgo = (spec: AlgoSpec) => err(ask((id) => ({ t: 'algo', id, spec, guards: guards() })));
export const stopAlgo = (algo: string) => post({ t: 'algoStop', algo });
export const history = async (account: string): Promise<PastOrder[]> => (await ask<PastOrder[]>((id) => ({ t: 'history', id, account }))).data ?? [];

// ---- following ----------------------------------------------------------------

/** What each panel follows: coins on a venue for their best prices, and an account's coin for its ticket. */
const wanted = new Map<string, { place: Place; coins: string[]; tickets: { account: string; coin: string }[]; ladders: string[] }>();
let followTimer = 0;
function sendFollow() {
  if (!worker) return;
  clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    const byPlace = new Map<Place, { coins: Set<string>; tickets: { account: string; coin: string }[]; ladders: Set<string> }>();
    const at = (p: Place) => byPlace.get(p) ?? (byPlace.set(p, { coins: new Set(), tickets: [], ladders: new Set() }), byPlace.get(p)!);
    for (const w of wanted.values()) {
      const x = at(w.place);
      for (const c of w.coins) x.coins.add(c);
      for (const c of w.ladders) x.ladders.add(c);
      x.tickets.push(...w.tickets);
    }
    // Every account's open positions too, the first forty: a mark for each row.
    for (const a of accounts()) {
      const x = at(placeOf(a));
      for (const p of (states()[a.id]?.positions ?? []).slice(0, 40)) x.coins.add(p.coin);
    }
    for (const p of Object.keys(markets()) as Place[]) at(p);
    for (const [p, x] of byPlace) {
      const [venue, network] = p.split(':') as [Venue, Network];
      post({ t: 'follow', venue, network, coins: [...x.coins], tickets: x.tickets.slice(0, 16), ladders: [...x.ladders].slice(0, 6) });
    }
  }, 30) as unknown as number;
}

/** What one panel follows, replacing what it followed; `null` lets go. */
export function follow(owner: string, what: { place: Place; coins: string[]; tickets?: { account: string; coin: string }[]; ladders?: string[] } | null): void {
  if (what) wanted.set(owner, { ...what, tickets: what.tickets ?? [], ladders: what.ladders ?? [] });
  else wanted.delete(owner);
  sendFollow();
}

/**
 * The coin a market of any exchange trades as on a venue: BTC for
 * `binance-perp:BTCUSDT` as for `hyperliquid-perp:BTCUSD`, kPEPE for 1000PEPE
 * on Hyperliquid. Null when the venue has no such perpetual.
 */
export function coinOfMarket(market: string, known: Map<string, MarketInfo> | undefined): string | null {
  const m = parseMarket(market);
  if (!m || m.venue === 'index' || !known) return null;
  const base = m.symbol.replace(/[-_]?(PERP|SWAP)$/, '').replace(/(USDT|USDC|USD|BUSD|FDUSD)$/, '');
  if (known.has(base)) return base;
  const k = base.startsWith('1000') ? `k${base.slice(4)}` : null;
  return k && known.has(k) ? k : null;
}

export const trade = { accounts, states, links, books, markets, down, activity, vault, guards, ready, algos, depths };

// How a position closes from the positions list: the parts offered (as percentages of it) and
// whether a close asks first. Kept in this browser.
const CLOSE_KEY = 'closePrefs';
export const DEFAULT_PARTS = [10, 25, 50, 75, 100];

interface ClosePrefs {
  confirm: boolean;
  parts: number[];
}

/** Whole percentages from 1 to 100, each once, smallest first; the defaults if none are left. */
export function cleanParts(list: unknown): number[] {
  if (!Array.isArray(list)) return DEFAULT_PARTS;
  const out = [...new Set(list.map(Number).filter((v) => Number.isFinite(v)).map((v) => Math.round(v)).filter((v) => v >= 1 && v <= 100))].sort((a, b) => a - b);
  return out.length ? out.slice(0, 6) : DEFAULT_PARTS;
}

const readClose = (): ClosePrefs => {
  const j = readJson(CLOSE_KEY) as Partial<ClosePrefs> | null;
  return { confirm: j?.confirm !== false, parts: cleanParts(j?.parts) };
};

const [closing, setClosing] = createSignal<ClosePrefs>(readClose());

export const closePrefs = closing;

export function setClosePrefs(p: Partial<ClosePrefs>): void {
  const next = { ...closing(), ...p };
  next.parts = cleanParts(next.parts);
  setClosing(next);
  writePref(CLOSE_KEY, JSON.stringify(next));
}

/**
 * A position's liquidation price: the exchange's or, where it gives none, worked out from the
 * leverage — the margin gone but the maintenance part, half the initial margin at the coin's
 * most leverage. Null where neither can say.
 */
export function liqOf(a: AccountRef, p: Position): number | null {
  if (p.liquidation) return p.liquidation;
  const most = markets()[placeOf(a)]?.get(p.coin)?.maxLeverage ?? 0;
  if (!(p.leverage > 0 && most > 0)) return null;
  return p.entry * (p.size > 0 ? 1 - 1 / p.leverage + 0.5 / most : 1 + 1 / p.leverage - 0.5 / most);
}
