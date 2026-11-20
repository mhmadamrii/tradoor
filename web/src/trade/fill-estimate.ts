/**
 * What a market order of a size would fill at, walked down the book's top
 * levels: the average price, how far it is from the best, and whether the
 * levels seen hold it all, or the slippage guard would leave some unfilled.
 */

export interface FillEstimate {
  /** The average price of what fills. */
  avg: number;
  /** The last level it reaches. */
  worst: number;
  /** The average's distance from the best price, as a fraction, always positive: what it costs. */
  slip: number;
  /** The share of the size that fills within the levels seen and the guard; 1 is all of it. */
  filled: number;
  /** The guard stops it short: the rest is cancelled, as an IOC's is. */
  capped: boolean;
}

/**
 * `levels` best first, `[price, size]`; a buy walks the asks, a sell the bids.
 * `guard` is the slippage allowed past the best (0.01 = 1%), as orders are sent.
 */
export function fillEstimate(levels: [number, number][], size: number, buy: boolean, guard: number): FillEstimate | null {
  const best = levels[0]?.[0] ?? 0;
  if (!(size > 0) || !(best > 0)) return null;
  const limit = buy ? best * (1 + guard) : best * (1 - guard);
  let left = size;
  let cost = 0;
  let worst = best;
  let capped = false;
  for (const [px, sz] of levels) {
    if (left <= 0) break;
    if (buy ? px > limit : px < limit) {
      capped = true;
      break;
    }
    const take = Math.min(left, sz);
    cost += take * px;
    left -= take;
    worst = px;
  }
  const got = size - left;
  if (!(got > 0)) return null;
  const avg = cost / got;
  return { avg, worst, slip: Math.abs(avg - best) / best, filled: got / size, capped };
}
