/**
 * A strategy traded live: when the strategy tester's run of a chart closes a
 * bar with an order, the same order goes to an account — a long or a short at
 * the market, sized in dollars, turning a position the other way round when
 * there is one; an exit closes the position. Set per market and timeframe, in
 * this browser, as the accounts are; it runs while tradoor and a chart of it
 * are open, and trades a bar once however many charts show it.
 */
import { readJson, writePref } from '../lib/prefs';
import { toast } from '../lib/toasts';
import type { BacktestResult } from '../engine/protocol';
import { coinOfMarket, flatten, order, placeOf, start, trade } from './client';

export interface LiveSettings {
  on: boolean;
  account: string;
  /** Each entry's size, in dollars. */
  usd: number;
}

const key = (where: string) => `strategyLive:${where}`;
/** Bars already traded: two charts of one market and timeframe send one order. */
const done = new Set<string>();

export function liveSettings(where: string): LiveSettings | null {
  const v = readJson(key(where)) as Partial<LiveSettings> | null;
  return v && typeof v.account === 'string' && typeof v.usd === 'number' ? { on: v.on === true, account: v.account, usd: v.usd } : null;
}

export function setLiveSettings(where: string, s: LiveSettings): void {
  writePref(key(where), JSON.stringify(s));
}

/** Waits for the accounts and the account's markets, for a moment at most. */
async function ready(account: string) {
  start();
  for (let i = 0; i < 50; i++) {
    const a = trade.accounts().find((x) => x.id === account);
    if (a && trade.markets()[placeOf(a)]) return a;
    await new Promise((r) => setTimeout(r, 100));
  }
  return trade.accounts().find((x) => x.id === account);
}

/** The order a bar closed with, sent to the account. */
export async function act(v: BacktestResult): Promise<void> {
  if (!v.ok) return;
  const s = liveSettings(`${v.market}|${v.timeframe}`);
  if (!s?.on || !(v.next === 1 || v.next === -1 || v.next === 2)) return;
  const bar = `${v.market}|${v.timeframe}|${v.time[v.time.length - 1]}`;
  if (done.has(bar)) return;
  done.add(bar);
  const a = await ready(s.account);
  if (!a || a.mode !== 'trade') return void toast({ tone: 'warn', title: 'Strategy not traded', body: 'Its account is gone, or only watched: pick another in the tester’s Live.' });
  const coin = coinOfMarket(v.market, trade.markets()[placeOf(a)]);
  if (!coin) return void toast({ tone: 'warn', title: 'Strategy not traded', body: `${a.label} has no market for this chart.` });
  const position = trade.states()[a.id]?.positions.find((p) => p.coin === coin && p.size !== 0);
  let no: string | null;
  let what: string;
  if (v.next === 2) {
    if (!position) return;
    no = await flatten(a.id, coin);
    what = `Closed ${coin}`;
  } else {
    const buy = v.next === 1;
    // Already that way: nothing to add.
    if (position && position.size > 0 === buy) return;
    const book = trade.books()[placeOf(a)]?.[coin];
    const price = book ? (buy ? book.ask : book.bid) : v.close[v.close.length - 1]!;
    const size = s.usd / price + (position ? Math.abs(position.size) : 0);
    no = await order(a.id, { coin, buy, size, kind: 'market' });
    what = `${buy ? 'Long' : 'Short'} ${coin}${position ? ', turned round' : ''}, $${s.usd.toLocaleString('en-US')}`;
  }
  toast({ tone: no ? 'warn' : 'info', title: no ? 'Strategy order refused' : 'Strategy traded', body: no ?? `${what} · ${a.label}` });
}
