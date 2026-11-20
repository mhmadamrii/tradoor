/**
 * Hyperliquid in the trade worker. One hub a network: one socket that carries
 * every account's streams (positions, open orders, fills, a ticket coin's
 * leverage and sizes — each message names its user), the best bid and ask of
 * the coins in use, and the orders themselves, posted over it so an order
 * costs one round trip and no new connection.
 */
import { actions, API, assetsOf, newCloid, Nonces, orderWire, refusal, roundPrice, roundSize, signAction, type Asset, type ExchangeReply, type OrderWire, type Signed } from '../hyperliquid';
import { isExit, type AccountRef, type Fill, type Guards, type Link, type MarketInfo, type Network, type OpenOrder, type OrderRequest, type PastOrder, type Position } from '../protocol';
import type { Signer } from '../signer';
import { emptyState, Follows, guard, num, throttle, tpslOf, triggerLimit, type Candle, type Child, type Conn, type Env, type Hub } from './common';

export class HlHub implements Hub {
  markets = new Map<string, MarketInfo>();
  assets = new Map<string, Asset>();
  books: Record<string, { bid: number; ask: number }> = {};
  link: Link = 'closed';
  private ws: WebSocket | null = null;
  private retry = 0;
  private ping = 0;
  private postId = 0;
  private posts = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  private conns = new Map<string, HlConn>();
  private followed = new Set<string>();
  private tickets = new Set<string>();
  private ladders = new Set<string>();
  private depthOut = new Map<string, () => void>();
  private closed = false;
  readonly nonces = new Nonces();
  private sayBooks = throttle(80, () => this.env.say({ t: 'books', venue: 'hyperliquid', network: this.network, books: this.books }));

  constructor(
    readonly network: Network,
    readonly env: Env,
    readonly signer: () => Promise<Signer>,
  ) {}

