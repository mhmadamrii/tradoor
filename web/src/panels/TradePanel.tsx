/**
 * The order ticket for the panel's market, on the account chosen in its
 * toolbar — any of this browser's accounts, on Hyperliquid or Lighter, testnet
 * for now. Binance's BTC chart trades the account's BTC. Market, limit and stop
 * orders, sized in dollars or coins or by a share of what the account can buy,
 * with reduce-only, post-only, and a take profit and stop that go live once
 * the entry fills.
 *
 * With no account yet, or from the toolbar's Accounts, it shows the accounts:
 * adding one, naming, removing, and how their keys are kept.
 */
import { setOverlay, setSettingsSection } from '../app/ui';
import { session } from '../lib/owner';
import { useDismiss } from '../lib/dismiss';
import { EXCHANGES, ExchangeLogo } from '../lib/exchanges';
import { Icon } from '../lib/icons';
import { setDraft, type DraftLine } from '../trade/chart-live';
import { pickPrice } from '../app/ui';
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { catalog } from '../lib/api';
import { symbolOf } from '../lib/markets';
import { readJson, writePref } from '../lib/prefs';
import { toast } from '../lib/toasts';
import { AccountsView } from '../trade/AccountsView';
import { ALGO_KINDS, AlgoForm, type AlgoKind } from '../trade/AlgoForm';
import { Basket, Hedge } from '../trade/Basket';
import { ConditionsEditor, useConditions } from '../trade/Conditions';
import { coinOfMarket, follow, leverage, order, placeOf, runAlgo, start, trade, unlock } from '../trade/client';
import { coins, pct, price, short, usd } from '../trade/format';
import { fillEstimate } from '../trade/fill-estimate';
import { VENUE_NAME, type AccountRef, type AlgoSpec, type Kind, type OrderRequest } from '../trade/protocol';
import '../trade/trade.css';
import { activate, addPanel, newPanel, tabsOf, type Panel, type TradePanelState } from '../workspace/model';
import { doc, focusPanel, marketOf, setPanelMarket, update } from '../workspace/store';
import { MarketButton } from './common';

/** The account a panel trades with, kept in this browser as the accounts are. */
export function useAccount(panelId: string, onlyTrading = false) {
  const key = `tradePanel:${panelId}`;
  const [chosen, setChosen] = createSignal<string>(String((readJson(key) as { account?: string } | null)?.account ?? ''));
  const pick = (id: string) => (setChosen(id), writePref(key, JSON.stringify({ account: id })));
  const account = createMemo<AccountRef | undefined>(() => {
    const list = trade.accounts();
    return list.find((a) => a.id === chosen()) ?? list.find((a) => a.mode === 'trade') ?? (onlyTrading ? undefined : list[0]);
  });
  return { account, pick, chosen };
}

export default function TradePanel(props: { panel: TradePanelState }) {
  onMount(start);
  const market = () => marketOf(props.panel);
  const { account, pick } = useAccount(props.panel.id);
  return (
    <div class="panelcol tradepanel">
      <div class="toolbar">
        {/* The account's own exchange: its search lists the markets it can trade. */}
        <MarketButton panelId={props.panel.id} market={market()} exchange={account()?.venue} />
        <span class="spacer" />
        <Show when={trade.accounts().length}>
          <AccountSwitcher value={account()} onPick={pick} />
        </Show>
      </div>
      <Show when={trade.ready()} fallback={<p class="empty">Opening the accounts…</p>}>
        <Show
          when={account()}
          fallback={
            <div class="om-start">
              <p>{session() || import.meta.env.DEV ? 'No trading account in this browser yet.' : 'Sign in with Telegram to add a trading account.'}</p>
              <button class="dbtn primary" onClick={() => manageAccounts(!(session() || import.meta.env.DEV))}>
                {session() || import.meta.env.DEV ? 'Add an account' : 'Sign in'}
              </button>
            </div>
          }
        >
          {(a) => <Ticket panel={props.panel} account={a()} market={market()} />}
        </Show>
      </Show>
    </div>
  );
}

