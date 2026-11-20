/**
 * What the page and the trade worker say to each other. The worker holds the
 * trading keys, one socket per exchange and network, and every account as the
 * exchange reports it; the page asks for orders and draws what it reports.
 *
 * Accounts are as many as one likes, on Hyperliquid or Lighter, each with its
 * own key, or none when it is only watched. They are named by an id of
 * tradoor's own, never by their key.
 */
export type Venue = 'hyperliquid' | 'lighter';
export type Network = 'mainnet' | 'testnet';
export type Mode = 'trade' | 'watch';
export type Tif = 'Gtc' | 'Alo' | 'Ioc';

export const VENUE_NAME: Record<Venue, string> = { hyperliquid: 'Hyperliquid', lighter: 'Lighter' };

/** An account as tradoor keeps it: everything but its key. */
export interface AccountRef {
  id: string;
  venue: Venue;
  network: Network;
  /** The owner's own address. */
  owner: string;
  /** What the person calls it. */
  label: string;
  mode: Mode;
  /** Hyperliquid: the trading key's address. Lighter: the API key's public key. */
  agent: string | null;
  /** Lighter: the account's index, and the index the API key sits at. */
  accountIndex?: number;
  apiKeyIndex?: number;
  /** When the exchange stops taking the key, ms; 0 for never. */
  validUntil: number;
  created: number;
}

/** A market of a venue, by its coin: what sizes and prices it takes. */
export interface MarketInfo {
  coin: string;
  szDecimals: number;
  /** Decimals a price may have; for Hyperliquid, 6 − szDecimals at most and five significant figures. */
  pxDecimals: number;
  maxLeverage: number;
  /** The smallest order, in USD. */
  minUsd: number;
}

export interface Position {
  coin: string;
  /** Signed: below zero is short. */
  size: number;
  entry: number;
  value: number;
  pnl: number;
  roe: number;
  liquidation: number | null;
  leverage: number;
  cross: boolean;
  margin: number;
  funding: number;
}

export interface OpenOrder {
  coin: string;
  oid: number;
  cloid: string | null;
  buy: boolean;
  price: number;
  size: number;
  origSize: number;
  /** In words: Limit, Stop Market, Take Profit Limit… */
  kind: string;
  trigger: number | null;
  triggerCondition: string;
  reduceOnly: boolean;
  /** The take profit or stop for the whole position. */
  positionTpsl: boolean;
  tif: string | null;
  time: number;
}

/** An order no longer open: filled, cancelled, rejected, triggered. */
export interface PastOrder extends OpenOrder {
  status: string;
  statusTime: number;
}

export interface Fill {
  coin: string;
  price: number;
  size: number;
  buy: boolean;
  time: number;
  /** Open Long, Close Short… */
  dir: string;
  pnl: number;
  fee: number;
  oid: number;
  tid: number;
  /** Taken from the book (taker), not rested on it. */
  crossed: boolean;
  /** tradoor's own id of the order, where the exchange gives it back. */
  cloid?: string;
}

export interface AccountState {
  value: number;
  marginUsed: number;
  notional: number;
  withdrawable: number;
  positions: Position[];
  orders: OpenOrder[];
  fills: Fill[];
  /** For the tickets' coins: the leverage set, and the most a buy or a sell can be, in coins. */
  assetData: Record<string, { leverage: number; cross: boolean; maxBuy: number; maxSell: number }>;
  at: number;
}

export type Link = 'connecting' | 'open' | 'closed';

/** One thing done to an account: what was asked, and how it went. */
export interface Activity {
  id: number;
  account: string;
  at: number;
  what: string;
  state: 'sent' | 'ok' | 'refused';
  detail: string;
  /** From signing to the exchange's answer. */
  ms: number;
  /** Taken by the exchange, then cancelled by it: a post-only that would cross, a reduce-only with nothing to reduce. */
  late?: boolean;
}