  async start() {
    const res = await fetch(`${API[this.network].http}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"meta"}' });
    const assets = assetsOf(await res.json());
    this.assets = new Map(assets.map((a) => [a.name, a]));
    this.markets = new Map(assets.map((a) => [a.name, { coin: a.name, szDecimals: a.szDecimals, pxDecimals: Math.max(0, 6 - a.szDecimals), maxLeverage: a.maxLeverage, minUsd: 10 }]));
    this.env.say({ t: 'markets', venue: 'hyperliquid', network: this.network, markets: [...this.markets.values()] });
    this.connect();
  }

  add(conn: Conn) {
    this.conns.set(conn.ref.id, conn as HlConn);
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
    this.env.say({ t: 'link', venue: 'hyperliquid', network: this.network, link: l });
  }

  send(method: 'subscribe' | 'unsubscribe', subscription: object) {
    if (this.open()) this.ws!.send(JSON.stringify({ method, subscription }));
  }

  private connect() {
    if (this.closed) return;
    this.setLink('connecting');
    const sock = new WebSocket(API[this.network].ws);
    this.ws = sock;
    sock.onopen = () => {
      if (this.ws !== sock) return;
      this.retry = 0;
      this.setLink('open');
      for (const c of this.followed) this.send('subscribe', { type: 'bbo', coin: c });
      for (const c of this.ladders) this.send('subscribe', { type: 'l2Book', coin: c });
      for (const c of this.conns.values()) c.subscribe();
      this.resubscribeTickets();
      clearInterval(this.ping);
      // The exchange closes a socket quiet for a minute.
      this.ping = setInterval(() => this.open() && sock.send('{"method":"ping"}'), 30_000) as unknown as number;
    };
    sock.onmessage = (e) => this.ws === sock && this.onMessage(JSON.parse(e.data as string));
    sock.onclose = () => {
      if (this.ws !== sock) return;
      this.ws = null;
      this.setLink('closed');
      for (const [, p] of this.posts) (clearTimeout(p.timer), p.reject(new Error('The connection closed')));
      this.posts.clear();
      setTimeout(() => this.connect(), [1000, 2000, 5000, 10_000][Math.min(this.retry++, 3)]);
    };
  }

  /** A request over the socket, or over HTTP when it is not open. */
  async request(kind: 'info' | 'action', payload: unknown): Promise<unknown> {
    const sock = this.ws;
    if (sock && sock.readyState === WebSocket.OPEN) {
      const id = ++this.postId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => (this.posts.delete(id), reject(new Error('No answer from Hyperliquid in 10 s'))), 10_000) as unknown as number;
        this.posts.set(id, { resolve, reject, timer });
        sock.send(JSON.stringify({ method: 'post', id, request: { type: kind, payload } }));
      });
    }
    const res = await fetch(`${API[this.network].http}/${kind === 'info' ? 'info' : 'exchange'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`Hyperliquid answered ${res.status}`);
    return res.json();
  }

  private byUser(user: string | undefined) {
    const u = user?.toLowerCase();
    return [...this.conns.values()].filter((c) => c.ref.owner === u);
  }

  private onMessage(m: { channel: string; data: any }) {
    const d = m.data;
    switch (m.channel) {
      case 'post': {
        const p = this.posts.get(d.id);
        if (!p) return;
        this.posts.delete(d.id);
        clearTimeout(p.timer);
        const r = d.response;
        if (r.type === 'error') p.reject(new Error(String(r.payload)));
        else p.resolve(r.type === 'info' ? r.payload.data : r.payload);
        return;
      }
      case 'clearinghouseState':
        for (const c of this.byUser(d.user)) c.readClearinghouse(d.clearinghouseState);
        return;
      case 'openOrders':
        for (const c of this.byUser(d.user)) c.readOrders(d.orders);
        return;
      case 'userFills':
        for (const c of this.byUser(d.user)) c.readFills(d.fills, d.isSnapshot);
        return;
      case 'activeAssetData':
        for (const c of this.byUser(d.user)) c.readAssetData(d);
        return;
      case 'l2Book': {
        const [bids, asks] = (d.levels ?? []) as { px: string; sz: string }[][];
        const side = (rows: { px: string; sz: string }[] | undefined) => (rows ?? []).map((r): [number, number] => [num(r.px), num(r.sz)]);
        this.depth(d.coin, side(bids), side(asks));
        return;
      }
      case 'bbo': {
        const [bid, ask] = d.bbo as ({ px: string } | null)[];
        this.books[d.coin] = { bid: num(bid?.px), ask: num(ask?.px) };
        this.sayBooks();
        return;
      }
    }
  }

  /** The book's top levels to the page, at most ten times a second a coin. */
  private depth(coin: string, bids: [number, number][], asks: [number, number][]) {
    this.lastDepth.set(coin, { bids, asks });
    let say = this.depthOut.get(coin);
    if (!say) {
      say = throttle(100, () => {
        const d = this.lastDepth.get(coin);
        if (d) this.env.say({ t: 'depth', venue: 'hyperliquid', network: this.network, coin, ...d });
      });
      this.depthOut.set(coin, say);
    }
    say();
  }
  private lastDepth = new Map<string, { bids: [number, number][]; asks: [number, number][] }>();

  private follows = new Follows((c, t, l) => this.apply(c, t, l));
  follow(coins: string[], tickets: { account: string; coin: string }[], ladders: string[] = []) {
    this.follows.panels(coins, tickets, ladders);
  }
  want(owner: string, coins: string[]) {
    this.follows.want(owner, coins);
  }

  async candles(coin: string, tf: string, count: number): Promise<Candle[]> {
    const ms = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }[tf] ?? 3_600_000;
    const end = Date.now();
    const list = (await this.request('info', { type: 'candleSnapshot', req: { coin, interval: tf, startTime: end - ms * (count + 1), endTime: end } })) as { t: number; o: string; h: string; l: string; c: string; v: string }[];
    return list.map((k) => ({ t: k.t, o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c), usd: num(k.v) * num(k.c) }));
  }

  private apply(coins: string[], tickets: { account: string; coin: string }[], ladders: string[]) {
    const nextLadders = new Set(ladders.filter((c) => this.markets.has(c)));
    for (const c of this.ladders) if (!nextLadders.has(c)) this.send('unsubscribe', { type: 'l2Book', coin: c });
    for (const c of nextLadders) if (!this.ladders.has(c)) this.send('subscribe', { type: 'l2Book', coin: c });
    this.ladders = nextLadders;
    const next = new Set(coins.filter((c) => this.markets.has(c)));
    for (const c of this.followed) if (!next.has(c)) this.send('unsubscribe', { type: 'bbo', coin: c });
    const added = [...next].filter((c) => !this.followed.has(c));
    for (const c of added) this.send('subscribe', { type: 'bbo', coin: c });
    this.followed = next;
    // Each ticket's leverage and sizes, for its account.
    const wanted = new Set(tickets.filter((t) => this.markets.has(t.coin) && this.conns.has(t.account)).map((t) => `${this.conns.get(t.account)!.ref.owner}|${t.coin}`));
    for (const key of this.tickets) if (!wanted.has(key)) this.send('unsubscribe', { type: 'activeAssetData', user: key.split('|')[0], coin: key.split('|')[1] });
    for (const key of wanted) if (!this.tickets.has(key)) this.send('subscribe', { type: 'activeAssetData', user: key.split('|')[0], coin: key.split('|')[1] });
    this.tickets = wanted;
    // The best bid and ask push only when they change: read them once now.
    for (const c of added.slice(0, 12)) void this.snapshot(c);
  }

  /** Tickets to subscribe again when the socket opens anew. */
  resubscribeTickets() {
    for (const key of this.tickets) this.send('subscribe', { type: 'activeAssetData', user: key.split('|')[0], coin: key.split('|')[1] });
  }

  private async snapshot(coin: string) {
    try {
      const book = (await this.request('info', { type: 'l2Book', coin })) as { levels: { px: string }[][] };
      if (!this.books[coin]) {
        this.books[coin] = { bid: num(book.levels[0]?.[0]?.px), ask: num(book.levels[1]?.[0]?.px) };
        this.sayBooks();
      }
    } catch {
      // The stream brings it.
    }
  }

  /** The price a market order is sent at: the best on the other side, and the slippage allowed past it. */
  async marketPrice(coin: string, buy: boolean, slippage: number): Promise<number> {
    let b = this.books[coin];
    if (!b || !(b.bid > 0 && b.ask > 0)) {
      const book = (await this.request('info', { type: 'l2Book', coin })) as { levels: { px: string }[][] };
      b = { bid: num(book.levels[0]?.[0]?.px), ask: num(book.levels[1]?.[0]?.px) };
    }
    const px = buy ? b.ask * (1 + slippage) : b.bid * (1 - slippage);
    if (!(px > 0)) throw new Error(`No price for ${coin}`);
    return px;
  }
}

