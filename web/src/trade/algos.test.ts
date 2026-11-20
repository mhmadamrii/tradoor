/// <reference lib="deno.ns" />
// The algorithms against a pretend exchange: a book moved by hand, post-only orders that rest
// and fill when the other side reaches them, IOC slices that fill at once.
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1';
import { Runner, type Place } from './algos.ts';
import type { AlgoSpec, AlgoState, Books, Guards, MarketInfo } from './protocol.ts';
import type { Child, Conn } from './venues/common.ts';

const GUARDS: Guards = { maxUsd: 1_000_000, band: 0.05, slippage: 0.01 };
const MARKET: MarketInfo = { coin: 'BTC', szDecimals: 5, pxDecimals: 1, maxLeverage: 40, minUsd: 10 };

class Fake {
  books: Books = { BTC: { bid: 100, ask: 100.5 } };
  open = new Map<string, Child>();
  filled = new Map<string, { size: number; avg: number }>();
  log: string[] = [];
  /** Shown only from a moment on, as Lighter's update comes after it took the order: id → when. */
  hidden = new Map<string, number>();
  /** How late each new order is shown, in ms. */
  lag = 0;
  private n = 0;
  conn = {
    ref: { id: 'a', venue: 'hyperliquid', network: 'testnet', owner: '0x', label: 'A', mode: 'trade', agent: null, validUntil: 0, created: 0 },
    tick: () => 0.1,
    childId: () => `c${++this.n}`,
    childPlace: async (cs: Child[]) => {
      for (const c of cs) {
        const b = this.books.BTC!;
        const crosses = c.buy ? c.price >= b.ask : c.price <= b.bid;
        if (c.tif === 'Alo' && crosses) return 'Post only order would have immediately matched';
        this.log.push(`place ${c.tif} ${c.buy ? 'buy' : 'sell'} ${c.size.toFixed(5)} @ ${c.price}`);
        if (this.lag) this.hidden.set(c.id, Date.now() + this.lag);
        if (c.tif === 'Ioc') this.filled.set(c.id, { size: c.size, avg: c.buy ? b.ask : b.bid });
        else this.open.set(c.id, { ...c });
      }
      return null;
    },
    childMove: async (c: Child) => {
      if (!this.open.has(c.id)) return 'Order was never placed, already canceled, or filled';
      this.log.push(`move ${c.price}`);
      this.open.set(c.id, { ...c });
      return null;
    },
    childCancel: async (cs: Child[]) => {
      for (const c of cs) this.open.delete(c.id);
      this.log.push(`cancel ${cs.length}`);
      return null;
    },
    childState: (c: Child) => {
      const o = this.open.get(c.id);
      const f = this.filled.get(c.id);
      if (this.hidden.has(c.id) && Date.now() < this.hidden.get(c.id)!) return { open: false, remaining: 0, filled: 0, avg: 0, known: false };
      return o ? { open: true, remaining: o.size, filled: 0, avg: 0, known: true } : { open: false, remaining: 0, filled: f?.size ?? 0, avg: f?.avg ?? 0, known: true };
    },
    flatten: async () => (this.log.push('flatten'), null),
    place: async (req: { buy: boolean; size: number; kind: string }) => (this.log.push(`order ${req.kind} ${req.buy ? 'buy' : 'sell'} ${req.size}`), null),
  } as unknown as Conn;
  candleList: { t: number; o: number; h: number; l: number; c: number; usd: number }[] = [];
  place: Place = { conn: () => this.conn, books: () => this.books, market: () => MARKET, want: () => {}, candles: async () => this.candleList };

  /** The book moves; resting orders the other side reaches fill at their price. */
  move(bid: number, ask: number) {
    this.books.BTC = { bid, ask };
    for (const [id, o] of this.open) {
      if ((o.buy && ask <= o.price) || (!o.buy && bid >= o.price)) {
        this.open.delete(id);
        this.filled.set(id, { size: o.size, avg: o.price });
      }
    }
  }
}