/** Limits every order is held to before it is signed. */
export interface Guards {
  /** The most one order may be worth, USD; 0 for no limit. */
  maxUsd: number;
  /** How far past the best price a limit may be, as a fraction. */
  band: number;
  /** A market order's worst price, as a fraction past the best. */
  slippage: number;
}

export const DEFAULT_GUARDS: Guards = { maxUsd: 25_000, band: 0.05, slippage: 0.01 };

/** An order that takes a position off at a price — its TP or SL — kept by the venue as the position's own or as a reduce-only trigger (Hyperliquid's entry-attached ones). */
export const isExit = (o: OpenOrder): boolean => o.positionTpsl || (o.reduceOnly && o.trigger !== null);

export type Kind = 'market' | 'limit' | 'stop' | 'stopLimit';

export interface OrderRequest {
  coin: string;
  buy: boolean;
  /** In coins. */
  size: number;
  kind: Kind;
  /** A limit's price, or a stop-limit's once triggered. */
  price?: number;
  /** A stop's trigger. */
  trigger?: number;
  tif?: Tif;
  reduceOnly?: boolean;
  /** Take profit and stop for the entry: live once it fills. */
  tp?: number;
  sl?: number;
  guards: Guards;
}

/** How the keys are kept: by this device alone, or also behind a passphrase. */
export interface VaultState {
  kind: 'device' | 'passphrase';
  locked: boolean;
  /** Minutes without an order before it locks again; 0 for never. */
  autoLock: number;
}

/** What TWAP does when the price leaves its bounds: waits, stops, does the rest at once, or closes the position. */
export type BoundsAction = 'pause' | 'abort' | 'finish' | 'close';

interface AlgoBase {
  account: string;
  coin: string;
  buy: boolean;
  /** In coins, all of it. */
  size: number;
  reduceOnly: boolean;
}

/**
 * Algorithms that run in the trade worker, on any account: a chase that
 * follows the best price with a post-only order, a TWAP of slices over time,
 * a scale of orders across a range, a swarm of market slices at once.
 */
export type AlgoSpec =
  | (AlgoBase & {
      kind: 'chase';
      /** On the other side of the spread, one tick inside it: still a maker, as near as can be. */
      aggressive: boolean;
      /** Ticks back from the best price; with `stalk`, a distance instead. */
      offset: number;
      stalk: { mode: 'maintain' | 'trail'; distance: number } | null;
      /** How far it may follow the price away from where it began, a fraction; 0 until filled. */
      chaseTo: number;
      /** Minutes it may take; 0 for as long as it takes. */
      minutes: number;
      /** At its limit or its time: cancelled, left resting, or the rest taken at the market. */
      onEnd: 'cancel' | 'keep' | 'market';
    })
  | (AlgoBase & {
      kind: 'twap';
      minutes: number;
      lots: number;
      /** How far each slice's time may stray from even spacing, a fraction of the interval. */
      jitter: number;
      /** How far each slice's size may stray from even, a fraction. */
      irregular: number;
      bounds: { low: number; high: number; action: BoundsAction } | null;
      /** Each slice at the market, or chased for part of its interval first. */
      slice: 'market' | 'chase';
      /** The part of its interval a chased slice may take. */
      timeout: number;
      /** A chased slice not filled by then: the rest at the market, or added to the next slice. */
      onTimeout: 'market' | 'next';
    })
  | (AlgoBase & {
      kind: 'scale';
      from: number;
      to: number;
      count: number;
      /** −1 bunches the orders towards `from`, +1 towards `to`; the same for their sizes. */
      priceSkew: number;
      sizeSkew: number;
      postOnly: boolean;
    })
  | (AlgoBase & { kind: 'swarm'; lots: number; irregular: number })
  | (AlgoBase & {
      kind: 'when';
      conditions: Condition[];
      /** All at once, or the first. */
      join: 'and' | 'or';
      /** What happens once they are met: an order, or an algorithm. */
      then: { kind: 'order'; req: Omit<OrderRequest, 'guards'> } | { kind: 'algo'; spec: Exclude<AlgoSpec, { kind: 'when' }> };
    });

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';
export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