const readOrder = (o: any): OpenOrder => ({
  coin: o.coin,
  oid: o.oid,
  cloid: o.cloid ?? null,
  buy: o.side === 'B',
  price: num(o.limitPx),
  size: num(o.sz),
  origSize: num(o.origSz),
  kind: o.orderType ?? 'Limit',
  trigger: o.isTrigger ? num(o.triggerPx) : null,
  triggerCondition: o.triggerCondition ?? '',
  reduceOnly: !!o.reduceOnly,
  positionTpsl: !!o.isPositionTpsl,
  tif: o.tif ?? null,
  time: o.timestamp,
});

const readFill = (f: any): Fill => ({ coin: f.coin, price: num(f.px), size: num(f.sz), buy: f.side === 'B', time: f.time, dir: f.dir, pnl: num(f.closedPnl), fee: num(f.fee), oid: f.oid, tid: f.tid, crossed: !!f.crossed });

export class HlConn implements Conn {
  state = emptyState();
  private changed = throttle(50, () => {
    this.state.at = Date.now();
    this.hub.env.say({ t: 'state', account: this.ref.id, state: this.state });
  });

  constructor(
    public ref: AccountRef,
    private hub: HlHub,
  ) {}

  private subs = () => [{ type: 'clearinghouseState', user: this.ref.owner }, { type: 'openOrders', user: this.ref.owner }, { type: 'userFills', user: this.ref.owner, aggregateByTime: true }];

  subscribe() {
    for (const s of this.subs()) this.hub.send('subscribe', s);
    void this.readSpot();
    clearInterval(this.spotTimer);
    this.spotTimer = setInterval(() => void this.readSpot(), 15_000);
  }

  unsubscribe() {
    for (const s of this.subs()) this.hub.send('unsubscribe', s);
    clearInterval(this.spotTimer);
  }

  /**
   * A unified (or portfolio-margin) account trades perps on its spot USDC: its perp side reads $0
   * (testnet, 2026-11-15: 999 USDC in spot, "Account $0.00"), so the spot USDC is counted in.
   * A standard account's spot USDC is not margin until moved, and is left out.
   */
  private spot = { total: 0, hold: 0 };
  private unified: boolean | null = null;
  private spotTimer: ReturnType<typeof setInterval> | undefined;
  private perp: any = null;

