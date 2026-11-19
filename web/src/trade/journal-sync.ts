/**
 * The trading accounts' trades kept in the journal: each account's fills
 * worked into round trips — a position from flat back to flat, or still
 * open — and written to the journal, by where each came from, whenever they
 * change. Only for a browser signed in with Telegram: the journal is an
 * account's. Fills, prices and sizes go to tradoor's server for the journal;
 * no key ever does.
 */
import { createEffect, createRoot } from 'solid-js';
import { catalog, json } from '../lib/api';
import { session } from '../lib/owner';
import { trade } from './client';
import type { AccountRef } from './protocol';
import { type Trip, tripsOf } from './trips';

let started = false;

export function startJournalSync(): void {
  if (started || !session()) return;
  started = true;
  const markets = catalog().then((c) => c.products);
  const sent = new Map<string, string>();
  createRoot(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    createEffect(() => {
      // Read here so the effect runs again when any of them changes.
      void [trade.accounts(), trade.states()];
      clearTimeout(pending);
      pending = setTimeout(() => void push(), 5_000);
    });
  });

  async function push(): Promise<void> {
    if (!session()) return;
    const products = await markets;
    const marketOf = (a: AccountRef, coin: string) => {
      const list = products.filter((p) => p.venue === `${a.venue}-perp`);
      const plain = coin.replace(/^k(?=[A-Z])/, '');
      return (list.find((p) => p.base === coin) ?? list.find((p) => p.base.toUpperCase() === plain.toUpperCase()))?.market ?? null;
    };
    for (const a of trade.accounts()) {
      const s = trade.states()[a.id];
      if (!s) continue;
      const coins = new Set([...s.fills.map((f) => f.coin), ...s.positions.filter((p) => p.size !== 0).map((p) => p.coin)]);
      const trips: Trip[] = [];
      for (const coin of coins) {
        const market = marketOf(a, coin);
        if (!market) continue;
        const p = s.positions.find((x) => x.coin === coin);
        trips.push(...tripsOf(s.fills.filter((f) => f.coin === coin), p?.size ?? 0, `${a.venue}:${a.network}:${a.owner.toLowerCase()}${a.accountIndex ? `#${a.accountIndex}` : ''}:${coin}`, market, p?.leverage || 1));
      }
      // Sent again only when they changed.
      const body = JSON.stringify(trips);
      if (!trips.length || sent.get(a.id) === body) continue;
      try {
        await json('/api/journal/sync', { method: 'POST', body: { trades: trips.slice(-2000) } });
        sent.set(a.id, body);
      } catch {
        // Not now (offline, signed out): the next change tries again.
      }
    }
  }
}
