import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert';
import { tripsOf } from './trips.ts';
import type { Fill } from './protocol.ts';

let tid = 0;
const fill = (time: number, buy: boolean, size: number, price: number, fee = 0): Fill => ({ coin: 'BTC', price, size, buy, time, dir: '', pnl: 0, fee, oid: 0, tid: ++tid, crossed: true });
const M = 'hyperliquid-perp:BTCUSD';

Deno.test('a long opened and closed is one round trip, a win', () => {
  const t = tripsOf([fill(1, true, 1, 100, 0.1), fill(2, false, 1, 110, 0.1)], 0, 'k', M, 10);
  assertEquals(t.length, 1);
  assertEquals(t[0]!.side, 'long');
  assertEquals([t[0]!.entry, t[0]!.exit, t[0]!.qty, t[0]!.openedAt, t[0]!.closedAt], [100, 110, 1, 1, 2]);
  assertAlmostEquals(t[0]!.fees, 0.2);
  assertEquals(t[0]!.source, 'k:1');
});

Deno.test('adding to it and closing in parts averages both sides', () => {
  const t = tripsOf([fill(1, true, 1, 100), fill(2, true, 1, 110), fill(3, false, 1, 120), fill(4, false, 1, 130)], 0, 'k', M, 1);
  assertEquals(t.length, 1);
  assertEquals([t[0]!.entry, t[0]!.exit, t[0]!.qty], [105, 125, 2]);
});

Deno.test('one fill past flat closes the long and opens a short with the rest', () => {
  const t = tripsOf([fill(1, true, 1, 100), fill(2, false, 3, 90, 3)], -2, 'k', M, 1);
  assertEquals(t.length, 2);
  assertEquals([t[0]!.side, t[0]!.exit, t[0]!.closedAt], ['long', 90, 2]);
  assertAlmostEquals(t[0]!.fees, 1, 1e-9, 'its share of the fee');
  assertEquals([t[1]!.side, t[1]!.entry, t[1]!.qty, t[1]!.closedAt], ['short', 90, 2, undefined]);
  assertAlmostEquals(t[1]!.fees, 2, 1e-9);
});

Deno.test('a trade begun before the history reaches is left out, not guessed', () => {
  // Held 1 before these fills: the sell closes a trade whose entry is not here.
  const t = tripsOf([fill(1, false, 1, 105), fill(2, true, 2, 100)], 2, 'k', M, 1);
  assertEquals(t.length, 1);
  assertEquals([t[0]!.side, t[0]!.entry, t[0]!.qty, t[0]!.exit], ['long', 100, 2, undefined]);
});

Deno.test('a position still held is an open trade', () => {
  const t = tripsOf([fill(5, false, 0.5, 200)], -0.5, 'k', M, 5);
  assertEquals(t.length, 1);
  assert(t[0]!.exit === undefined && t[0]!.closedAt === undefined);
  assertEquals([t[0]!.side, t[0]!.leverage], ['short', 5]);
});
