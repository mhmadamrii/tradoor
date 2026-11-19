/** A drawing kind's saved styles: apply one to this drawing, save its look
 *  under a name, or let one go. In the drawing's toolbar and its settings. */
import { createSignal, For, Show } from 'solid-js';
import { deleteStyle, saveStyle, savedStyles } from '../lib/drawing-options';
import type { Style } from '../lib/drawing-style';
import { tl } from '../lib/i18n';
import { Icon } from '../lib/icons';

export function StyleMenu(props: { kind: string; style: Style; onApply(style: Style): void; onDone(): void }) {
  const [list, setList] = createSignal(savedStyles(props.kind));
  const [name, setName] = createSignal('');
  const save = () => {
    const n = name().trim().slice(0, 40);
    if (!n) return;
    saveStyle(props.kind, n, props.style);
    setList(savedStyles(props.kind));
    setName('');
  };
  return (
    <div class="stylemenu">
      <div class="cap">{tl('Saved styles')}</div>
      <Show when={list().length > 0} fallback={<p class="none">{tl('None saved yet')}</p>}>
        <For each={list()}>
          {(s) => (
            <div class="srow">
              <button
                class="sapply"
                onClick={() => {
                  props.onApply(s.style);
                  props.onDone();
                }}
              >
                <span class="swatch-dot" style={{ background: String(s.style.color ?? s.style.textColor ?? s.style.fill ?? 'var(--muted)') }} />
                <span class="grow">{s.name}</span>
              </button>
              <button
                class="sdel"
                aria-label={`${tl('Delete')} ${s.name}`}
                onClick={() => {
                  deleteStyle(props.kind, s.name);
                  setList(savedStyles(props.kind));
                }}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          )}
        </For>
      </Show>
      <form
        class="ssave"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input class="box" value={name()} maxLength={40} placeholder={tl('Name this style')} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" class="dbtn" disabled={!name().trim()}>
          {tl('Save')}
        </button>
      </form>
    </div>
  );
}