  private async readSpot() {
    try {
      if (this.unified === null) {
        const mode = await this.hub.request('info', { type: 'userAbstraction', user: this.ref.owner });
        this.unified = mode === 'unifiedAccount' || mode === 'portfolioMargin';
      }
      if (!this.unified) return;
      const sp = (await this.hub.request('info', { type: 'spotClearinghouseState', user: this.ref.owner })) as { balances?: { coin: string; total: string; hold: string }[] };
      const usdc = sp.balances?.find((b) => b.coin === 'USDC');
      this.spot = { total: num(usdc?.total), hold: num(usdc?.hold) };
      if (this.perp) this.readClearinghouse(this.perp);
    } catch {
      // Read again on the next round.
    }
  }

  readClearinghouse(cs: any) {
    if (!cs) return;
    this.perp = cs;
    const s = this.state;
    s.marginUsed = num(cs.marginSummary?.totalMarginUsed);
    s.notional = num(cs.marginSummary?.totalNtlPos);
    s.withdrawable = this.unified ? Math.max(0, this.spot.total - this.spot.hold) : num(cs.withdrawable);
    s.positions = (cs.assetPositions as any[]).map(({ position: p }): Position => ({
      coin: p.coin,
      size: num(p.szi),
      entry: num(p.entryPx),
      value: num(p.positionValue),
      pnl: num(p.unrealizedPnl),
      roe: num(p.returnOnEquity),
      liquidation: p.liquidationPx === null ? null : num(p.liquidationPx),
      leverage: num(p.leverage?.value),
      cross: p.leverage?.type !== 'isolated',
      margin: num(p.marginUsed),
      funding: num(p.cumFunding?.sinceOpen),
    }));
    // Unified: the spot USDC and what the positions are up or down. (The perp side's value is margin
    // the spot balance already holds: added to it, the account read ~$1 high on a $20 position.)
    s.value = this.unified ? this.spot.total + s.positions.reduce((t, p) => t + p.pnl, 0) : num(cs.marginSummary?.accountValue);
    this.changed();
  }

  readOrders(orders: any[]) {
    this.state.orders = orders.map(readOrder);
    this.changed();
  }

  readFills(fills: any[], snapshot: boolean) {
    const fresh = fills.map(readFill);
    const known = new Set(this.state.fills.map((f) => f.tid));
    this.state.fills = [...fresh.filter((f) => !known.has(f.tid)), ...this.state.fills].sort((a, b) => b.time - a.time).slice(0, 2000);
    // A fill moves the position (and a unified account's spot USDC): read them now rather than at the next push.
    if (!snapshot) void this.refresh().then(() => this.readSpot());
    this.changed();
  }

  readAssetData(d: any) {
    this.state.assetData[d.coin] = { leverage: num(d.leverage?.value), cross: d.leverage?.type !== 'isolated', maxBuy: num(d.maxTradeSzs?.[0]), maxSell: num(d.maxTradeSzs?.[1]) };
    this.changed();
  }

  /** Positions and orders read now. */
  async refresh() {
    try {
      const [cs, orders] = await Promise.all([this.hub.request('info', { type: 'clearinghouseState', user: this.ref.owner }), this.hub.request('info', { type: 'frontendOpenOrders', user: this.ref.owner })]);
      this.readClearinghouse(cs);
      this.readOrders(orders as any[]);
    } catch {
      // The next push brings it.
    }
  }

  /** Signs with the account's trading key and sends; the refusal in words, or null. */
  private async send(action: Signed['action'], what: string | null): Promise<string | null> {
    return (await this.sendRaw(action, what)).error;
  }

  /** As `send`, with the exchange's reply. A `what` of null leaves no line in the activity: an algo's own repricing. */
  private async sendRaw(action: Signed['action'], what: string | null): Promise<{ error: string | null; reply?: ExchangeReply }> {
    if (this.ref.mode !== 'trade') return { error: 'Watching only: this account has no trading key' };
    const note = what ? this.hub.env.activity(this.ref.id, what) : () => {};
    let key: Uint8Array | null;
    try {
      key = await this.hub.env.secret(this.ref.id);
    } catch {
      note('refused', 'The keys are locked');
      return { error: 'The keys are locked: unlock them to trade' };
    }
    if (!key) return { error: 'This account has no trading key' };
    let signed: Signed;
    try {
      signed = signAction(await this.hub.signer(), key, action, this.hub.nonces.next(), this.hub.network);
    } finally {
      key.fill(0);
    }
    note('sent', '');
    try {
      const reply = (await this.hub.request('action', signed)) as ExchangeReply;
      const no = refusal(reply);
      note(no ? 'refused' : 'ok', no ?? statusText(reply));
      void this.refresh();
      return { error: no, reply };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      note('refused', msg);
      return { error: msg };
    }
  }

