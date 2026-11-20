/**
 * Lighter in the trade worker. One hub a network: the markets (prices and sizes
 * as integers, by each market's decimals), one socket for the best bids and
 * asks and every account's positions, trades and figures, and tradoor's own
 * signer (signers/lighter), which signs orders, cancels, changes and leverage
 * and has no way to sign a transfer or a withdrawal.
 *
 * Each API key has its own nonce, counted here from the exchange's; a
 * transaction the API refuses does not use its nonce, so it is read afresh.
 * Open orders need an auth token signed by the key: a watched account shows
 * its positions and trades, not its orders.
 */
import { fromHex, toHex } from '../signer';
import type { AccountRef, Fill, Guards, Link, MarketInfo, Network, OpenOrder, OrderRequest, PastOrder, Position } from '../protocol';
import { emptyState, Follows, guard, num, throttle, tpslOf, triggerLimit, type Candle, type Child, type Conn, type Env, type Hub } from './common';

export const LIGHTER: Record<Network, { http: string; ws: string; chain: number; app: string }> = {
  mainnet: { http: 'https://mainnet.zklighter.elliot.ai', ws: 'wss://mainnet.zklighter.elliot.ai/stream', chain: 304, app: 'https://app.lighter.xyz' },
  testnet: { http: 'https://testnet.zklighter.elliot.ai', ws: 'wss://testnet.zklighter.elliot.ai/stream', chain: 300, app: 'https://testnet.app.lighter.xyz' },
};

/** The API key index tradoor takes unless told otherwise: one of its own, so no other app's key is replaced. */
export const TRADOOR_KEY_INDEX = 128;

interface Market extends MarketInfo {
  id: number;
  sizeDec: number;
  priceDec: number;
  minBase: number;
  /** The leverage a position takes until one is set. */
  defaultLeverage: number;
}

type SignerCall = (req: Record<string, unknown>) => Record<string, any>;

/** Order types and times in force, as Lighter numbers them. */
const TYPE = { limit: 0, market: 1, stopLoss: 2, stopLossLimit: 3, takeProfit: 4, takeProfitLimit: 5 } as const;
const TIF = { ioc: 0, gtt: 1, post: 2 } as const;

export class LighterHub implements Hub {
  markets = new Map<string, MarketInfo>();
  byCoin = new Map<string, Market>();
  byId = new Map<number, Market>();
  books: Record<string, { bid: number; ask: number }> = {};
  link: Link = 'closed';
  private ws: WebSocket | null = null;
  private retry = 0;
  private ping = 0;
  private conns = new Map<string, LighterConn>();
  private followed = new Set<string>();
  private ladders = new Set<string>();
  private sides = new Map<string, { bids: Map<number, number>; asks: Map<number, number> }>();
  private depthOut = new Map<string, () => void>();
  private closed = false;
  private sayBooks = throttle(80, () => this.env.say({ t: 'books', venue: 'lighter', network: this.network, books: this.books }));
  private signerCall: Promise<SignerCall> | null = null;

  constructor(
    readonly network: Network,
    readonly env: Env,
    private signerUrls: () => { wasm: string; glue: string },
  ) {}

  get api() {
    return LIGHTER[this.network];
  }

