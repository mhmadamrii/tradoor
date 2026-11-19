/**
 * The order system on the charts. On a chart of an account's own exchange and
 * coin (an order on Lighter's BTC shows on Lighter's BTC chart, not another
 * exchange's):
 *
 * - each resting order a dashed line across the chart, its side's colour,
 *   named at the left and priced at the right (as levels stay in sight
 *   however the chart is scrolled); a stop, take profit or stop loss dotted;
 * - the position a solid line at its entry, with what it is up or down, and
 *   its liquidation price;
 * - its recent fills as arrows, under the bar for a buy, over it for a sell;
 * - the position's entry, its orders, take profit and stop as lines a drag
 *   moves: the entry dragged sets a take profit or a stop where it is let go
 *   (ChartPanel's `liveDrag`), an order dragged is moved there;
 * - each algorithm running a line over its time — a TWAP from its start to
 *   its end — at what it has filled at so far, with how far it has got.
 *
 * Testnet's prices are its own: on a mainnet chart its lines sit at
 * testnet's prices, and say "testnet". Built here, loaded with the order
 * system; the chart only takes the shapes (app/ui `liveShapes`).
 */
import { createEffect, createRoot, createSignal } from 'solid-js';
import { setLiveShapes, type ShownTrades } from '../app/ui';
import { catalog } from '../lib/api';
import { liqOf, placeOf, trade } from './client';
import { coins, pct, price, usd } from './format';
import { isExit, type AccountRef, type AlgoState, type Fill } from './protocol';

type Shape = ShownTrades['parts'][number];

/** How far a line still open runs past now. */
const AHEAD = 30 * 60_000;
/** Fills marked: the last ones, of the last day. */
const FILLS = 40;
const DAY = 86_400_000;

/**
 * What a ticket would place, before it is sent: its entry, take profit and
 * stop, a scale's orders, a basket's legs, drawn dashed as previews on the
 * coin's chart. A line dragged moves the field it came from (`move`).
 */
export type DraftLine = { price: number; label: string; tone: 'entry' | 'tp' | 'sl' | 'buy' | 'sell'; field?: string };
export type Draft = { account: AccountRef; coin: string; lines: DraftLine[]; move?: (field: string, price: number) => void };
const [drafts, setDrafts] = createSignal<Record<string, Draft>>({});

/** A form's preview, by the form's own key; null takes it away. */
export function setDraft(key: string, d: Draft | null): void {
  const all = { ...drafts() };
  if (d && d.lines.length) all[key] = d;
  else if (key in all) delete all[key];
  else return;
  setDrafts(all);
}

/** A preview line let go somewhere: its form's field takes the price. */
export function moveDraft(key: string, field: string, price: number): void {
  drafts()[key]?.move?.(field, price);
}

let started = false;

export function startChartLive(): void {
  if (started) return;
  started = true;
  createRoot(() => {
    // The catalog's markets of each exchange the order system trades, by coin: where its shapes go.
    const [index, setIndex] = createSignal(new Map<string, string[]>());
    void catalog().then((c) => {
      const m = new Map<string, string[]>();
      for (const p of c.products) {
        if (p.venue !== 'hyperliquid-perp' && p.venue !== 'lighter-perp') continue;
        for (const coin of new Set([p.base, `k${p.base}`])) m.set(`${p.venue}|${coin}`, [...(m.get(`${p.venue}|${coin}`) ?? []), p.market]);
      }
      setIndex(m);
    });
    // A clock for what moves with time: lines running to now, a TWAP's next slice.
    const [now, setNow] = createSignal(Date.now());
    setInterval(() => setNow(Date.now()), 10_000);
    let pending: ReturnType<typeof setTimeout> | undefined;
    createEffect(() => {
      // Read here so the effect runs again on any of them.
      const inputs = [index(), now(), trade.accounts(), trade.states(), trade.algos(), drafts()];
      void inputs;
      // A position's mark moves many times a second: drawn again at most four times a second.
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        setLiveShapes(build(index()));
      }, 250);
    });
  });
}

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** The labels' backing: the page's own colour, so a label reads over the candles. */
let back = '';

