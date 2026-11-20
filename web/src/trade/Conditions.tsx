/**
 * "Only when…": the conditions an order or an algorithm waits for, edited in
 * the ticket — a price, one coin in another, a candle's close or volume, a
 * time; up to five, all at once or any.
 */
import { createSignal, For, Index, Show, type Accessor } from 'solid-js';
import { TIMEFRAMES, type Condition, type Timeframe } from './protocol';

type Kind = Condition['kind'];
const KINDS: { id: Kind; label: string }[] = [
  { id: 'price', label: 'Price' },
  { id: 'ratio', label: 'One coin in another' },
  { id: 'close', label: 'A candle closes' },
  { id: 'volume', label: 'A candle’s volume, $' },
  { id: 'time', label: 'At a time' },
];

interface Draft {
  kind: Kind;
  coin: string;
  of: string;
  tf: Timeframe;
  above: boolean;
  value: string;
  at: string;
}

const draft = (coin: string): Draft => ({ kind: 'price', coin, of: 'BTC', tf: '1h', above: true, value: '', at: '' });

function toCondition(d: Draft): Condition | null {
  const v = Number(d.value);
  if (d.kind === 'time') {
    const t = new Date(d.at).getTime();
    return Number.isFinite(t) && t > Date.now() ? { kind: 'time', at: t } : null;
  }
  if (!(v > 0) || !d.coin) return null;
  if (d.kind === 'price') return { kind: 'price', coin: d.coin, above: d.above, value: v };
  if (d.kind === 'ratio') return d.of ? { kind: 'ratio', coin: d.coin, of: d.of, above: d.above, value: v } : null;
  return { kind: d.kind, coin: d.coin, tf: d.tf, above: d.above, value: v };
}

export function useConditions(coin: Accessor<string>) {
  const [on, setOn] = createSignal(false);
  // A row's coin left empty is the ticket's: made before the venue's markets were read, it had none.
  const [rows, setRows] = createSignal<Draft[]>([draft('')]);
  const coinOf = (d: Draft) => d.coin || coin();
  const [join, setJoin] = createSignal<'and' | 'or'>('and');
  /** The conditions when they are on and all complete; null when off; a reason when not complete. */
  const value = (): { conditions: Condition[]; join: 'and' | 'or' } | string | null => {
    if (!on()) return null;
    const list = rows().map((d) => toCondition({ ...d, coin: coinOf(d), of: d.of || coin() }));
    if (list.some((c) => !c)) return 'Fill in every condition, or take it away';
    return { conditions: list as Condition[], join: join() };
  };
  return { on, setOn, rows, setRows, join, setJoin, value, coinOf };
}

export function ConditionsEditor(props: { state: ReturnType<typeof useConditions>; coins: string[] }) {
  const s = props.state;
  const set = (i: number, patch: Partial<Draft>) => s.setRows(s.rows().map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div class="om-when">
      <div class="om-when-head">
        <span>Only when</span>
        <Show when={s.rows().length > 1}>
          <div class="om-seg om-join">
            <button classList={{ on: s.join() === 'and' }} onClick={() => s.setJoin('and')}>
              all
            </button>
            <button classList={{ on: s.join() === 'or' }} onClick={() => s.setJoin('or')}>
              any
            </button>
          </div>
          <span class="dim">of these</span>
        </Show>
      </div>
      {/* By place: each edit makes a new row object, which <For> took for a new row, its inputs made anew (focus lost at each key). */}
      <Index each={s.rows()}>
        {(r, at) => (
          <div class="om-when-row">
            <select value={r().kind} onChange={(e) => set(at, { kind: e.currentTarget.value as Kind })}>
              <For each={KINDS}>{(k) => <option value={k.id}>{k.label}</option>}</For>
            </select>
            <Show
              when={r().kind !== 'time'}
              fallback={<input class="om-input" type="datetime-local" value={r().at} onInput={(e) => set(at, { at: e.currentTarget.value })} />}
            >
              <Show when={r().kind === 'close' || r().kind === 'volume'}>
                <select value={r().tf} onChange={(e) => set(at, { tf: e.currentTarget.value as Timeframe })}>
                  <For each={TIMEFRAMES}>{(tf) => <option value={tf}>{tf}</option>}</For>
                </select>
              </Show>
              <select value={s.coinOf(r())} onChange={(e) => set(at, { coin: e.currentTarget.value })}>
                <For each={props.coins}>{(c) => <option value={c}>{c}</option>}</For>
              </select>
              <Show when={r().kind === 'ratio'}>
                <span class="dim">in</span>
                <select value={r().of} onChange={(e) => set(at, { of: e.currentTarget.value })}>
                  <For each={props.coins}>{(c) => <option value={c}>{c}</option>}</For>
                </select>
              </Show>
              <select value={r().above ? 'above' : 'below'} onChange={(e) => set(at, { above: e.currentTarget.value === 'above' })}>
                <option value="above">over</option>
                <option value="below">under</option>
              </select>
              <input class="om-input num" inputmode="decimal" placeholder={r().kind === 'volume' ? '$' : 'level'} value={r().value} onInput={(e) => set(at, { value: e.currentTarget.value })} />
            </Show>
            <button class="tb" data-tip="Take this condition away" onClick={() => (s.rows().length > 1 ? s.setRows(s.rows().filter((_, j) => j !== at)) : s.setOn(false))}>
              ✕
            </button>
          </div>
        )}
      </Index>
      <Show when={s.rows().length < 5}>
        <button class="om-when-add" onClick={() => s.setRows([...s.rows(), draft(s.rows()[0]?.coin ?? '')])}>
          + Another condition
        </button>
      </Show>
      <p class="dim om-note">Checked while tradoor is open; candles once each closes. The order goes out, held to your guards, the moment they are met.</p>
    </div>
  );
}
