/**
 * A chart's drawings as a tree: each one shown, hidden, copied or deleted,
 * and gathered into groups that fold, hide and go as one. A group is a name
 * in each of its drawings' style (`group`); hiding is `hidden`, which keeps a
 * drawing off the chart but in this list.
 */
import { createMemo, createSignal, For, Show } from 'solid-js';
import type { ChartController } from '../app/ui';
import { KIND_NAMES } from '../lib/drawing-options';
import { tl, tlf } from '../lib/i18n';
import { Icon, type IconName } from '../lib/icons';
import { toolName, TOOLS } from '../panels/DrawingRail';
import './layers.css';

type Row = ReturnType<ChartController['drawings']>[number];

const iconOf = (d: Row): IconName => {
  const tool = typeof d.style.tool === 'string' ? d.style.tool : d.kind;
  return TOOLS.find((t) => t.kind === tool)?.icon ?? TOOLS.find((t) => t.kind === d.kind)?.icon ?? 'pencil';
};
const nameOf = (d: Row): string => {
  const tool = typeof d.style.tool === 'string' ? d.style.tool : '';
  const name = tl(tool ? toolName(tool) : (KIND_NAMES[d.kind] ?? toolName(d.kind)));
  return d.label ? `${name} · ${d.label.split('\n')[0]}` : name;
};
const groupOf = (d: Row): string => (typeof d.style.group === 'string' ? d.style.group : '');

