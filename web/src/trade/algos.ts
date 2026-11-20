/**
 * tradoor's own execution algorithms, run in the trade worker on any account,
 * on any venue: they place, change and cancel their orders through the
 * account's connection (by tradoor's own id for each), and read fills and the
 * best bid and ask from it and its hub.
 *
 * - Chase: a post-only order at the best price, moved as the price moves —
 *   joined, one tick inside the spread (aggressive), so many ticks back, or a
 *   distance away that it keeps (maintain) or only closes (trail). It stops at
 *   a limit away from where it began, or after a time, and is then cancelled,
 *   left resting, or finished at the market.
 * - TWAP: slices spread over a time, their times and sizes made uneven on
 *   request, each at the market or chased first; price bounds that pause it,
 *   stop it, finish it at once, or close the position.
 * - Scale: orders across a range, bunched towards one end on request, their
 *   sizes likewise.
 * - Swarm: one size as many market slices, sent together.
 *
 * Each is held to the guards as one order: its whole size at most the limit.
 * They run while tradoor is open; a reload ends them, and their resting
 * orders stay on the exchange.
 */
import type { AlgoSpec, AlgoState, Books, Condition, FromWorker, Guards, MarketInfo } from './protocol';
import { guard, TF_MS, throttle, type Candle, type Child, type Conn } from './venues/common';

export interface Place {
  conn(account: string): Conn | undefined;
  books(account: string): Books;
  market(account: string, coin: string): MarketInfo | undefined;
  /** Coins an algorithm watches, on the account's venue; an empty list lets go. */
  want(account: string, owner: string, coins: string[]): void;
  candles(account: string, coin: string, tf: string, count: number): Promise<Candle[]>;
}

const MIN_MOVE_MS = 400;
/** How long an order just placed counts as resting while the exchange has not shown it. */
const PENDING_MS = 5_000;

abstract class Algo {
  state: AlgoState;
  protected busy = false;
  protected children: Child[] = [];
  /** What finished children filled: their size, and size times price. */
  protected done = { size: 0, value: 0 };

  constructor(
    readonly id: string,
    readonly spec: AlgoSpec,
    protected place: Place,
    protected guards: Guards,
    protected onChange: () => void,
  ) {
    this.state = { id, spec, status: 'running', started: Date.now(), ended: 0, filled: 0, avg: 0, lotsDone: 0, lotsTotal: 1, detail: '' };
  }

  protected get conn() {
    return this.place.conn(this.spec.account);
  }

  protected book() {
    return this.place.books(this.spec.account)[this.spec.coin];
  }

  protected market() {
    return this.place.market(this.spec.account, this.spec.coin);
  }

  protected tick(price: number) {
    return this.conn?.tick(this.spec.coin, price) ?? 0;
  }

  /** A price on the venue's grid: down for a buy, up for a sell, so it never pays more than meant. */
  protected onGrid(price: number, buy = this.spec.buy) {
    const t = this.tick(price);
    if (!(t > 0)) return price;
    const n = buy ? Math.floor(price / t + 1e-9) : Math.ceil(price / t - 1e-9);
    return Number((n * t).toPrecision(12));
  }

  /** When each child was placed, and those the exchange has shown resting. */
  private placed = new Map<string, number>();
  private seen = new Set<string>();

  /**
   * A child as the exchange has it — but one just placed and not shown yet
   * counts as resting. Lighter's update comes a few hundred ms after it took
   * the order; read as gone, a chase placed it again each step (2026-11-15:
   * 118 orders on testnet). Shown or done, or 5 s unseen, it is read as it is.
   */
  protected stateOf(ch: Child) {
    const st = this.conn?.childState(ch);
    if (!st) return st;
    if (!this.placed.has(ch.id)) this.placed.set(ch.id, Date.now());
    if (st.open) this.seen.add(ch.id);
    else if (!st.known && !this.seen.has(ch.id) && Date.now() - this.placed.get(ch.id)! < PENDING_MS) return { ...st, open: true, remaining: ch.size - st.filled };
    return st;
  }

  /** Children that are done are counted and let go; what open ones filled is counted as it goes. */
  protected account() {
    let openFilled = 0;
    let openValue = 0;
    this.children = this.children.filter((ch) => {
      const st = this.stateOf(ch);
      if (!st) return true;
      if (st.open) {
        openFilled += st.filled;
        openValue += st.filled * (st.avg || ch.price);
        return true;
      }
      this.done.size += st.filled;
      this.done.value += st.filled * (st.avg || ch.price);
      return false;
    });
    const filled = this.done.size + openFilled;
    this.state.filled = filled;
    this.state.avg = filled > 0 ? (this.done.value + openValue) / filled : 0;
    return filled;
  }

