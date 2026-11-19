/**
 * The ticket's algorithms: chase (and stalk), TWAP, scale (and scale near the
 * price), swarm — their settings, the buy and sell that start them, and the
 * ones running on the account's coin with how far they have got.
 */
import { createEffect, createSignal, For, onCleanup, Show, type Accessor } from 'solid-js';
import { setDraft } from './chart-live';
import { toast } from '../lib/toasts';
import { runAlgo, stopAlgo, trade } from './client';
import { coins, price } from './format';
import type { AlgoSpec, AlgoState, BoundsAction } from './protocol';

export type AlgoKind = 'chase' | 'twap' | 'scale' | 'swarm';
export const ALGO_KINDS: { id: AlgoKind; label: string; tip: string }[] = [
  { id: 'chase', label: 'Chase', tip: 'A post-only order that follows the best price until it fills: maker fees, no chasing by hand' },
  { id: 'twap', label: 'TWAP', tip: 'A size in slices over a time, at the market or each chased first' },
  { id: 'scale', label: 'Scale', tip: 'Orders across a price range, bunched towards one end on request' },
  { id: 'swarm', label: 'Swarm', tip: 'A market order as many slices sent together' },
];

type ChaseMode = 'join' | 'aggressive' | 'back' | 'maintain' | 'trail';

const num = (s: string, d = 0) => (Number.isFinite(Number(s)) && s.trim() !== '' ? Number(s) : d);

function Field(props: { label: string; tip?: string; value: string; set: (v: string) => void; unit?: string; placeholder?: string }) {
  return (
    <label class="om-field" data-tip={props.tip}>
      <span>{props.label}</span>
      <input class="om-input num" inputmode="decimal" placeholder={props.placeholder} value={props.value} onInput={(e) => props.set(e.currentTarget.value)} />
      <Show when={props.unit}>
        <span class="dim">{props.unit}</span>
      </Show>
    </label>
  );
}