  // ---- an algo's own orders, by cloid ----

  /** The exchange's id of each child order, and what an order filled at once, as its reply said. */
  private oids = new Map<string, number>();
  private quick = new Map<string, { filled: number; avg: number }>();

  tick(coin: string, price: number): number {
    const a = this.asset(coin);
    if (!a || !(price > 0)) return 0;
    if (price >= 1e5) return 1;
    // Five significant figures, and no more than 6 − szDecimals decimals.
    return Math.max(10 ** (Math.floor(Math.log10(price)) - 4), 10 ** -Math.max(0, 6 - a.szDecimals));
  }

  childId(): string {
    return newCloid();
  }

  private childWire(c: Child) {
    const asset = this.asset(c.coin)!;
    return orderWire({ asset, buy: c.buy, price: c.price, size: c.size, reduceOnly: c.reduceOnly, tif: c.tif, cloid: c.id });
  }

  private learn(children: Child[], reply: ExchangeReply | undefined) {
    const statuses = reply && typeof reply.response === 'object' ? (reply.response.data?.statuses ?? []) : [];
    statuses.forEach((st, i) => {
      const c = children[i];
      if (!c || typeof st !== 'object') return;
      if ('resting' in st) this.oids.set(c.id, st.resting.oid);
      if ('filled' in st) {
        this.oids.set(c.id, st.filled.oid);
        this.quick.set(c.id, { filled: num(st.filled.totalSz), avg: num(st.filled.avgPx) });
      }
    });
  }

  async childPlace(children: Child[], what: string | null): Promise<string | null> {
    if (children.some((c) => !this.asset(c.coin))) return 'Not traded on Hyperliquid';
    const r = await this.sendRaw(actions.order(children.map((c) => this.childWire(c))), what);
    this.learn(children, r.reply);
    return r.error;
  }

  async childMove(c: Child, what: string | null): Promise<string | null> {
    const r = await this.sendRaw(actions.modify(c.id, this.childWire(c)), what);
    return r.error;
  }

  async childCancel(children: Child[], what: string | null): Promise<string | null> {
    const list = children.filter((c) => this.asset(c.coin));
    if (!list.length) return null;
    return this.send(actions.cancelByCloid(list.map((c) => ({ asset: this.asset(c.coin)!.asset, cloid: c.id }))), what);
  }

  childState(c: Child): { open: boolean; remaining: number; filled: number; avg: number; known: boolean } {
    const open = this.state.orders.find((o) => o.cloid === c.id);
    if (open) this.oids.set(c.id, open.oid);
    const oid = this.oids.get(c.id);
    const fills = oid === undefined ? [] : this.state.fills.filter((f) => f.oid === oid);
    let filled = fills.reduce((s, f) => s + f.size, 0);
    let avg = filled > 0 ? fills.reduce((s, f) => s + f.size * f.price, 0) / filled : 0;
    const q = this.quick.get(c.id);
    if (q && q.filled > filled) ((filled = q.filled), (avg = q.avg));
    if (open) return { open: true, remaining: open.size, filled: Math.max(filled, open.origSize - open.size), avg, known: true };
    // A reply that said it filled, or fills of it: done. One that said it rests but is not in the list yet is not known to be gone.
    return { open: false, remaining: 0, filled, avg, known: fills.length > 0 || !!q };
  }

  private asset(coin: string) {
    return this.hub.assets.get(coin);
  }

