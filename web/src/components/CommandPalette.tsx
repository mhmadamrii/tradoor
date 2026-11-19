import { createEffect, createMemo, createSignal, For, on, onMount } from 'solid-js';
import { tl } from '../lib/i18n';
import { tradeOn } from '../trade/present';

export interface Command {
  group: string;
  label: string;
  hint?: string;
  run(): void;
}

/** Everything the app can do, by name. Every word typed must appear. */
export function CommandPalette(props: { commands: Command[]; onClose(): void }) {
  const [query, setQuery] = createSignal('');
  const [cursor, setCursor] = createSignal(0);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  onMount(() => input.focus());

  // With trading accounts in this browser, a typed line can be an order: read by the commands, loaded then.
  const [trading, setTrading] = createSignal<typeof import('../trade/command-run') | null>(null);
  onMount(() => tradeOn() && void import('../trade/command-run').then((m) => setTrading(() => m)));
  const tradeRow = createMemo((): (Command & { error?: boolean }) | null => {
    const r = trading()?.preview(query());
    return r ? { group: r.error ? 'Trade ▲' : 'Trade', label: r.label, hint: r.error ? undefined : '↵ sends', run: r.run, error: r.error } : null;
  });
  const matches = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    const row = tradeRow();
    if (row) return [row];
    if (words.length === 0) return props.commands;
    return props.commands.filter((c) => {
      const text = `${c.group} ${c.label} ${tl(c.group)} ${tl(c.label)} ${c.hint ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  });
  createEffect(on(query, () => setCursor(0), { defer: true }));
  createEffect(() => {
    cursor();
    list.querySelector('[data-cur]')?.scrollIntoView({ block: 'nearest' });
  });

  const run = (c: Command | undefined) => {
    if (!c) return;
    // Closed first, so a command can open another dialog.
    props.onClose();
    c.run();
  };

  return (
    <div class="backdrop" onPointerDown={() => props.onClose()}>
      <div
        class="dialog medium"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          const n = matches().length;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (n > 0) setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            run(matches()[cursor()]);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        <header>
          <span class="title caps">{tl('Command')}</span>
          <input ref={input} class="q" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} placeholder={tradeOn() ? tl('new chart, 4 hours… or trade: buy 0.01 btc, chase sell $500…') : tl('new chart, 4 hours, log scale, link blue…')} />
        </header>
        <div ref={list} class="list">
          <For each={matches()} fallback={<div class="empty">{tl('No command matches “')}{query()}”.</div>}>
            {(c, i) => (
              <div class="row" classList={{ cur: i() === cursor(), trade: c.group.startsWith('Trade'), warn: c.group === 'Trade ▲' }} data-cur={i() === cursor() ? '' : undefined} onMouseMove={() => setCursor(i())} onClick={() => run(c)}>
                <span class="dim" style={{ 'min-width': '90px' }}>
                  {tl(c.group)}
                </span>
                <span class="grow">{tl(c.label)}</span>
                {c.hint ? <kbd>{tl(c.hint)}</kbd> : null}
              </div>
            )}
          </For>
        </div>
        <footer>
          <span>{matches().length} {tl('commands')}</span>
          <span>{tl('↑↓ move · ↵ run · esc close')}</span>
        </footer>
      </div>
    </div>
  );
}