export function AlgoForm(props: { kind: AlgoKind; account: string; coin: string; size: Accessor<number>; reduce: Accessor<boolean>; book: Accessor<{ bid: number; ask: number } | undefined>; watching: boolean; locked: boolean; szDecimals: number; wrap?: (spec: AlgoSpec) => AlgoSpec | string | null }) {
  // Chase
  const [mode, setMode] = createSignal<ChaseMode>('join');
  const [back, setBack] = createSignal('1');
  const [distance, setDistance] = createSignal('0.5');
  const [chaseTo, setChaseTo] = createSignal('0.5');
  const [untilFilled, setUntilFilled] = createSignal(false);
  const [limitMin, setLimitMin] = createSignal('0');
  const [onEnd, setOnEnd] = createSignal<'cancel' | 'keep' | 'market'>('cancel');
  // TWAP
  const [minutes, setMinutes] = createSignal('30');
  const [lots, setLots] = createSignal('10');
  const [jitter, setJitter] = createSignal('20');
  const [irregular, setIrregular] = createSignal('0');
  const [sliceHow, setSliceHow] = createSignal<'market' | 'chase'>('market');
  const [timeout, setTimeout_] = createSignal('50');
  const [onTimeout, setOnTimeout] = createSignal<'market' | 'next'>('market');
  const [boundsOn, setBoundsOn] = createSignal(false);
  const [low, setLow] = createSignal('');
  const [high, setHigh] = createSignal('');
  const [boundsAction, setBoundsAction] = createSignal<BoundsAction>('pause');
  // Scale
  const [from, setFrom] = createSignal('');
  const [to, setTo] = createSignal('');
  const [count, setCount] = createSignal('10');
  const [priceSkew, setPriceSkew] = createSignal(0);
  const [sizeSkew, setSizeSkew] = createSignal(0);
  const [postOnly, setPostOnly] = createSignal(true);
  // Swarm
  const [swarmLots, setSwarmLots] = createSignal('5');
  const [swarmIrregular, setSwarmIrregular] = createSignal('30');
  const [busy, setBusy] = createSignal(false);
  const [last, setLast] = createSignal<{ ok: boolean; text: string } | null>(null);

  // A scale's orders previewed on the chart as it is set up, spread and sized as it will place them
  // (algos.ts `make`); its two ends drag to move the range.
  const draftKey = `scale:${props.account}:${props.coin}`;
  createEffect(() => {
    const a = trade.accounts().find((x) => x.id === props.account);
    const f = num(from());
    const t = num(to());
    if (props.kind !== 'scale' || !a || !(f > 0 && t > 0)) return setDraft(draftKey, null);
    const n = Math.max(2, Math.min(100, Math.round(num(count(), 10))));
    const bend = (x: number, skew: number) => x ** 3 ** skew;
    const at = Array.from({ length: n }, (_, i) => i / (n - 1));
    const weights = at.map((x) => Math.exp(sizeSkew() * 2 * (x - 0.5)));
    const total = weights.reduce((x, y) => x + y, 0);
    const lines = at.map((x, i) => {
      const px = f + (t - f) * bend(x, -priceSkew());
      const sz = (props.size() * weights[i]!) / total;
      const end = i === 0 ? 'from' : i === n - 1 ? 'to' : undefined;
      return { price: px, label: end || n <= 12 ? `Scale ${i + 1}/${n}${sz > 0 ? ` · ${coins(sz, props.szDecimals)}` : ''}` : '', tone: 'entry' as const, field: end };
    });
    setDraft(draftKey, { account: a, coin: props.coin, lines, move: (field, px) => (field === 'from' ? setFrom : setTo)(String(Number(px.toPrecision(6)))) });
  });
  onCleanup(() => setDraft(draftKey, null));

  /** A scale near the price: from just off the best, so far back. */
  const near = (offset: number, range: number, buy: boolean) => {
    const b = props.book();
    if (!b) return;
    const ref = buy ? b.bid : b.ask;
    const a = buy ? ref * (1 - offset) : ref * (1 + offset);
    const z = buy ? ref * (1 - offset - range) : ref * (1 + offset + range);
    setFrom(String(Number(a.toPrecision(6))));
    setTo(String(Number(z.toPrecision(6))));
  };

  const spec = (buy: boolean): AlgoSpec | string => {
    const base = { account: props.account, coin: props.coin, buy, size: props.size(), reduceOnly: props.reduce() };
    if (!(base.size > 0)) return 'Enter a size';
    if (props.kind === 'chase') {
      const m = mode();
      return { ...base, kind: 'chase', aggressive: m === 'aggressive', offset: m === 'back' ? Math.max(0, Math.round(num(back(), 1))) : 0, stalk: m === 'maintain' || m === 'trail' ? { mode: m, distance: num(distance(), 0.5) / 100 } : null, chaseTo: untilFilled() ? 0 : num(chaseTo(), 0.5) / 100, minutes: num(limitMin(), 0), onEnd: onEnd() };
    }
    if (props.kind === 'twap') {
      const bounds = boundsOn() && num(low()) > 0 && num(high()) > num(low()) ? { low: num(low()), high: num(high()), action: boundsAction() } : null;
      return { ...base, kind: 'twap', minutes: num(minutes(), 30), lots: Math.max(2, Math.round(num(lots(), 10))), jitter: Math.min(0.5, num(jitter(), 0) / 100), irregular: Math.min(0.9, num(irregular(), 0) / 100), bounds, slice: sliceHow(), timeout: Math.min(0.95, Math.max(0.05, num(timeout(), 50) / 100)), onTimeout: onTimeout() };
    }
    if (props.kind === 'scale') {
      if (!(num(from()) > 0 && num(to()) > 0)) return 'Enter both ends of the range';
      return { ...base, kind: 'scale', from: num(from()), to: num(to()), count: Math.round(num(count(), 10)), priceSkew: priceSkew(), sizeSkew: sizeSkew(), postOnly: postOnly() };
    }
    return { ...base, kind: 'swarm', lots: Math.round(num(swarmLots(), 5)), irregular: Math.min(0.9, num(swarmIrregular(), 0) / 100) };
  };

  const go = async (buy: boolean) => {
    const plain = spec(buy);
    if (typeof plain === 'string') return setLast({ ok: false, text: plain });
    // Held until the ticket's conditions are met, when it has any.
    const w = props.wrap?.(plain) ?? null;
    if (typeof w === 'string') return setLast({ ok: false, text: w });
    const s = w ?? plain;
    setBusy(true);
    const no = await runAlgo(s);
    setBusy(false);
    setLast(no ? { ok: false, text: no } : { ok: true, text: `${ALGO_KINDS.find((k) => k.id === props.kind)!.label} started` });
    if (no) toast({ title: 'Not started', body: no, tone: 'warn' });
  };

  return (
    <>
      <Show when={props.kind === 'chase'}>
        <label class="om-field" data-tip="Where the order sits">
          <span>Follows</span>
          <select value={mode()} onChange={(e) => setMode(e.currentTarget.value as ChaseMode)}>
            <option value="join">The best price on its side</option>
            <option value="aggressive">One tick inside the spread (AGGR)</option>
            <option value="back">So many ticks back</option>
            <option value="maintain">Stalk: a distance off, both ways</option>
            <option value="trail">Stalk: a distance off, closing only</option>
          </select>
        </label>
        <Show when={mode() === 'back'}>
          <Field label="Ticks" value={back()} set={setBack} />
        </Show>
        <Show when={mode() === 'maintain' || mode() === 'trail'}>
          <Field label="Distance" tip="How far from the best price it waits: a wick through it fills it" value={distance()} set={setDistance} unit="%" />
        </Show>
        <div class="om-opts">
          <label class="om-check" data-tip="Follows the price however far it goes, until filled or stopped">
            <input type="checkbox" checked={untilFilled()} onChange={(e) => setUntilFilled(e.currentTarget.checked)} /> Until filled
          </label>
        </div>
        <Show when={!untilFilled()}>
          <Field label="Chase to" tip="How far it may follow the price away from where it began" value={chaseTo()} set={setChaseTo} unit="%" />
        </Show>
        <Field label="At most" tip="Minutes it may take; 0 for as long as it takes" value={limitMin()} set={setLimitMin} unit="min" />
        <label class="om-field" data-tip="At its limit or its time">
          <span>Then</span>
          <select value={onEnd()} onChange={(e) => setOnEnd(e.currentTarget.value as 'cancel')}>
            <option value="cancel">Cancel what is left</option>
            <option value="keep">Leave it resting as a limit</option>
            <option value="market">Take the rest at the market</option>
          </select>
        </label>
      </Show>
      <Show when={props.kind === 'twap'}>
        <div class="om-two">
          <Field label="Over" value={minutes()} set={setMinutes} unit="min" />
          <Field label="Slices" value={lots()} set={setLots} />
        </div>
        <div class="om-two">
          <Field label="Jitter" tip="Each slice's time moved by up to this much of the interval, so it is not seen" value={jitter()} set={setJitter} unit="%" />
          <Field label="Uneven" tip="Each slice's size moved by up to this much, so it is not seen" value={irregular()} set={setIrregular} unit="%" />
        </div>
        <label class="om-field">
          <span>Slices</span>
          <select value={sliceHow()} onChange={(e) => setSliceHow(e.currentTarget.value as 'market')}>
            <option value="market">At the market</option>
            <option value="chase">Chased first: maker fees</option>
          </select>
        </label>
        <Show when={sliceHow() === 'chase'}>
          <div class="om-two">
            <Field label="For" tip="The part of each slice's interval it is chased for" value={timeout()} set={setTimeout_} unit="%" />
            <select value={onTimeout()} onChange={(e) => setOnTimeout(e.currentTarget.value as 'market')} data-tip="A slice not filled by then">
              <option value="market">then at the market</option>
              <option value="next">then into the next slice</option>
            </select>
          </div>
        </Show>
        <label class="om-check" data-tip="Only while the price is between two levels">
          <input type="checkbox" checked={boundsOn()} onChange={(e) => setBoundsOn(e.currentTarget.checked)} /> Price bounds
        </label>
        <Show when={boundsOn()}>
          <div class="om-two">
            <Field label="Low" value={low()} set={setLow} placeholder={price(props.book()?.bid)} />
            <Field label="High" value={high()} set={setHigh} placeholder={price(props.book()?.ask)} />
          </div>
          <label class="om-field">
            <span>Outside</span>
            <select value={boundsAction()} onChange={(e) => setBoundsAction(e.currentTarget.value as BoundsAction)}>
              <option value="pause">Pause until it is back</option>
              <option value="abort">Stop the TWAP</option>
              <option value="finish">Do the rest at once</option>
              <option value="close">Stop and close the position</option>
            </select>
          </label>
        </Show>
      </Show>
      <Show when={props.kind === 'scale'}>
        <div class="om-two">
          <Field label="From" value={from()} set={setFrom} placeholder={price(props.book()?.bid)} />
          <Field label="To" value={to()} set={setTo} />
        </div>
        <For each={[true, false]}>
          {(buy) => (
            <div class="om-shares" data-tip={buy ? 'From 0.1% under the best bid, so far down: for a buy' : 'From 0.1% over the best ask, so far up: for a sell'}>
              <span class="dim">{buy ? 'Under the bid' : 'Over the ask'}</span>
              <For each={[0.005, 0.01, 0.02, 0.05]}>
                {(r) => (
                  <button class="tb" onClick={() => near(0.001, r, buy)}>
                    {r * 100}%
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
        <Field label="Orders" tip="2 to 100" value={count()} set={setCount} />
        <label class="om-field" data-tip="Bunches the orders towards the first price (left) or the second (right)">
          <span>Prices</span>
          <input type="range" min="-1" max="1" step="0.1" value={priceSkew()} onInput={(e) => setPriceSkew(Number(e.currentTarget.value))} />
          <span class="dim num">{priceSkew() === 0 ? 'even' : priceSkew() < 0 ? 'to From' : 'to To'}</span>
        </label>
        <label class="om-field" data-tip="Bigger orders towards the first price (left) or the second (right)">
          <span>Sizes</span>
          <input type="range" min="-1" max="1" step="0.1" value={sizeSkew()} onInput={(e) => setSizeSkew(Number(e.currentTarget.value))} />
          <span class="dim num">{sizeSkew() === 0 ? 'even' : sizeSkew() < 0 ? 'to From' : 'to To'}</span>
        </label>
        <label class="om-check">
          <input type="checkbox" checked={postOnly()} onChange={(e) => setPostOnly(e.currentTarget.checked)} /> Post only
        </label>
      </Show>
      <Show when={props.kind === 'swarm'}>
        <div class="om-two">
          <Field label="Slices" value={swarmLots()} set={setSwarmLots} />
          <Field label="Uneven" tip="Each slice's size moved by up to this much" value={swarmIrregular()} set={setSwarmIrregular} unit="%" />
        </div>
      </Show>
      <div class="om-sides">
        <button class="om-buy" disabled={busy() || props.watching || props.locked} onClick={() => void go(true)}>
          {ALGO_KINDS.find((k) => k.id === props.kind)!.label} buy
        </button>
        <button class="om-sell" disabled={busy() || props.watching || props.locked} onClick={() => void go(false)}>
          {ALGO_KINDS.find((k) => k.id === props.kind)!.label} sell
        </button>
      </div>
      <Show when={last()}>{(l) => <p class={`om-note ${l().ok ? 'dim' : 'warn'}`}>{l().ok ? '✓' : '▲'} {l().text}</p>}</Show>
      <AlgoList account={props.account} coin={props.coin} szDecimals={props.szDecimals} />
    </>
  );
}

const KIND_NAME: Record<AlgoSpec['kind'], string> = { chase: 'Chase', twap: 'TWAP', scale: 'Scale', swarm: 'Swarm', when: 'When' };

/** Algorithms of an account (and a coin), running first: how far each has got, and a stop. */
export function AlgoList(props: { account?: string; coin?: string; szDecimals?: number; all?: boolean }) {
  const list = () => trade.algos().filter((a) => (!props.account || a.spec.account === props.account) && (!props.coin || a.spec.coin === props.coin) && (props.all || a.status === 'running' || a.status === 'paused' || Date.now() - a.ended < 60_000));
  return (
    <Show when={list().length}>
      <div class="om-algos">
        <For each={list()}>{(a) => <AlgoRow a={a} szDecimals={props.szDecimals ?? 4} />}</For>
      </div>
    </Show>
  );
}

export function AlgoRow(props: { a: AlgoState; szDecimals: number }) {
  const a = () => props.a;
  const live = () => a().status === 'running' || a().status === 'paused';
  const share = () => (a().spec.size > 0 ? Math.min(1, a().filled / a().spec.size) : 0);
  return (
    <div class="om-algo" classList={{ live: live() }}>
      <span classList={{ bull: a().spec.buy, bear: !a().spec.buy }}>
        {KIND_NAME[a().spec.kind]} {a().spec.buy ? 'buy' : 'sell'}
      </span>
      <span class="num">
        {coins(a().filled, props.szDecimals)} / {coins(a().spec.size, props.szDecimals)} {a().spec.coin}
      </span>
      <Show when={a().avg > 0}>
        <span class="num dim">@ {price(a().avg)}</span>
      </Show>
      <span class="om-bar">
        <span style={{ width: `${share() * 100}%` }} />
      </span>
      <span class="dim om-algo-detail">{a().status === 'running' ? a().detail : `${a().status}: ${a().detail}`}</span>
      <Show when={live()}>
        <button class="tb" onClick={() => stopAlgo(a().id)}>
          Stop
        </button>
      </Show>
    </div>
  );
}
