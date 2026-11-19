/**
 * The strategy tester's Live: an account and a size, and the switch that has
 * the strategy's orders sent to it as its bars close.
 */
import { createSignal, For, Show } from 'solid-js';
import { start, trade } from './client';
import { liveSettings, setLiveSettings } from './strategy-live';
import { VENUE_NAME } from './protocol';
import './trade.css';

export function StrategyLive(props: { market: string; timeframe: string; onOn: () => void }) {
  start();
  const where = `${props.market}|${props.timeframe}`;
  const kept = liveSettings(where);
  const [account, setAccount] = createSignal(kept?.account ?? '');
  const [usd, setUsd] = createSignal(kept?.usd ?? 100);
  const [on, setOn] = createSignal(kept?.on ?? false);
  const trading = () => trade.accounts().filter((a) => a.mode === 'trade');
  const pick = () => account() || trading()[0]?.id || '';
  const save = (next: boolean) => {
    if (next && !pick()) return;
    setOn(next);
    setLiveSettings(where, { on: next, account: pick(), usd: usd() });
    if (next) props.onOn();
  };
  return (
    <div class="om-live">
      <Show when={trading().length} fallback={<p class="dim om-note">No account with a key yet: add one in a Trade panel (Accounts).</p>}>
        <label class="om-field">
          <span>Account</span>
          <select value={pick()} disabled={on()} onChange={(e) => setAccount(e.currentTarget.value)}>
            <For each={trading()}>
              {(a) => (
                <option value={a.id}>
                  {a.label} · {VENUE_NAME[a.venue]}
                  {a.network === 'testnet' ? ' testnet' : ''}
                </option>
              )}
            </For>
          </select>
        </label>
        <label class="om-field" data-tip="What each entry buys or sells, in dollars">
          <span>Each entry</span>
          <input class="om-input num" type="number" min="10" disabled={on()} value={usd()} onInput={(e) => Number(e.currentTarget.value) > 0 && setUsd(Number(e.currentTarget.value))} />
          <span class="dim">USD</span>
        </label>
        <button class={on() ? 'tb om-kill on' : 'om-primary'} onClick={() => save(!on())}>
          {on() ? 'Stop trading it' : 'Trade it live'}
        </button>
        <p class="dim om-note">As each bar of this market and timeframe closes with an order: a long or a short at the market (turning a position round), an exit closing it. While tradoor and a chart of it are open; held to your guards.</p>
      </Show>
    </div>
  );
}