  async place(req: OrderRequest): Promise<string | null> {
    const asset = this.asset(req.coin);
    const m = this.hub.markets.get(req.coin);
    if (!asset || !m) return `${req.coin} is not traded on Hyperliquid`;
    const g = req.guards;
    const book = this.hub.books[req.coin];
    let wire: OrderWire;
    let ref: number;
    if (req.kind === 'market') {
      ref = await this.hub.marketPrice(req.coin, req.buy, g.slippage);
      wire = orderWire({ asset, buy: req.buy, price: ref, size: req.size, reduceOnly: req.reduceOnly, tif: 'Ioc', cloid: newCloid() });
    } else if (req.kind === 'limit') {
      ref = req.price ?? 0;
      wire = orderWire({ asset, buy: req.buy, price: ref, size: req.size, reduceOnly: req.reduceOnly, tif: req.tif ?? 'Gtc', cloid: newCloid() });
    } else {
      const trigger = req.trigger ?? 0;
      if (!(trigger > 0)) return 'A stop needs its trigger price';
      ref = req.kind === 'stopLimit' ? (req.price ?? 0) : trigger;
      const price = req.kind === 'stopLimit' ? (req.price ?? 0) : triggerLimit(req.buy, trigger);
      wire = orderWire({ asset, buy: req.buy, price, size: req.size, reduceOnly: req.reduceOnly, trigger: { price: trigger, market: req.kind === 'stop', tpsl: tpslOf(req.buy, trigger, book) }, cloid: newCloid() });
    }
    const no = guard(m, book, req.buy, roundSize(req.size, asset.szDecimals), ref, g, !!req.reduceOnly || req.kind === 'stop' || req.kind === 'stopLimit');
    if (no) return no;
    const what = `${req.buy ? 'Buy' : 'Sell'} ${wire.s} ${req.coin} ${req.kind === 'market' ? 'at market' : req.kind === 'limit' ? `@ ${wire.p}` : `stop @ ${req.trigger}`}`;
    if (req.tp || req.sl) {
      // The entry, then its exits: on the other side, reduce-only, live once it fills.
      const exits = [
        ...(req.tp ? [orderWire({ asset, buy: !req.buy, price: triggerLimit(!req.buy, req.tp), size: req.size, reduceOnly: true, trigger: { price: req.tp, market: true, tpsl: 'tp' } })] : []),
        ...(req.sl ? [orderWire({ asset, buy: !req.buy, price: triggerLimit(!req.buy, req.sl), size: req.size, reduceOnly: true, trigger: { price: req.sl, market: true, tpsl: 'sl' } })] : []),
      ];
      return this.send(actions.order([wire, ...exits], 'normalTpsl'), `${what}${req.tp ? `, TP ${req.tp}` : ''}${req.sl ? `, SL ${req.sl}` : ''}`);
    }
    return this.send(actions.order([wire]), what);
  }

  async cancel(orders: { coin: string; oid: number }[]): Promise<string | null> {
    const cancels = orders.flatMap((o) => (this.asset(o.coin) ? [{ asset: this.asset(o.coin)!.asset, oid: o.oid }] : []));
    if (!cancels.length) return null;
    return this.send(actions.cancel(cancels), cancels.length === 1 ? `Cancel ${orders[0]!.coin} order` : `Cancel ${cancels.length} orders`);
  }

  /** An order moved to another price: changed in place, keeping its id, size and kind. */
  async move(o: OpenOrder, px: number): Promise<string | null> {
    const asset = this.asset(o.coin);
    if (!asset) return `${o.coin} is not traded on Hyperliquid`;
    const price = roundPrice(px, asset.szDecimals);
    let wire: OrderWire;
    if (o.trigger !== null) {
      const market = /market/i.test(o.kind);
      const tpsl: 'tp' | 'sl' = /take profit/i.test(o.kind) ? 'tp' : 'sl';
      const limit = market ? triggerLimit(o.buy, price) : o.price + (price - o.trigger);
      wire = orderWire({ asset, buy: o.buy, price: limit, size: o.size, reduceOnly: o.reduceOnly, trigger: { price, market, tpsl }, ...(o.cloid ? { cloid: o.cloid } : {}) });
    } else {
      const tif = o.tif === 'Alo' || o.tif === 'Ioc' ? o.tif : 'Gtc';
      wire = orderWire({ asset, buy: o.buy, price, size: o.size, reduceOnly: o.reduceOnly, tif, ...(o.cloid ? { cloid: o.cloid } : {}) });
    }
    return this.send(actions.modify(o.oid, wire), `Move ${o.coin} ${o.buy ? 'buy' : 'sell'} to ${'trigger' in wire.t ? wire.t.trigger.triggerPx : wire.p}`);
  }

