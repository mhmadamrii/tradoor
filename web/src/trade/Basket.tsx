/**
 * Baskets: several coins at once, long and short, each with its share of one
 * size in dollars and each on any account — opened together at the market,
 * closed together, kept by name in this browser. And hedging: a position
 * covered by the other side of another coin, as a share of its value.
 */
import { createEffect, createSignal, For, Index, onCleanup, Show } from 'solid-js';
import { setDraft } from './chart-live';
import { readJson, writePref } from '../lib/prefs';
import { toast } from '../lib/toasts';
import { order, placeOf, trade } from './client';
import { coins, usd } from './format';
import type { AccountRef, Position } from './protocol';

interface Leg {
  account: string;
  coin: string;
  long: boolean;
  /** Its share of the size, in per cent. */
  weight: number;
}

interface Saved {
  name: string;
  legs: Leg[];
}

/** A leg as an order: its account, coin, side and size in coins. */
interface Sized {
  account: string;
  coin: string;
  buy: boolean;
  size: number;
}

const KEY = 'tradeBaskets';
const savedBaskets = (): Saved[] => {
  const v = readJson(KEY);
  return Array.isArray(v) ? (v as Saved[]).filter((b) => b && typeof b.name === 'string' && Array.isArray(b.legs)) : [];
};

const mid = (a: AccountRef, coin: string) => {
  const b = trade.books()[placeOf(a)]?.[coin];
  return b && b.bid > 0 && b.ask > 0 ? (b.bid + b.ask) / 2 : 0;
};