export function LayersPanel(props: { target: () => ChartController | undefined; onClose(): void }) {
  const list = () => props.target()?.drawings() ?? [];
  const [ticked, setTicked] = createSignal<number[]>([]);
  const [folded, setFolded] = createSignal<string[]>([]);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  /** Groups in the order their first drawing was made, then the drawings outside any. */
  const tree = createMemo(() => {
    const groups = new Map<string, Row[]>();
    const loose: Row[] = [];
    for (const d of [...list()].sort((a, b) => a.createdAt - b.createdAt)) {
      const g = groupOf(d);
      if (!g) loose.push(d);
      else groups.set(g, [...(groups.get(g) ?? []), d]);
    }
    return { groups: [...groups.entries()], loose };
  });
  const t = () => props.target();
  const tick = (id: number) => setTicked((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));
  const each = (ids: number[], f: (id: number) => void) => {
    for (const id of ids) f(id);
  };
  const nextGroup = () => {
    const names = new Set(tree().groups.map(([g]) => g));
    let n = 1;
    while (names.has(`${tl('Group')} ${n}`)) n += 1;
    return `${tl('Group')} ${n}`;
  };
  const allHidden = (rows: Row[]) => rows.length > 0 && rows.every((d) => d.style.hidden === true);

  const row = (d: Row, inGroup: boolean) => (
    <div class="lrow" classList={{ sub: inGroup, off: d.style.hidden === true, on: ticked().includes(d.id) }}>
      <input type="checkbox" checked={ticked().includes(d.id)} aria-label={tlf('Pick {0}', nameOf(d))} onChange={() => tick(d.id)} />
      <button class="lname" onClick={() => t()?.selectDrawing(d.id)}>
        <Icon name={iconOf(d)} size={15} />
        <span>{nameOf(d)}</span>
      </button>
      <button class="lact" aria-label={d.style.hidden ? tl('Show') : tl('Hide')} data-tip={d.style.hidden ? 'Show' : 'Hide'} onClick={() => t()?.restyleDrawing(d.id, { hidden: !d.style.hidden })}>
        <Icon name={d.style.hidden ? 'eyeOff' : 'eye'} size={14} />
      </button>
      <button class="lact" aria-label={tl('Clone')} data-tip="Clone" onClick={() => t()?.cloneDrawing(d.id)}>
        <Icon name="copy" size={14} />
      </button>
      <button class="lact del" aria-label={tl('Delete')} data-tip="Delete" onClick={() => t()?.removeDrawing(d.id)}>
        <Icon name="trash" size={14} />
      </button>
    </div>
  );

  return (
    <div class="layers" onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <span class="ltitle">{tl('Object tree')}</span>
        <span class="lcount">{list().length}</span>
        <button class="lx" aria-label={tl('Close')} onClick={() => props.onClose()}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <div class="ltools">
        <button
          disabled={ticked().length === 0}
          data-tip="Put the picked drawings in a new group"
          onClick={() => {
            const g = nextGroup();
            each(ticked(), (id) => t()?.restyleDrawing(id, { group: g }));
            setTicked([]);
          }}
        >
          <Icon name="folder" size={14} />
          {tl('Group')}
        </button>
        <button
          disabled={ticked().length === 0}
          data-tip="Take the picked drawings out of their groups"
          onClick={() => {
            each(ticked(), (id) => t()?.restyleDrawing(id, { group: '' }));
            setTicked([]);
          }}
        >
          {tl('Ungroup')}
        </button>
        <button disabled={ticked().length === 0} aria-label={tl('Hide or show the picked drawings')} onClick={() => each(ticked(), (id) => t()?.restyleDrawing(id, { hidden: !allHidden(list().filter((d) => ticked().includes(d.id))) }))}>
          <Icon name="eye" size={14} />
        </button>
        <button
          disabled={ticked().length === 0}
          aria-label={tl('Clone the picked drawings')}
          onClick={() => {
            each(ticked(), (id) => t()?.cloneDrawing(id));
            setTicked([]);
          }}
        >
          <Icon name="copy" size={14} />
        </button>
        <button
          class="del"
          disabled={ticked().length === 0}
          aria-label={tl('Delete the picked drawings')}
          onClick={() => {
            each(ticked(), (id) => t()?.removeDrawing(id));
            setTicked([]);
          }}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      <div class="lbody">
        <Show when={list().length > 0} fallback={<p class="lnone">{tl('No drawings on this market yet.')}</p>}>
          <For each={tree().groups}>
            {([g, rows]) => (
              <>
                <div class="lrow group" classList={{ off: allHidden(rows) }}>
                  <button class="lfold" aria-expanded={!folded().includes(g)} aria-label={tl('Fold')} onClick={() => setFolded((v) => (v.includes(g) ? v.filter((x) => x !== g) : [...v, g]))}>
                    <Icon name="chevron" size={11} />
                  </button>
                  <Show
                    when={renaming() === g}
                    fallback={
                      <button class="lname" onDblClick={() => setRenaming(g)} data-tip="Double-click to rename">
                        <Icon name="folder" size={15} />
                        <span>{g}</span>
                        <span class="lcount">{rows.length}</span>
                      </button>
                    }
                  >
                    <input
                      class="box lrename"
                      value={g}
                      ref={(el) => queueMicrotask(() => el.select())}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Escape') setRenaming(null);
                        if (e.key !== 'Enter') return;
                        const name = e.currentTarget.value.trim().slice(0, 40);
                        if (name && name !== g) each(rows.map((d) => d.id), (id) => t()?.restyleDrawing(id, { group: name }));
                        setRenaming(null);
                      }}
                      onBlur={() => setRenaming(null)}
                    />
                  </Show>
                  <button class="lact" aria-label={allHidden(rows) ? tl('Show') : tl('Hide')} onClick={() => each(rows.map((d) => d.id), (id) => t()?.restyleDrawing(id, { hidden: !allHidden(rows) }))}>
                    <Icon name={allHidden(rows) ? 'eyeOff' : 'eye'} size={14} />
                  </button>
                  <button class="lact" aria-label={tl('Clone')} onClick={() => each(rows.map((d) => d.id), (id) => t()?.cloneDrawing(id))}>
                    <Icon name="copy" size={14} />
                  </button>
                  <button class="lact del" aria-label={tl('Delete')} onClick={() => each(rows.map((d) => d.id), (id) => t()?.removeDrawing(id))}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
                <Show when={!folded().includes(g)}>
                  <For each={rows}>{(d) => row(d, true)}</For>
                </Show>
              </>
            )}
          </For>
          <For each={tree().loose}>{(d) => row(d, false)}</For>
        </Show>
      </div>
    </div>
  );
}
