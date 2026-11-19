/** Money, sizes and prices as the trading panels write them. */
import { formatPrice } from '../lib/format';

export const usd = (v: number, signed = false): string => {
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}$${s}`;
};

/** A size to the coin's own decimals. */
export const coins = (v: number, decimals: number): string => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: Math.max(0, decimals) });

/** Six significant figures at most: the exchange's prices have five, a middle of the book one more, and its liquidation prices many. */
export const price = (v: number | null | undefined): string => (v === null || v === undefined || !(v > 0) ? '—' : formatPrice(Number(v.toPrecision(6))));

export const pct = (v: number, signed = true): string => `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}${Math.abs(v * 100).toFixed(2)}%`;

export const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