/** A level across the chart: named and priced at its right end, by the price axis. */
const level = (at: number, label: string, color: string, dash: 'solid' | 'dashed' | 'dotted', width = 1): Shape => ({
  kind: 'horizontal',
  points: [{ time: Date.now(), price: at }],
  label,
  style: { color, width, dash, textColor: color, priceLabels: true, labelRight: true, ...(back ? { textBg: back } : {}) },
});

/** A line over a time, named at its middle: a TWAP from its start to its end. */
const span = (from: number, to: number, at: number, label: string, color: string, dash: 'solid' | 'dashed' | 'dotted', width = 1): Shape => ({
  kind: 'trendline',
  points: [
    { time: from, price: at },
    { time: to, price: at },
  ],
  label,
  style: { color, width, dash, textColor: color, ...(back ? { textBg: back } : {}) },
});

/** A fill: an arrow under its bar for a buy, over it for a sell (the engine puts it at the bar's low or high, `atBar`). */
const arrow = (time: number, at: number, buy: boolean, color: string): Shape => ({
  kind: buy ? 'markup' : 'markdown',
  points: [{ time, price: at }],
  label: null,
  style: { color, atBar: true },
});

/** A line a drag acts on: what it is, for whom, and what ChartPanel does when it is let go. */
const handle = (s: Shape, live: Record<string, string | number>): Shape => ({ ...s, style: { ...s.style, ...live } });

const live = (a: AlgoState) => a.status === 'running' || a.status === 'paused';
const KIND: Record<string, string> = { chase: 'Chase', twap: 'TWAP', scale: 'Scale', swarm: 'Swarm', when: 'When' };

function build(index: Map<string, string[]>): Record<string, Shape[]> {
  const out: Record<string, Shape[]> = {};
  if (!index.size) return out;
  const now = Date.now();
  const bull = css('--bull', '#089981');
  const bear = css('--bear', '#f23645');
  const warn = css('--warn', '#ffc247');
  const accent = css('--primary', '#aafd35');
  const page = css('--bg', '');
  back = /^#[0-9a-f]{6}$/i.test(page) ? `${page}d9` : '';
  const accounts = trade.accounts();
  const algos = trade.algos().filter(live);
  for (const a of accounts) {
    const s = trade.states()[a.id];
    if (!s) continue;
    const venue = `${a.venue}-perp`;
    // The account named only where another on the same exchange could be meant.
    const who = accounts.filter((x) => x.venue === a.venue).length > 1 ? ` · ${a.label}` : '';
    const net = a.network === 'testnet' ? ' · testnet' : '';
    const mine = algos.filter((x) => x.spec.account === a.id);
    const recent = s.fills.filter((f) => now - f.time < DAY);
    const coinSet = new Set([...s.positions.filter((p) => p.size !== 0).map((p) => p.coin), ...s.orders.map((o) => o.coin), ...recent.slice(0, FILLS).map((f) => f.coin), ...mine.map((x) => x.spec.coin)]);
    for (const coin of coinSet) {
      const markets = index.get(`${venue}|${coin}`);
      if (!markets) continue;
      const list = shapesOf(a, coin, s, recent, mine, { now, bull, bear, warn, accent, who, net });
      for (const m of markets) (out[m] ??= []).push(...list);
    }
  }
  // The previews, dashed and named so: nothing of them is on the exchange yet.
  const tone = { entry: accent, tp: bull, sl: bear, buy: bull, sell: bear };
  for (const [key, d] of Object.entries(drafts())) {
    const markets = index.get(`${d.account.venue}-perp|${d.coin}`);
    if (!markets) continue;
    const list = d.lines.filter((l) => l.price > 0).map((l) => handle(level(l.price, l.label ? `Preview · ${l.label}` : '', tone[l.tone], 'dashed', 1), { live: 'draft', draft: key, field: l.field ?? '' }));
    for (const m of markets) (out[m] ??= []).push(...list);
  }
  return out;
}

