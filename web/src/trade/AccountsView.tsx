/**
 * Every trading account in this browser, and how to add one: on Hyperliquid or
 * Lighter, by the owner's wallet approving a key made here, by pasting a key
 * made on the exchange, or by watching an address. And how the keys are kept:
 * a passphrase on top of this device's own encryption, a lock after a while
 * without an order, and a way to remove every key at once.
 */
import { createSignal, For, Show } from 'solid-js';
import { addWatch, clearPassphrase, connectHyperliquid, connectLighter, importKey, KEY_DAYS, lock, NETWORKS, remove, removeAll, rename, setGuards, setPassphrase, trade, unlock } from './client';
import { walletChoices, type WalletChoice } from './wallet';
import { short } from './format';
import { EXCHANGES, ExchangeLogo } from '../lib/exchanges';
import { API } from './hyperliquid';
import { VENUE_NAME, type AccountRef, type Network, type Venue } from './protocol';
import { LIGHTER, TRADOOR_KEY_INDEX } from './venues/lighter';

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v.trim());

export function AccountsView(props: { onPick?: (id: string) => void }) {
  return (
    <div class="om-connect">
      <Show when={trade.accounts().length}>
        <h3>Accounts</h3>
        <div class="om-accounts">
          <For each={trade.accounts()}>{(a) => <AccountRow a={a} onPick={props.onPick} />}</For>
        </div>
      </Show>
      <AddAccount />
      <Vault />
      <GuardsBox />
    </div>
  );
}