export function Basket(props: { account: AccountRef; coin: string }) {
  const trading = () => trade.accounts().filter((a) => a.mode === 'trade');
  const [legs, setLegs] = createSignal<Leg[]>([{ account: props.account.id, coin: props.coin, long: true, weight: 50 }, { account: props.account.id, coin: props.coin === 'BTC' ? 'ETH' : 'BTC', long: false, weight: 50 }]);
  const [size, setSize] = createSignal('1000');
  const [name, setName] = createSignal('');
  const [saved, setSaved] = createSignal(savedBaskets());
  const [busy, setBusy] = createSignal(false);
  const set = (i: number, patch: Partial<Leg>) => setLegs(legs().map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = () => legs().reduce((s, l) => s + l.weight, 0);
  const acct = (id: string) => trade.accounts().find((a) => a.id === id);
  // Each leg previewed on its own coin's chart, at today's price: what opening the basket would take on.
  let shown: string[] = [];
  createEffect(() => {
    const money = Number(size());
    const keys: string[] = [];
    legs().forEach((l, i) => {
      const a = acct(l.account);
      const px = a ? mid(a, l.coin) : 0;
      if (!a || !(px > 0) || !(money > 0) || !(total() > 0)) return;
      const worth = (money * l.weight) / total();
      const key = `basket:${i}`;
      keys.push(key);
      setDraft(key, { account: a, coin: l.coin, lines: [{ price: px, label: `Basket · ${l.long ? 'Long' : 'Short'} ${coins(worth / px, 4)} ${l.coin} · ${usd(worth)}`, tone: l.long ? 'buy' : 'sell' }] });
    });
    for (const k of shown) if (!keys.includes(k)) setDraft(k, null);
    shown = keys;
  });
  onCleanup(() => shown.forEach((k) => setDraft(k, null)));
  const coinsOf = (id: string) => {
    const a = acct(id);
    return a ? [...(trade.markets()[placeOf(a)]?.keys() ?? [])].sort() : [];
  };

  /** What the basket opened here, leg by leg: closing undoes that and no more. */
  const [opened, setOpened] = createSignal<Sized[]>([]);
  /** Each leg's size for the basket's dollars at today's prices. */
  const sized = (errors: string[]): Sized[] => {
    const money = Number(size());
    return legs().flatMap((l) => {
      const a = acct(l.account);
      const px = a ? mid(a, l.coin) : 0;
      if (!a || !(px > 0)) return (errors.push(`${l.coin}: no price yet`), []);
      return [{ account: a.id, coin: l.coin, buy: l.long, size: (money * l.weight) / total() / px }];
    });
  };

  const open = async () => {
    const money = Number(size());
    if (!(money > 0)) return toast({ tone: 'warn', title: 'No size', body: 'The basket’s size, in dollars' });
    setBusy(true);
    const errors: string[] = [];
    const done: Sized[] = [];
    // Every leg at once: a basket is opened together, not one coin after another.
    await Promise.all(
      sized(errors).map(async (l) => {
        const no = await order(l.account, { coin: l.coin, buy: l.buy, size: l.size, kind: 'market' });
        if (no) errors.push(`${l.coin}: ${no}`);
        else done.push(l);
      }),
    );
    setOpened([...opened(), ...done]);
    setBusy(false);
    toast({ tone: errors.length ? 'warn' : 'info', title: errors.length ? 'Basket opened in part' : 'Basket opened', body: errors.length ? errors.join('; ') : `${legs().length} legs, ${usd(money)}` });
  };

  // Not the coins' whole positions (it closed a long the basket never opened): what it opened,
  // reduce-only so it never turns a leg around. Opened before a reload, it is the basket's dollars now.
  const close = async () => {
    setBusy(true);
    const errors: string[] = [];
    const list = opened().length ? opened() : sized(errors);
    await Promise.all(
      list.map(async (l) => {
        const no = await order(l.account, { coin: l.coin, buy: !l.buy, size: l.size, kind: 'market', reduceOnly: true });
        if (no) errors.push(`${l.coin}: ${no}`);
      }),
    );
    setOpened([]);
    setBusy(false);
    toast({ tone: errors.length ? 'warn' : 'info', title: errors.length ? 'Closed in part' : 'Basket closed', body: errors.join('; ') || 'Each leg at the market, as much as the basket opened' });
  };

  const save = () => {
    const n = name().trim();
    if (!n) return;
    const list = [...saved().filter((b) => b.name !== n), { name: n, legs: legs() }];
    writePref(KEY, JSON.stringify(list));
    setSaved(list);
    toast({ tone: 'info', title: 'Basket kept', body: n }, 3000);
  };

  return (
    <div class="om-basket">
      <Show when={saved().length}>
        <div class="om-shares">
          <span class="dim">Kept</span>
          <For each={saved()}>
            {(b) => (
              <button class="tb" onClick={() => (setLegs(b.legs), setName(b.name))}>
                {b.name}
              </button>
            )}
          </For>
        </div>
      </Show>
      {/* By place: an edit makes a new leg, which <For> took for a new row, its inputs made anew (focus lost at each key). */}
      <Index each={legs()}>
        {(l, i) => (
          <div class="om-leg">
            <select value={l().long ? 'long' : 'short'} onChange={(e) => set(i, { long: e.currentTarget.value === 'long' })} classList={{ bull: l().long, bear: !l().long }}>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
            <select value={l().coin} onChange={(e) => set(i, { coin: e.currentTarget.value })}>
              <For each={coinsOf(l().account)}>{(c) => <option value={c}>{c}</option>}</For>
            </select>
            <input class="om-input num" type="number" min="1" value={l().weight} onInput={(e) => set(i, { weight: Math.max(0, Number(e.currentTarget.value) || 0) })} />
            <span class="dim">%</span>
            <Show when={trading().length > 1}>
              <select value={l().account} onChange={(e) => set(i, { account: e.currentTarget.value })} data-tip="The account this leg trades on">
                <For each={trading()}>{(a) => <option value={a.id}>{a.label}</option>}</For>
              </select>
            </Show>
            <button class="tb" onClick={() => setLegs(legs().filter((_, j) => j !== i))} disabled={legs().length <= 1}>
              ✕
            </button>
          </div>
        )}
      </Index>
      <div class="om-shares">
        <button class="om-when-add" onClick={() => setLegs([...legs(), { account: props.account.id, coin: props.coin, long: true, weight: 10 }])}>
          + A leg
        </button>
        <span class="spacer" />
        <span class="dim num" classList={{ warn: Math.abs(total() - 100) > 0.01 }}>
          {total()}% {Math.abs(total() - 100) > 0.01 ? '(shared out as the weights stand)' : ''}
        </span>
      </div>
      <label class="om-field">
        <span>Size</span>
        <input class="om-input num" inputmode="decimal" value={size()} onInput={(e) => setSize(e.currentTarget.value)} />
        <span class="dim">USD in all</span>
      </label>
      <div class="om-sides">
        <button class="om-buy" disabled={busy() || !trading().length} onClick={() => void open()}>
          Open the basket
        </button>
        <button class="om-sell" disabled={busy() || !trading().length} onClick={() => void close()}>
          Close the basket
        </button>
      </div>
      <div class="om-row">
        <input class="om-input" placeholder="Name it to keep it" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        <button class="dbtn" disabled={!name().trim()} onClick={save}>
          Keep
        </button>
      </div>
    </div>
  );
}

/** A position covered by the other side of another coin, as a share of its value. */
export function Hedge(props: { account: AccountRef; position: Position }) {
  const coins = () => [...(trade.markets()[placeOf(props.account)]?.keys() ?? [])].filter((c) => c !== props.position.coin).sort((a, b) => (a === 'BTC' ? -1 : b === 'BTC' ? 1 : a === 'ETH' ? -1 : b === 'ETH' ? 1 : a.localeCompare(b)));
  const [coin, setCoin] = createSignal(props.position.coin === 'BTC' ? 'ETH' : 'BTC');
  const [share, setShare] = createSignal(100);
  const [busy, setBusy] = createSignal(false);
  const worth = () => Math.abs(props.position.value) * (share() / 100);
  const go = async () => {
    const px = mid(props.account, coin());
    if (!(px > 0)) return toast({ tone: 'warn', title: 'No price yet', body: coin() });
    setBusy(true);
    const no = await order(props.account.id, { coin: coin(), buy: props.position.size < 0, size: worth() / px, kind: 'market' });
    setBusy(false);
    toast({ tone: no ? 'warn' : 'info', title: no ? 'Hedge refused' : 'Hedged', body: no ?? `${props.position.size < 0 ? 'Long' : 'Short'} ${usd(worth())} of ${coin()} against the ${props.position.coin} ${props.position.size > 0 ? 'long' : 'short'}` });
  };
  return (
    <div class="om-hedge">
      <span class="dim">Hedge with</span>
      <select value={coin()} onChange={(e) => setCoin(e.currentTarget.value)}>
        <For each={coins()}>{(c) => <option value={c}>{c}</option>}</For>
      </select>
      <input type="range" min="10" max="150" step="5" value={share()} onInput={(e) => setShare(Number(e.currentTarget.value))} data-tip="The hedge's size as a share of the position's value" />
      <span class="num">{share()}%</span>
      <span class="num dim">{usd(worth())}</span>
      <button class="dbtn" disabled={busy()} onClick={() => void go()}>
        {props.position.size > 0 ? 'Short' : 'Long'} it
      </button>
    </div>
  );
}
