/**
 * What every venue in the trade worker shares: a hub per venue and network
 * (one socket, the markets, the best bids and asks, however many accounts
 * there are), an account's connection on it, and the guards every order is
 * held to before it is signed.
 */
import type { AccountRef, AccountState, Books, FromWorker, Guards, Link, MarketInfo, OpenOrder, OrderRequest, PastOrder } from '../protocol';

/** What the worker gives a venue. */
export interface Env {
  say(m: FromWorker): void;
  /** An account's key for one use, wiped by the caller; throws `locked` while the keys are locked. */
  secret(account: string): Promise<Uint8Array | null>;
  /** Notes an order on its way: called again with how it went. `late`: the exchange undid it after taking it, so the page says so aloud. */
  activity(account: string, what: string): (state: 'sent' | 'ok' | 'refused', detail: string, late?: boolean) => void;
}

export interface Hub {
  markets: Map<string, MarketInfo>;
  books: Books;
  link: Link;
  start(): Promise<void>;
  add(conn: Conn): void;
  remove(id: string): void;
  follow(coins: string[], tickets: { account: string; coin: string }[], ladders: string[]): void;
  /** Coins an algorithm watches, followed beside the panels' own. */
  want(owner: string, coins: string[]): void;
  /** The latest candles, oldest first: their start, prices and volume in dollars. */
  candles(coin: string, tf: string, count: number): Promise<Candle[]>;
  close(): void;
}

export interface Conn {
  ref: AccountRef;
  state: AccountState;
  /** Called on the hub's socket opening: subscribe what this account needs. */
  subscribe(): void;
  unsubscribe(): void;
  place(req: OrderRequest): Promise<string | null>;
  cancel(orders: { coin: string; oid: number }[]): Promise<string | null>;
  move(order: OpenOrder, price: number): Promise<string | null>;
  leverage(coin: string, leverage: number, cross: boolean): Promise<string | null>;
  exits(coin: string, tp: number | null, sl: number | null): Promise<string | null>;
  flatten(coin: string | null, guards: Guards): Promise<string | null>;
  history(): Promise<PastOrder[]>;
  /** The smallest step a price may move at that price. */
  tick(coin: string, price: number): number;
  /** An algo's own orders, by tradoor's id for each: placed (several at once), changed, cancelled, and how each stands. */
  childPlace(children: Child[], what: string | null): Promise<string | null>;
  childMove(child: Child, what: string | null): Promise<string | null>;
  childCancel(children: Child[], what: string | null): Promise<string | null>;
  /** `known`: the exchange has shown it at all — open, done, or a fill. An order just placed may not be shown yet. */
  childState(child: Child): { open: boolean; remaining: number; filled: number; avg: number; known: boolean };
  /** A new id for a child order. */
  childId(): string;
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  usd: number;
}

export const TF_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

/** The panels' coins and the algorithms', followed as one: what `follow` and `want` share. */
export class Follows {
  private last: [string[], { account: string; coin: string }[], string[]] = [[], [], []];
  private wanted = new Map<string, string[]>();
  constructor(private apply: (coins: string[], tickets: { account: string; coin: string }[], ladders: string[]) => void) {}
  panels(coins: string[], tickets: { account: string; coin: string }[], ladders: string[]) {
    this.last = [coins, tickets, ladders];
    this.run();
  }
  want(owner: string, coins: string[]) {
    if (coins.length) this.wanted.set(owner, coins);
    else this.wanted.delete(owner);
    this.run();
  }
  private run() {
    const [coins, tickets, ladders] = this.last;
    this.apply([...new Set([...coins, ...[...this.wanted.values()].flat()])], tickets, ladders);
  }
}

/** An order an algo places and looks after. */
export interface Child {
  id: string;
  coin: string;
  buy: boolean;
  size: number;
  price: number;
  /** Post-only, resting, or immediate-or-cancel (a market slice when its price is past the book). */
  tif: 'Alo' | 'Gtc' | 'Ioc';
  reduceOnly: boolean;
}

export const emptyState = (): AccountState => ({ value: 0, marginUsed: 0, notional: 0, withdrawable: 0, positions: [], orders: [], fills: [], assetData: {}, at: 0 });

export const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));

/** Why an order may not go, or null: its size, the venue's smallest order, the person's limits. */
export function guard(m: MarketInfo, book: Books[string] | undefined, buy: boolean, size: number, price: number, g: Guards, reduceOnly: boolean): string | null {
  if (!(size > 0)) return `Below ${m.coin}'s smallest size, ${10 ** -m.szDecimals}`;
  if (!(price > 0)) return 'No price to order at';
  const worth = size * price;
  if (!reduceOnly && worth < m.minUsd) return `Worth $${worth.toFixed(2)}: the smallest order here is $${m.minUsd}`;
  if (g.maxUsd > 0 && worth > g.maxUsd) return `Worth $${Math.round(worth).toLocaleString('en-US')}, over your limit of $${g.maxUsd.toLocaleString('en-US')} an order`;
  if (book && book.bid > 0 && book.ask > 0 && g.band > 0) {
    if (buy && price > book.ask * (1 + g.band)) return `A buy ${(g.band * 100).toFixed(1)}% or more over the best ask: refused by your price guard`;
    if (!buy && price < book.bid * (1 - g.band)) return `A sell ${(g.band * 100).toFixed(1)}% or more under the best bid: refused by your price guard`;
  }
  return null;
}

/** A trigger's kind: a stop moves against the side it buys or sells, a take profit with it. */
export function tpslOf(buy: boolean, trigger: number, book: Books[string] | undefined): 'tp' | 'sl' {
  const mid = book && book.bid > 0 && book.ask > 0 ? (book.bid + book.ask) / 2 : trigger;
  return buy === trigger >= mid ? 'sl' : 'tp';
}

/** A market trigger's worst price once it fires: 10% past its trigger. */
export const triggerLimit = (buy: boolean, trigger: number): number => (buy ? trigger * 1.1 : trigger * 0.9);

/** Calls `run` at most every `ms`, the last call always made. */
export function throttle(ms: number, run: () => void): () => void {
  let timer = 0;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      run();
    }, ms) as unknown as number;
  };
}
