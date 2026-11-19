/**
 * A trading account's fills as round trips: a position from flat back to
 * flat, or still open. Pure, for the journal sync.
 */
import type { Fill } from './protocol';

export interface Trip {
  source: string;
  market: string;
  side: 'long' | 'short';
  entry: number;
  qty: number;
  openedAt: number;
  exit?: number;
  closedAt?: number;
  fees: number;
  leverage: number;
}

const EPS = 1e-9;

/**
 * One coin's fills as round trips. `now` is the position held now (signed):
 * what the fills start from is worked back from it, and fills before the
 * first time it is flat are left out — their trade began before the history
 * reaches, and its entry cannot be known.
 */
export function tripsOf(fills: Fill[], now: number, key: string, market: string, leverage: number): Trip[] {
  const asc = [...fills].sort((a, b) => a.time - b.time || a.tid - b.tid);
  const signed = (f: Fill) => (f.buy ? f.size : -f.size);
  let pos = now - asc.reduce((s, f) => s + signed(f), 0);
  const out: Trip[] = [];
  let open: { side: 'long' | 'short'; cost: number; qty: number; exitCost: number; exitQty: number; fees: number; at: number } | null = null;
  const tol = (x: number) => Math.abs(x) < EPS * Math.max(1, Math.abs(now));
  for (const f of asc) {
    const s = signed(f);
    if (open === null && !tol(pos)) {
      // Still in a trade from before the history: wait for flat.
      pos += s;
      continue;
    }
    let left = Math.abs(s);
    let fee = f.fee;
    while (left > EPS) {
      if (open === null) {
        open = { side: s > 0 ? 'long' : 'short', cost: 0, qty: 0, exitCost: 0, exitQty: 0, fees: 0, at: f.time };
      }
      const adds = (open.side === 'long') === s > 0;
      if (adds) {
        open.cost += f.price * left;
        open.qty += left;
        open.fees += fee;
        pos += open.side === 'long' ? left : -left;
        left = 0;
      } else {
        // Takes off what is held; past flat, the rest opens the other way.
        const held = Math.abs(pos);
        const take = Math.min(left, held);
        const share = left > 0 ? take / left : 1;
        open.exitCost += f.price * take;
        open.exitQty += take;
        open.fees += fee * share;
        fee *= 1 - share;
        pos += open.side === 'long' ? -take : take;
        left -= take;
        if (tol(pos)) {
          out.push({ source: `${key}:${open.at}`, market, side: open.side, entry: open.cost / open.qty, qty: open.qty, openedAt: open.at, exit: open.exitCost / open.exitQty, closedAt: f.time, fees: open.fees, leverage });
          pos = 0;
          open = null;
        }
      }
    }
  }
  if (open && open.qty > EPS) out.push({ source: `${key}:${open.at}`, market, side: open.side, entry: open.cost / open.qty, qty: open.qty, openedAt: open.at, fees: open.fees, leverage });
  return out;
}