  protected remaining() {
    return Math.max(0, this.spec.size - this.state.filled);
  }

  protected small(size: number, price: number) {
    const m = this.market();
    return !m || size * price < m.minUsd * 0.999 || size < 10 ** -m.szDecimals;
  }

  protected finish(status: AlgoState['status'], detail: string) {
    if (this.state.status !== 'running' && this.state.status !== 'paused') return;
    this.state.status = status;
    this.state.detail = detail;
    this.state.ended = Date.now();
    this.onChange();
  }

  get live() {
    return this.state.status === 'running' || this.state.status === 'paused';
  }

  /** Its own open orders cancelled. */
  async stop(detail = 'Stopped') {
    const open = this.children.filter((c) => this.stateOf(c)?.open);
    if (open.length) await this.conn?.childCancel(open, null);
    this.account();
    this.finish('stopped', detail);
  }

  async step() {
    if (this.busy || !this.live) return;
    this.busy = true;
    try {
      await this.run();
    } catch (e) {
      this.state.detail = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  protected abstract run(): Promise<void>;
}

/** The best price on the order's side, and on the other. */
const sides = (b: Books[string] | undefined, buy: boolean) => (b && b.bid > 0 && b.ask > 0 ? { near: buy ? b.bid : b.ask, far: buy ? b.ask : b.bid } : null);

class Chase extends Algo {
  private start = 0;
  private trailed = 0;
  private lastMove = 0;
  private retry = 0;
  private atLimit = false;

  constructor(...args: ConstructorParameters<typeof Algo>) {
    super(...args);
    this.state.detail = 'Starting';
  }

  private get s() {
    return this.spec as Extract<AlgoSpec, { kind: 'chase' }>;
  }

  /** Where the order should be now. */
  private target(near: number, far: number) {
    const s = this.s;
    const buy = s.buy;
    const t = this.tick(near);
    let p: number;
    if (s.stalk) {
      const away = buy ? near * (1 - s.stalk.distance) : near * (1 + s.stalk.distance);
      // Trail only ever closes the distance; maintain keeps it both ways.
      if (s.stalk.mode === 'trail' && this.trailed) p = buy ? Math.max(this.trailed, away) : Math.min(this.trailed, away);
      else p = away;
      this.trailed = p;
    } else if (s.aggressive) {
      // One tick inside the spread, or the best price if the spread is a tick.
      p = buy ? Math.max(near, far - t) : Math.min(near, far + t);
    } else p = buy ? near - s.offset * t : near + s.offset * t;
    // As far as it may go from where it began.
    this.atLimit = false;
    if (s.chaseTo > 0 && this.start > 0) {
      const limit = buy ? this.start * (1 + s.chaseTo) : this.start * (1 - s.chaseTo);
      if ((buy && p > limit) || (!buy && p < limit)) {
        p = limit;
        this.atLimit = true;
      }
    }
    return this.onGrid(p);
  }

  protected async run() {
    const s = this.s;
    const c = this.conn;
    if (!c) return this.finish('failed', 'The account is gone');
    const bs = sides(this.book(), s.buy);
    this.account();
    const left = this.remaining();
    const open = this.children.find((ch) => this.stateOf(ch)?.open);
    if (!bs) return void (this.state.detail = 'Waiting for a price');
    if (!this.start) this.start = bs.near;
    if (this.small(left, bs.near) && !open) return this.finish('done', `Filled ${this.state.filled} at ${this.state.avg.toPrecision(6)}`);
    // Out of time: as asked.
    if (s.minutes > 0 && Date.now() - this.state.started > s.minutes * 60_000) return this.end(open, 'Its time ran out');
    const price = this.target(bs.near, bs.far);
    if (this.atLimit && open && Math.abs(open.price - price) < this.tick(price) / 2 && (s.buy ? bs.near > price : bs.near < price)) return this.end(open, 'The price went past its limit');
    if (!open) {
      if (Date.now() < this.retry) return;
      const child: Child = { id: c.childId(), coin: s.coin, buy: s.buy, size: left, price, tif: 'Alo', reduceOnly: s.reduceOnly };
      const no = await c.childPlace([child], null);
      if (no) {
        // A post-only order that would have taken, most often: try again at the next price.
        this.state.detail = no;
        this.retry = Date.now() + 300;
        return;
      }
      this.children.push(child);
      this.lastMove = Date.now();
      this.state.detail = `Resting at ${price}`;
      return;
    }
    const t = this.tick(price);
    if (Math.abs(open.price - price) >= t * 0.999 && Date.now() - this.lastMove >= MIN_MOVE_MS) {
      const st = this.stateOf(open)!;
      const moved: Child = { ...open, price, size: st.remaining || open.size };
      const no = await c.childMove(moved, null);
      this.lastMove = Date.now();
      if (no) {
        // Gone in the meantime, or would cross: let it be found again.
        this.state.detail = no;
        return;
      }
      Object.assign(open, moved);
      this.state.detail = `Following at ${price}`;
    }
  }

  private async end(open: Child | undefined, why: string) {
    const s = this.s;
    const c = this.conn!;
    if (s.onEnd === 'keep') return this.finish('done', `${why}: left resting at ${open?.price ?? '—'}`);
    if (open) await c.childCancel([open], null);
    this.account();
    const left = this.remaining();
    if (s.onEnd === 'market' && left > 0) {
      const bs = sides(this.book(), s.buy);
      if (bs && !this.small(left, bs.far)) {
        const px = this.onGrid(s.buy ? bs.far * (1 + this.guards.slippage) : bs.far * (1 - this.guards.slippage));
        const child: Child = { id: c.childId(), coin: s.coin, buy: s.buy, size: left, price: px, tif: 'Ioc', reduceOnly: s.reduceOnly };
        await c.childPlace([child], null);
        this.children.push(child);
        this.account();
        return this.finish('done', `${why}: the rest at the market`);
      }
    }
    this.finish('done', `${why}: ${this.state.filled > 0 ? `${this.state.filled} filled, the rest cancelled` : 'cancelled'}`);
  }
}

class Twap extends Algo {
  private next = 0;
  private lot = 0;
  private chase: Chase | null = null;

  constructor(...args: ConstructorParameters<typeof Algo>) {
    super(...args);
    this.state.lotsTotal = this.s.lots;
    this.next = Date.now();
    this.state.detail = `${this.s.lots} slices over ${this.s.minutes} min`;
  }

  private get s() {
    return this.spec as Extract<AlgoSpec, { kind: 'twap' }>;
  }

  private interval() {
    return (this.s.minutes * 60_000) / this.s.lots;
  }

  override async stop(detail = 'Stopped') {
    if (this.chase) await this.chase.stop();
    await super.stop(detail);
  }

  protected async run() {
    const s = this.s;
    const c = this.conn;
    if (!c) return this.finish('failed', 'The account is gone');
    // A slice being chased: let it run, and count what it filled when it ends.
    if (this.chase) {
      await this.chase.step();
      if (this.chase.live) return;
      this.done.size += this.chase.state.filled;
      this.done.value += this.chase.state.filled * this.chase.state.avg;
      this.chase = null;
    }
    this.account();
    // A slice not yet answered for: what it fills is not counted yet, so the next would buy it again.
    if (this.children.length) return;
    const bs = sides(this.book(), s.buy);
    if (!bs) return void (this.state.detail = 'Waiting for a price');
    const left = this.remaining();
    if (this.lot >= s.lots || this.small(left, bs.near)) return this.finish('done', `Filled ${this.state.filled} at ${this.state.avg.toPrecision(6)}`);
    if (Date.now() < this.next) return;
    // Its bounds: the middle of the book within them, or as asked.
    if (s.bounds) {
      const mid = (bs.near + bs.far) / 2;
      if (mid < s.bounds.low || mid > s.bounds.high) {
        if (s.bounds.action === 'pause') {
          this.state.status = 'paused';
          this.state.detail = `Paused: the price is outside ${s.bounds.low}–${s.bounds.high}`;
          this.next = Date.now() + 1000;
          return;
        }
        if (s.bounds.action === 'abort') return this.finish('stopped', 'The price left its bounds');
        if (s.bounds.action === 'close') {
          await c.flatten(s.coin, this.guards);
          return this.finish('stopped', 'The price left its bounds: the position was closed');
        }
        // finish: what is left, all at once.
        await this.slice(left, 'market');
        this.lot = s.lots;
        return;
      }
      this.state.status = 'running';
    }
    const lotsLeft = s.lots - this.lot;
    const even = left / lotsLeft;
    const size = lotsLeft === 1 ? left : Math.min(left, even * (1 + s.irregular * (Math.random() * 2 - 1)));
    await this.slice(size, s.slice);
    this.lot++;
    this.state.lotsDone = this.lot;
    const iv = this.interval();
    this.next = this.state.started + this.lot * iv + s.jitter * iv * (Math.random() * 2 - 1);
    this.state.detail = `Slice ${this.lot} of ${s.lots}${this.lot < s.lots ? `, next in ${Math.max(0, Math.round((this.next - Date.now()) / 1000))} s` : ''}`;
  }

  private async slice(size: number, how: 'market' | 'chase') {
    const s = this.s;
    const c = this.conn!;
    const bs = sides(this.book(), s.buy)!;
    if (this.small(size, bs.near)) return;
    if (how === 'chase') {
      const minutes = (this.interval() * s.timeout) / 60_000;
      this.chase = new Chase(`${this.id}:${this.lot}`, { kind: 'chase', account: s.account, coin: s.coin, buy: s.buy, size, reduceOnly: s.reduceOnly, aggressive: false, offset: 0, stalk: null, chaseTo: 0, minutes, onEnd: s.onTimeout === 'market' ? 'market' : 'cancel' }, this.place, this.guards, () => {});
      await this.chase.step();
      return;
    }
    const px = this.onGrid(s.buy ? bs.far * (1 + this.guards.slippage) : bs.far * (1 - this.guards.slippage));
    const child: Child = { id: c.childId(), coin: s.coin, buy: s.buy, size, price: px, tif: 'Ioc', reduceOnly: s.reduceOnly };
    const no = await c.childPlace([child], null);
    if (no) this.state.detail = no;
    else this.children.push(child);
  }
}

/** Orders across a range, or a size as market slices at once: placed in one go, then done — a swarm once its slices are answered for. */
class OneShot extends Algo {
  private sent = false;

  protected async run() {
    const s = this.spec;
    const c = this.conn;
    if (!c) return this.finish('failed', 'The account is gone');
    if (this.sent) {
      // The swarm's slices filled or not: done when none is left unanswered, with what they filled.
      this.account();
      if (!this.children.length) this.finish('done', `${this.state.lotsTotal} slices: ${this.state.filled} filled${this.state.filled > 0 ? ` at ${this.state.avg.toPrecision(6)}` : ''}`);
      return;
    }
    const bs = sides(this.book(), s.buy);
    if (!bs) return void (this.state.detail = 'Waiting for a price');
    const list = this.make(c, bs);
    if (typeof list === 'string') return this.finish('failed', list);
    for (let i = 0; i < list.length; i += 40) {
      const no = await c.childPlace(list.slice(i, i + 40), null);
      if (no) return this.finish('failed', no);
    }
    this.children.push(...list);
    this.state.lotsDone = this.state.lotsTotal = list.length;
    if (s.kind === 'scale') return this.finish('done', `${list.length} orders placed from ${list[0]!.price} to ${list[list.length - 1]!.price}`);
    this.sent = true;
    this.state.detail = `${list.length} slices sent`;
  }

  private make(c: Conn, bs: { near: number; far: number }): Child[] | string {
    const s = this.spec;
    if (s.kind === 'scale') {
      const n = Math.max(2, Math.min(100, Math.round(s.count)));
      // A skew bends even spacing towards one end: t^e with e = 3^skew.
      const bend = (t: number, skew: number) => t ** 3 ** skew;
      const at = Array.from({ length: n }, (_, i) => i / (n - 1));
      const prices = at.map((t) => this.onGrid(s.from + (s.to - s.from) * bend(t, -s.priceSkew)));
      const weights = at.map((t) => Math.exp(s.sizeSkew * 2 * (t - 0.5)));
      const total = weights.reduce((x, y) => x + y, 0);
      const out = prices.map((price, i): Child => ({ id: c.childId(), coin: s.coin, buy: s.buy, size: (s.size * weights[i]!) / total, price, tif: s.postOnly ? 'Alo' : 'Gtc', reduceOnly: s.reduceOnly }));
      const tiny = out.find((o) => this.small(o.size, o.price));
      if (tiny) return `The smallest of the ${n} orders comes to $${(tiny.size * tiny.price).toFixed(2)}, under the $${this.market()?.minUsd ?? 10} smallest order: fewer orders, or a larger size`;
      return out;
    }
    if (s.kind === 'swarm') {
      const n = Math.max(2, Math.min(50, Math.round(s.lots)));
      const min = this.market()?.minUsd ?? 10;
      const avg = (s.size * bs.far) / n;
      if (avg < min * 1.01) return `${n} slices of $${avg.toFixed(2)} are under the $${min} smallest order: fewer slices, or a larger size`;
      // Uneven, but never so uneven that a slice falls under the smallest order (which refused the lot, at random).
      const irregular = Math.min(s.irregular, (avg - min * 1.01) / (avg + min * 1.01));
      const w = Array.from({ length: n }, () => 1 + irregular * (Math.random() * 2 - 1));
      const total = w.reduce((x, y) => x + y, 0);
      const px = this.onGrid(s.buy ? bs.far * (1 + this.guards.slippage) : bs.far * (1 - this.guards.slippage));
      const out = w.map((x): Child => ({ id: c.childId(), coin: s.coin, buy: s.buy, size: (s.size * x) / total, price: px, tif: 'Ioc', reduceOnly: s.reduceOnly }));
      if (out.some((o) => this.small(o.size, bs.far))) return `${n} slices are under the $${min} smallest order: fewer slices, or a larger size`;
      return out;
    }
    return 'Not a one-shot algorithm';
  }
}

/** In words: what a condition waits for. */
export function conditionText(c: Condition): string {
  const op = 'above' in c ? (c.above ? 'over' : 'under') : '';
  switch (c.kind) {
    case 'price':
      return `${c.coin} ${op} ${c.value}`;
    case 'ratio':
      return `${c.coin}/${c.of} ${op} ${c.value}`;
    case 'close':
      return `a ${c.tf} ${c.coin} candle closes ${op} ${c.value}`;
    case 'volume':
      return `${c.tf} ${c.coin} volume ${op} $${c.value.toLocaleString('en-US')}`;
    case 'time':
      return `at ${new Date(c.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  }
}

/**
 * A conditional order: it waits until its conditions are met (all at once, or
 * any), then places its order or starts its algorithm, and is done. Candle
 * conditions are read from the exchange's candles just after each closes; a
 * volume over a level can be met while its candle forms, under one only once
 * it has closed.
 */
class When extends Algo {
  private met = new Map<number, boolean>();
  private checked = new Map<number, number>();
  constructor(
    id: string,
    spec: AlgoSpec,
    place: Place,
    guards: Guards,
    onChange: () => void,
    private launch: (spec: AlgoSpec, g: Guards) => string | null,
  ) {
    super(id, spec, place, guards, onChange);
    const coins = this.s.conditions.flatMap((c) => (c.kind === 'ratio' ? [c.coin, c.of] : c.kind === 'time' ? [] : [c.coin]));
    place.want(spec.account, id, [...new Set([...coins, spec.coin])]);
    this.state.detail = `Waiting: ${this.s.conditions.map(conditionText).join(this.s.join === 'and' ? ' and ' : ' or ')}`;
  }

  private get s() {
    return this.spec as Extract<AlgoSpec, { kind: 'when' }>;
  }

  private mid(coin: string) {
    const b = this.place.books(this.spec.account)[coin];
    return b && b.bid > 0 && b.ask > 0 ? (b.bid + b.ask) / 2 : 0;
  }

  /** Whether one condition holds now; candles are read once a candle has closed (and, for a volume over a level, every few seconds). */
  private async holds(i: number, c: Condition): Promise<boolean> {
    const now = Date.now();
    switch (c.kind) {
      case 'time':
        return now >= c.at;
      case 'price': {
        const p = this.mid(c.coin);
        return p > 0 && (c.above ? p > c.value : p < c.value);
      }
      case 'ratio': {
        const a = this.mid(c.coin);
        const b = this.mid(c.of);
        return a > 0 && b > 0 && (c.above ? a / b > c.value : a / b < c.value);
      }
      case 'close':
      case 'volume': {
        const tf = TF_MS[c.tf] ?? 3_600_000;
        const closedAt = Math.floor(now / tf) * tf;
        const forming = c.kind === 'volume' && c.above;
        // Read after each close, a few seconds in; a volume over a level, every 5 s as well.
        const last = this.checked.get(i) ?? 0;
        const due = forming ? now - last > 5000 : last < closedAt && now - closedAt > 3000;
        if (!due) return this.met.get(i) ?? false;
        this.checked.set(i, now);
        const list = await this.place.candles(this.spec.account, c.coin, c.tf, 3);
        const done = list.filter((k) => k.t + tf <= now);
        const k = forming ? list.at(-1) : done.at(-1);
        if (!k) return false;
        const v = c.kind === 'close' ? k.c : k.usd;
        const ok = c.above ? v > c.value : v < c.value;
        this.met.set(i, ok);
        return ok;
      }
    }
  }

  override async stop(detail = 'Stopped') {
    this.place.want(this.spec.account, this.id, []);
    this.finish('stopped', detail);
  }

  protected async run() {
    const s = this.s;
    const results: boolean[] = [];
    for (const [i, c] of s.conditions.entries()) results.push(await this.holds(i, c));
    const go = s.join === 'and' ? results.every(Boolean) : results.some(Boolean);
    if (!go) {
      const n = results.filter(Boolean).length;
      this.state.detail = `Waiting: ${s.conditions.map((c, i) => `${results[i] ? '✓ ' : ''}${conditionText(c)}`).join(s.join === 'and' ? ' and ' : ' or ')}${s.join === 'and' && s.conditions.length > 1 ? ` (${n} of ${s.conditions.length})` : ''}`;
      return;
    }
    this.place.want(this.spec.account, this.id, []);
    if (s.then.kind === 'order') {
      const no = await this.conn?.place({ ...s.then.req, guards: this.guards });
      return no ? this.finish('failed', `Met, but the order was refused: ${no}`) : this.finish('done', 'Met: the order was sent');
    }
    const no = this.launch(s.then.spec, this.guards);
    this.finish(no ? 'failed' : 'done', no ? `Met, but the algorithm did not start: ${no}` : `Met: the ${s.then.spec.kind} started`);
  }
}

export class Runner {
  private algos = new Map<string, Algo>();
  private timer = 0;
  private say = throttle(150, () => this.out({ t: 'algos', algos: [...this.algos.values()].map((a) => a.state) }));

  constructor(
    private place: Place,
    private out: (m: FromWorker) => void,
  ) {}

  /** Starts one; the reason it may not, or null. */
  start(spec: AlgoSpec, g: Guards): string | null {
    const m = this.place.market(spec.account, spec.coin);
    const conn = this.place.conn(spec.account);
    if (!m || !conn) return `${spec.coin} is not traded on this account's exchange`;
    if (conn.ref.mode !== 'trade') return 'Watching only: this account has no key';
    const b = this.place.books(spec.account)[spec.coin];
    if (spec.kind === 'when') {
      if (!spec.conditions.length || spec.conditions.length > 5) return 'One to five conditions';
      // Its order or algorithm is held to the guards when it fires: the price may well be another by then.
      const id = crypto.randomUUID();
      this.algos.set(id, new When(id, spec, this.place, g, this.say, (s, gg) => this.start(s, gg)));
      this.run();
      this.say();
      return null;
    }
    const ref = spec.kind === 'scale' ? Math.max(spec.from, spec.to) : (b?.ask ?? 0) || (b?.bid ?? 0);
    if (spec.kind === 'scale' && !(spec.from > 0 && spec.to > 0)) return 'A scale needs both ends of its range';
    if (spec.kind === 'twap' && !(spec.minutes > 0 && spec.lots >= 2)) return 'A TWAP needs a time and two slices at least';
    // The guards, for the whole of it as one order; the price band only for what is placed near the book.
    const no = guard(m, spec.kind === 'scale' ? undefined : b, spec.buy, spec.size, ref, { ...g, band: spec.kind === 'chase' ? g.band : 0 }, spec.reduceOnly || spec.kind === 'scale');
    if (no) return no;
    const id = crypto.randomUUID();
    const algo = spec.kind === 'chase' ? new Chase(id, spec, this.place, g, this.say) : spec.kind === 'twap' ? new Twap(id, spec, this.place, g, this.say) : new OneShot(id, spec, this.place, g, this.say);
    this.algos.set(id, algo);
    this.run();
    this.say();
    return null;
  }

  async stop(id: string) {
    await this.algos.get(id)?.stop();
    this.say();
  }

  /** Every running algo of an account stopped: before its kill switch closes everything. */
  async stopAccount(account: string | null) {
    await Promise.all([...this.algos.values()].filter((a) => a.live && (account === null || a.spec.account === account)).map((a) => a.stop('Stopped by the kill switch')));
    this.say();
  }

  private run() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const live = [...this.algos.values()].filter((a) => a.live);
      if (!live.length) {
        clearInterval(this.timer);
        this.timer = 0;
        return;
      }
      for (const a of live) void a.step();
    }, 200) as unknown as number;
  }
}