export function AccountRow(props: { a: AccountRef; onPick?: (id: string) => void }) {
  const a = () => props.a;
  const [editing, setEditing] = createSignal(false);
  const [sure, setSure] = createSignal(false);
  const state = () => trade.states()[a().id];
  const expires = () => (a().validUntil ? new Date(a().validUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  return (
    <div class="om-acc">
      <span class="om-acc-logo">
        <ExchangeLogo exchange={EXCHANGES[a().venue]} size={22} />
      </span>
      <Show
        when={editing()}
        fallback={
          <button class="om-acc-name" data-tip="Trade with this account" onClick={() => props.onPick?.(a().id)}>
            {a().label}
          </button>
        }
      >
        <input class="om-input" value={a().label} maxlength="40" onKeyDown={(e) => e.key === 'Enter' && (rename(a().id, e.currentTarget.value), setEditing(false))} onBlur={(e) => (rename(a().id, e.currentTarget.value), setEditing(false))} ref={(el) => setTimeout(() => el.focus())} />
      </Show>
      <span class="dim">
        {VENUE_NAME[a().venue]} {a().network === 'testnet' ? <span class="om-testnet">Testnet</span> : ''} <span class="num">{short(a().owner)}</span>
        {a().accountIndex ? <span class="num"> #{a().accountIndex}</span> : ''}
      </span>
      <span class="dim">{a().mode === 'watch' ? 'watch only' : a().venue === 'lighter' ? `API key ${a().apiKeyIndex}` : expires() ? `key until ${expires()}` : 'key'}</span>
      <span class="num">{state() ? `$${state()!.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : ''}</span>
      <span class="spacer" />
      <button class="tb" onClick={() => setEditing(true)}>
        Rename
      </button>
      <Show
        when={sure()}
        fallback={
          <button class="tb" data-tip="Remove the account and its key from this browser" onClick={() => setSure(true)}>
            Remove
          </button>
        }
      >
        <button class="tb om-kill on" onClick={() => remove(a().id)}>
          Remove {a().mode === 'trade' ? 'it and its key' : 'it'}?
        </button>
        <button class="tb" onClick={() => setSure(false)}>
          No
        </button>
      </Show>
    </div>
  );
}

/** Adding an account: on one exchange when `venue` is given (Settings' second step), else with a choice of both. */
export function AddAccount(props: { venue?: Venue } = {}) {
  const [venue, setVenue] = createSignal<Venue>(props.venue ?? 'hyperliquid');
  const network = (): Network => NETWORKS[0] ?? 'testnet';
  const [label, setLabel] = createSignal('');
  const [days, setDays] = createSignal(30);
  const [keyIndex, setKeyIndex] = createSignal(TRADOOR_KEY_INDEX);
  const [accountIndex, setAccountIndex] = createSignal('');
  const [owner, setOwner] = createSignal('');
  const [key, setKey] = createSignal('');
  const [watched, setWatched] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [done, setDone] = createSignal('');
  /** The wallets found, once "Connect a wallet" asks; null before. */
  const [choices, setChoices] = createSignal<WalletChoice[] | null>(null);
  const name = () => label().trim() || `${VENUE_NAME[venue()]} ${trade.accounts().filter((a) => a.venue === venue()).length + 1}`;
  const idx = () => (Number(accountIndex()) > 0 ? Number(accountIndex()) : undefined);
  const run = async (f: () => Promise<string | null>, ok: string) => {
    setBusy(true);
    setError('');
    setDone('');
    const no = await f();
    setBusy(false);
    if (no) setError(no);
    else (setDone(ok), setKey(''), setLabel(''));
  };
  const app = () => (venue() === 'hyperliquid' ? API[network()].app : LIGHTER[network()].app);
  return (
    <section class="om-add">
      <Show when={!props.venue}>
        <h3>
          Add an account <span class="om-testnet">Testnet</span>
        </h3>
      </Show>
      <p class="om-testnote">Testnet only for now: test money, nothing real. As many accounts as you like, each with its own key.</p>
      <Show when={!props.venue}>
        <div class="om-seg" role="radiogroup" aria-label="Exchange">
          <For each={['hyperliquid', 'lighter'] as Venue[]}>
            {(v) => (
              <button classList={{ on: venue() === v }} onClick={() => setVenue(v)}>
                {VENUE_NAME[v]}
              </button>
            )}
          </For>
        </div>
      </Show>
      <label class="om-field">
        <span>Name</span>
        <input class="om-input" placeholder={name()} maxlength="40" value={label()} onInput={(e) => setLabel(e.currentTarget.value)} />
      </label>
      <Show when={venue() === 'lighter'}>
        <label class="om-field" data-tip="The API key's place on the account, 4 to 254. tradoor takes its own so it replaces no other app's key">
          <span>Key index</span>
          <input class="om-input num" type="number" min="4" max="254" value={keyIndex()} onInput={(e) => setKeyIndex(Math.min(254, Math.max(4, Number(e.currentTarget.value) || TRADOOR_KEY_INDEX)))} />
        </label>
        <label class="om-field" data-tip="Blank for the main account; a sub-account's index for that one">
          <span>Account #</span>
          <input class="om-input num" inputmode="numeric" placeholder="main account" value={accountIndex()} onInput={(e) => setAccountIndex(e.currentTarget.value)} />
        </label>
      </Show>
      <div class="om-row">
        <button
          class="om-primary"
          disabled={busy()}
          onClick={async () => {
            setError('');
            const found = await walletChoices();
            if (!found.length) return setError('No browser wallet found: install MetaMask, Phantom or Rabby, or paste a key below');
            setChoices(found);
          }}
        >
          Connect a wallet
        </button>
        <Show when={venue() === 'hyperliquid'}>
          <select data-tip="How long the trading key is approved for; connect again to renew it" value={days()} onChange={(e) => setDays(Number(e.currentTarget.value))}>
            <For each={KEY_DAYS}>{(d) => <option value={d}>{d} days</option>}</For>
          </select>
        </Show>
      </div>
      <Show when={choices()}>
        {(list) => (
          <div class="om-wallets" role="list" aria-label="Wallets in this browser">
            <span class="dim">Which wallet?</span>
            <For each={list()}>
              {(w) => (
                <button
                  class="om-wallet"
                  disabled={busy()}
                  onClick={() => {
                    setChoices(null);
                    void run(() => (venue() === 'hyperliquid' ? connectHyperliquid(network(), days(), name(), w.id) : connectLighter(network(), name(), keyIndex(), idx(), w.id)), `Connected with ${w.name}`);
                  }}
                >
                  <Show when={w.icon} fallback={<span class="om-wallet-blank" />}>
                    <img src={w.icon} alt="" width="20" height="20" />
                  </Show>
                  {w.name}
                </button>
              )}
            </For>
            <button class="tb" onClick={() => setChoices(null)}>
              Cancel
            </button>
          </div>
        )}
      </Show>
      <p class="dim om-note">
        {venue() === 'hyperliquid'
          ? 'Your wallet signs once to approve a key made here: it places and cancels orders, it cannot withdraw. Nothing is moved.'
          : "Your wallet signs once to register an API key made here. Lighter lets an API key withdraw only back to your own address, and tradoor's signer cannot sign a withdrawal or transfer at all. Nothing is moved."}
      </p>
      <details>
        <summary>Paste a key made on {VENUE_NAME[venue()]}</summary>
        <p class="dim om-note">
          From{' '}
          <a href={`${app()}${venue() === 'hyperliquid' ? '/API' : '/apikeys'}`} target="_blank" rel="noopener">
            {VENUE_NAME[venue()]}'s API page
          </a>
          : your account's address and the {venue() === 'hyperliquid' ? "API wallet's private key" : "API key's private key, at the key index above"}.
        </p>
        <input class="om-input num" placeholder="Account address, 0x…" value={owner()} onInput={(e) => setOwner(e.currentTarget.value)} />
        <input class="om-input num" type="password" autocomplete="off" placeholder="Private key" value={key()} onInput={(e) => setKey(e.currentTarget.value)} />
        <button class="dbtn" disabled={busy() || !isAddress(owner()) || key().length < 64} onClick={() => void run(() => importKey({ venue: venue(), network: network(), owner: owner(), label: name(), key: key(), accountIndex: idx(), apiKeyIndex: keyIndex() }), 'Key connected')}>
          Connect the key
        </button>
      </details>
      <details>
        <summary>Watch an address</summary>
        <p class="dim om-note">Its positions and fills, read only{venue() === 'lighter' ? ' (Lighter shows orders to a key only)' : ', and its orders'}.</p>
        <input class="om-input num" placeholder="Address, 0x…" value={watched()} onInput={(e) => setWatched(e.currentTarget.value)} />
        <button class="dbtn" disabled={busy() || !isAddress(watched())} onClick={() => void run(() => addWatch({ venue: venue(), network: network(), owner: watched(), label: name(), accountIndex: idx() }), 'Watching')}>
          Watch
        </button>
      </details>
      <Show when={error()}>
        <p class="warn om-note">▲ {error()}</p>
      </Show>
      <Show when={done()}>
        <p class="dim om-note">✓ {done()}</p>
      </Show>
    </section>
  );
}

export function Vault() {
  const v = trade.vault;
  const [pass, setPass] = createSignal('');
  const [again, setAgain] = createSignal('');
  const [minutes, setMinutes] = createSignal(15);
  const [error, setError] = createSignal('');
  const [sureAll, setSureAll] = createSignal(false);
  const act = async (f: () => Promise<string | null>) => {
    setError('');
    const no = await f();
    if (no) setError(no);
    else (setPass(''), setAgain(''));
  };
  return (
    <section class="om-add">
      <h3>Keys</h3>
      <p class="dim om-note">Every API key and wallet key stays in this browser. tradoor's server never receives one and has no way to. Each is kept under layers of encryption:</p>
      <ol class="om-layers">
        <li class="on">
          <b>Its own key</b> — AES-256-GCM, made for that key alone
        </li>
        <li class="on">
          <b>This browser's key</b> — AES-256-GCM that cannot leave this browser: copied elsewhere, the keys are unreadable
        </li>
        <li classList={{ on: v().kind === 'passphrase' }}>
          <b>Your passphrase</b> — PBKDF2-SHA-256, 600,000 rounds{v().kind === 'passphrase' ? (v().locked ? ' · locked' : ' · unlocked') : ' · add one below for the third layer'}
        </li>
      </ol>
      <div class="om-pass" classList={{ on: v().kind === 'passphrase' }}>
        <div class="om-pass-head">
          <b>Passphrase</b>
          <span class="dim">the third layer</span>
          <span class="om-chip" classList={{ on: v().kind === 'passphrase' && !v().locked, lock: v().kind === 'passphrase' && v().locked }}>
            {v().kind !== 'passphrase' ? 'Off' : v().locked ? 'Locked' : 'On · unlocked'}
          </span>
        </div>
        <Show
          when={v().kind === 'passphrase' && v().locked}
          fallback={
            <>
              <p class="dim om-note">
                {v().kind === 'passphrase'
                  ? 'Change it, lock the keys now, or take it off.'
                  : 'Asked once a session before the first order: nothing trades from this browser without it, even with the browser’s files copied. Forgotten, it cannot be recovered — the accounts are then removed and connected again.'}
              </p>
              <label class="om-pfield">
                <span>{v().kind === 'passphrase' ? 'New passphrase' : 'Passphrase'}</span>
                <input class="om-input" type="password" autocomplete="new-password" placeholder="8 characters at least" value={pass()} onInput={(e) => setPass(e.currentTarget.value)} />
              </label>
              <label class="om-pfield">
                <span>Repeat it</span>
                <input class="om-input" type="password" autocomplete="new-password" placeholder="The same again" value={again()} onInput={(e) => setAgain(e.currentTarget.value)} />
              </label>
              <p class="om-pcheck">
                <span classList={{ ok: pass().length >= 8 }}>{pass().length >= 8 ? '✓' : '○'} 8 characters or more</span>
                <span classList={{ ok: pass().length > 0 && pass() === again() }}>{pass().length > 0 && pass() === again() ? '✓' : '○'} Both the same</span>
              </p>
              <div class="om-pfield">
                <span>Lock after</span>
                <div class="om-seg om-seg-sm" role="radiogroup" aria-label="Lock after">
                  <For each={[0, 5, 15, 30, 60]}>
                    {(m) => (
                      <button role="radio" aria-checked={minutes() === m} classList={{ on: minutes() === m }} onClick={() => setMinutes(m)}>
                        {m === 0 ? 'Never' : `${m} min`}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div class="om-pactions">
                <button class="dbtn primary" disabled={pass().length < 8 || pass() !== again()} onClick={() => void act(() => setPassphrase(pass(), minutes()))}>
                  {v().kind === 'passphrase' ? 'Change the passphrase' : 'Turn on the third layer'}
                </button>
                <Show when={v().kind === 'passphrase'}>
                  <button class="tb" onClick={() => void act(lock)}>
                    Lock now
                  </button>
                  <button class="tb" onClick={() => void act(clearPassphrase)}>
                    Take it off
                  </button>
                </Show>
              </div>
            </>
          }
        >
          <p class="dim om-note">The keys are locked. The passphrase opens them for this session.</p>
          <div class="om-pactions">
            <input class="om-input" type="password" placeholder="Passphrase" value={pass()} onInput={(e) => setPass(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && void act(() => unlock(pass()))} />
            <button class="dbtn primary" onClick={() => void act(() => unlock(pass()))}>
              Unlock
            </button>
          </div>
        </Show>
      </div>
      <details class="om-verify">
        <summary>Check it yourself</summary>
        <ol>
          <li>
            Press <kbd>F12</kbd>, open <b>Application</b>, then <b>IndexedDB → tradoor-trade</b>.
          </li>
          <li>
            <b>secrets</b> holds each key as encrypted bytes only: <code>inner</code> the key under its own key, <code>key</code> that one under this browser’s
            {v().kind === 'passphrase' ? ' and your passphrase' : ''}.
          </li>
          <li>
            <b>wrap</b> holds this browser’s key as a locked <code>CryptoKey</code>: not even DevTools can show its bytes.
          </li>
          <li>Nothing of it is on tradoor’s server: the Network tab shows the keys never sent, only signed orders to the exchange.</li>
        </ol>
        <p class="warn">Delete nothing there: without <b>wrap</b>, every key kept here is gone for good. Remove accounts from this page instead.</p>
      </details>
      <Show when={error()}>
        <p class="warn om-note">▲ {error()}</p>
      </Show>
      <Show when={trade.accounts().length}>
        <Show
          when={sureAll()}
          fallback={
            <button class="om-forget" onClick={() => setSureAll(true)}>
              Remove every account and key from this browser
            </button>
          }
        >
          <div class="om-row">
            <button class="tb om-kill on" onClick={() => (removeAll(), setSureAll(false))}>
              Remove all {trade.accounts().length}? It cannot be undone
            </button>
            <button class="tb" onClick={() => setSureAll(false)}>
              No
            </button>
          </div>
        </Show>
      </Show>
    </section>
  );
}

export function GuardsBox() {
  const g = trade.guards;
  const field = (label: string, tip: string, value: number, set: (v: number) => void, unit: string) => (
    <label class="om-field" data-tip={tip}>
      <span>{label}</span>
      <input class="om-input num" type="number" min="0" step="any" value={value} onChange={(e) => Number(e.currentTarget.value) >= 0 && set(Number(e.currentTarget.value))} />
      <span class="dim">{unit}</span>
    </label>
  );
  return (
    <section class="om-add">
      <h3>Guards on every order</h3>
      {field('At most', 'The most one order may be worth; 0 for no limit', g().maxUsd, (v) => setGuards({ ...g(), maxUsd: v }), 'USD')}
      {field('Price band', 'A limit this far past the best price is refused: a slip of the finger', +(g().band * 100).toFixed(2), (v) => setGuards({ ...g(), band: v / 100 }), '%')}
      {field('Slippage', 'The worst a market order may fill at, past the best price', +(g().slippage * 100).toFixed(2), (v) => setGuards({ ...g(), slippage: Math.min(v, 50) / 100 }), '%')}
    </section>
  );
}