/** Settings, open on the trading accounts — or on the account, to sign in first. */
const manageAccounts = (signIn = false) => {
  setSettingsSection(signIn ? 'account' : 'trading');
  setOverlay({ kind: 'settings' });
};

/** The account a ticket trades with: its exchange's mark and its name, and a list of them all by exchange. */
function AccountSwitcher(props: { value: AccountRef | undefined; onPick(id: string): void }) {
  const [open, setOpen] = createSignal(false);
  useDismiss(open, () => setOpen(false));
  const venues = () => (['hyperliquid', 'lighter'] as const).filter((v) => trade.accounts().some((a) => a.venue === v));
  return (
    <span class="om-switch">
      <button class="om-switch-btn" aria-haspopup="listbox" aria-expanded={open()} data-tip="Which account this ticket trades with" onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(!open())}>
        <Show when={props.value}>
          {(a) => (
            <>
              <ExchangeLogo exchange={EXCHANGES[a().venue]} size={15} />
              <span class="om-switch-name">{a().label}</span>
              <Show when={a().network === 'testnet'}>
                <span class="om-testnet">Testnet</span>
              </Show>
            </>
          )}
        </Show>
        <Icon name="chevron" size={10} />
      </button>
      <Show when={open()}>
        <div class="menu om-switch-menu" role="listbox" onPointerDown={(e) => e.stopPropagation()}>
          <For each={venues()}>
            {(v) => (
              <div class="om-switch-group">
                <div class="cap">
                  <ExchangeLogo exchange={EXCHANGES[v]} size={12} />
                  {VENUE_NAME[v]}
                </div>
                <For each={trade.accounts().filter((a) => a.venue === v)}>
                  {(a) => (
                    <button role="option" aria-selected={props.value?.id === a.id} classList={{ cur: props.value?.id === a.id }} onClick={() => (props.onPick(a.id), setOpen(false))}>
                      <span class="grow">{a.label}</span>
                      <span class="dim num">{trade.states()[a.id] ? usd(trade.states()[a.id]!.value) : a.mode === 'watch' ? 'watch' : ''}</span>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
          <hr />
          <button onClick={() => (setOpen(false), manageAccounts())}>Manage accounts…</button>
        </div>
      </Show>
    </span>
  );
}

export function AccountPicker(props: { value: string; onPick: (id: string) => void; all?: boolean }) {
  return (
    <select class="om-pick" data-tip="Which account" value={props.value} onChange={(e) => props.onPick(e.currentTarget.value)}>
      <Show when={props.all}>
        <option value="">All accounts</option>
      </Show>
      <For each={trade.accounts()}>
        {(a) => (
          <option value={a.id}>
            {a.label} · {VENUE_NAME[a.venue]}
            {a.network === 'testnet' ? ' testnet' : ''}
            {a.mode === 'watch' ? ' · watch' : ''}
          </option>
        )}
      </For>
    </select>
  );
}

/** Where the account stands: its exchange, the line to it, and whether it only watches. */
function AccountLine(props: { account: AccountRef }) {
  const a = () => props.account;
  const link = () => trade.links()[placeOf(a())] ?? 'closed';
  return (
    <div class="om-acctline">
      <span class={`om-dot ${link()}`} data-tip={`The line to ${VENUE_NAME[a().venue]}: ${link()}`} />
      <span>{VENUE_NAME[a().venue]}</span>
      <Show when={a().network === 'testnet'}>
        <span class="om-testnet">Testnet</span>
      </Show>
      <span class="num dim">{short(a().owner)}</span>
      <Show when={a().mode === 'watch'}>
        <span class="badge">watch</span>
      </Show>
    </div>
  );
}

export function Unlock() {
  const [pass, setPass] = createSignal('');
  const [error, setError] = createSignal('');
  const go = async () => {
    const no = await unlock(pass());
    setPass('');
    setError(no ?? '');
  };
  return (
    <div class="om-unlock">
      <span>The keys are locked.</span>
      <input class="om-input" type="password" placeholder="Passphrase" value={pass()} onInput={(e) => setPass(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && void go()} />
      <button class="dbtn" onClick={() => void go()}>
        Unlock
      </button>
      <Show when={error()}>
        <span class="warn">{error()}</span>
      </Show>
    </div>
  );
}

type Unit = 'usd' | 'coin';

function Ticket(props: { panel: TradePanelState; account: AccountRef; market: string }) {
  const a = () => props.account;
  const place = () => placeOf(a());
  const known = () => trade.markets()[place()];
  const coin = createMemo(() => coinOfMarket(props.market, known()));
  const owner = `trade:${props.panel.id}`;
  // A market order's book too, for what it would fill at.
  createEffect(() => follow(owner, coin() ? { place: place(), coins: [coin()!], tickets: [{ account: a().id, coin: coin()! }], ladders: marketing() ? [coin()!] : [] } : null));
  // The account's DOM, opened from here as a tab of its own, follows the ticket's coin on the account's exchange.
  createEffect(
    on(coin, (c) => {
      const held = domOf(a().id);
      if (c && held) void venueMarket(a(), c).then((m) => m && marketOf(held) !== m && setPanelMarket(held.id, m));
    }, { defer: true }),
  );
  const openDom = async () => {
    const c = coin();
    if (!c) return;
    const m = await venueMarket(a(), c);
    if (!m) return toast({ tone: 'warn', title: 'No DOM for it', body: `tradoor has no ${VENUE_NAME[a().venue]} ${c} market to draw` });
    const held = domOf(a().id);
    if (held) {
      setPanelMarket(held.id, m);
      update((d) => {
        const tabs = tabsOf(d.root, held.id);
        if (tabs) activate(d, tabs.id, held.id);
      });
      return focusPanel(held.id);
    }
    // Not linked: it stays on the account's exchange whatever the chart beside it shows.
    const panel = newPanel('dom', { link: null, market: m });
    writePref(`domAccount:${panel.id}`, JSON.stringify({ account: a().id, testnet: a().network === 'testnet' }));
    update((d) => addPanel(d, panel, tabsOf(d.root, props.panel.id)?.id ?? null, 'center'));
    focusPanel(panel.id);
  };
  onCleanup(() => follow(owner, null));

  // The ticket's kind — a plain order's, an algorithm's, or the basket — kept in this browser, not in the
  // workspace: what loads first carries none of the order system.
  const algoKey = `tradeKind:${props.panel.id}`;
  const stored = readJson(algoKey);
  const [algo, setAlgo] = createSignal<AlgoKind | null>((ALGO_KINDS.find((k) => k.id === stored)?.id as AlgoKind) ?? null);
  const [kind, setPlain] = createSignal<PlainKind>(PLAIN.includes(stored as PlainKind) ? (stored as PlainKind) : 'limit');
  const [basket, setBasket] = createSignal(stored === 'basket');
  const [hedge, setHedge] = createSignal(false);
  const setKind = (k: PlainKind) => (setAlgo(null), setBasket(false), setPlain(k), writePref(algoKey, JSON.stringify(k)));
  const pickAlgo = (k: AlgoKind) => (setAlgo(k), setBasket(false), writePref(algoKey, JSON.stringify(k)));
  const pickBasket = () => (setAlgo(null), setBasket(true), writePref(algoKey, JSON.stringify('basket')));
  const info = () => (coin() ? known()?.get(coin()!) : undefined);
  /** A price clicked on the chart, to the decimals the coin takes. */
  const picked = (set: (v: string) => void) => pickPrice((p) => set(String(Number(p.toFixed(info()?.pxDecimals ?? 4)))));
  const dec = () => info()?.szDecimals ?? 4;
  const book = () => (coin() ? trade.books()[place()]?.[coin()!] : undefined);
  const mid = () => {
    const b = book();
    return b && b.bid > 0 && b.ask > 0 ? (b.bid + b.ask) / 2 : 0;
  };
  const state = () => trade.states()[a().id];
  const data = () => (coin() ? state()?.assetData[coin()!] : undefined);
  const position = () => state()?.positions.find((p) => p.coin === coin() && p.size !== 0);

  const [unit, setUnit] = createSignal<Unit>('usd');
  const [amount, setAmount] = createSignal('');
  const [limitPx, setLimitPx] = createSignal('');
  const [trigger, setTrigger] = createSignal('');
  const [stopLimit, setStopLimit] = createSignal(false);
  const [reduce, setReduce] = createSignal(false);
  const [post, setPost] = createSignal(false);
  const [ioc, setIoc] = createSignal(false);
  const [exitsOn, setExitsOn] = createSignal(false);
  const [tp, setTp] = createSignal('');
  const [sl, setSl] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [last, setLast] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [levOpen, setLevOpen] = createSignal(false);
  const [levValue, setLevValue] = createSignal(10);
  const [levCross, setLevCross] = createSignal(true);
  const when = useConditions(() => coin() ?? '');
  /** An order or an algorithm held until the ticket's conditions are met, when it has any. */
  const held = (base: { coin: string; buy: boolean; size: number; reduceOnly: boolean }, then: Extract<AlgoSpec, { kind: 'when' }>['then']): AlgoSpec | string | null => {
    const w = when.value();
    if (w === null) return null;
    if (typeof w === 'string') return w;
    return { kind: 'when', account: a().id, ...base, conditions: w.conditions, join: w.join, then };
  };

  /** The price the size is worked out at: the limit's, the stop's, or the middle of the book. */
  const refPrice = () => {
    if (kind() === 'limit' && Number(limitPx()) > 0) return Number(limitPx());
    if (kind() === 'stop' && Number(trigger()) > 0) return stopLimit() && Number(limitPx()) > 0 ? Number(limitPx()) : Number(trigger());
    return mid();
  };
  const size = () => {
    const n = Number(amount());
    if (!(n > 0)) return 0;
    return unit() === 'coin' ? n : refPrice() > 0 ? n / refPrice() : 0;
  };
  const worth = () => size() * refPrice();
  const marketing = () => kind() === 'market' && !algo() && !basket();
  /** What a market order of this size would fill at, each way, from the book's top levels. */
  const estimate = createMemo(() => {
    const c = coin();
    const d = c ? trade.depths()[place()]?.[c] : undefined;
    if (!marketing() || !d || !(size() > 0)) return null;
    const g = trade.guards().slippage;
    const buy = fillEstimate(d.asks, size(), true, g);
    const sell = fillEstimate(d.bids, size(), false, g);
    return buy || sell ? { buy, sell, guard: g } : null;
  });

  /** A share of the margin available, as exchanges count it: 10% of $9,860 at 50× is an order
   *  worth $49,300 that takes $986 of margin; never more than the most a buy can be. */
  const share = (f: number) => {
    const free = state()?.withdrawable ?? 0;
    const px = refPrice();
    const lev = data()?.leverage || 1;
    if (!(free > 0) || !(px > 0)) return;
    const most = data()?.maxBuy ? data()!.maxBuy * px : Infinity;
    const worth = Math.min(free * f * lev, most);
    setAmount(unit() === 'coin' ? String(Number((worth / px).toFixed(dec()))) : String(Math.floor(worth * 100) / 100));
  };

  // A limit's price is set once, when the tab or the coin changes, to the middle of the book, and then
  // left alone: a limit waits at its price, it does not follow the book (the Mid button sets it again).
  let filledFor = '';
  createEffect(() => {
    const at = `${kind()}|${coin() ?? ''}`;
    if (at === filledFor || (kind() !== 'limit' && !(kind() === 'stop' && stopLimit()))) return;
    const m = mid();
    if (!(m > 0)) return;
    filledFor = at;
    setLimitPx(String(Number(m.toPrecision(6))));
  });

  // What the ticket would place, previewed on the coin's chart while it is filled in: its entry,
  // and its take profit and stop with what each makes or loses. A line dragged moves its field.
  const fixPx = (p: number) => String(Number(p.toFixed(info()?.pxDecimals ?? 4)));
  createEffect(() => {
    const c = coin();
    const lines: DraftLine[] = [];
    if (c && !algo() && !basket()) {
      const k = kind();
      const entry = k === 'limit' || (k === 'stop' && stopLimit()) ? Number(limitPx()) : k === 'stop' ? Number(trigger()) : mid();
      const sz = size();
      const what = sz > 0 ? ` ${coins(sz, dec())}` : '';
      if (k === 'limit' && entry > 0) lines.push({ price: entry, label: `Limit${what}`, tone: 'entry', field: 'limit' });
      if (k === 'stop' && Number(trigger()) > 0) lines.push({ price: Number(trigger()), label: `Stop${what}`, tone: 'entry', field: 'trigger' });
      if (k === 'stop' && stopLimit() && Number(limitPx()) > 0) lines.push({ price: Number(limitPx()), label: 'Limit once triggered', tone: 'entry', field: 'limit' });
      // What it makes at the take profit, what it loses at the stop: the size, either way from the entry.
      const at = (px: number, sign: string) => (sz > 0 && entry > 0 ? ` · ${sign}${usd(Math.abs(px - entry) * sz)} (${sign}${((Math.abs(px - entry) / entry) * 100).toFixed(2)}%)` : '');
      if (exitsOn() && !reduce() && Number(tp()) > 0) lines.push({ price: Number(tp()), label: `TP${at(Number(tp()), '+')}`, tone: 'tp', field: 'tp' });
      if (exitsOn() && !reduce() && Number(sl()) > 0) lines.push({ price: Number(sl()), label: `SL${at(Number(sl()), '−')}`, tone: 'sl', field: 'sl' });
    }
    setDraft(`ticket:${props.panel.id}`, c ? { account: a(), coin: c, lines, move: (f, p) => ({ limit: setLimitPx, trigger: setTrigger, tp: setTp, sl: setSl } as Record<string, (v: string) => void>)[f]?.(fixPx(p)) } : null);
  });
  onCleanup(() => setDraft(`ticket:${props.panel.id}`, null));

  const send = async (buy: boolean) => {
    const c = coin();
    const sz = size();
    if (!c) return;
    if (!(sz > 0)) return setLast({ ok: false, text: 'Enter a size' });
    const k: Kind = kind() === 'stop' ? (stopLimit() ? 'stopLimit' : 'stop') : kind();
    const req: Omit<OrderRequest, 'guards'> = {
      coin: c,
      buy,
      size: sz,
      kind: k,
      ...(k === 'limit' || k === 'stopLimit' ? { price: Number(limitPx()) } : {}),
      ...(k === 'stop' || k === 'stopLimit' ? { trigger: Number(trigger()) } : {}),
      tif: k === 'limit' ? (post() ? 'Alo' : ioc() ? 'Ioc' : 'Gtc') : undefined,
      reduceOnly: reduce(),
      ...(exitsOn() && !reduce() && Number(tp()) > 0 ? { tp: Number(tp()) } : {}),
      ...(exitsOn() && !reduce() && Number(sl()) > 0 ? { sl: Number(sl()) } : {}),
    };
    const wrapped = held({ coin: c, buy, size: sz, reduceOnly: reduce() }, { kind: 'order', req });
    if (typeof wrapped === 'string') return setLast({ ok: false, text: wrapped });
    setBusy(true);
    const no = wrapped ? await runAlgo(wrapped) : await order(a().id, req);
    if (wrapped && !no) {
      setBusy(false);
      return setLast({ ok: true, text: 'Held: it goes out once its conditions are met (Positions → Algos)' });
    }
    setBusy(false);
    const done = trade.activity().find((x) => x.account === a().id);
    setLast(no ? { ok: false, text: no } : { ok: true, text: done ? `${done.what}${done.detail ? ` · ${done.detail}` : ''} · ${done.ms} ms` : 'Sent' });
    if (no) toast({ title: 'Order refused', body: no, tone: 'warn' });
  };

  const watching = () => a().mode !== 'trade';
  const locked = () => !watching() && trade.vault().locked;

  return (
    <div class="om-ticket">
      <div class="om-form">
      <AccountLine account={a()} />
      <Show when={locked()}>
        <Unlock />
      </Show>
      <Show when={coin()} fallback={<p class="empty">{known() ? `${VENUE_NAME[a().venue]} has no ${symbolOf(props.market)} perpetual to trade.` : trade.down()[placeOf(a())] ? `${VENUE_NAME[a().venue]}${a().network === 'testnet' ? ' testnet' : ''} is not answering (${trade.down()[placeOf(a())]}). Trying again every 15 seconds…` : `Reading ${VENUE_NAME[a().venue]}'s markets…`}</p>}>
        <div class="om-quote">
          <span class="om-coin">{coin()}-PERP</span>
          <span class="num bull" data-tip="Best bid">
            {price(book()?.bid)}
          </span>
          <span class="num bear" data-tip="Best ask">
            {price(book()?.ask)}
          </span>
          <span class="spacer" />
          <button class="tb" data-tip={`A DOM of ${VENUE_NAME[a().venue]}'s own ${a().network === 'testnet' ? 'testnet ' : ''}book for this coin, in a tab of its own: click a bid to buy, an ask to sell`} onClick={() => void openDom()}>
            DOM
          </button>
          <button class="tb" disabled={watching()} data-tip="Leverage for this coin, and cross or isolated margin" onClick={() => (setLevValue(data()?.leverage || 10), setLevCross(data()?.cross ?? true), setLevOpen(!levOpen()))}>
            {data()?.leverage ? `${data()!.cross ? 'Cross' : 'Isolated'} ${data()!.leverage}×` : 'Leverage'}
          </button>
        </div>
        <Show when={levOpen()}>
          <div class="om-lev">
            <input type="range" min="1" max={info()?.maxLeverage ?? 20} value={levValue()} onInput={(e) => setLevValue(Number(e.currentTarget.value))} />
            <span class="num">{levValue()}×</span>
            <select value={levCross() ? 'cross' : 'isolated'} onChange={(e) => setLevCross(e.currentTarget.value === 'cross')}>
              <option value="cross">Cross</option>
              <option value="isolated">Isolated</option>
            </select>
            <button
              class="dbtn"
              disabled={busy()}
              onClick={async () => {
                setBusy(true);
                const no = await leverage(a().id, coin()!, levValue(), levCross());
                setBusy(false);
                setLast(no ? { ok: false, text: no } : { ok: true, text: `${levCross() ? 'Cross' : 'Isolated'} ${levValue()}×` });
                if (!no) setLevOpen(false);
              }}
            >
              Set
            </button>
          </div>
        </Show>
        <div class="om-seg om-kinds" role="tablist" aria-label="Order kind">
          <For each={['market', 'limit', 'stop'] as const}>
            {(k) => (
              <button role="tab" aria-selected={!algo() && !basket() && kind() === k} classList={{ on: !algo() && !basket() && kind() === k }} onClick={() => setKind(k)}>
                {k === 'market' ? 'Market' : k === 'limit' ? 'Limit' : 'Stop'}
              </button>
            )}
          </For>
          <For each={ALGO_KINDS}>
            {(k) => (
              <button role="tab" aria-selected={algo() === k.id} classList={{ on: algo() === k.id, algo: true }} data-tip={k.tip} onClick={() => pickAlgo(k.id)}>
                {k.label}
              </button>
            )}
          </For>
          <button role="tab" aria-selected={basket()} classList={{ on: basket(), algo: true }} data-tip="Several coins at once, long and short, each with its share of one size" onClick={pickBasket}>
            Basket
          </button>
        </div>
        <Show when={!basket()} fallback={<Basket account={a()} coin={coin()!} />}>
        <Show when={!algo() && kind() === 'stop'}>
          <label class="om-field">
            <span>Trigger</span>
            <input class="om-input num" inputmode="decimal" placeholder={price(mid())} value={trigger()} onInput={(e) => setTrigger(e.currentTarget.value)} {...picked(setTrigger)} data-tip="Type it, or click the chart for a price" />
          </label>
          <label class="om-check">
            <input type="checkbox" checked={stopLimit()} onChange={(e) => setStopLimit(e.currentTarget.checked)} /> A limit once triggered
          </label>
        </Show>
        <Show when={!algo() && (kind() === 'limit' || (kind() === 'stop' && stopLimit()))}>
          <label class="om-field">
            <span>Price</span>
            <input class="om-input num" inputmode="decimal" placeholder="Price" value={limitPx()} onInput={(e) => setLimitPx(e.currentTarget.value)} {...picked(setLimitPx)} data-tip="Type it, or click the chart for a price" />
            <button class="tb" data-tip="The middle of the book" onClick={() => mid() > 0 && setLimitPx(String(Number(mid().toPrecision(6))))}>
              Mid
            </button>
          </label>
        </Show>
        <label class="om-field">
          <span>Size</span>
          <input class="om-input num" inputmode="decimal" placeholder="0" value={amount()} onInput={(e) => setAmount(e.currentTarget.value)} />
          <select value={unit()} onChange={(e) => (setUnit(e.currentTarget.value as Unit), setAmount(''))}>
            <option value="usd">USD</option>
            <option value="coin">{coin()}</option>
          </select>
        </label>
        <div class="om-shares">
          <For each={[0.1, 0.25, 0.5, 1]}>
            {(f) => (
              <button class="tb" data-tip={`${f * 100}% of the margin available, times the leverage`} disabled={!(state()?.withdrawable ?? 0)} onClick={() => share(f)}>
                {f * 100}%
              </button>
            )}
          </For>
          <span class="spacer" />
          <span class="dim num">{size() > 0 ? `${coins(size(), dec())} ${coin()} · ${usd(worth())}${(data()?.leverage ?? 0) > 0 ? ` · margin ${usd(worth() / data()!.leverage)}` : ''}` : ''}</span>
        </div>
        <Show when={estimate()}>
          {(e) => (
            <div class="om-est num" data-tip={`Walked down ${VENUE_NAME[a().venue]}'s ${a().network === 'testnet' ? 'testnet ' : ''}book, level by level, for this size. Past your ${pct(e().guard, false)} slippage guard the rest is cancelled.`}>
              <span class="om-est-k">Est. fill</span>
              <For each={[['Buy', e().buy], ['Sell', e().sell]] as const}>
                {([side, f]) => (
                  <span class="om-est-side" classList={{ warn: !!f && (f.capped || f.filled < 1 || f.slip > 0.0025) }}>
                    <span class={side === 'Buy' ? 'bull' : 'bear'}>{side}</span> {f ? price(f.avg) : '—'}
                    <Show when={f}>
                      {(x) => (
                        <span class="dim">
                          {' '}
                          {side === 'Buy' ? '+' : '−'}
                          {(x().slip * 100).toFixed(2)}%{x().filled < 1 ? ` · ${Math.round(x().filled * 100)}% fills` : ''}
                        </span>
                      )}
                    </Show>
                  </span>
                )}
              </For>
            </div>
          )}
        </Show>
        <div class="om-opts">
          <label class="om-check" data-tip="Only makes the position smaller: never opens or adds">
            <input type="checkbox" checked={reduce()} onChange={(e) => setReduce(e.currentTarget.checked)} /> Reduce only
          </label>
          <Show when={!algo() && kind() === 'limit'}>
            <label class="om-check" data-tip="Rests on the book or is cancelled: never takes, so it pays the maker fee">
              <input type="checkbox" checked={post()} onChange={(e) => (setPost(e.currentTarget.checked), e.currentTarget.checked && setIoc(false))} /> Post only
            </label>
            <label class="om-check" data-tip="Immediate or cancel: what does not fill at once is cancelled">
              <input type="checkbox" checked={ioc()} onChange={(e) => (setIoc(e.currentTarget.checked), e.currentTarget.checked && setPost(false))} /> IOC
            </label>
          </Show>
          <label class="om-check" data-tip="Held until a price, a ratio, a candle or a time says so">
            <input type="checkbox" checked={when.on()} onChange={(e) => when.setOn(e.currentTarget.checked)} /> Only when…
          </label>
          <Show when={!algo() && !reduce()}>
            <label class="om-check" data-tip="A take profit and a stop, live once the entry fills">
              <input type="checkbox" checked={exitsOn()} onChange={(e) => setExitsOn(e.currentTarget.checked)} /> TP / SL
            </label>
          </Show>
        </div>
        <Show when={when.on()}>
          <ConditionsEditor state={when} coins={[...(known()?.keys() ?? [])].sort()} />
        </Show>
        <Show when={!algo() && exitsOn() && !reduce()}>
          <div class="om-exits">
            <label class="om-field">
              <span class="bull">TP</span>
              <input class="om-input num" inputmode="decimal" placeholder="Take profit" value={tp()} onInput={(e) => setTp(e.currentTarget.value)} {...picked(setTp)} />
            </label>
            <label class="om-field">
              <span class="bear">SL</span>
              <input class="om-input num" inputmode="decimal" placeholder="Stop loss" value={sl()} onInput={(e) => setSl(e.currentTarget.value)} {...picked(setSl)} />
            </label>
          </div>
        </Show>
        <Show
          when={algo()}
          fallback={
            <div class="om-sides">
              <button class="om-buy" disabled={busy() || watching() || locked()} onClick={() => void send(true)}>
                Buy / Long
              </button>
              <button class="om-sell" disabled={busy() || watching() || locked()} onClick={() => void send(false)}>
                Sell / Short
              </button>
            </div>
          }
        >
          {(k) => <AlgoForm kind={k()} account={a().id} coin={coin()!} size={size} reduce={reduce} book={book} watching={watching()} locked={locked()} szDecimals={dec()} wrap={(spec) => held({ coin: spec.coin, buy: spec.buy, size: spec.size, reduceOnly: spec.reduceOnly }, { kind: 'algo', spec: spec as Exclude<AlgoSpec, { kind: 'when' }> })} />}
        </Show>
        </Show>
        <Show when={watching()}>
          <p class="dim om-note">Watching only: this account has no key to send orders with.</p>
        </Show>
        <Show when={last()}>{(l) => <p class={`om-note ${l().ok ? 'dim' : 'warn'}`}>{l().ok ? '✓' : '▲'} {l().text}</p>}</Show>
        <Show when={position()}>
          {(p) => (
            <div class="om-pos num">
              <span classList={{ bull: p().size > 0, bear: p().size < 0 }}>{p().size > 0 ? 'Long' : 'Short'}</span> {coins(p().size, dec())} @ {price(p().entry)}
              <span classList={{ bull: p().pnl > 0, bear: p().pnl < 0 }}>
                {usd(p().pnl, true)} ({pct(p().roe)})
              </span>
              <Show when={p().liquidation}>
                <span class="dim">liq {price(p().liquidation)}</span>
              </Show>
              <Show when={!watching()}>
                <span class="spacer" />
                <button class="tb" classList={{ on: hedge() }} data-tip="Cover it with the other side of another coin" onClick={() => setHedge(!hedge())}>
                  Hedge
                </button>
              </Show>
            </div>
          )}
        </Show>
        <Show when={hedge() && !watching() && position()}>{(p) => <Hedge account={a()} position={p()} />}</Show>
      </Show>
      <Show when={state()}>
        {(s) => (
          <dl class="om-summary num">
            <dt>Account</dt>
            <dd>{usd(s().value)}</dd>
            <dt>Margin used</dt>
            <dd>{usd(s().marginUsed)}</dd>
            <dt>Available</dt>
            <dd>{usd(s().withdrawable)}</dd>
          </dl>
        )}
      </Show>
      </div>
    </div>
  );
}

/** The DOM opened for an account, if one still is: kept in this browser, never in the workspace. */
function domOf(account: string): Panel | undefined {
  return Object.values(doc.panels).find((p) => p.type === 'dom' && (readJson(`domAccount:${p.id}`) as { account?: string } | null)?.account === account);
}

/** The account's exchange's own market for a coin, as the catalog names it: the DOM draws that one, not the chart's exchange. */
export async function venueMarket(a: AccountRef, coin: string): Promise<string | null> {
  const venue = `${a.venue}-perp`;
  const plain = coin.replace(/^k(?=[A-Z])/, '');
  const list = (await catalog()).products.filter((p) => p.venue === venue);
  return (list.find((p) => p.base === coin) ?? list.find((p) => p.base.toUpperCase() === plain.toUpperCase()))?.market ?? null;
}

type PlainKind = 'market' | 'limit' | 'stop';
const PLAIN: PlainKind[] = ['market', 'limit', 'stop'];