function run(fake: Fake, spec: AlgoSpec, g = GUARDS) {
  const states: AlgoState[][] = [];
  const runner = new Runner(fake.place, (m) => m.t === 'algos' && states.push(m.algos));
  const no = runner.start(spec, g);
  const last = () => states.at(-1)?.[0];
  return { no, runner, last };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = { account: 'a', coin: 'BTC', reduceOnly: false } as const;

Deno.test('a chase joins the bid, follows it up, and is done when the price comes down to it', async () => {
  const f = new Fake();
  const { runner, last } = run(f, { ...base, kind: 'chase', buy: true, size: 1, aggressive: false, offset: 0, stalk: null, chaseTo: 0, minutes: 0, onEnd: 'cancel' });
  await wait(300);
  assertEquals([...f.open.values()][0]?.price, 100);
  f.move(100.4, 100.8);
  await wait(700);
  assertEquals([...f.open.values()][0]?.price, 100.4, 'moved up with the bid');
  f.move(100.2, 100.4);
  await wait(700);
  assertEquals(last()?.status, 'done');
  assertAlmostEquals(last()!.filled, 1, 1e-9);
  assertEquals(last()!.avg, 100.4);
  await runner.stopAccount(null);
});

Deno.test('an exchange slow to show an order: the chase places it once, not again each step', async () => {
  // Lighter's update comes after it took the order; read as gone, a chase placed it again and again.
  const f = new Fake();
  f.lag = 900;
  const { runner } = run(f, { ...base, kind: 'chase', buy: true, size: 1, aggressive: false, offset: 0, stalk: null, chaseTo: 0, minutes: 0, onEnd: 'cancel' });
  await wait(1500);
  assertEquals(f.log.filter((l) => l.startsWith('place')).length, 1, f.log.join('\n'));
  assertEquals(f.open.size, 1);
  await runner.stopAccount(null);
  assertEquals(f.open.size, 0, 'and stopped, its order is cancelled though it was not shown yet');
});

Deno.test('aggressive sits one tick inside the spread; a stalk that trails never backs away', async () => {
  const f = new Fake();
  const a = run(f, { ...base, kind: 'chase', buy: true, size: 1, aggressive: true, offset: 0, stalk: null, chaseTo: 0, minutes: 0, onEnd: 'cancel' });
  await wait(300);
  assertEquals([...f.open.values()][0]?.price, 100.4);
  await a.runner.stopAccount(null);
  const g = new Fake();
  const b = run(g, { ...base, kind: 'chase', buy: true, size: 1, aggressive: false, offset: 0, stalk: { mode: 'trail', distance: 0.01 }, chaseTo: 0, minutes: 0, onEnd: 'cancel' });
  await wait(300);
  assertEquals([...g.open.values()][0]?.price, 99, '1% under the bid');
  g.move(102, 102.5);
  await wait(700);
  assertEquals([...g.open.values()][0]?.price, 100.9, 'up with the price');
  g.move(101, 101.5);
  await wait(700);
  assertEquals([...g.open.values()][0]?.price, 100.9, 'not down again');
  await b.runner.stopAccount(null);
});

Deno.test('a chase stops at its limit and leaves the order resting there when asked', async () => {
  const f = new Fake();
  const { last } = run(f, { ...base, kind: 'chase', buy: true, size: 1, aggressive: false, offset: 0, stalk: null, chaseTo: 0.01, minutes: 0, onEnd: 'keep' });
  await wait(300);
  f.move(103, 103.5);
  await wait(1200);
  assertEquals([...f.open.values()][0]?.price, 101, 'no higher than 1% over where it began');
  assertEquals(last()?.status, 'done');
  assert(last()!.detail.includes('left resting'));
});

Deno.test('a TWAP sends its slices over its time and fills the whole size', async () => {
  const f = new Fake();
  const { last } = run(f, { ...base, kind: 'twap', buy: false, size: 0.5, minutes: 0.02, lots: 4, jitter: 0, irregular: 0, bounds: null, slice: 'market', timeout: 0.5, onTimeout: 'market' });
  await wait(2500);
  assertEquals(last()?.status, 'done');
  assertAlmostEquals(last()!.filled, 0.5, 1e-9);
  assertEquals(f.log.filter((l) => l.startsWith('place Ioc sell')).length, 4);
});

Deno.test('a TWAP outside its bounds waits, and goes on once the price is back', async () => {
  const f = new Fake();
  f.move(90, 90.5);
  const { last } = run(f, { ...base, kind: 'twap', buy: true, size: 0.5, minutes: 0.01, lots: 2, jitter: 0, irregular: 0, bounds: { low: 95, high: 105, action: 'pause' }, slice: 'market', timeout: 0.5, onTimeout: 'market' });
  await wait(800);
  assertEquals(last()?.status, 'paused');
  assertEquals(f.log.length, 0);
  f.move(100, 100.5);
  await wait(1500);
  assertEquals(last()?.status, 'done');
});

Deno.test('a scale spreads its orders across the range and its size across them', async () => {
  const f = new Fake();
  const { last } = run(f, { ...base, kind: 'scale', buy: true, size: 2, from: 90, to: 99, count: 10, priceSkew: 0, sizeSkew: 0, postOnly: true });
  await wait(400);
  assertEquals(last()?.status, 'done');
  const orders = [...f.open.values()];
  assertEquals(orders.length, 10);
  assertEquals(orders[0]!.price, 90);
  assertEquals(orders[9]!.price, 99);
  assertAlmostEquals(orders.reduce((s, o) => s + o.size, 0), 2, 1e-9);
  const g = new Fake();
  run(g, { ...base, kind: 'scale', buy: true, size: 5, from: 90, to: 99, count: 10, priceSkew: 1, sizeSkew: 1, postOnly: true });
  await wait(400);
  const skewed = [...g.open.values()];
  assert(skewed[5]!.price > 94.5, 'bunched towards the far end');
  assert(skewed[9]!.size > skewed[0]!.size, 'bigger towards the far end');
});

Deno.test('a scale whose orders would each be under the smallest order is refused, not half placed', async () => {
  const f = new Fake();
  const { last } = run(f, { ...base, kind: 'scale', buy: true, size: 1, from: 90, to: 99, count: 10, priceSkew: 0, sizeSkew: 0, postOnly: true });
  await wait(400);
  assertEquals(last()?.status, 'failed');
  assertEquals(f.open.size, 0);
});

Deno.test('a swarm sends its slices together; the guards hold the whole of an algorithm', async () => {
  const f = new Fake();
  const { last } = run(f, { ...base, kind: 'swarm', buy: true, size: 1, lots: 5, irregular: 0.3 });
  await wait(1000);
  assertEquals(last()?.status, 'done');
  assertEquals(f.log.filter((l) => l.startsWith('place Ioc buy')).length, 5);
  assertAlmostEquals(last()!.filled, 1, 1e-9, 'done once its slices are answered for, with what they filled');
  const g = new Fake();
  const r = run(g, { ...base, kind: 'chase', buy: true, size: 10, aggressive: false, offset: 0, stalk: null, chaseTo: 0, minutes: 0, onEnd: 'cancel' }, { ...GUARDS, maxUsd: 500 });
  assert(r.no?.includes('over your limit'), r.no ?? '');
});

Deno.test('a conditional order waits for its price, then sends its order', async () => {
  const f = new Fake();
  const { last } = run(f, { ...base, kind: 'when', buy: true, size: 0.5, conditions: [{ kind: 'price', coin: 'BTC', above: true, value: 105 }], join: 'and', then: { kind: 'order', req: { coin: 'BTC', buy: true, size: 0.5, kind: 'market' } } });
  await wait(500);
  assertEquals(last()?.status, 'running');
  assert(last()!.detail.startsWith('Waiting'));
  f.move(106, 106.5);
  await wait(500);
  assertEquals(last()?.status, 'done');
  assertEquals(f.log, ['order market buy 0.5']);
});

Deno.test('all conditions at once: a ratio and a candle that closed over a level', async () => {
  const f = new Fake();
  f.books.ETH = { bid: 3, ask: 3.02 };
  const hour = 3_600_000;
  const closed = Math.floor(Date.now() / hour) * hour - hour;
  f.candleList = [{ t: closed, o: 100, h: 101, l: 99, c: 99.5, usd: 1e6 }];
  const spec = { ...base, kind: 'when' as const, buy: false, size: 1, conditions: [{ kind: 'ratio' as const, coin: 'BTC', of: 'ETH', above: true, value: 30 }, { kind: 'close' as const, coin: 'BTC', tf: '1h' as const, above: true, value: 100 }], join: 'and' as const, then: { kind: 'order' as const, req: { coin: 'BTC', buy: false, size: 1, kind: 'market' as const } } };
  const { last } = run(f, spec);
  await wait(600);
  assertEquals(last()?.status, 'running', 'the ratio is met (about 33), the close is not (99.5)');
  assert(last()!.detail.includes('(1 of 2)'));
  f.candleList = [{ t: closed, o: 100, h: 101, l: 99, c: 100.5, usd: 1e6 }];
  // The candle is read once a close: a new one does not show until the next, so this one starts afresh.
  const g = new Fake();
  g.books.ETH = { bid: 3, ask: 3.02 };
  g.candleList = f.candleList;
  const r = run(g, spec);
  await wait(600);
  assertEquals(r.last()?.status, 'done');
  await r.runner.stopAccount(null);
});

Deno.test('at a time; or the first of several; stopped, it sends nothing', async () => {
  const f = new Fake();
  const { last } = run(f, { ...base, kind: 'when', buy: true, size: 0.1, conditions: [{ kind: 'price', coin: 'BTC', above: false, value: 50 }, { kind: 'time', at: Date.now() + 300 }], join: 'or', then: { kind: 'order', req: { coin: 'BTC', buy: true, size: 0.1, kind: 'market' } } });
  await wait(800);
  assertEquals(last()?.status, 'done');
  const g = new Fake();
  const r = run(g, { ...base, kind: 'when', buy: true, size: 0.1, conditions: [{ kind: 'price', coin: 'BTC', above: true, value: 1e6 }], join: 'and', then: { kind: 'order', req: { coin: 'BTC', buy: true, size: 0.1, kind: 'market' } } });
  await wait(300);
  await r.runner.stop(r.last()!.id);
  assertEquals(r.last()?.status, 'stopped');
  assertEquals(g.log, []);
});
