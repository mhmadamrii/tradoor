/**
 * Trading commands against the accounts: the palette's rows for a typed line
 * (what it will do, in words), and doing it — orders, algorithms, closes,
 * cancels, moves, definitions, repeats — on Enter or a bound key.
 */
import { parseMarket } from '../lib/markets';
import { readJson, writePref } from '../lib/prefs';
import { toast } from '../lib/toasts';
import { focusedPanel, marketOf, targetChart } from '../workspace/store';
import { cancel, coinOfMarket, exits, flatten, follow, leverage, move, order, placeOf, runAlgo, start, trade } from './client';
import { aliases, define, expand, read, TRADING_WORDS, type Action, type Ctx } from './commands';
import './trade.css';

const LAST = 'tradeLastAccount';

export function context(): Ctx {
  const focus = focusedPanel() ?? targetChart();
  // The account a line trades on unless it names one: the focused Trade panel's, else one on the
  // exchange the focused panel shows, else the last used. (The first in the list, a Hyperliquid
  // account, took a line typed over a Lighter ticket.)
  const panelAccount = focus?.type === 'trade' ? (readJson(`tradePanel:${focus.id}`) as { account?: string } | null)?.account : undefined;
  const venue = focus ? parseMarket(marketOf(focus))?.venue : undefined;
  const sameVenue = trade.accounts().find((a) => a.mode === 'trade' && `${a.venue}-perp` === venue)?.id;
  return {
    accounts: trade.accounts(),
    defaultAccount: panelAccount || sameVenue || String(readJson(LAST) ?? ''),
    markets: (a) => trade.markets()[placeOf(a)],
    book: (a, coin) => trade.books()[placeOf(a)]?.[coin],
    position: (a, coin) => trade.states()[a.id]?.positions.find((p) => p.coin === coin && p.size !== 0),
    orders: (a) => trade.states()[a.id]?.orders ?? [],
    maxSize: (a, coin, buy) => {
      const d = trade.states()[a.id]?.assetData[coin];
      return d ? (buy ? d.maxBuy : d.maxSell) : 0;
    },
    market: focus ? marketOf(focus) : null,
    coinOf: coinOfMarket,
    guards: trade.guards(),
  };
}

/** Whether a line is the commands': a trading word, or an alias. */
export const isTrading = (line: string) => TRADING_WORDS.test(line) || !!aliases()[line.trim().split(/\s+/)[0]?.toLowerCase() ?? ''];

/** What a line will do, read afresh as prices come in; it follows the coin it names so its price arrives. */
export function preview(line: string): { label: string; error: boolean; run: () => void } | null {
  if (!isTrading(line)) return null;
  start();
  const ctx = context();
  const r = read(line, ctx);
  // The coin it trades, followed while the line is there, for its price — a line waiting on one
  // too, or its price would never come.
  const first = 'actions' in r ? r.actions.find((x) => 'account' in x && ('req' in x || 'spec' in x)) : undefined;
  const want = 'error' in r ? r.want : first && 'account' in first ? { account: first.account, coin: 'req' in first ? first.req.coin : 'spec' in first ? first.spec.coin : null } : undefined;
  if (want?.coin) follow('palette', { place: placeOf(want.account), coins: [want.coin], tickets: [{ account: want.account.id, coin: want.coin }] });
  if ('error' in r) return { label: r.error, error: true, run: () => toast({ title: 'Not done', body: r.error, tone: 'warn' }) };
  return { label: r.label, error: false, run: () => void run(r.actions, r.label) };
}

/** Reads and does a line: from a bound key. */
export async function runLine(line: string): Promise<void> {
  start();
  const r = read(expand(line), context());
  if ('error' in r) return toast({ title: 'Not done', body: r.error, tone: 'warn' });
  await run(r.actions, r.label);
}

async function run(actions: Action[], label: string) {
  follow('palette', null);
  for (const a of actions) {
    const no = await perform(a);
    if (no) return toast({ title: 'Refused', body: no, tone: 'warn' });
  }
  toast({ title: 'Done', body: label, tone: 'info' }, 6000);
}

async function perform(a: Action): Promise<string | null> {
  if ('account' in a) writePref(LAST, JSON.stringify(a.account.id));
  switch (a.kind) {
    case 'order':
      return order(a.account.id, a.req);
    case 'algo':
      return runAlgo(a.spec);
    case 'flatten':
      return flatten(a.account.id, a.coin);
    case 'close':
      return order(a.account.id, { coin: a.coin, buy: a.buy, size: a.size, kind: 'market', reduceOnly: true });
    case 'cancel':
      return cancel(a.account.id, a.orders);
    case 'leverage':
      return leverage(a.account.id, a.coin, a.leverage, a.cross);
    case 'exits':
      return exits(a.account.id, a.coin, a.tp, a.sl);
    case 'move': {
      for (const m of a.moves) {
        const no = await move(a.account.id, m.order, m.price);
        if (no) return no;
      }
      return null;
    }
    case 'alias':
    case 'let':
    case 'bind':
      define(a);
      if (a.kind === 'bind') void import('./hotkeys').then((h) => h.install());
      return null;
    case 'repeat': {
      let left = a.times - 1;
      void runLine(a.line);
      const timer = setInterval(() => {
        if (left-- <= 0) return clearInterval(timer);
        void runLine(a.line);
      }, a.every);
      return null;
    }
  }
}
