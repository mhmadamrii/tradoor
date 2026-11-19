/// <reference lib="deno.ns" />
// Typed trading lines read into what they will do, against a pretend account with a book.
import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1';
import { normalKey, read, type Action, type Ctx } from './commands.ts';
import type { AccountRef, MarketInfo, OpenOrder, Position } from './protocol.ts';

const acct = (id: string, label: string, venue: 'hyperliquid' | 'lighter' = 'hyperliquid'): AccountRef => ({ id, venue, network: 'testnet', owner: '0x1', label, mode: 'trade', agent: null, validUntil: 0, created: 0 });
const A = acct('a', 'Main');
const L = acct('l', 'Lighter one', 'lighter');
const mk = (coin: string): MarketInfo => ({ coin, szDecimals: 4, pxDecimals: 1, maxLeverage: 40, minUsd: 10 });
const MARKETS = new Map([['BTC', mk('BTC')], ['ETH', mk('ETH')], ['kPEPE', mk('kPEPE')]]);
const BOOKS: Record<string, { bid: number; ask: number }> = { BTC: { bid: 60_000, ask: 60_010 }, ETH: { bid: 2_000, ask: 2_001 } };
let position: Position | undefined;
let orders: OpenOrder[] = [];

const ctx: Ctx = {
  accounts: [A, L],
  defaultAccount: 'a',
  markets: () => MARKETS,
  book: (_a, coin) => BOOKS[coin],
  position: (_a, coin) => (position?.coin === coin ? position : undefined),
  orders: () => orders,
  maxSize: () => 2,
  market: 'binance-perp:BTCUSDT',
  coinOf: (m) => (m.includes('BTC') ? 'BTC' : null),
  guards: { maxUsd: 1e6, band: 0.05, slippage: 0.01 },
};

function one(line: string): Action {
  const r = read(line, ctx);
  if ('error' in r) throw new Error(r.error);
  assertEquals(r.actions.length, 1, line);
  return r.actions[0]!;
}
const err = (line: string) => {
  const r = read(line, ctx);
  return 'error' in r ? r.error : null;
};

Deno.test('a market order, a limit at the middle, a share with exits from its price', () => {
  const a = one('buy 0.01 btc');
  assert(a.kind === 'order' && a.req.kind === 'market' && a.req.buy && a.req.size === 0.01 && a.req.coin === 'BTC');
  const b = one('sell $500 eth @mid post');
  assert(b.kind === 'order' && b.req.kind === 'limit' && b.req.tif === 'Alo' && !b.req.buy);
  assertEquals(b.req.price, 2000.5);
  assertAlmostEquals(b.req.size, 500 / 2000.5, 1e-9);
  const c = one('long 25% @-0.5% tp 2% sl 1%');
  assert(c.kind === 'order' && c.req.coin === 'BTC', 'the focused panel’s coin');
  assertEquals(c.req.size, 0.5);
  assertAlmostEquals(c.req.price!, 59_700, 1e-6);
  assertAlmostEquals(c.req.tp!, 59_700 * 1.02, 1e-6);
  assertAlmostEquals(c.req.sl!, 59_700 * 0.99, 1e-6);
  const d = one('short 0.1 tp 2% sl 1%');
  assert(d.kind === 'order' && d.req.tp! < 60_000 && d.req.sl! > 60_000, 'a short profits down');
});

Deno.test('stops, closes, cancels, leverage and moves', () => {
  const s = one('stop sell 0.1 btc at 59000 limit 58900');
  assert(s.kind === 'order' && s.req.kind === 'stopLimit' && s.req.trigger === 59_000 && s.req.price === 58_900);
  position = { coin: 'BTC', size: 0.4, entry: 59_000, value: 24_000, pnl: 0, roe: 0, liquidation: null, leverage: 10, cross: true, margin: 2400, funding: 0 };
  const c = one('close btc 50%');
  assert(c.kind === 'close' && !c.buy && c.size === 0.2);
  assertEquals(one('close').kind, 'flatten');
  const e = one('tp 62000 sl 2%');
  assert(e.kind === 'exits' && e.tp === 62_000);
  assertAlmostEquals(e.sl!, 59_000 * 0.98, 1e-6);
  orders = [{ coin: 'BTC', oid: 1, cloid: null, buy: true, price: 59_500, size: 0.1, origSize: 0.1, kind: 'Limit', trigger: null, triggerCondition: '', reduceOnly: false, positionTpsl: false, tif: 'Gtc', time: 0 }];
  const x = one('cancel all');
  assert(x.kind === 'cancel' && x.orders.length === 1);
  const m = one('bump buys -1%');
  assert(m.kind === 'move');
  assertAlmostEquals(m.moves[0]!.price, 59_500 * 0.99, 1e-6);
  const l = one('lev 10x iso');
  assert(l.kind === 'leverage' && l.leverage === 10 && !l.cross);
  position = undefined;
  orders = [];
});