  async leverage(coin: string, lev: number, cross: boolean): Promise<string | null> {
    const a = this.asset(coin);
    if (!a) return `${coin} is not traded on Hyperliquid`;
    const l = Math.min(Math.max(1, Math.round(lev)), a.maxLeverage);
    return this.send(actions.leverage(a.asset, cross, l), `${coin} ${cross ? 'cross' : 'isolated'} ${l}×`);
  }

  /** The position's own take profit and stop, replacing those it had. */
  async exits(coin: string, tp: number | null, sl: number | null): Promise<string | null> {
    const asset = this.asset(coin);
    const p = this.state.positions.find((x) => x.coin === coin && x.size !== 0);
    if (!asset || !p) return `No ${coin} position`;
    const buy = p.size < 0;
    const size = Math.abs(p.size);
    const old = this.state.orders.filter((o) => o.coin === coin && isExit(o) && ((tp !== null && /take profit/i.test(o.kind)) || (sl !== null && /stop/i.test(o.kind))));
    if (old.length) {
      const no = await this.send(actions.cancel(old.map((o) => ({ asset: asset.asset, oid: o.oid }))), `Cancel ${coin}'s exits`);
      if (no) return no;
    }
    const wires = [
      ...(tp !== null ? [orderWire({ asset, buy, price: triggerLimit(buy, tp), size, reduceOnly: true, trigger: { price: tp, market: true, tpsl: 'tp' } })] : []),
      ...(sl !== null ? [orderWire({ asset, buy, price: triggerLimit(buy, sl), size, reduceOnly: true, trigger: { price: sl, market: true, tpsl: 'sl' } })] : []),
    ];
    if (!wires.length) return null;
    return this.send(actions.order(wires, 'positionTpsl'), `${coin} ${tp !== null ? `TP ${tp}` : ''}${tp !== null && sl !== null ? ', ' : ''}${sl !== null ? `SL ${sl}` : ''}`);
  }

  /** Cancels the orders, then closes the positions at the market: one coin's, or all. */
  async flatten(coin: string | null, g: Guards): Promise<string | null> {
    // One coin closed keeps its entries resting; the kill switch takes them first, so none fills while it closes.
    // The exits go last, once the close is through: cancelled first, a close then refused left the position
    // unprotected (testnet, 2026-11-15: "Price too far from oracle").
    const mine = this.state.orders.filter((o) => coin === null || o.coin === coin);
    const entries = coin === null ? mine.filter((o) => !isExit(o)) : [];
    const exits = mine.filter((o) => isExit(o) || (o.reduceOnly && coin !== null));
    if (entries.length) {
      const no = await this.cancel(entries);
      if (no) return no;
    }
    const wires: OrderWire[] = [];
    for (const p of this.state.positions.filter((x) => x.size !== 0 && (coin === null || x.coin === coin))) {
      const asset = this.asset(p.coin);
      if (!asset) continue;
      const buy = p.size < 0;
      const px = await this.hub.marketPrice(p.coin, buy, Math.max(g.slippage, 0.02));
      wires.push(orderWire({ asset, buy, price: px, size: Math.abs(p.size), reduceOnly: true, tif: 'Ioc', cloid: newCloid() }));
    }
    if (wires.length) {
      const no = await this.send(actions.order(wires), coin ? `Close ${coin} at market` : `Close ${wires.length} position${wires.length > 1 ? 's' : ''} at market`);
      if (no) return exits.length ? `${no} (its TP / SL are kept)` : no;
    }
    return exits.length ? this.cancel(exits) : null;
  }

  /** The latest 2,000 orders that are done: filled, cancelled, rejected, triggered. */
  async history(): Promise<PastOrder[]> {
    const list = (await this.hub.request('info', { type: 'historicalOrders', user: this.ref.owner })) as { order: any; status: string; statusTimestamp: number }[];
    return list.filter((h) => h.status !== 'open').map((h) => ({ ...readOrder(h.order), status: h.status, statusTime: h.statusTimestamp }));
  }
}

/** What went through: rested, filled at a price. */
function statusText(reply: ExchangeReply): string {
  const statuses = typeof reply.response === 'object' ? (reply.response.data?.statuses ?? []) : [];
  return statuses
    .map((s) => (typeof s === 'string' ? s : 'filled' in s ? `filled ${s.filled.totalSz} @ ${s.filled.avgPx}` : 'resting' in s ? 'resting' : ''))
    .filter(Boolean)
    .join(', ');
}
