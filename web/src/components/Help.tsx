/**
 * Keyboard and mouse: every shortcut, by section, with a search. Keys show as
 * keycaps (`Ctrl` `S`), alternatives with "or", and what is done with the mouse
 * as a dashed pill of its own, so a key and a click never look alike.
 */
import { createMemo, createSignal, For, Show } from 'solid-js';
import { tl } from '../lib/i18n';
import { tradeOn } from '../trade/present';
import './help.css';

/** A row: what it does, and how — key combos (any of them), or something done with the mouse. */
interface Row {
  what: string;
  keys?: string[][];
  mouse?: string;
  /** Keys one after another on one modifier: Alt and T, H, J or R. */
  letters?: { mod: string; list: string[] };
}

const k = (...combos: string[]): string[][] => combos.map((c) => c.split(' '));

const SECTIONS: { id: string; title: string; rows: Row[]; trading?: boolean }[] = [
  {
    id: 'workspace',
    title: 'Workspace',
    rows: [
      { what: 'Commands', keys: k('/', 'Ctrl K') },
      { what: 'This help', keys: k('?') },
      { what: 'Save the workspace now (it also saves itself)', keys: k('Ctrl S') },
      { what: 'Dock a panel: to the centre or an edge of a group', mouse: 'drag a tab' },
      { what: 'Link panels so they share one market', mouse: 'link icon on a tab' },
      { what: 'Close a panel', mouse: 'middle-click its tab' },
    ],
  },
  {
    id: 'chart',
    title: 'Chart',
    rows: [
      { what: 'Search for a symbol', keys: k('a–z') },
      { what: 'Shorter or longer timeframe', keys: k('←', '→') },
      { what: 'Previous or next market in the watchlist, or the Signal list', keys: k('↑', '↓') },
      { what: 'This chart alone over the layout, and back', keys: k('Alt ↵') },
      { what: 'Zoom time', mouse: 'wheel' },
      { what: 'Pan time; up or down moves the price', mouse: 'drag' },
      { what: 'Scale the price', mouse: 'wheel or drag the price axis' },
      { what: 'Auto scale that pane again', mouse: 'double-click the price axis' },
      { what: 'Price follows the bars again', mouse: 'AUTO button' },
      { what: 'Chart menu', mouse: 'right-click' },
    ],
  },
  {
    id: 'drawing',
    title: 'Drawing',
    rows: [
      { what: 'Trendline, horizontal level, ray, zone', letters: { mod: 'Alt', list: ['T', 'H', 'J', 'R'] } },
      { what: 'Parallel channel, fib, note, measure', letters: { mod: 'Alt', list: ['C', 'F', 'N', 'M'] } },
      { what: 'Long, short, brush, path', letters: { mod: 'Alt', list: ['L', 'S', 'B', 'P'] } },
      { what: 'Magnet: off, weak, strong', keys: k('Alt G') },
      { what: 'Hold for a weak magnet while drawing, when it is off', keys: k('Ctrl') },
      { what: 'Keep a line level while drawing or dragging it', keys: k('Shift') },
      { what: 'Undo the last drawing change', keys: k('Ctrl Z') },
      { what: 'Redo', keys: k('Ctrl Shift Z', 'Ctrl Y') },
      { what: 'Cancel the tool, or deselect', keys: k('Esc') },
      { what: 'Remove the selected drawing', keys: k('Delete') },
      { what: 'Finish a path', keys: k('Enter') },
      { what: 'Finish a path', mouse: 'double-click' },
      { what: 'A drawing’s settings: style, text, coordinates, visibility', mouse: 'double-click it' },
      { what: 'Copy a 4K picture of the chart (with Shift: save the file)', keys: k('Alt K') },
    ],
  },
  {
    id: 'alerts',
    title: 'Alerts',
    rows: [
      { what: 'A crossing alert at the price under the pointer', mouse: 'clock by the price axis' },
      { what: 'An alert’s name, and delete', mouse: 'hover its line' },
      { what: 'Move an alert to another price', mouse: 'drag its line' },
      { what: 'Every alert: restart, edit, delete; the Log lists each trigger', mouse: 'Alerts panel' },
    ],
  },
  {
    id: 'watchlist',
    title: 'Watchlist',
    rows: [
      { what: 'Flag a market, add a section or a symbol', mouse: 'right-click' },
      { what: 'Move a row; a section moves with its markets', mouse: 'drag a row' },
      { what: 'Fold a section shut or open', mouse: 'click it' },
      { what: 'Rename a section', mouse: 'double-click it' },
    ],
  },
  {
    id: 'search',
    title: 'Symbol search',
    rows: [
      { what: 'Move through the results', keys: k('↑', '↓') },
      { what: 'Open', keys: k('↵') },
      { what: 'All, perpetuals or spot', keys: k('Tab') },
      { what: 'Filter by exchange and kind', mouse: 'type “bybit btc”' },
      { what: 'Close', keys: k('Esc') },
    ],
  },
  {
    id: 'trading',
    title: 'Trading',
    rows: [
      { what: 'Buy at that price, or sell', mouse: 'click a bid or an ask' },
      { what: 'Cancel your order', mouse: 'click it' },
      { what: 'Move your order', mouse: 'drag it to another row' },
      { what: 'The position’s stop at that price', mouse: 'Shift-click a row' },
      { what: 'The position’s take profit at that price', mouse: 'Ctrl-click a row' },
    ],
  },
  {
    id: 'commands',
    title: 'Trading commands',
    trading: true,
    rows: [
      { what: 'At the market; $500 or 25% for a size in money or a share', mouse: 'buy 0.01 btc' },
      { what: 'A post-only limit at the middle of the book', mouse: 'sell $500 eth @mid post' },
      { what: 'With a take profit and a stop from its price', mouse: 'long 25% @-0.5% tp 2% sl 1%' },
      { what: 'Close, cancel, reverse; one coin or all', mouse: 'close btc 50% · cancel all' },
      { what: 'Chase, TWAP, scale, swarm', mouse: 'chase buy $1000 aggr to 0.5%' },
      { what: 'Another account, by its name', mouse: '… on main' },
      { what: 'Name a line, a value, or put it on a key', mouse: 'alias · let · bind alt+b =' },
    ],
  },
];

