/**
 * The drawing tools down a chart's left edge: one button for each group of
 * tools, showing the one last used, with the whole group a click on its corner
 * away; the magnet, undo and redo, and the drawings' delete and clear. A workspace showing one
 * chart gives it its own; one showing several keeps a single rail at its left
 * for all of them, as TradingView does: the tool armed there draws on whichever
 * chart is clicked next, and the rest act on the chart in use.
 */
import { createSignal, For, Show } from 'solid-js';
import { useDismiss } from '../lib/dismiss';
import { armedTool, cycleMagnet, magnet, setArmedTool, TOOL_KEYS, type ChartController, type MagnetMode } from '../app/ui';
import { Icon, type IconName } from '../lib/icons';
import { tl, tlf } from '../lib/i18n';
import { readJson, readPref, writePref } from '../lib/prefs';

export const TOOLS: { kind: string; icon: IconName; title: string }[] = [
  { kind: '', icon: 'pointer', title: 'Select and pan (Esc) — click a drawing to select it, then Delete to remove it' },
  { kind: 'path', icon: 'path', title: 'Path — click each turn, then Enter or double-click to finish' },
  { kind: 'trendline', icon: 'trendline', title: 'Trendline — click the two ends; anchored to time and price' },
  { kind: 'horizontal', icon: 'horizontal', title: 'Horizontal level — one click, drawn edge to edge' },
  { kind: 'trendray', icon: 'trendray', title: 'Ray — click two points; the line runs on past the second' },
  { kind: 'infoline', icon: 'infoline', title: 'Info line — click the two ends; shows the move, percent and bars' },
  { kind: 'extended', icon: 'extended', title: 'Extended line — click two points; the line runs edge to edge' },
  { kind: 'angle', icon: 'angle', title: 'Trend angle — click the two ends; shows its angle on screen' },
  { kind: 'ray', icon: 'ray', title: 'Horizontal ray — one click; the level runs on from where you put it' },
  { kind: 'vertical', icon: 'vertical', title: 'Vertical line — one click, drawn top to bottom' },
  { kind: 'cross', icon: 'cross', title: 'Crossline — one click; a level and a time through the point' },
  { kind: 'rect', icon: 'rect', title: 'Zone — click opposite corners' },
  { kind: 'channel', icon: 'channel', title: 'Parallel channel — click the two ends of one line, then where the parallel line runs' },
  { kind: 'fib', icon: 'fib', title: 'Fib retracement — click the 100% end first, then the 0% end' },
  { kind: 'text', icon: 'text', title: 'Note — click where it goes, then type it' },
  { kind: 'measure', icon: 'measure', title: 'Measure — click from and to; reports the move, percent and bars' },
  { kind: 'long', icon: 'long', title: 'Long position — click the entry; drag its handles to set stop, target and width' },
  { kind: 'short', icon: 'short', title: 'Short position — click the entry; drag its handles to set stop, target and width' },
  { kind: 'brush', icon: 'brush', title: 'Brush — drag to draw freehand' },
];

/** The tool's name with its Alt shortcut: `Trendline (Alt+T) — click the two ends…`. */
const toolTip = (t: { kind: string; title: string }): string => {
  const key = Object.entries(TOOL_KEYS).find(([, kind]) => kind === t.kind)?.[0];
  if (!key) return t.title;
  const [name, ...rest] = t.title.split(' — ');
  return [`${name} (Alt+${key.slice(3)})`, ...rest].join(' — ');
};

/** The tools in groups, for the rail's buttons and a phone's sheet (DrawingSheet). */
export const GROUPS: { name: string; kinds: string[] }[] = [
  { name: 'Lines', kinds: ['trendline', 'trendray', 'infoline', 'extended', 'angle', 'horizontal', 'ray', 'vertical', 'cross'] },
  { name: 'Channels', kinds: ['channel'] },
  { name: 'Fibonacci', kinds: ['fib'] },
  { name: 'Shapes', kinds: ['rect', 'path'] },
  { name: 'Brushes', kinds: ['brush'] },
  { name: 'Text and notes', kinds: ['text'] },
  { name: 'Forecasting and measure', kinds: ['long', 'short', 'measure'] },
];

/** Each group's tool last picked, which its rail button shows and arms. */
const savedShown = readJson('railShown');
const [shown, setShown] = createSignal<Record<string, string>>(savedShown && typeof savedShown === 'object' ? (savedShown as Record<string, string>) : {});
const shownIn = (g: { name: string; kinds: string[] }): string => {
  const k = shown()[g.name];
  return k && g.kinds.includes(k) ? k : (g.kinds[0] ?? '');
};
const showIn = (group: string, kind: string) => {
  const next = { ...shown(), [group]: kind };
  setShown(next);
  writePref('railShown', JSON.stringify(next));
};

/** The tool's Alt shortcut, `Alt+T`, if it has one. */
export const toolKey = (kind: string): string | undefined => {
  const key = Object.entries(TOOL_KEYS).find(([, k]) => k === kind)?.[0];
  return key ? `Alt+${key.slice(3)}` : undefined;
};

/** The tool's own name, the words before its description. */
export const toolName = (kind: string): string => TOOLS.find((t) => t.kind === kind)?.title.split(' — ')[0] ?? kind;

