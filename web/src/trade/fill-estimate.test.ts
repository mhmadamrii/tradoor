import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert';
import { fillEstimate } from './fill-estimate.ts';

const asks: [number, number][] = [[100, 1], [101, 1], [102, 2]];
const bids: [number, number][] = [[99, 0.5], [98, 0.5], [90, 10]];

Deno.test('a size the best level holds fills at the best', () => {
  const e = fillEstimate(asks, 0.5, true, 0.05)!;
  assertEquals([e.avg, e.worst, e.slip, e.filled, e.capped], [100, 100, 0, 1, false]);
});

Deno.test('a bigger one walks the levels and averages them', () => {
  const e = fillEstimate(asks, 3, true, 0.05)!;
  assertAlmostEquals(e.avg, (100 + 101 + 102) / 3);
  assertEquals([e.worst, e.filled], [102, 1]);
  assertAlmostEquals(e.slip, 0.01);
});

Deno.test('more than the levels seen hold: the share that fills says so', () => {
  const e = fillEstimate(asks, 8, true, 0.5)!;
  assertEquals(e.filled, 0.5);
  assert(!e.capped);
});

Deno.test('a sell stops at the slippage guard, and the rest would be cancelled', () => {
  const e = fillEstimate(bids, 2, false, 0.02)!;
  assertEquals([e.avg, e.worst, e.filled, e.capped], [98.5, 98, 0.5, true]);
});

Deno.test('nothing to say without a size or a book', () => {
  assertEquals(fillEstimate([], 1, true, 0.01), null);
  assertEquals(fillEstimate(asks, 0, true, 0.01), null);
});
