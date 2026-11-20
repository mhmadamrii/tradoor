/**
 * The chart's order system lines, acted on (ChartPanel): a TP or an SL dragged
 * out of the entry line, and a line let go somewhere. Loaded the first time
 * one is, so the chart's start-up code carries none of it.
 */
import { toast } from '../lib/toasts';
import { moveDraft } from './chart-live';
import { exits, move, trade } from './client';

type Style = Record<string, string | number | boolean>;
type Ghost = { side: 'tp' | 'sl'; y: number; text: string } | null;

/** The dragged line's words: its price, what the position makes or loses there, and that on its margin. */
const words = (side: 'tp' | 'sl', px: number | null, s: Style): string => {
  if (!px) return side.toUpperCase();
  const pnl = (px - Number(s.entry)) * Number(s.size);
  const sign = pnl >= 0 ? '+' : '−';
  const margin = Number(s.margin);
  const roe = margin > 0 ? ` (${sign}${Math.abs((pnl / margin) * 100).toFixed(2)}%)` : '';
  return `${side.toUpperCase()} ${px.toPrecision(6)} · ${sign}$${Math.abs(pnl).toLocaleString('en-US', { maximumFractionDigits: 2 })}${roe}`;
};

const said = (coin: unknown, what: string, no: string | null, at: number) =>
  toast(no ? { tone: 'warn', title: `${coin} not changed`, body: no } : { tone: 'info', title: `${coin} ${what} set`, body: `at ${at.toPrecision(6)}` });

/** A take profit or a stop drawn out of the entry line while the pointer is down, set where it is let go. */
export function dragExit(o: { side: 'tp' | 'sl'; from: number; style: Style; top: number; priceAt(y: number): Promise<number | null>; show(g: Ghost | ((g: Ghost) => Ghost)): void; done(): void }): void {
  const s = o.style;
  const mark = Number(s.mark);
  o.show({ side: o.side, y: o.from, text: words(o.side, null, s) });
  let asked = 0;
  const move = (m: PointerEvent) => {
    const y = m.clientY - o.top;
    o.show((g) => g && { ...g, y });
    const n = ++asked;
    void o.priceAt(y).then((p) => n === asked && o.show((g) => g && { ...g, text: words(o.side, p, s) }));
  };
  const up = async (u: PointerEvent) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    const y = u.clientY - o.top;
    const at = await o.priceAt(y);
    o.show(null);
    o.done();
    if (!at || Math.abs(y - o.from) < 4) return;
    // A take profit goes where the position gains, a stop where it loses.
    const gains = s.long ? at > mark : at < mark;
    const tp = o.side === 'tp';
    if (tp !== gains) return void toast({ tone: 'warn', title: `Not a ${tp ? 'take profit' : 'stop'} there`, body: `A ${s.long ? 'long' : 'short'}'s ${tp ? 'take profit' : 'stop'} goes ${tp === !!s.long ? 'above' : 'below'} the price` });
    said(s.coin, tp ? 'take profit' : 'stop', await exits(String(s.account), String(s.coin), tp ? at : null, tp ? null : at), at);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/**
 * A line let go somewhere: the entry dragged sets a take profit on the side the
 * position gains and a stop on the side it loses, from the mark; an order is
 * moved. The caller draws the lines afresh after, so a refusal leaves them be.
 */
export async function dropLine(s: Style | undefined, at: number | undefined): Promise<void> {
  if (!s || !s.live || !(at && at > 0)) return;
  // A preview: its form's field moves; nothing is sent.
  if (s.live === 'draft') return s.field ? moveDraft(String(s.draft), String(s.field), at) : undefined;
  const account = String(s.account);
  if (s.live === 'entry') {
    const gain = s.long ? at > Number(s.mark) : at < Number(s.mark);
    return said(s.coin, gain ? 'take profit' : 'stop', await exits(account, String(s.coin), gain ? at : null, gain ? null : at), at);
  }
  const order = trade.states()[account]?.orders.find((x) => String(x.oid) === String(s.oid));
  const no = order ? await move(account, order, at) : 'That order is gone';
  if (no) toast({ tone: 'warn', title: `${s.coin} not changed`, body: no }, 10_000);
}