  /** tradoor's Lighter signer, loaded the first time it is needed: a few megabytes, so only then. */
  signer(): Promise<SignerCall> {
    this.signerCall ??= (async () => {
      const { wasm, glue } = this.signerUrls();
      await import(/* @vite-ignore */ glue);
      const go = new (globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } }).Go();
      const { instance } = await WebAssembly.instantiateStreaming(fetch(wasm), go.importObject).catch(async () => WebAssembly.instantiate(await (await fetch(wasm)).arrayBuffer(), go.importObject));
      void go.run(instance);
      const fn = (globalThis as unknown as { tradoorLighter?: (json: string) => string }).tradoorLighter;
      if (!fn) throw new Error('The Lighter signer did not start');
      return (req) => JSON.parse(fn(JSON.stringify(req)));
    })();
    return this.signerCall;
  }

  async get(path: string, auth?: string): Promise<any> {
    const res = await fetch(`${this.api.http}${path}`, auth ? { headers: { Authorization: auth } } : {});
    const body = await res.json().catch(() => ({ code: res.status, message: `Lighter answered ${res.status}` }));
    if (body.code && body.code !== 200) throw new Error(body.message ?? `Lighter answered ${body.code}`);
    return body;
  }

  /** Sends signed transactions; the refusal in words, or null. */
  async sendTx(txs: { txType: number; txInfo: string }[]): Promise<{ error: string | null; hash?: string }> {
    const one = txs.length === 1;
    const body = one ? new URLSearchParams({ tx_type: String(txs[0]!.txType), tx_info: txs[0]!.txInfo }) : new URLSearchParams({ tx_types: JSON.stringify(txs.map((t) => t.txType)), tx_infos: JSON.stringify(txs.map((t) => t.txInfo)) });
    const res = await fetch(`${this.api.http}/api/v1/${one ? 'sendTx' : 'sendTxBatch'}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const r = await res.json().catch(() => ({ code: res.status, message: `Lighter answered ${res.status}` }));
    return r.code === 200 ? { error: null, hash: r.tx_hash ?? r.tx_hash?.[0] } : { error: r.message ?? `Refused (${r.code})` };
  }

  async start() {
    const d = await this.get('/api/v1/orderBookDetails?filter=perp');
    for (const m of (d.order_book_details ?? []) as any[]) {
      if (m.status !== 'active' || m.market_type !== 'perp') continue;
      const market: Market = {
        coin: m.symbol,
        id: m.market_id,
        szDecimals: m.size_decimals,
        pxDecimals: m.price_decimals,
        sizeDec: m.size_decimals,
        priceDec: m.price_decimals,
        minBase: num(m.min_base_amount),
        minUsd: num(m.min_quote_amount) || 10,
        maxLeverage: m.min_initial_margin_fraction > 0 ? Math.floor(10_000 / m.min_initial_margin_fraction) : 1,
        defaultLeverage: m.default_initial_margin_fraction > 0 ? Math.floor(10_000 / m.default_initial_margin_fraction) : 1,
      };
      this.byCoin.set(market.coin, market);
      this.byId.set(market.id, market);
      this.markets.set(market.coin, market);
      if (num(m.mark_price) > 0 && !this.books[market.coin]) this.books[market.coin] = { bid: num(m.mark_price), ask: num(m.mark_price) };
    }
    this.env.say({ t: 'markets', venue: 'lighter', network: this.network, markets: [...this.markets.values()].map(({ coin, szDecimals, pxDecimals, maxLeverage, minUsd }) => ({ coin, szDecimals, pxDecimals, maxLeverage, minUsd })) });
    this.connect();
  }

  add(conn: Conn) {
    this.conns.set(conn.ref.id, conn as unknown as LighterConn);
    if (this.open()) conn.subscribe();
  }

  remove(id: string) {
    const c = this.conns.get(id);
    if (c && this.open()) c.unsubscribe();
    this.conns.delete(id);
  }

  close() {
    this.closed = true;
    clearInterval(this.ping);
    this.ws?.close();
    this.ws = null;
  }

  private open = () => this.ws?.readyState === WebSocket.OPEN;

  private setLink(l: Link) {
    if (this.link === l) return;
    this.link = l;
    this.env.say({ t: 'link', venue: 'lighter', network: this.network, link: l });
  }

  send(msg: object) {
    if (this.open()) this.ws!.send(JSON.stringify(msg));
  }

  private connect() {
    if (this.closed) return;
    this.setLink('connecting');
    const sock = new WebSocket(this.api.ws);
    this.ws = sock;
    sock.onopen = () => {
      if (this.ws !== sock) return;
      this.retry = 0;
      this.setLink('open');
      for (const c of this.followed) this.send({ type: 'subscribe', channel: `ticker/${this.byCoin.get(c)!.id}` });
      for (const c of this.ladders) this.send({ type: 'subscribe', channel: `order_book/${this.byCoin.get(c)!.id}` });
      for (const c of this.conns.values()) c.subscribe();
      clearInterval(this.ping);
      // A frame at least every two minutes keeps the socket.
      this.ping = setInterval(() => this.send({ type: 'ping' }), 50_000) as unknown as number;
    };
    sock.onmessage = (e) => this.ws === sock && this.onMessage(JSON.parse(e.data as string));
    sock.onclose = () => {
      if (this.ws !== sock) return;
      this.ws = null;
      this.setLink('closed');
      setTimeout(() => this.connect(), [1000, 2000, 5000, 10_000][Math.min(this.retry++, 3)]);
    };
  }

  private onMessage(m: any) {
    const channel = String(m.channel ?? '');
    const [name, a] = channel.split(':');
    if (name === 'ticker') {
      const market = this.byId.get(Number(a));
      if (!market) return;
      this.books[market.coin] = { bid: num(m.ticker?.b?.price), ask: num(m.ticker?.a?.price) };
      this.sayBooks();
      return;
    }
    if (name === 'order_book') {
      const market = this.byId.get(Number(a));
      if (market) this.readBook(market.coin, m.order_book, String(m.type).startsWith('subscribed'));
      return;
    }
    const idx = Number(m.account ?? a);
    for (const c of this.conns.values()) {
      if (c.ref.accountIndex !== idx) continue;
      if (name === 'account_all') c.readAll(m, String(m.type).startsWith('subscribed'));
      else if (name === 'user_stats') c.readStats(m.stats);
      else if (name === 'account_all_orders') c.readOrders(m.orders, String(m.type).startsWith('subscribed'));
    }
  }

  /** The book as a snapshot, then changes: a size of 0 takes a level away. */
  private readBook(coin: string, ob: any, snapshot: boolean) {
    if (!ob) return;
    let s = this.sides.get(coin);
    if (!s || snapshot) this.sides.set(coin, (s = { bids: new Map(), asks: new Map() }));
    for (const [key, side] of [['bids', s.bids], ['asks', s.asks]] as const)
      for (const l of (ob[key] ?? []) as { price: string; size: string }[]) {
        const p = num(l.price);
        if (num(l.size) > 0) side.set(p, num(l.size));
        else side.delete(p);
      }
    let say = this.depthOut.get(coin);
    if (!say) {
      say = throttle(100, () => {
        const cur = this.sides.get(coin);
        if (!cur) return;
        const bids = [...cur.bids].sort((x, y) => y[0] - x[0]).slice(0, 30);
        const asks = [...cur.asks].sort((x, y) => x[0] - y[0]).slice(0, 30);
        this.env.say({ t: 'depth', venue: 'lighter', network: this.network, coin, bids, asks });
      });
      this.depthOut.set(coin, say);
    }
    say();
  }

  private follows = new Follows((c, t, l) => this.apply(c, t, l));
  follow(coins: string[], tickets: { account: string; coin: string }[], ladders: string[] = []) {
    this.follows.panels(coins, tickets, ladders);
  }
  want(owner: string, coins: string[]) {
    this.follows.want(owner, coins);
  }

  async candles(coin: string, tf: string, count: number): Promise<Candle[]> {
    const m = this.byCoin.get(coin);
    if (!m) return [];
    const ms = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }[tf] ?? 3_600_000;
    const end = Date.now();
    const d = await this.get(`/api/v1/candles?market_id=${m.id}&resolution=${tf}&start_timestamp=${end - ms * (count + 1)}&end_timestamp=${end}&count_back=${count}`);
    return ((d.c ?? []) as { t: number; o: number; h: number; l: number; c: number; V: number }[]).map((k) => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, usd: k.V }));
  }

  private apply(coins: string[], tickets: { account: string; coin: string }[], ladders: string[]) {
    const nextLadders = new Set(ladders.filter((c) => this.byCoin.has(c)));
    for (const c of this.ladders) if (!nextLadders.has(c)) (this.send({ type: 'unsubscribe', channel: `order_book/${this.byCoin.get(c)!.id}` }), this.sides.delete(c));
    for (const c of nextLadders) if (!this.ladders.has(c)) this.send({ type: 'subscribe', channel: `order_book/${this.byCoin.get(c)!.id}` });
    this.ladders = nextLadders;
    const next = new Set([...coins, ...tickets.map((t) => t.coin)].filter((c) => this.byCoin.has(c)));
    for (const c of this.followed) if (!next.has(c)) this.send({ type: 'unsubscribe', channel: `ticker/${this.byCoin.get(c)!.id}` });
    for (const c of next) if (!this.followed.has(c)) this.send({ type: 'subscribe', channel: `ticker/${this.byCoin.get(c)!.id}` });
    this.followed = next;
  }

  /** The worst price a market order may take: the best on the other side, and the slippage past it. */
  async marketPrice(coin: string, buy: boolean, slippage: number): Promise<number> {
    let b = this.books[coin];
    const m = this.byCoin.get(coin);
    if (m && (!b || !(b.bid > 0 && b.ask > 0))) {
      const d = await this.get(`/api/v1/orderBookOrders?market_id=${m.id}&limit=1`);
      b = { bid: num(d.bids?.[0]?.price), ask: num(d.asks?.[0]?.price) };
    }
    const px = b ? (buy ? b.ask * (1 + slippage) : b.bid * (1 - slippage)) : 0;
    if (!(px > 0)) throw new Error(`No price for ${coin}`);
    return px;
  }
}

/** An id of tradoor's own for an order: unique across markets, under 2^47. */
const clientIndex = () => {
  const b = crypto.getRandomValues(new Uint32Array(2));
  return (b[0]! & 0x7fff) * 2 ** 32 + b[1]!;
};

const KIND: Record<string, string> = { limit: 'Limit', market: 'Market', 'stop-loss': 'Stop Market', 'stop-loss-limit': 'Stop Limit', 'take-profit': 'Take Profit Market', 'take-profit-limit': 'Take Profit Limit', twap: 'TWAP', 'twap-sub': 'TWAP slice', liquidation: 'Liquidation' };
const TIF_NAME: Record<string, string> = { 'good-till-time': 'Gtc', 'post-only': 'Alo', 'immediate-or-cancel': 'Ioc' };

/** An order's expiry as Lighter keeps them, 28 days on, in ms: worked out once for orders that must share it. */
const until = () => Date.now() + 28 * 86_400_000;

/** Why Lighter took an order off the book itself, by its status. */
const WHY: Record<string, string> = {
  'canceled-post-only': 'post only, and it would have crossed the book',
  'canceled-reduce-only': 'reduce only, and there was no position for it to reduce',
  'canceled-position-not-allowed': 'the position it would open is not allowed',
  'canceled-margin-not-allowed': 'not enough margin for it',
  'canceled-too-much-slippage': 'it would have slipped too far from the price',
  'canceled-not-enough-liquidity': 'not enough on the book to fill it',
  'canceled-self-trade': 'it would have traded with your own order',
  'canceled-expired': 'it expired',
  'canceled-liquidation': 'the account was being liquidated',
};

function readOrder(o: any): OpenOrder & { status: string; statusTime: number } {
  const trigger = num(o.trigger_price);
  return {
    coin: o.market_symbol ?? '',
    oid: o.order_index,
    cloid: o.client_order_index !== undefined ? String(o.client_order_index) : null,
    buy: !o.is_ask,
    price: num(o.price),
    size: num(o.remaining_base_amount),
    origSize: num(o.initial_base_amount),
    kind: KIND[o.type] ?? o.type,
    trigger: trigger > 0 ? trigger : null,
    triggerCondition: trigger > 0 ? `at ${o.trigger_price}` : '',
    reduceOnly: !!o.reduce_only,
    positionTpsl: !!o.reduce_only && trigger > 0,
    tif: TIF_NAME[o.time_in_force] ?? null,
    time: num(o.timestamp) * 1000,
    status: o.status ?? '',
    statusTime: num(o.updated_at) * 1000 || num(o.timestamp) * 1000,
  };
}

export class LighterConn implements Conn {
  state = emptyState();
  private positions = new Map<number, any>();
  private nonce: number | null = null;
  private auth: { token: string; until: number } | null = null;
  private authTimer = 0;
  private changed = throttle(50, () => {
    this.state.at = Date.now();
    this.hub.env.say({ t: 'state', account: this.ref.id, state: this.state });
  });
  private stats: any = null;

  constructor(
    public ref: AccountRef,
    private hub: LighterHub,
  ) {}

  private get idx() {
    return this.ref.accountIndex!;
  }

  subscribe() {
    this.hub.send({ type: 'subscribe', channel: `account_all/${this.idx}` });
    this.hub.send({ type: 'subscribe', channel: `user_stats/${this.idx}` });
    if (this.ref.mode === 'trade') void this.subscribeOrders();
  }

  unsubscribe() {
    clearTimeout(this.authTimer);
    for (const c of [`account_all/${this.idx}`, `user_stats/${this.idx}`, `account_all_orders/${this.idx}`]) this.hub.send({ type: 'unsubscribe', channel: c });
  }

  /** The key, as the signer takes it: hex. Wiped by the caller of `withKey`. */
  private async withKey<T>(run: (key: string) => Promise<T> | T): Promise<T> {
    let raw: Uint8Array | null;
    try {
      raw = await this.hub.env.secret(this.ref.id);
    } catch {
      throw new Error('The keys are locked: unlock them to trade');
    }
    if (!raw) throw new Error('This account has no API key');
    try {
      return await run(`0x${toHex(raw)}`);
    } finally {
      raw.fill(0);
    }
  }

  /** An auth token signed by the key, renewed before its seven hours run out. */
  private async token(): Promise<string> {
    if (this.auth && this.auth.until > Date.now() + 60_000) return this.auth.token;
    const signer = await this.hub.signer();
    const deadline = Math.floor(Date.now() / 1000) + 7 * 3600;
    const r = await this.withKey((key) => signer({ op: 'auth', key, chain: this.hub.api.chain, account: this.idx, apiKey: this.ref.apiKeyIndex, deadline }));
    if (r.error) throw new Error(r.error);
    this.auth = { token: r.authToken, until: deadline * 1000 };
    return r.authToken;
  }

  private async subscribeOrders() {
    try {
      const auth = await this.token();
      this.hub.send({ type: 'subscribe', channel: `account_all_orders/${this.idx}`, auth });
      clearTimeout(this.authTimer);
      // Subscribed again with a fresh token before this one runs out.
      this.authTimer = setTimeout(() => void this.subscribeOrders(), 6 * 3600_000) as unknown as number;
    } catch {
      // Locked: the orders show once the keys are unlocked and an order is sent.
    }
  }

  readAll(m: any, snapshot: boolean) {
    if (snapshot) this.positions.clear();
    for (const [id, p] of Object.entries(m.positions ?? {})) this.positions.set(Number(id), p);
    // Lighter writes the initial margin as a percentage: 5.00 is 5%, 20 times.
    const imfOf = (p: any) => num(p.initial_margin_fraction) / 100;
    this.state.positions = [...this.positions.values()]
      .filter((p) => num(p.position) !== 0)
      .map((p): Position => {
        const imf = imfOf(p);
        const margin = num(p.allocated_margin) || num(p.position_value) * imf;
        return {
          coin: p.symbol,
          size: num(p.position) * (p.sign < 0 ? -1 : 1),
          entry: num(p.avg_entry_price),
          value: num(p.position_value),
          pnl: num(p.unrealized_pnl),
          roe: margin > 0 ? num(p.unrealized_pnl) / margin : 0,
          liquidation: num(p.liquidation_price) > 0 ? num(p.liquidation_price) : null,
          leverage: imf > 0 ? Math.round(1 / imf) : 0,
          cross: p.margin_mode !== 1,
          margin,
          funding: -num(p.total_funding_paid_out),
        };
      });
    // Each market's leverage, for the ticket.
    for (const p of this.positions.values()) {
      const imf = imfOf(p);
      const prev = this.state.assetData[p.symbol];
      this.state.assetData[p.symbol] = { leverage: imf > 0 ? Math.round(1 / imf) : (prev?.leverage ?? 0), cross: p.margin_mode !== 1, maxBuy: prev?.maxBuy ?? 0, maxSell: prev?.maxSell ?? 0 };
    }
    const fresh: Fill[] = [];
    for (const list of Object.values(m.trades ?? {}) as any[][]) for (const t of list) fresh.push(this.readTrade(t));
    if (fresh.length) {
      const known = new Set(this.state.fills.map((f) => f.tid));
      this.state.fills = [...fresh.filter((f) => !known.has(f.tid)), ...this.state.fills].sort((a, b) => b.time - a.time).slice(0, 2000);
    }
    this.sizes();
    this.changed();
  }

  private readTrade(t: any): Fill {
    const buy = t.bid_account_id === this.idx;
    const taker = t.is_maker_ask ? buy : !buy;
    const cloid = buy ? (t.bid_client_id_str ?? t.bid_client_id) : (t.ask_client_id_str ?? t.ask_client_id);
    return { coin: t.market_symbol ?? this.hub.byId.get(t.market_id)?.coin ?? '', price: num(t.price), size: num(t.size), buy, time: num(t.timestamp), dir: buy ? 'Buy' : 'Sell', pnl: num(buy ? t.bid_account_pnl : t.ask_account_pnl), fee: 0, oid: buy ? t.bid_id : t.ask_id, tid: t.trade_id, crossed: taker, ...(cloid !== undefined ? { cloid: String(cloid) } : {}) };
  }

  readStats(s: any) {
    if (!s) return;
    this.stats = s;
    this.state.value = num(s.portfolio_value);
    this.state.withdrawable = num(s.available_balance);
    // What is held is what the account is worth less what is free: Lighter's own margin_usage
    // comes rounded to hundredths of a percent, so a small position read as $0.00 used.
    this.state.marginUsed = Math.max(0, num(s.portfolio_value) - num(s.available_balance), (num(s.portfolio_value) * num(s.margin_usage)) / 100);
    this.state.notional = num(s.portfolio_value) * num(s.leverage);
    this.sizes();
    this.changed();
  }

  /**
   * The most a buy or a sell can be, in coins, for each followed market: the
   * buying power at its price, or with none given (a unified account gives 0)
   * what is available times the market's leverage.
   */
  private sizes() {
    const power = num(this.stats?.buying_power);
    const available = num(this.stats?.available_balance);
    for (const [coin, b] of Object.entries(this.hub.books)) {
      const mid = b.bid > 0 && b.ask > 0 ? (b.bid + b.ask) / 2 : b.bid || b.ask;
      const m = this.hub.byCoin.get(coin);
      if (!(mid > 0) || !m) continue;
      const prev = this.state.assetData[coin];
      const lev = prev?.leverage || m.defaultLeverage;
      const max = (power > 0 ? power : available * lev) / mid;
      this.state.assetData[coin] = { leverage: lev, cross: prev?.cross ?? true, maxBuy: max, maxSell: max };
    }
  }

  /** The open orders as a snapshot, then changes: an update names only the orders that changed, and one no longer open leaves the list. */
  readOrders(byMarket: Record<string, any[]>, snapshot: boolean) {
    const open = new Map<number, OpenOrder>(snapshot ? [] : this.state.orders.map((o) => [o.oid, o]));
    for (const orders of Object.values(byMarket ?? {}))
      for (const o of orders) {
        if (['open', 'pending', 'in-progress'].includes(o.status)) {
          open.set(o.order_index, readOrder(o));
          continue;
        }
        open.delete(o.order_index);
        // Kept for the history even if it never showed as open: a post-only that crossed is cancelled on arrival.
        const r = readOrder(o);
        if (this.closed.some((c) => c.oid === r.oid && c.status === r.status)) continue;
        this.closed = [r, ...this.closed.filter((c) => c.oid !== r.oid)].slice(0, 100);
        // Lighter undoing an order it took is said aloud, but not an algo's (a chase re-places its own), nor a bracket's other leg.
        const why = /^canceled-(?!oco|child)/.test(o.status) && !snapshot && !this.kids.has(Number(o.client_order_index)) ? (WHY[o.status] ?? o.status.slice(9).replace(/-/g, ' ')) : null;
        if (why) this.hub.env.activity(this.ref.id, `${r.buy ? 'Buy' : 'Sell'} ${r.origSize} ${r.coin}${r.price ? ` @ ${r.price}` : ''}`)('refused', `Lighter cancelled it: ${why}`, true);
      }
    this.state.orders = [...open.values()];
    this.changed();
  }

  private market(coin: string) {
    return this.hub.byCoin.get(coin);
  }

  private base = (m: Market, size: number) => Math.floor(size * 10 ** m.sizeDec + 1e-9);
  private px = (m: Market, price: number) => Math.round(price * 10 ** m.priceDec);

  /** The sends in line: one at a time per key. */
  private line: Promise<unknown> = Promise.resolve();

  /**
   * Signs with the account's API key, at its next nonce, and sends; the refusal in words, or null.
   * One at a time: Lighter takes a key's nonces in order, and two sent at once (a basket's legs)
   * could arrive the wrong way round — the later nonce first, refused as invalid.
   */
  private send(what: string, make: (sign: (req: Record<string, unknown>) => Promise<{ txType: number; txInfo: string }>) => Promise<{ txType: number; txInfo: string }[]>, quiet = false): Promise<string | null> {
    const run = this.line.then(() => this.sendNow(what, make, quiet));
    this.line = run.catch(() => {});
    return run;
  }

  private async sendNow(what: string, make: (sign: (req: Record<string, unknown>) => Promise<{ txType: number; txInfo: string }>) => Promise<{ txType: number; txInfo: string }[]>, quiet: boolean): Promise<string | null> {
    if (this.ref.mode !== 'trade') return 'Watching only: this account has no API key';
    const note = quiet ? () => {} : this.hub.env.activity(this.ref.id, what);
    let txs: { txType: number; txInfo: string }[];
    try {
      if (this.nonce === null) this.nonce = (await this.hub.get(`/api/v1/nextNonce?account_index=${this.idx}&api_key_index=${this.ref.apiKeyIndex}`)).nonce as number;
      const signer = await this.hub.signer();
      txs = await this.withKey((key) =>
        make(async (req) => {
          const r = signer({ ...req, key, chain: this.hub.api.chain, account: this.idx, apiKey: this.ref.apiKeyIndex, nonce: this.nonce! });
          if (r.error) throw new Error(r.error);
          this.nonce!++;
          return { txType: r.txType, txInfo: r.txInfo };
        }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.nonce = null;
      note('refused', msg);
      return msg;
    }
    if (!txs.length) return null;
    note('sent', '');
    try {
      const r = await this.hub.sendTx(txs);
      // A refusal by the API leaves the nonces unused: read the next one afresh.
      if (r.error) this.nonce = null;
      note(r.error ? 'refused' : 'ok', r.error ?? 'accepted');
      if (!r.error) void this.subscribeOrdersOnce();
      return r.error;
    } catch (e) {
      this.nonce = null;
      const msg = e instanceof Error ? e.message : String(e);
      note('refused', msg);
      return msg;
    }
  }

  /** Orders seen leaving the open list this session, newest first (at most 100). */
  private closed: PastOrder[] = [];
  /** The client order indexes of algos' orders. */
  private kids = new Set<number>();
  private ordersOn = false;
  /** The orders channel once a key has signed: a locked account subscribes on its first order. */
  private async subscribeOrdersOnce() {
    if (this.ordersOn) return;
    this.ordersOn = true;
    await this.subscribeOrders();
  }

  async place(req: OrderRequest): Promise<string | null> {
    const m = this.market(req.coin);
    if (!m) return `${req.coin} is not traded on Lighter`;
    const g = req.guards;
    const book = this.hub.books[req.coin];
    const size = this.base(m, req.size) / 10 ** m.sizeDec;
    let order: Record<string, number>;
    let ref: number;
    const common = { market: m.id, clientOrder: clientIndex(), base: this.base(m, req.size), ask: req.buy ? 0 : 1, reduce: req.reduceOnly ? 1 : 0 };
    if (req.kind === 'market') {
      ref = await this.hub.marketPrice(req.coin, req.buy, g.slippage);
      order = { ...common, price: this.px(m, ref), type: TYPE.market, tif: TIF.ioc, trigger: 0, expiry: 0 };
    } else if (req.kind === 'limit') {
      ref = req.price ?? 0;
      const tif = req.tif === 'Alo' ? TIF.post : req.tif === 'Ioc' ? TIF.ioc : TIF.gtt;
      order = { ...common, price: this.px(m, ref), type: TYPE.limit, tif, trigger: 0, expiry: tif === TIF.ioc ? 0 : -1 };
    } else {
      const trigger = req.trigger ?? 0;
      if (!(trigger > 0)) return 'A stop needs its trigger price';
      const tp = tpslOf(req.buy, trigger, book) === 'tp';
      const limit = req.kind === 'stopLimit';
      ref = limit ? (req.price ?? 0) : trigger;
      order = { ...common, price: this.px(m, limit ? (req.price ?? 0) : triggerLimit(req.buy, trigger)), type: tp ? (limit ? TYPE.takeProfitLimit : TYPE.takeProfit) : limit ? TYPE.stopLossLimit : TYPE.stopLoss, tif: limit ? TIF.gtt : TIF.ioc, trigger: this.px(m, trigger), expiry: -1 };
    }
    if (size < m.minBase && !req.reduceOnly) return `Below ${m.coin}'s smallest size here, ${m.minBase}`;
    const no = guard(m, book, req.buy, size, ref, g, !!req.reduceOnly || req.kind === 'stop' || req.kind === 'stopLimit');
    if (no) return no;
    const what = `${req.buy ? 'Buy' : 'Sell'} ${size} ${req.coin} ${req.kind === 'market' ? 'at market' : req.kind === 'limit' ? `@ ${req.price}` : `stop @ ${req.trigger}`}`;
    // Lighter's grouped orders: the exits carry no size (they take what the entry fills), and one expiry
    // for the lot — each worked out from the clock on its own could land a millisecond apart and be refused.
    const at = until();
    const exit = (tp: boolean, price: number) => ({ market: m.id, clientOrder: clientIndex(), base: 0, ask: req.buy ? 1 : 0, reduce: 1, price: this.px(m, triggerLimit(!req.buy, price)), type: tp ? TYPE.takeProfit : TYPE.stopLoss, tif: TIF.ioc, trigger: this.px(m, price), expiry: at });
    const exits = [...(req.tp ? [exit(true, req.tp)] : []), ...(req.sl ? [exit(false, req.sl)] : [])];
    if (exits.length) {
      if (req.kind !== 'market' && req.kind !== 'limit') return 'Lighter takes a TP / SL with a market or limit entry only: place the stop, then its exits once it fills';
      if (order.expiry === -1) order = { ...order, expiry: at };
      // One-triggers-the-other, or with both exits one-triggers-a-one-cancels-the-other.
      return this.send(`${what}${req.tp ? `, TP ${req.tp}` : ''}${req.sl ? `, SL ${req.sl}` : ''}`, async (sign) => [await sign({ op: 'grouped', grouping: exits.length === 2 ? 3 : 1, orders: [order, ...exits] })]);
    }
    return this.send(what, async (sign) => [await sign({ op: 'order', order })]);
  }

  async cancel(orders: { coin: string; oid: number }[]): Promise<string | null> {
    const list = orders.flatMap((o) => (this.market(o.coin) ? [{ market: this.market(o.coin)!.id, index: o.oid }] : []));
    if (!list.length) return null;
    return this.send(list.length === 1 ? `Cancel ${orders[0]!.coin} order` : `Cancel ${list.length} orders`, async (sign) => {
      const out = [];
      // Fifty to a batch, as many batches as it takes.
      for (const c of list.slice(0, 50)) out.push(await sign({ op: 'cancel', market: c.market, index: c.index }));
      return out;
    });
  }

  async move(o: OpenOrder, price: number): Promise<string | null> {
    const m = this.market(o.coin);
    if (!m) return `${o.coin} is not traded on Lighter`;
    const base = this.base(m, o.size);
    const trigger = o.trigger !== null ? this.px(m, price) : 0;
    const limit = o.trigger !== null ? (/market/i.test(o.kind) ? this.px(m, triggerLimit(o.buy, price)) : this.px(m, o.price + (price - o.trigger))) : this.px(m, price);
    return this.send(`Move ${o.coin} ${o.buy ? 'buy' : 'sell'} to ${price}`, async (sign) => [await sign({ op: 'modify', market: m.id, index: o.oid, base, price: limit, trigger })]);
  }

  async leverage(coin: string, lev: number, cross: boolean): Promise<string | null> {
    const m = this.market(coin);
    if (!m) return `${coin} is not traded on Lighter`;
    const l = Math.min(Math.max(1, Math.round(lev)), m.maxLeverage);
    return this.send(`${coin} ${cross ? 'cross' : 'isolated'} ${l}×`, async (sign) => [await sign({ op: 'leverage', market: m.id, fraction: Math.round(10_000 / l), marginMode: cross ? 0 : 1 })]);
  }

  async exits(coin: string, tp: number | null, sl: number | null): Promise<string | null> {
    const m = this.market(coin);
    const p = this.state.positions.find((x) => x.coin === coin && x.size !== 0);
    if (!m || !p) return `No ${coin} position`;
    const buy = p.size < 0;
    const base = this.base(m, Math.abs(p.size));
    const old = this.state.orders.filter((o) => o.coin === coin && o.positionTpsl && ((tp !== null && /take profit/i.test(o.kind)) || (sl !== null && /stop/i.test(o.kind))));
    // One expiry for both: one-cancels-the-other is refused when theirs differ.
    const at = until();
    const exit = (isTp: boolean, price: number) => ({ market: m.id, clientOrder: clientIndex(), base, ask: buy ? 0 : 1, reduce: 1, price: this.px(m, triggerLimit(buy, price)), type: isTp ? TYPE.takeProfit : TYPE.stopLoss, tif: TIF.ioc, trigger: this.px(m, price), expiry: at });
    const orders = [...(tp !== null ? [exit(true, tp)] : []), ...(sl !== null ? [exit(false, sl)] : [])];
    return this.send(`${coin} ${tp !== null ? `TP ${tp}` : ''}${tp !== null && sl !== null ? ', ' : ''}${sl !== null ? `SL ${sl}` : ''}`, async (sign) => {
      const out = [];
      for (const o of old) out.push(await sign({ op: 'cancel', market: m.id, index: o.oid }));
      // Both: one cancels the other.
      if (orders.length === 2) out.push(await sign({ op: 'grouped', grouping: 2, orders }));
      else for (const o of orders) out.push(await sign({ op: 'order', order: o }));
      return out;
    });
  }

  async flatten(coin: string | null, g: Guards): Promise<string | null> {
    const closes: Record<string, number>[] = [];
    for (const p of this.state.positions.filter((x) => x.size !== 0 && (coin === null || x.coin === coin))) {
      const m = this.market(p.coin);
      if (!m) continue;
      const buy = p.size < 0;
      const px = await this.hub.marketPrice(p.coin, buy, Math.max(g.slippage, 0.02));
      closes.push({ market: m.id, clientOrder: clientIndex(), base: this.base(m, Math.abs(p.size)), ask: buy ? 0 : 1, reduce: 1, price: this.px(m, px), type: TYPE.market, tif: TIF.ioc, trigger: 0, expiry: 0 });
    }
    if (!coin)
      // The kill switch: the closes, then every order gone, in one batch.
      return this.send('Cancel every order and close every position', async (sign) => {
        const out = [];
        for (const c of closes) out.push(await sign({ op: 'order', order: c }));
        out.push(await sign({ op: 'cancelAll', cancelTif: 0, cancelTime: 0, cancelMarket: 255 }));
        return out;
      });
    // One coin closed keeps its entries resting. Its exits go once the close is through: a close refused keeps them.
    const exits = this.state.orders.filter((o) => o.coin === coin && o.reduceOnly);
    const m = this.market(coin);
    if (closes.length) {
      const no = await this.send(`Close ${coin} at market`, async (sign) => [await sign({ op: 'order', order: closes[0]! })]);
      if (no) return exits.length ? `${no} (its TP / SL are kept)` : no;
    }
    if (!exits.length || !m) return null;
    return this.send(`Cancel ${coin}'s TP / SL`, async (sign) => {
      const out = [];
      for (const o of exits) out.push(await sign({ op: 'cancel', market: m.id, index: o.oid }));
      return out;
    });
  }

  // ---- an algo's own orders, by client order index ----

  tick(coin: string): number {
    const m = this.market(coin);
    return m ? 10 ** -m.priceDec : 0;
  }

  childId(): string {
    return String(clientIndex());
  }

  private childOrder(c: Child) {
    const m = this.market(c.coin)!;
    const ioc = c.tif === 'Ioc';
    return { market: m.id, clientOrder: Number(c.id), base: this.base(m, c.size), price: this.px(m, c.price), ask: c.buy ? 0 : 1, type: ioc ? TYPE.market : TYPE.limit, tif: ioc ? TIF.ioc : c.tif === 'Alo' ? TIF.post : TIF.gtt, reduce: c.reduceOnly ? 1 : 0, trigger: 0, expiry: ioc ? 0 : -1 };
  }

  async childPlace(children: Child[], what: string | null): Promise<string | null> {
    if (children.some((c) => !this.market(c.coin))) return 'Not traded on Lighter';
    for (const c of children) this.kids.add(Number(c.id));
    return this.send(what ?? '', async (sign) => {
      const out = [];
      for (const c of children.slice(0, 50)) out.push(await sign({ op: 'order', order: this.childOrder(c) }));
      return out;
    }, what === null);
  }

  async childMove(c: Child, what: string | null): Promise<string | null> {
    const m = this.market(c.coin);
    if (!m) return 'Not traded on Lighter';
    return this.send(what ?? '', async (sign) => [await sign({ op: 'modify', market: m.id, index: Number(c.id), base: this.base(m, c.size), price: this.px(m, c.price), trigger: 0 })], what === null);
  }

  async childCancel(children: Child[], what: string | null): Promise<string | null> {
    const list = children.filter((c) => this.market(c.coin));
    if (!list.length) return null;
    return this.send(what ?? '', async (sign) => {
      const out = [];
      for (const c of list.slice(0, 50)) out.push(await sign({ op: 'cancel', market: this.market(c.coin)!.id, index: Number(c.id) }));
      return out;
    }, what === null);
  }

  childState(c: Child): { open: boolean; remaining: number; filled: number; avg: number; known: boolean } {
    const open = this.state.orders.find((o) => o.cloid === c.id);
    const fills = this.state.fills.filter((f) => f.cloid === c.id);
    const filled = fills.reduce((s, f) => s + f.size, 0);
    const avg = filled > 0 ? fills.reduce((s, f) => s + f.size * f.price, 0) / filled : 0;
    if (open) return { open: true, remaining: open.size, filled: Math.max(filled, open.origSize - open.size), avg, known: true };
    return { open: false, remaining: 0, filled, avg, known: fills.length > 0 || this.closed.some((o) => o.cloid === c.id) };
  }

  async history(): Promise<PastOrder[]> {
    if (this.ref.mode !== 'trade') return [];
    const auth = await this.token();
    const d = await this.hub.get(`/api/v1/accountInactiveOrders?account_index=${this.idx}&limit=100`, auth);
    // Lighter's archive can lag minutes behind (testnet listed none of a cancel 5 minutes on): the orders seen closing here fill the gap.
    const past = new Map<number, PastOrder>([...this.closed].map((o) => [o.oid, o]));
    for (const o of (d.orders ?? []) as any[]) past.set(o.order_index, readOrder(o));
    return [...past.values()].sort((a, b) => b.statusTime - a.statusTime);
  }
}

/** A Lighter key as kept: its hex, back to bytes. */
export const keyBytes = (hex: string): Uint8Array => fromHex(hex.trim());
