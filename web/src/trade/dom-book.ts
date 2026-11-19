/**
 * A DOM's book from the trade worker: the account's own exchange and network —
 * on testnet, testnet's book, at its own prices — for a DOM the Trade panel
 * opened for an account (its DOM button). The levels only: the worker reads no
 * testnet trades, so Bought, Sold and Volume stay empty.
 */
import { createEffect, createMemo, createRoot } from 'solid-js';
import { Flow } from '../lib/orderflow';
import { coinOfMarket, follow, placeOf, resume, trade } from './client';
import './trade.css';

let n = 0;

export function accountFlow(market: string, accountId: string): Flow {
  return new Flow(market, (flow) =>
    createRoot((dispose) => {
      resume();
      const owner = `dom-book:${++n}`;
      const account = () => trade.accounts().find((a) => a.id === accountId);
      const coin = createMemo(() => {
        const a = account();
        return a ? coinOfMarket(market, trade.markets()[placeOf(a)]) : null;
      });
      createEffect(() => {
        const a = account();
        const c = coin();
        follow(owner, a && c ? { place: placeOf(a), coins: [c], ladders: [c] } : null);
      });
      createEffect(() => {
        const a = account();
        const c = coin();
        const d = a && c ? trade.depths()[placeOf(a)]?.[c] : undefined;
        if (d) flow.feedBook(d.bids, d.asks);
      });
      return () => {
        follow(owner, null);
        dispose();
      };
    }),
  );
}
