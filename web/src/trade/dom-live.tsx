/**
 * The DOM trading for real, as Training's paper account does it
 * (panels/DomTrade): a click on a bid rests a buy there, on an ask a sell; a
 * click on your order cancels it and a drag moves it in place; with a position
 * open, Shift-click a row for its stop and Ctrl-click for its take profit. The
 * bar under the toolbar sizes those clicks and trades at the market.
 *
 * On the DOM's own exchange (Hyperliquid's book trades a Hyperliquid account,
 * Lighter's a Lighter one), so a row's price is a real one. A DOM of the
 * mainnet book trades no testnet account; one the Trade panel opened for an
 * account draws that account's own book — testnet's, on testnet — and trades it.
 */
import { createEffect, createMemo, createSignal, onCleanup, Show, type Accessor } from 'solid-js';
import { parseMarket } from '../lib/markets';
import { readJson, writePref } from '../lib/prefs';
import { toast } from '../lib/toasts';
import type { DomTrade } from '../panels/DomTrade';
import type { Order, Position } from '../training/model';
import { cancel, coinOfMarket, exits, flatten, follow, move, order, placeOf, resume, trade } from './client';
import { coins, price, usd } from './format';
import { isExit, type Venue } from './protocol';
import './trade.css';

const SIZE_KEY = 'domLiveUsd';

