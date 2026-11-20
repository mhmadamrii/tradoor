/**
 * Settings' trading accounts: the accounts in this browser, each with its
 * exchange's mark, adding one in two steps (the exchange, then how its key is
 * made), how the keys are kept, and the guards every order passes.
 */
import { createSignal, For, onMount, Show } from 'solid-js';
import { EXCHANGES, ExchangeLogo } from '../lib/exchanges';
import { AccountRow, AddAccount, GuardsBox, Vault } from './AccountsView';
import { closePrefs, DEFAULT_PARTS, setClosePrefs, start, trade } from './client';
import { VENUE_NAME, type Venue } from './protocol';
import './trade.css';

const TABS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'keys', label: 'Keys' },
  { id: 'guards', label: 'Guards' },
  { id: 'closing', label: 'Closing' },
] as const;

const ABOUT: Record<Venue, string> = {
  hyperliquid: 'Your wallet approves a trading key once. It places and cancels orders; it cannot withdraw.',
  lighter: 'An API key on your Lighter account, made here. Orders only, never a withdrawal.',
};

export default function TradingSettings() {
  onMount(start);
  const [tab, setTab] = createSignal<(typeof TABS)[number]['id']>('accounts');
  /** Adding one: null shows the list, 'pick' the exchanges, an exchange its details. */
  const [adding, setAdding] = createSignal<null | 'pick' | Venue>(null);
  return (
    <div class="om-settings">
      <div class="om-tabs" role="tablist">
        <For each={TABS}>
          {(t) => (
            <button role="tab" classList={{ on: tab() === t.id }} aria-selected={tab() === t.id} onClick={() => (setTab(t.id), setAdding(null))}>
              {t.label}
            </button>
          )}
        </For>
        <span class="om-testnet">Testnet</span>
      </div>

      <Show when={tab() === 'accounts'}>
        <Show
          when={adding()}
          fallback={
            <>
              <button class="om-addbtn" onClick={() => setAdding('pick')}>
                + Add account
              </button>
              <Show when={trade.accounts().length} fallback={<p class="om-none">No trading account yet. Add one to trade from a Trade panel.</p>}>
                <div class="om-acc-head">
                  <span>Account</span>
                  <span>Value</span>
                </div>
                <div class="om-accounts">
                  <For each={trade.accounts()}>{(a) => <AccountRow a={a} />}</For>
                </div>
              </Show>
            </>
          }
        >
          {(step) => (
            <Show
              when={step() !== 'pick' && (step() as Venue)}
              fallback={
                <div class="om-step">
                  <h3>Which exchange?</h3>
                  <div class="om-venues">
                    <For each={['hyperliquid', 'lighter'] as Venue[]}>
                      {(v) => (
                        <button class="om-venue" onClick={() => setAdding(v)}>
                          <ExchangeLogo exchange={EXCHANGES[v]} size={30} />
                          <span class="om-venue-name">{VENUE_NAME[v]}</span>
                          <span class="dim">{ABOUT[v]}</span>
                        </button>
                      )}
                    </For>
                  </div>
                  <button class="tb" onClick={() => setAdding(null)}>
                    ← Back
                  </button>
                </div>
              }
            >
              {(v) => (
                <div class="om-step">
                  <div class="om-step-head">
                    <ExchangeLogo exchange={EXCHANGES[v()]} size={26} />
                    <h3>{VENUE_NAME[v()]}</h3>
                    <span class="spacer" />
                    <button class="tb" onClick={() => setAdding('pick')}>
                      Change
                    </button>
                  </div>
                  <AddAccount venue={v()} />
                  <button class="tb" onClick={() => setAdding(null)}>
                    ← Back to the accounts
                  </button>
                </div>
              )}
            </Show>
          )}
        </Show>
      </Show>
      <Show when={tab() === 'keys'}>
        <Vault />
      </Show>
      <Show when={tab() === 'guards'}>
        <GuardsBox />
      </Show>
      <Show when={tab() === 'closing'}>
        <Closing />
      </Show>
    </div>
  );
}

/** How the positions list closes one: ask first or not, and the parts it offers. */
function Closing() {
  const set = (i: number, v: string) => {
    const list = [...closePrefs().parts];
    list[i] = Number(v);
    setClosePrefs({ parts: list });
  };
  return (
    <div class="om-closing">
      <label class="om-check">
        <input type="checkbox" checked={closePrefs().confirm} onChange={(e) => setClosePrefs({ confirm: e.currentTarget.checked })} />
        Ask before a position closes
      </label>
      <p class="dim">Off, Close and each part close at the market on the first click.</p>
      <div>
        <h3>Parts to close</h3>
        <p class="dim">The percentages Close % offers, of what the position holds; 100% is the Close button.</p>
        <div class="om-pcts">
          <For each={closePrefs().parts}>
            {(x, i) => <input class="box num" inputmode="numeric" value={x} onChange={(e) => set(i(), e.currentTarget.value)} />}
          </For>
          <span class="dim">%</span>
        </div>
      </div>
      <button class="tb" onClick={() => setClosePrefs({ parts: DEFAULT_PARTS, confirm: true })}>
        Back to 10, 25, 50, 75, 100% and asking
      </button>
    </div>
  );
}