/**
 * What a conditional order waits for: a coin's price over or under a level,
 * one coin's price in another's, a candle closing over or under a level, a
 * candle's volume in dollars, or a time.
 */
export type Condition =
  | { kind: 'price'; coin: string; above: boolean; value: number }
  | { kind: 'ratio'; coin: string; of: string; above: boolean; value: number }
  | { kind: 'close'; coin: string; tf: Timeframe; above: boolean; value: number }
  | { kind: 'volume'; coin: string; tf: Timeframe; above: boolean; value: number }
  | { kind: 'time'; at: number };

export interface AlgoState {
  id: string;
  spec: AlgoSpec;
  status: 'running' | 'paused' | 'done' | 'stopped' | 'failed';
  started: number;
  ended: number;
  filled: number;
  avg: number;
  lotsDone: number;
  lotsTotal: number;
  detail: string;
}

/** What a venue's book says now, by coin. */
export type Books = Record<string, { bid: number; ask: number }>;

export type ToWorker =
  | { t: 'start'; signers: { hyperliquid: string; lighter: string; lighterGlue: string } }
  | { t: 'addWatch'; id: number; venue: Venue; network: Network; owner: string; label: string; accountIndex?: number }
  | { t: 'newAgent'; id: number; network: Network; owner: string; validUntil: number }
  | { t: 'approveAgent'; id: number; network: Network; owner: string; label: string; agent: string; action: unknown; nonce: number; signature: { r: string; s: string; v: number } }
  | { t: 'importKey'; id: number; venue: Venue; network: Network; owner: string; label: string; key: string; accountIndex?: number; apiKeyIndex?: number }
  | { t: 'lighterKey'; id: number; network: Network; owner: string; accountIndex: number; apiKeyIndex: number }
  | { t: 'lighterRegister'; id: number; network: Network; owner: string; label: string; accountIndex: number; apiKeyIndex: number; l1Sig: string }
  | { t: 'rename'; account: string; label: string }
  | { t: 'remove'; account: string }
  | { t: 'removeAll' }
  | { t: 'vault'; id: number; op: 'unlock' | 'lock' | 'set' | 'clear'; passphrase?: string; autoLock?: number }
  | { t: 'follow'; venue: Venue; network: Network; coins: string[]; tickets: { account: string; coin: string }[]; ladders: string[] }
  | { t: 'order'; id: number; account: string; req: OrderRequest }
  | { t: 'cancel'; id: number; account: string; orders: { coin: string; oid: number }[] }
  | { t: 'move'; id: number; account: string; order: OpenOrder; price: number }
  | { t: 'leverage'; id: number; account: string; coin: string; leverage: number; cross: boolean }
  | { t: 'exits'; id: number; account: string; coin: string; tp: number | null; sl: number | null }
  | { t: 'flatten'; id: number; account: string | null; coin: string | null; guards: Guards }
  | { t: 'history'; id: number; account: string }
  | { t: 'algo'; id: number; spec: AlgoSpec; guards: Guards }
  | { t: 'algoStop'; algo: string };

export type FromWorker =
  | { t: 'accounts'; accounts: AccountRef[] }
  | { t: 'state'; account: string; state: AccountState }
  | { t: 'link'; venue: Venue; network: Network; link: Link }
  | { t: 'books'; venue: Venue; network: Network; books: Books }
  | { t: 'depth'; venue: Venue; network: Network; coin: string; bids: [number, number][]; asks: [number, number][] }
  | { t: 'markets'; venue: Venue; network: Network; markets: MarketInfo[] }
  /** An exchange that would not start (down, unreachable), and why; null once it has. */
  | { t: 'venueDown'; venue: Venue; network: Network; error: string | null }
  | { t: 'activity'; activity: Activity }
  | { t: 'vault'; vault: VaultState }
  | { t: 'algos'; algos: AlgoState[] }
  | { t: 'reply'; id: number; error: string | null; data?: unknown }
  | { t: 'error'; message: string };
