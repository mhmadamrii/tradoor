/**
 * Every account's positions, open orders, order history, trades and what
 * tradoor did, a tab each — all accounts together, with a column saying
 * whose, or one chosen in the toolbar. A position closes at the market or
 * halves; its take profit and stop are set in place; an order is cancelled
 * with a click; and the kill switch cancels every order and closes every
 * position of every account that trades.
 */
import { createEffect, createMemo, createResource, createSignal, For, type JSXElement, lazy, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { formatClock, formatDateTime } from '../lib/timezone';
import { readJson, writePref } from '../lib/prefs';
import { toast } from '../lib/toasts';
import { cancel, closePrefs, exits, liqOf, flatten, history, order, placeOf, start, trade } from '../trade/client';
import { coins, pct, price, usd } from '../trade/format';
import { isExit, type AccountRef, type Fill, type OpenOrder, type PastOrder, type Position } from '../trade/protocol';
import '../trade/trade.css';
import type { PositionsPanelState } from '../workspace/model';
import { AlgoList } from '../trade/AlgoForm';
import { AccountPicker, useAccount, venueMarket } from './TradePanel';
import { setPanelMarket, targetChart } from '../workspace/store';
import { pickPrice } from '../app/ui';

/** A coin in a row: a click shows it on the chart last used, as the account's own exchange lists it. */
function Coin(props: { a: AccountRef; coin: string; children?: JSXElement; /** A position's side: a bar before the coin, green long, red short. */ long?: boolean }) {
  const show = async () => {
    const chart = targetChart();
    const m = await venueMarket(props.a, props.coin);
    if (!chart) return toast({ tone: 'warn', title: 'No chart to show it on', body: 'Open a chart panel first' });
    if (!m) return toast({ tone: 'warn', title: `No ${props.coin} chart`, body: `tradoor has no market for ${props.coin} on this exchange` });
    setPanelMarket(chart.id, m);
  };
  return (
    <td class="om-coin" classList={{ 'om-long': props.long === true, 'om-short': props.long === false }} title={props.long === undefined ? undefined : props.long ? 'Long' : 'Short'}>
      <button class="om-coinlink" data-tip={`Show ${props.coin} on the chart`} onClick={() => void show()}>
        {props.coin}
      </button>
      {props.children}
    </td>
  );
}

type Tab = 'positions' | 'orders' | 'history' | 'fills' | 'algos' | 'activity';
const PnlCard = lazy(() => import('../trade/PnlCard').then((m) => ({ default: m.PnlCard })));
const TABS: { id: Tab; label: string }[] = [
  { id: 'positions', label: 'Positions' },
  { id: 'orders', label: 'Orders' },
  { id: 'history', label: 'Order history' },
  { id: 'fills', label: 'Trades' },
  { id: 'algos', label: 'Algos' },
  { id: 'activity', label: 'Activity' },
];

export default function PositionsPanel(props: { panel: PositionsPanelState }) {
  onMount(start);
  // Kept in this browser: what loads first carries none of the order system.
  const tabKey = `positionsTab:${props.panel.id}`;
  const stored = readJson(tabKey) as Tab;
  const [tab, setTab] = createSignal<Tab>(TABS.some((t) => t.id === stored) ? stored : 'positions');
  const pickTab = (t: Tab) => (setTab(t), writePref(tabKey, JSON.stringify(t)));
  const { chosen, pick } = useAccount(props.panel.id);
  const shown = createMemo(() => trade.accounts().filter((a) => !chosen() || a.id === chosen()));
  const many = () => !chosen() && trade.accounts().length > 1;
  const rows = <T,>(get: (a: AccountRef) => T[]) => shown().flatMap((a) => get(a).map((item) => ({ a, item })));
  const positions = createMemo(() => rows((a) => (trade.states()[a.id]?.positions ?? []).filter((p) => p.size !== 0)));
  const orders = createMemo(() => rows((a) => trade.states()[a.id]?.orders ?? []).sort((x, y) => y.item.time - x.item.time));
  const fills = createMemo(() => rows((a) => trade.states()[a.id]?.fills ?? []).sort((x, y) => y.item.time - x.item.time).slice(0, 500));
  const [confirm, setConfirm] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const trading = () => shown().some((a) => a.mode === 'trade');
  createEffect(() => !trading() && setConfirm(false));
  const total = () => shown().reduce((s, a) => s + (trade.states()[a.id]?.value ?? 0), 0);
  const running = () => trade.algos().filter((x) => (x.status === 'running' || x.status === 'paused') && shown().some((a) => a.id === x.spec.account)).length;
  return (
    <div class="panelcol tradepanel">
      <div class="toolbar">
        <For each={TABS}>
          {(t) => (
            <button class="tb" classList={{ on: tab() === t.id }} onClick={() => pickTab(t.id)}>
              {t.label}
              <Show when={t.id === 'positions' && positions().length > 0}>
                <span class="om-n">{positions().length}</span>
              </Show>
              <Show when={t.id === 'orders' && orders().length > 0}>
                <span class="om-n">{orders().length}</span>
              </Show>
              <Show when={t.id === 'algos' && running() > 0}>
                <span class="om-n">{running()}</span>
              </Show>
            </button>
          )}
        </For>
        <span class="spacer" />
        <Show when={trade.accounts().length}>
          <span class="num dim om-total" data-tip="What the accounts shown are worth together">
            {usd(total())}
          </span>
          <AccountPicker all value={chosen()} onPick={pick} />
        </Show>
        <Show when={trading() && (positions().length > 0 || orders().length > 0)}>
          <Show
            when={confirm()}
            fallback={
              <button class="tb om-kill" data-tip={chosen() ? "Cancel this account's orders and close its positions at the market" : 'Cancel every order and close every position, in every account that trades'} onClick={() => setConfirm(true)}>
                Kill switch
              </button>
            }
          >
            <button
              class="tb om-kill on"
              disabled={busy()}
              onClick={async () => {
                setBusy(true);
                const no = await flatten(chosen() || null, null);
                setBusy(false);
                setConfirm(false);
                toast(no ? { tone: 'warn', title: 'Not all closed', body: no } : { tone: 'info', title: 'Kill switch', body: 'Every order cancelled, every position closed' }, no ? 12_000 : 5_000);
              }}
            >
              {chosen() ? 'Cancel all and close all?' : 'Every account: cancel all and close all?'}
            </button>
            <button class="tb" onClick={() => setConfirm(false)}>
              No
            </button>
          </Show>
        </Show>
      </div>
      <Show when={trade.ready()} fallback={<p class="empty">Opening the accounts…</p>}>
        <Show when={trade.accounts().length} fallback={<p class="empty">Add an account in a Trade panel (its Accounts button) to see its positions here.</p>}>
          <div class="om-table">
            <Show when={tab() === 'positions'}>
              <Positions list={positions()} many={many()} />
            </Show>
            <Show when={tab() === 'orders'}>
              <Orders list={orders()} many={many()} />
            </Show>
            <Show when={tab() === 'history'}>
              <History accounts={shown()} many={many()} />
            </Show>
            <Show when={tab() === 'fills'}>
              <Fills list={fills()} many={many()} />
            </Show>
            <Show when={tab() === 'activity'}>
              <Activity accounts={shown()} many={many()} />
            </Show>
            <Show when={tab() === 'algos'}>
              <Show when={trade.algos().some((x) => shown().some((a) => a.id === x.spec.account))} fallback={<p class="empty">Chases, TWAPs, scales and swarms started from a Trade panel show here while they run.</p>}>
                <div class="om-algos-tab">
                  <AlgoList account={chosen() || undefined} all />
                </div>
              </Show>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}

const marketOf = (a: AccountRef, coin: string) => trade.markets()[placeOf(a)]?.get(coin);
const dec = (a: AccountRef, coin: string) => marketOf(a, coin)?.szDecimals ?? 4;
const mark = (a: AccountRef, coin: string) => {
  const b = trade.books()[placeOf(a)]?.[coin];
  return b && b.bid > 0 && b.ask > 0 ? (b.bid + b.ask) / 2 : null;
};

function Who(props: { a: AccountRef; many: boolean }) {
  return (
    <Show when={props.many}>
      <td class="om-who" data-tip={`${props.a.venue} · ${props.a.owner}`}>
        {props.a.label}
      </td>
    </Show>
  );
}

function Positions(props: { list: { a: AccountRef; item: Position }[]; many: boolean }) {
  const byKey = createMemo(() => new Map(props.list.map((r) => [`${r.a.id}|${r.item.coin}`, r])));
  const keys = createMemo(() => [...byKey().keys()]);
  return (
    <Show when={props.list.length} fallback={<p class="empty">No open positions.</p>}>
      <table>
        <thead>
          <tr>
            <Show when={props.many}>
              <th>Account</th>
            </Show>
            <th>Coin</th>
            <th class="num">Size</th>
            <th class="num">Value</th>
            <th class="num">Entry</th>
            <th class="num">Mark</th>
            <th class="num">PnL</th>
            <th class="num">Liq.</th>
            <th class="num">Margin</th>
            <th class="num">TP / SL</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {/* By account and coin, so a new price updates a row in place: an open TP/SL field or Share card stays open. */}
          <For each={keys()}>{(k) => <Show when={byKey().get(k)}>{(r) => <PositionRow a={r().a} p={r().item} many={props.many} />}</Show>}</For>
        </tbody>
      </table>
    </Show>
  );
}

function PositionRow(props: { a: AccountRef; p: Position; many: boolean }) {
  const p = () => props.p;
  const a = () => props.a;
  const trading = () => a().mode === 'trade';
  const exitOrders = () => (trade.states()[a().id]?.orders ?? []).filter((o) => o.coin === p().coin && isExit(o));
  const tpNow = () => exitOrders().find((o) => /take profit/i.test(o.kind))?.trigger ?? null;
  const slNow = () => exitOrders().find((o) => /stop/i.test(o.kind))?.trigger ?? null;
  const [editing, setEditing] = createSignal(false);
  const [tp, setTp] = createSignal('');
  const [sl, setSl] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [card, setCard] = createSignal(false);
  /** The part of it a click asks to close, waiting on a yes; the menu of parts open. */
  const [asking, setAsking] = createSignal<number | null>(null);
  const [parts, setParts] = createSignal(false);
  const want = (f: number) => {
    setParts(false);
    if (closePrefs().confirm) setAsking(f);
    else void close(f);
  };
  const close = async (f: number) => {
    setAsking(null);
    setBusy(true);
    const no = f >= 1 ? await flatten(a().id, p().coin) : await order(a().id, { coin: p().coin, buy: p().size < 0, size: Math.abs(p().size) * f, kind: 'market', reduceOnly: true });
    setBusy(false);
    // Refused, it says so where it was asked: the row alone would look as if nothing happened.
    if (no) toast({ tone: 'warn', title: `${p().coin} not closed`, body: no }, 10_000);
  };
  return (
    <tr>
      <Who a={a()} many={props.many} />
      <Coin a={a()} coin={p().coin} long={p().size > 0}>
        {' '}
        <span class="dim">{p().leverage}×</span>
      </Coin>
      <td class="num" classList={{ bull: p().size > 0, bear: p().size < 0 }}>
        {p().size > 0 ? '' : '−'}
        {coins(p().size, dec(a(), p().coin))}
      </td>
      <td class="num">{usd(p().value)}</td>
      <td class="num">{price(p().entry)}</td>
      <td class="num">{price(mark(a(), p().coin))}</td>
      <td class="num" classList={{ bull: p().pnl > 0, bear: p().pnl < 0 }}>
        {usd(p().pnl, true)} <span class="dim">{pct(p().roe)}</span>
      </td>
      <td class="num om-liq" data-tip={p().liquidation ? 'Liquidation, as the exchange gives it' : 'Liquidation, estimated from the leverage'}>
        {p().liquidation ? '' : '≈ '}
        {price(liqOf(a(), p()))}
      </td>
      <td class="num">
        {usd(p().margin)} <span class="dim">{p().cross ? 'cross' : 'iso'}</span>
      </td>
      <td class="num">
        <Show
          when={editing()}
          fallback={
            <button class="om-cell" disabled={!trading()} data-tip="Set the position's take profit and stop" onClick={() => (setTp(tpNow() ? String(tpNow()) : ''), setSl(slNow() ? String(slNow()) : ''), setEditing(true))}>
              <span class="bull">{price(tpNow())}</span> / <span class="bear">{price(slNow())}</span>
            </button>
          }
        >
          <span class="om-inline">
            <input class="box num" placeholder="TP" data-tip="Type it, or click the chart for a price" value={tp()} onInput={(e) => setTp(e.currentTarget.value)} {...pickPrice((v) => setTp(String(Number(v.toPrecision(6)))))} />
            <input class="box num" placeholder="SL" data-tip="Type it, or click the chart for a price" value={sl()} onInput={(e) => setSl(e.currentTarget.value)} {...pickPrice((v) => setSl(String(Number(v.toPrecision(6)))))} />
            <button
              class="tb"
              disabled={busy()}
              onClick={async () => {
                setBusy(true);
                await exits(a().id, p().coin, Number(tp()) > 0 ? Number(tp()) : null, Number(sl()) > 0 ? Number(sl()) : null);
                setBusy(false);
                setEditing(false);
              }}
            >
              Set
            </button>
            <button class="tb" onClick={() => setEditing(false)}>
              ✕
            </button>
          </span>
        </Show>
      </td>
      <td class="om-acts">
        <button class="tb" data-tip="A picture of the position, to share" onClick={() => setCard(true)}>
          Share
        </button>
        <Show when={card()}>
          <Portal>
            <PnlCard account={a()} position={p()} mark={mark(a(), p().coin)} onClose={() => setCard(false)} />
          </Portal>
        </Show>
        <Show when={trading()}>
          <Show
            when={asking()}
            fallback={
              <span class="om-parts-wrap">
                <button class="tb om-part-btn" classList={{ on: parts() }} disabled={busy()} data-tip="Close part of it at the market" onClick={() => setParts(!parts())}>
                  Close %
                </button>
                <Show when={parts()}>
                  <div class="om-parts" onPointerLeave={() => setParts(false)}>
                    <For each={closePrefs().parts.filter((x) => x < 100)}>{(x) => <button onClick={() => want(x / 100)}>{x}%</button>}</For>
                  </div>
                </Show>
                <button class="tb om-close-btn" disabled={busy()} data-tip="Close at the market, and cancel this coin's orders" onClick={() => want(1)}>
                  Close
                </button>
              </span>
            }
          >
            {(f) => (
              <span class="om-ask">
                <span>
                  {f() >= 1 ? 'Close all' : `Close ${Math.round(f() * 100)}%`} of {p().coin}?
                </span>
                <button class="tb om-yes" disabled={busy()} onClick={() => void close(f())}>
                  Yes
                </button>
                <button class="tb" onClick={() => setAsking(null)}>
                  No
                </button>
              </span>
            )}
          </Show>
        </Show>
      </td>
    </tr>
  );
}

function OrderCells(props: { a: AccountRef; o: OpenOrder }) {
  const o = () => props.o;
  return (
    <>
      <Coin a={props.a} coin={o().coin} />
      <td>
        {o().kind}
        {o().reduceOnly ? <span class="dim"> · reduce</span> : ''}
        {o().tif === 'Alo' ? <span class="dim"> · post</span> : ''}
      </td>
      <td classList={{ bull: o().buy, bear: !o().buy }}>{o().buy ? 'Buy' : 'Sell'}</td>
      <td class="num">{/market/i.test(o().kind) ? 'Market' : price(o().price)}</td>
      <td class="num">{o().trigger ? `${/above/i.test(o().triggerCondition) ? '≥ ' : /below/i.test(o().triggerCondition) ? '≤ ' : ''}${price(o().trigger)}` : '—'}</td>
      <td class="num">{coins(o().origSize || o().size, dec(props.a, o().coin))}</td>
    </>
  );
}

function Orders(props: { list: { a: AccountRef; item: OpenOrder }[]; many: boolean }) {
  const [busy, setBusy] = createSignal(false);
  const cancelAll = async () => {
    setBusy(true);
    const by = new Map<string, { coin: string; oid: number }[]>();
    for (const r of props.list) if (r.a.mode === 'trade') by.set(r.a.id, [...(by.get(r.a.id) ?? []), { coin: r.item.coin, oid: r.item.oid }]);
    const no = (await Promise.all([...by].map(([id, list]) => cancel(id, list)))).filter(Boolean);
    if (no.length) toast({ tone: 'warn', title: 'Not all cancelled', body: no.join('; ') }, 10_000);
    setBusy(false);
  };
  return (
    <Show when={props.list.length} fallback={<p class="empty">No open orders.</p>}>
      <table>
        <thead>
          <tr>
            <th class="num">Time</th>
            <Show when={props.many}>
              <th>Account</th>
            </Show>
            <th>Coin</th>
            <th>Kind</th>
            <th>Side</th>
            <th class="num">Price</th>
            <th class="num">Trigger</th>
            <th class="num">Size</th>
            <th class="num">Filled</th>
            <th class="num">
              <Show when={props.list.some((r) => r.a.mode === 'trade')}>
                <button class="tb" disabled={busy()} data-tip="Cancel every open order shown" onClick={() => void cancelAll()}>
                  Cancel all
                </button>
              </Show>
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.list}>
            {(r) => (
              <tr>
                <td class="num dim">{formatClock(r.item.time)}</td>
                <Who a={r.a} many={props.many} />
                <OrderCells a={r.a} o={r.item} />
                <td class="num dim">{r.item.origSize > 0 ? pct((r.item.origSize - r.item.size) / r.item.origSize, false) : '—'}</td>
                <td class="om-acts">
                  <Show when={r.a.mode === 'trade'}>
                    <button class="tb" data-tip="Cancel this order" onClick={() => void cancel(r.a.id, [{ coin: r.item.coin, oid: r.item.oid }]).then((no) => no && toast({ tone: 'warn', title: 'Not cancelled', body: no }, 10_000))}>
                      Cancel
                    </button>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}

/** Orders no longer open, read from each exchange when the tab opens. */
function History(props: { accounts: AccountRef[]; many: boolean }) {
  const [list, { refetch }] = createResource(
    () => props.accounts.map((a) => a.id).join() || ' ',
    async () => {
      const all = await Promise.all(props.accounts.map(async (a) => (await history(a.id)).map((item) => ({ a, item }))));
      return all.flat().sort((x, y) => y.item.statusTime - x.item.statusTime).slice(0, 1000);
    },
  );
  const statusText = (s: string) => s.replace(/([A-Z])/g, ' $1').replace(/-/g, ' ').toLowerCase();
  return (
    <>
      <div class="om-refresh">
        <button class="tb" onClick={() => void refetch()}>
          Refresh
        </button>
        <span class="dim">{list.loading ? 'Reading…' : `${list()?.length ?? 0} orders`}</span>
        <Show when={props.accounts.some((a) => a.venue === 'lighter' && a.mode === 'watch')}>
          <span class="dim">· a watched Lighter account shows no orders: Lighter shows them to its key only</span>
        </Show>
      </div>
      <Show when={list()?.length} fallback={<p class="empty">{list.loading ? '' : 'No past orders.'}</p>}>
        <table>
          <thead>
            <tr>
              <th class="num">Time</th>
              <Show when={props.many}>
                <th>Account</th>
              </Show>
              <th>Coin</th>
              <th>Kind</th>
              <th>Side</th>
              <th class="num">Price</th>
              <th class="num">Trigger</th>
              <th class="num">Size</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <For each={list()}>
              {(r: { a: AccountRef; item: PastOrder }) => (
                <tr>
                  <td class="num dim">{formatDateTime(r.item.statusTime)}</td>
                  <Who a={r.a} many={props.many} />
                  <OrderCells a={r.a} o={r.item} />
                  <td classList={{ bull: r.item.status === 'filled', warn: /reject|margin|canceled-/i.test(r.item.status) }}>{statusText(r.item.status)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </>
  );
}

function Fills(props: { list: { a: AccountRef; item: Fill }[]; many: boolean }) {
  return (
    <Show when={props.list.length} fallback={<p class="empty">No trades yet.</p>}>
      <table>
        <thead>
          <tr>
            <th class="num">Time</th>
            <Show when={props.many}>
              <th>Account</th>
            </Show>
            <th>Coin</th>
            <th>Direction</th>
            <th class="num">Price</th>
            <th class="num">Size</th>
            <th class="num">Value</th>
            <th class="num">Fee</th>
            <th class="num">Closed PnL</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.list}>
            {(r) => (
              <tr>
                <td class="num dim">{formatDateTime(r.item.time)}</td>
                <Who a={r.a} many={props.many} />
                <Coin a={r.a} coin={r.item.coin} />
                <td classList={{ bull: r.item.buy, bear: !r.item.buy }}>
                  {r.item.dir} <span class="dim">{r.item.crossed ? 'taker' : 'maker'}</span>
                </td>
                <td class="num">{price(r.item.price)}</td>
                <td class="num">{coins(r.item.size, dec(r.a, r.item.coin))}</td>
                <td class="num">{usd(r.item.size * r.item.price)}</td>
                <td class="num dim">{usd(r.item.fee)}</td>
                <td class="num" classList={{ bull: r.item.pnl > 0, bear: r.item.pnl < 0 }}>
                  {r.item.pnl ? usd(r.item.pnl, true) : '—'}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}

function Activity(props: { accounts: AccountRef[]; many: boolean }) {
  const ids = () => new Set(props.accounts.map((a) => a.id));
  const byId = () => new Map(trade.accounts().map((a) => [a.id, a]));
  const list = () => trade.activity().filter((x) => ids().has(x.account));
  return (
    <Show when={list().length} fallback={<p class="empty">Orders sent from tradoor show here, with how long the exchange took to answer.</p>}>
      <table>
        <thead>
          <tr>
            <th class="num">Time</th>
            <Show when={props.many}>
              <th>Account</th>
            </Show>
            <th>What</th>
            <th>Result</th>
            <th class="num">Took</th>
          </tr>
        </thead>
        <tbody>
          <For each={list()}>
            {(x) => (
              <tr>
                <td class="num dim">{formatClock(x.at)}</td>
                <Show when={props.many}>
                  <td class="om-who">{byId().get(x.account)?.label ?? ''}</td>
                </Show>
                <td>{x.what}</td>
                <td classList={{ warn: x.state === 'refused', dim: x.state === 'sent' }}>{x.state === 'sent' ? 'Sent…' : x.state === 'ok' ? x.detail || 'Done' : x.detail}</td>
                <td class="num dim">{x.state === 'sent' || x.late ? '' : `${x.ms} ms`}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}