Deno.test('the algorithms, their settings as typed', () => {
  const c = one('chase buy $1000 aggr to 0.3% for 5m then market');
  assert(c.kind === 'algo' && c.spec.kind === 'chase' && c.spec.aggressive && c.spec.chaseTo === 0.003 && c.spec.minutes === 5 && c.spec.onEnd === 'market');
  const t = one('twap sell 1 eth over 30m x12 jitter 20% uneven 10% chase 40% next between 1900 2100 abort');
  assert(t.kind === 'algo' && t.spec.kind === 'twap');
  assertEquals([t.spec.minutes, t.spec.lots, t.spec.jitter, t.spec.irregular, t.spec.slice, t.spec.timeout, t.spec.onTimeout], [30, 12, 0.2, 0.1, 'chase', 0.4, 'next']);
  assertEquals(t.spec.bounds, { low: 1900, high: 2100, action: 'abort' });
  const s = one('scale buy 1 btc from 60000 to 58000 x10 skew 0.5');
  assert(s.kind === 'algo' && s.spec.kind === 'scale' && s.spec.count === 10 && s.spec.priceSkew === 0.5 && s.spec.from === 60_000);
  const w = one('swarm buy 2 btc x5');
  assert(w.kind === 'algo' && w.spec.kind === 'swarm' && w.spec.lots === 5);
  const st = one('chase sell 0.1 stalk 0.5% trail until');
  assert(st.kind === 'algo' && st.spec.kind === 'chase' && st.spec.stalk?.mode === 'trail' && st.spec.chaseTo === 0);
});

Deno.test('another account by name, lines in a row, a repeat', () => {
  const a = one('buy 0.01 btc on lighter');
  assert(a.kind === 'order' && a.account.id === 'l');
  const r = read('buy 0.01 btc; sell 0.1 eth', ctx);
  assert('actions' in r && r.actions.length === 2 && r.label.includes('; then '));
  const p = one('repeat 3 every 10s buy 0.001 btc');
  assert(p.kind === 'repeat' && p.times === 3 && p.every === 10_000);
  const k = one('buy 1000 kpepe');
  assert(k.kind === 'order' && k.req.coin === 'kPEPE');
});

Deno.test('held until conditions are met: price, a ratio, a candle, a time', () => {
  const a = one('when btc > 70000 and 4h eth close < 1900: buy 0.1 eth');
  assert(a.kind === 'algo' && a.spec.kind === 'when');
  assertEquals(a.spec.join, 'and');
  assertEquals(a.spec.conditions, [{ kind: 'price', coin: 'BTC', above: true, value: 70000 }, { kind: 'close', coin: 'ETH', tf: '4h', above: false, value: 1900 }]);
  assert(a.spec.then.kind === 'order' && a.spec.then.req.coin === 'ETH');
  const b = one('when btc/eth > 30 or 1h btc volume > 2m: chase buy $1000');
  assert(b.kind === 'algo' && b.spec.kind === 'when' && b.spec.join === 'or');
  assertEquals(b.spec.conditions[1], { kind: 'volume', coin: 'BTC', tf: '1h', above: true, value: 2_000_000 });
  assert(b.spec.then.kind === 'algo' && b.spec.then.spec.kind === 'chase');
  const c = one('at 23:59: twap buy 1 btc over 1h');
  assert(c.kind === 'algo' && c.spec.kind === 'when' && c.spec.conditions[0]!.kind === 'time');
  assert(err('when btc 70000: buy 1 btc')?.includes('a condition is like'));
  assert(err('when 2w btc close > 1: buy 1 btc')?.includes('timeframe'));
});

Deno.test('what cannot be done says why; keys that are tradoor’s own are not taken', () => {
  assert(err('fly 1 btc')?.includes('not a command'));
  assert(err('buy btc')?.includes('<size>'));
  assert(err('buy 0.1 btc on nobody')?.includes('No account'));
  assert(err('close eth')?.includes('No ETH position'));
  assert(err('bind alt+b = buy 1 btc')?.includes('taken'));
  assertEquals(normalKey('alt+1'), 'alt+1');
  assertEquals(normalKey('Shift+Ctrl+B'), 'ctrl+shift+b');
  assertEquals(normalKey('b'), null, 'a plain letter is typing');
  const b = one('bind alt+1 = buy $100');
  assert(b.kind === 'bind' && b.key === 'alt+1');
});