function shapesOf(
  a: AccountRef,
  coin: string,
  s: NonNullable<ReturnType<typeof trade.states>[string]>,
  recent: Fill[],
  algos: AlgoState[],
  c: { now: number; bull: string; bear: string; warn: string; accent: string; who: string; net: string },
): Shape[] {
  const out: Shape[] = [];
  const dec = trade.markets()[placeOf(a)]?.get(coin)?.szDecimals ?? 4;
  const ahead = c.now + AHEAD;
  // Fills first, so the lines are drawn over them.
  for (const f of recent.filter((x) => x.coin === coin).slice(0, FILLS)) out.push(arrow(f.time, f.price, f.buy, f.buy ? c.bull : c.bear));

  const p = s.positions.find((x) => x.coin === coin && x.size !== 0);
  if (p) {
    const tone = p.size > 0 ? c.bull : c.bear;
    // The mark, from what the position is up or down: the account's own exchange's price, not the chart's.
    const mark = p.entry + p.pnl / p.size;
    // Only what matters at a glance: the side, the size, how it stands. The price is on the axis.
    out.push(handle(level(p.entry, `${p.size > 0 ? 'Long' : 'Short'} ${coins(p.size, dec)} · ${usd(p.pnl, true)} (${pct(p.roe)})${c.who}`, tone, 'dashed', 1.5), { live: 'entry', account: a.id, coin, mark, long: p.size > 0 ? 1 : 0, entry: p.entry, size: p.size, margin: p.margin }));
    const liq = liqOf(a, p);
    // Where it is anywhere near: a line far off the chart only squeezes its scale.
    if (liq && liq > 0 && Math.abs(liq - p.entry) / p.entry < 0.5) out.push(level(liq, `Liq.${p.liquidation ? '' : ' est.'}${c.who}`, c.warn, 'dashed'));
  }

  for (const o of s.orders.filter((x) => x.coin === coin)) {
    const at = o.trigger ?? o.price;
    if (!(at > 0)) continue;
    if (isExit(o) || o.trigger !== null) {
      const tp = /take profit/i.test(o.kind);
      const label = o.reduceOnly ? `${tp ? 'TP' : 'SL'} ${coins(o.size, dec)}` : `Stop ${o.buy ? 'buy' : 'sell'} ${coins(o.size, dec)}`;
      out.push(handle(level(at, `${label}${c.who}`, o.reduceOnly ? (tp ? c.bull : c.bear) : o.buy ? c.bull : c.bear, 'dotted'), { live: 'order', account: a.id, coin, oid: String(o.oid) }));
    } else out.push(handle(level(at, `${o.buy ? 'Buy' : 'Sell'} ${coins(o.size, dec)}${c.who}`, o.buy ? c.bull : c.bear, 'dashed'), { live: 'order', account: a.id, coin, oid: String(o.oid) }));
  }

  const book = trade.books()[placeOf(a)]?.[coin];
  const mid = book && book.bid > 0 && book.ask > 0 ? (book.bid + book.ask) / 2 : 0;
  for (const x of algos.filter((y) => y.spec.coin === coin)) {
    const sp = x.spec;
    const side = sp.buy ? 'buy' : 'sell';
    const done = `${coins(x.filled, dec)} / ${coins(sp.size, dec)}`;
    if (sp.kind === 'when') {
      // A price it waits for, on this coin: a line at the level.
      for (const k of sp.conditions) if (k.kind === 'price' && k.coin === coin) out.push(level(k.value, `When ${k.above ? 'over' : 'under'}: ${side} ${coins(sp.size, dec)}${c.who}`, c.accent, 'dotted'));
      continue;
    }
    // Where it has got: at what it filled at so far, or where it is working (a chase's price), or the book's middle.
    const working = Number(/\bat ([\d.]+)/.exec(x.detail)?.[1]);
    const at = x.avg > 0 ? x.avg : working > 0 ? working : mid;
    if (!(at > 0)) continue;
    const end = sp.kind === 'twap' ? x.started + sp.minutes * 60_000 : sp.kind === 'chase' && sp.minutes > 0 ? x.started + sp.minutes * 60_000 : ahead;
    const avg = x.avg > 0 ? ` · avg ${price(x.avg)}` : '';
    // Its time on the chart, from its start to its end: how far through it is, where it filled.
    out.push(span(x.started, Math.max(end, c.now), at, `${KIND[sp.kind] ?? sp.kind} ${side} ${done}${avg} · ${x.detail}${c.who}`, c.accent, 'solid', 2));
    if (sp.kind === 'twap' && sp.bounds) {
      out.push(span(x.started, end, sp.bounds.low, `TWAP low ${price(sp.bounds.low)}`, c.accent, 'dotted'));
      out.push(span(x.started, end, sp.bounds.high, `TWAP high ${price(sp.bounds.high)}`, c.accent, 'dotted'));
    }
  }
  return out;
}