function Keys(props: { row: Row }) {
  return (
    <span class="hk-keys">
      <Show when={props.row.keys}>
        <For each={props.row.keys}>
          {(combo, i) => (
            <>
              <Show when={i() > 0}>
                <span class="hk-or">{tl('or')}</span>
              </Show>
              <span class="hk-combo">
                <For each={combo}>{(key) => <kbd class="hk-cap">{key}</kbd>}</For>
              </span>
            </>
          )}
        </For>
      </Show>
      <Show when={props.row.letters}>
        {(l) => (
          <span class="hk-combo">
            <kbd class="hk-cap">{l().mod}</kbd>
            <span class="hk-plus">+</span>
            <For each={l().list}>
              {(c, i) => (
                <>
                  <Show when={i() > 0}>
                    <span class="hk-slash">/</span>
                  </Show>
                  <kbd class="hk-cap">{c}</kbd>
                </>
              )}
            </For>
          </span>
        )}
      </Show>
      <Show when={props.row.mouse}>{(m) => <span class="hk-mouse">{tl(m())}</span>}</Show>
    </span>
  );
}

export function Help(props: { onClose(): void }) {
  const [query, setQuery] = createSignal('');
  const [section, setSection] = createSignal('all');
  const sections = () => SECTIONS.filter((s) => !s.trading || tradeOn());
  const shown = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    // A search finds a row by its words in English and in the page's language.
    const text = (s: string | undefined) => (s ? `${s} ${tl(s)}` : '');
    return sections()
      .filter((s) => section() === 'all' || s.id === section())
      .map((s) => ({
        ...s,
        rows: words.length ? s.rows.filter((r) => words.every((w) => `${text(s.title)} ${text(r.what)} ${text(r.mouse)} ${(r.keys ?? []).flat().join(' ')} ${r.letters ? r.letters.mod + r.letters.list.join('') : ''}`.toLowerCase().includes(w))) : s.rows,
      }))
      .filter((s) => s.rows.length);
  });
  let input!: HTMLInputElement;
  return (
    <div class="backdrop" onPointerDown={() => props.onClose()}>
      <div
        class="dialog hk"
        tabIndex={-1}
        ref={() => queueMicrotask(() => input.focus())}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === '?' && e.target !== input)) {
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        <header>
          <span class="title caps">{tl('Keyboard & mouse')}</span>
          <input ref={input} class="q" placeholder={tl('Find a shortcut: undo, magnet, alert…')} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
          <button class="x" onClick={() => props.onClose()}>
            {tl('esc ✕')}
          </button>
        </header>
        <nav class="hk-sections" aria-label={tl('Sections')}>
          <button classList={{ on: section() === 'all' }} onClick={() => setSection('all')}>
            {tl('All')}
          </button>
          <For each={sections()}>
            {(s) => (
              <button classList={{ on: section() === s.id }} onClick={() => setSection(s.id)}>
                {tl(s.title)}
              </button>
            )}
          </For>
        </nav>
        <div class="hk-body">
          <div class="hk-cols">
            <For each={shown()} fallback={<p class="empty">{tl('Nothing matches “')}{query()}”</p>}>
              {(s) => (
                <section class="hk-section">
                  <h3>{tl(s.title)}</h3>
                  <For each={s.rows}>
                    {(r) => (
                      <div class="hk-row">
                        <span class="hk-what">{tl(r.what)}</span>
                        <Keys row={r} />
                      </div>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
          {/* The same words as the README's Disclaimer, shortened. */}
          <Show when={!query().trim()}>
            <section class="hk-note">
              <h3>{tl('Disclaimer')}</h3>
              <p>{tl('tradoor terminal is software: a tool that charts market data and works out technical studies from it. It is not a financial adviser, a broker or an exchange, and it never holds your money. Nothing it shows — charts, indicators, signals, alerts, backtests or shared scripts — is advice to buy or sell.')}</p>
              <p>{tl('Market data comes from the exchanges and can be late, incomplete or wrong. Trading, above all with leverage, can lose all you put in. Every trade is your own decision and your own risk: tradoor terminal and its authors are not liable for any loss.')}</p>
            </section>
          </Show>
        </div>
        <footer>
          <span>
            <kbd class="hk-cap">{tl('key')}</kbd> {tl('on the keyboard')} · <span class="hk-mouse">{tl('mouse')}</span> {tl('with the pointer')}
          </span>
          <span>
            <kbd class="hk-cap">?</kbd> {tl('opens this anywhere')}
          </span>
        </footer>
      </div>
    </div>
  );
}