export function liveDomTrade(market: Accessor<string>, panelId: string, bound: { account: string; testnet: boolean } | null = null): DomTrade {
  resume();
  const venue = (): Venue | null => {
    const v = parseMarket(market())?.venue;
    return v === 'hyperliquid-perp' ? 'hyperliquid' : v === 'lighter-perp' ? 'lighter' : null;
  };
  // The account it was opened for, on its own exchange; else the first that trades there.
  const account = createMemo(() => trade.accounts().find((a) => a.mode === 'trade' && a.venue === venue() && (bound ? a.id === bound.account : true)));
  const coin = createMemo(() => {
    const a = account();
    return a ? coinOfMarket(market(), trade.markets()[placeOf(a)]) : null;
  });
  const owner = `dom:${panelId}`;
  createEffect(() => {
    const a = account();
    follow(owner, a && coin() ? { place: placeOf(a), coins: [coin()!] } : null);
  });
  onCleanup(() => follow(owner, null));
  const stored = Number(readJson(SIZE_KEY));
  const [size, setSize] = createSignal(Number.isFinite(stored) && stored > 0 ? stored : 100);
  createEffect(() => writePref(SIZE_KEY, String(size())));
  const [busy, setBusy] = createSignal(false);

  const id = () => account()?.id ?? '';
  const state = () => trade.states()[id()];
  const trading = () => !!account() && !!coin();
  // Its rows are the account's own network's prices: mainnet's book, or testnet's where the DOM draws it.
  // A testnet order at a row of mainnet's book would be at the wrong price.
  const clicks = () => trading() && (account()!.network === 'mainnet' || (!!bound?.testnet && account()!.network === 'testnet'));
  const dec = () => (account() && coin() ? (trade.markets()[placeOf(account()!)]?.get(coin()!)?.szDecimals ?? 4) : 4);
  const liveOrders = () => (state()?.orders ?? []).filter((o) => o.coin === coin() && o.trigger === null);
  const pos = () => state()?.positions.find((p) => p.coin === coin() && p.size !== 0);
  const exitAt = (tp: boolean) => (state()?.orders ?? []).find((o) => o.coin === coin() && isExit(o) && (tp ? /take profit/i.test(o.kind) : /stop/i.test(o.kind)))?.trigger ?? null;
  const book = () => (account() && coin() ? trade.books()[placeOf(account()!)]?.[coin()!] : undefined);

  const act = async (run: () => Promise<string | null>) => {
    if (busy()) return;
    setBusy(true);
    const no = await run();
    setBusy(false);
    if (no) toast({ title: 'Order refused', body: no, tone: 'warn' });
  };
  const at = (buy: boolean, px: number) => act(() => order(id(), { coin: coin()!, buy, size: size() / px, kind: 'limit', price: px, tif: 'Gtc' }));
  const atMarket = (buy: boolean) => {
    const b = book();
    const px = b ? (buy ? b.ask : b.bid) : 0;
    if (px > 0) void act(() => order(id(), { coin: coin()!, buy, size: size() / px, kind: 'market' }));
  };

  return {
    live: clicks,
    orders: (): Order[] => liveOrders().map((o) => ({ id: o.oid, symbol: o.coin, side: o.buy ? 'buy' : 'sell', price: o.price, qty: o.size, tp: null, sl: null, createdAt: o.time })),
    position: (): Position | undefined => {
      const p = pos();
      if (!p) return undefined;
      return { symbol: p.coin, side: p.size > 0 ? 'long' : 'short', qty: Math.abs(p.size), entry: p.entry, leverage: p.leverage, margin: p.margin, tp: exitAt(true), sl: exitAt(false), liquidation: p.liquidation ?? 0, openedAt: 0, realized: 0, fees: 0, funding: p.funding };
    },
    limit: (buy, px) => void at(buy, px),
    cancel: (o) => void act(() => cancel(id(), [{ coin: coin()!, oid: o.id }])),
    move: (o, px) => {
      const live = liveOrders().find((x) => x.oid === o.id);
      if (live) void act(() => move(id(), live, px));
    },
    exit: (kind, px) => {
      if (pos()) void act(() => exits(id(), coin()!, kind === 'tp' ? px : null, kind === 'sl' ? px : null));
    },
    bar: () => (
      <Show when={trading()}>
        <Show
          when={clicks()}
          fallback={
            <div class="dom-trade">
              <span class="om-testnet">Testnet</span>
              <span class="dim" data-tip="Testnet is a market of its own, at its own prices">
                This DOM shows mainnet's book, so it does not trade testnet: the Trade panel's DOM button opens one of testnet's.
              </span>
            </div>
          }
        >
          <div class="dom-trade">
            <span class="dim">{account()!.label}</span>
            <label class="dom-size" data-tip="What a click on the DOM orders, in USD">
              <input class="dinput num" type="number" inputmode="decimal" min="0" value={size()} onInput={(e) => Number(e.currentTarget.value) > 0 && setSize(Number(e.currentTarget.value))} />
              <span class="dim">USD</span>
            </label>
            <button class="tb dom-buy" disabled={busy()} data-tip="Buy at the market" onClick={() => atMarket(true)}>
              Buy
            </button>
            <button class="tb dom-sell" disabled={busy()} data-tip="Sell at the market" onClick={() => atMarket(false)}>
              Sell
            </button>
            <button class="tb" disabled={busy() || !pos()} data-tip="Close the position at the market, and its TP / SL; orders waiting to open stay" onClick={() => void act(() => flatten(id(), coin()))}>
              Flat
            </button>
            <button
              class="tb"
              disabled={busy() || !pos()}
              data-tip="Close it and open as much the other way, at the market"
              onClick={() => {
                const p = pos();
                if (p) void act(() => order(id(), { coin: p.coin, buy: p.size < 0, size: Math.abs(p.size) * 2, kind: 'market' }));
              }}
            >
              Reverse
            </button>
            <button class="tb" disabled={busy() || liveOrders().length === 0} data-tip="Cancel this coin's orders" onClick={() => void act(() => cancel(id(), liveOrders().map((o) => ({ coin: o.coin, oid: o.oid }))))}>
              Cancel all
            </button>
            <span class="spacer" />
            <Show when={pos()} fallback={<span class="dim" data-tip="Click your order to cancel it, drag it to move it; Shift-click a row for the stop, Ctrl-click for the take profit">Click a bid to buy, an ask to sell</span>}>
              {(p) => (
                <span class="num">
                  <span classList={{ bull: p().size > 0, bear: p().size < 0 }}>{p().size > 0 ? 'Long' : 'Short'}</span> {coins(p().size, dec())} {coin()} <span class="dim">@</span> {price(p().entry)}{' '}
                  <span classList={{ bull: p().pnl > 0, bear: p().pnl < 0 }}>{usd(p().pnl, true)}</span>
                </span>
              )}
            </Show>
          </div>
        </Show>
      </Show>
    ),
  };
}