/** A phone's starred tools (DrawingSheet), and whether they sit in the chart's bottom bar for one tap. */
const savedFavs = readJson('drawFavs');
export const [drawFavs, setDrawFavs] = createSignal<string[]>(Array.isArray(savedFavs) ? savedFavs.filter((k): k is string => TOOLS.some((t) => t.kind === k && k !== '')) : ['trendline', 'horizontal', 'rect']);
export const [favsOnChart, setFavsOnChart] = createSignal(readPref('drawFavsOnChart') !== '0');
export const toggleDrawFav = (kind: string) => {
  const next = drawFavs().includes(kind) ? drawFavs().filter((k) => k !== kind) : [...drawFavs(), kind];
  setDrawFavs(next);
  writePref('drawFavs', JSON.stringify(next));
};
export const showFavsOnChart = (on: boolean) => {
  setFavsOnChart(on);
  writePref('drawFavsOnChart', on ? '1' : '0');
};

export const MAGNET_TIP: Record<MagnetMode, string> = {
  off: 'Magnet off (Alt+G) — click for a weak magnet, or hold Ctrl while drawing for one',
  weak: 'Weak magnet (Alt+G) — anchors near a bar take its open, high, low or close; elsewhere a whole tick. Click for strong',
  strong: 'Strong magnet (Alt+G) — anchors always take the nearest open, high, low or close. Click to turn it off',
};

/** `target`: the chart the undo, delete and clear act on — its own, or the one in use. */
export function DrawingRail(props: { target: () => ChartController | undefined }) {
  useDismiss(flyout, () => setFlyout(null));
  /** This rail, so a chart's own rail and another's open their lists apart. */
  const rail = {};
  const offline = () => props.target()?.offline() ?? null;
  const count = () => props.target()?.drawingCount() ?? 0;
  return (
    <div class="rail">
      <button classList={{ on: armedTool() === '' }} data-tip={toolTip(TOOLS[0]!)} onClick={() => setArmedTool('')}>
        <Icon name="pointer" />
      </button>
      <For each={GROUPS}>{(g) => <RailGroup rail={rail} group={g} offline={offline} />}</For>
      <hr />
      <button class="magnet" classList={{ on: magnet() !== 'off', strong: magnet() === 'strong' }} data-tip={MAGNET_TIP[magnet()]} onClick={cycleMagnet}>
        <Icon name="magnet" />
      </button>
      <hr />
      <button disabled={!props.target()?.canUndo()} data-tip="Undo (Ctrl Z)" onClick={() => props.target()?.undo()}>
        <Icon name="undo" />
      </button>
      <button disabled={!props.target()?.canRedo()} data-tip="Redo (Ctrl Y)" onClick={() => props.target()?.redo()}>
        <Icon name="redo" />
      </button>
      <hr />
      <button
        class="del"
        disabled={props.target()?.selected() == null}
        data-tip={props.target()?.selected() == null ? 'Select a drawing on the chart first' : 'Delete the selected drawing (Delete)'}
        onClick={() => props.target()?.deleteSelected()}
      >
        <Icon name="trash" />
      </button>
      <button class="del" disabled={count() === 0} data-tip={tlf('Remove all {0} drawings on this market, on every timeframe', count())} onClick={() => props.target()?.clearDrawings()}>
        <Icon name="eraser" />
      </button>
      <Show when={count() > 0}>
        <span class="count num">{count()}</span>
      </Show>
    </div>
  );
}

/** The one group whose list is open, and where. */
const [flyout, setFlyout] = createSignal<{ rail: object; group: string; x: number; y: number } | null>(null);

/** A group's button: its tool last used, and on its corner the whole group in a list. */
function RailGroup(props: { rail: object; group: { name: string; kinds: string[] }; offline: () => string | null }) {
  const open = () => (flyout()?.group === props.group.name && flyout()?.rail === props.rail ? flyout() : null);
  const setOpen = (v: { x: number; y: number } | null) => setFlyout(v && { rail: props.rail, group: props.group.name, ...v });
  const kind = () => shownIn(props.group);
  const tool = () => TOOLS.find((t) => t.kind === kind())!;
  const pick = (k: string) => {
    showIn(props.group.name, k);
    setArmedTool(k);
    setOpen(null);
  };
  let box!: HTMLDivElement;
  return (
    <div class="rgroup" ref={box}>
      <button
        classList={{ on: props.group.kinds.includes(armedTool()) }}
        disabled={props.offline() !== null}
        data-tip={props.offline() ? tlf('{0} — unavailable: drawings are saved on the tradoor server ({1})', toolName(kind()), props.offline()) : toolTip(tool())}
        onClick={() => setArmedTool(armedTool() === kind() ? '' : kind())}
      >
        <Icon name={tool().icon} />
      </button>
      <Show when={props.group.kinds.length > 1}>
        <button
          class="rmore"
          classList={{ open: open() !== null }}
          aria-label={tlf('Every tool in {0}', tl(props.group.name))}
          aria-expanded={open() !== null}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            const r = box.getBoundingClientRect();
            setOpen(open() ? null : { x: r.right + 4, y: r.top });
          }}
        />
      </Show>
      <Show when={open()}>
        {(at) => (
          <div class="menu rflyout" style={{ left: `${at().x}px`, top: `${at().y}px` }} onPointerDown={(e) => e.stopPropagation()}>
            <div class="cap">{tl(props.group.name)}</div>
            <For each={props.group.kinds}>
              {(k) => (
                <button classList={{ cur: armedTool() === k }} disabled={props.offline() !== null} onClick={() => pick(k)}>
                  <Icon name={TOOLS.find((t) => t.kind === k)!.icon} />
                  <span class="grow">{tl(toolName(k))}</span>
                  <Show when={toolKey(k)}>{(key) => <kbd>{key()}</kbd>}</Show>
                </button>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}
