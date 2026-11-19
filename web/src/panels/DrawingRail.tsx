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
  { kind: 'regression', icon: 'regression', title: 'Regression trend — click the first time, then the last; fits the closes between, with bands two deviations out' },
  { kind: 'flat', icon: 'flat', title: 'Flat top/bottom — click the two ends of the trendline, then the level' },
  { kind: 'disjoint', icon: 'disjoint', title: 'Disjoint channel — click the two ends of the first line, then where the second starts' },
  { kind: 'pitchfork', icon: 'pitchfork', title: 'Pitchfork — click the pivot, then the two swings after it' },
  { kind: 'schiff', icon: 'schiff', title: 'Schiff pitchfork — click the pivot, then the two swings; starts halfway up the first swing' },
  { kind: 'mschiff', icon: 'mschiff', title: 'Modified Schiff pitchfork — click the pivot, then the two swings; starts halfway along the first swing' },
  { kind: 'rect', icon: 'rect', title: 'Zone — click opposite corners' },
  { kind: 'rotrect', icon: 'rotrect', title: 'Rotated rectangle — click both ends of one side, then how far it reaches' },
  { kind: 'disk', icon: 'disk', title: 'Circle — click the centre, then a point on the edge' },
  { kind: 'ellipse', icon: 'ellipse', title: 'Ellipse — click opposite corners of the box it fills' },
  { kind: 'triangle', icon: 'triangle', title: 'Triangle — click its three corners' },
  { kind: 'arc', icon: 'arc', title: 'Arc — click both ends, then a point it passes through' },
  { kind: 'curve', icon: 'curve', title: 'Curve — click both ends, then where it bends towards' },
  { kind: 'dcurve', icon: 'dcurve', title: 'Double curve — click both ends, then its two bends' },
  { kind: 'channel', icon: 'channel', title: 'Parallel channel — click the two ends of one line, then where the parallel line runs' },
  { kind: 'fib', icon: 'fib', title: 'Fib retracement — click the 100% end first, then the 0% end' },
  { kind: 'text', icon: 'text', title: 'Note — click where it goes, then type it' },
  { kind: 'measure', icon: 'measure', title: 'Measure — click from and to; reports the move, percent and bars' },
  { kind: 'long', icon: 'long', title: 'Long position — click the entry; drag its handles to set stop, target and width' },
  { kind: 'short', icon: 'short', title: 'Short position — click the entry; drag its handles to set stop, target and width' },
  { kind: 'brush', icon: 'brush', title: 'Brush — drag to draw freehand' },
  { kind: 'highlighter', icon: 'highlighter', title: 'Highlighter — drag to mark over the candles, wide and see-through' },
  { kind: 'arrow', icon: 'arrowline', title: 'Arrow — click where it starts, then where it points' },
  { kind: 'marker', icon: 'marker', title: 'Arrow marker — click where it starts, then where it points; a thick arrow' },
  { kind: 'markup', icon: 'markup', title: 'Arrow mark up — click under a bar' },
  { kind: 'markdown', icon: 'markdown', title: 'Arrow mark down — click over a bar' },
  { kind: 'callout', icon: 'callout', title: 'Callout — click what it is about, then where the note goes, then type it' },
  { kind: 'pricenote', icon: 'pricenote', title: 'Price note — click the price, then where its tag goes' },
  { kind: 'pricelabel', icon: 'pricelabel', title: 'Price label — one click; a tag reading the price there' },
  { kind: 'pin', icon: 'pin', title: 'Pin — one click' },
  { kind: 'flag', icon: 'flag', title: 'Flag — one click' },
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
  { name: 'Lines', kinds: ['trendline', 'trendray', 'infoline', 'extended', 'angle', 'horizontal', 'ray', 'vertical', 'cross', 'channel', 'regression', 'flat', 'disjoint'] },
  { name: 'Pitchforks', kinds: ['pitchfork', 'schiff', 'mschiff'] },
  { name: 'Fibonacci', kinds: ['fib'] },
  { name: 'Brushes', kinds: ['brush', 'highlighter'] },
  { name: 'Arrows', kinds: ['arrow', 'marker', 'markup', 'markdown'] },
  { name: 'Shapes', kinds: ['rect', 'rotrect', 'path', 'disk', 'ellipse', 'triangle', 'arc', 'curve', 'dcurve'] },
  { name: 'Text and notes', kinds: ['text', 'callout', 'pricenote', 'pricelabel', 'pin', 'flag'] },
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
      <button
        class="favs"
        classList={{ on: favsOnChart() }}
        aria-pressed={favsOnChart()}
        data-tip={favsOnChart() ? 'Hide the favourites bar' : 'Show the favourites bar — star tools in the lists to put them in it'}
        onClick={() => showFavsOnChart(!favsOnChart())}
      >
        <Icon name="star" fill={favsOnChart()} />
      </button>
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
            // Beside its button, lifted where a long list would run off the bottom.
            const rows = props.group.kinds.length;
            setOpen(open() ? null : { x: r.right + 4, y: Math.max(8, Math.min(r.top, innerHeight - (rows * 31 + 74) - 8)) });
          }}
        />
      </Show>
      <Show when={open()}>
        {(at) => (
          <div class="menu rflyout" style={{ left: `${at().x}px`, top: `${at().y}px` }} onPointerDown={(e) => e.stopPropagation()}>
            <div class="cap">{tl(props.group.name)}</div>
            <For each={props.group.kinds}>
              {(k) => (
                <div class="rrow">
                  <button classList={{ cur: armedTool() === k }} disabled={props.offline() !== null} onClick={() => pick(k)}>
                    <Icon name={TOOLS.find((t) => t.kind === k)!.icon} />
                    <span class="grow">{tl(toolName(k))}</span>
                    <Show when={toolKey(k)}>{(key) => <kbd>{key()}</kbd>}</Show>
                  </button>
                  <button class="rstar" classList={{ on: drawFavs().includes(k) }} aria-pressed={drawFavs().includes(k)} aria-label={tlf('Favourite: {0}', tl(toolName(k)))} onClick={() => toggleDrawFav(k)}>
                    <Icon name="star" size={12} stroke={2} fill={drawFavs().includes(k)} />
                  </button>
                </div>
              )}
            </For>
            <label class="rfavs">
              <input type="checkbox" checked={favsOnChart()} onChange={(e) => showFavsOnChart(e.currentTarget.checked)} />
              {tl('Favourites bar over the chart')}
            </label>
          </div>
        )}
      </Show>
    </div>
  );
}

/** Where the favourites bar was left, from the window's top left. */
const savedAt = readJson('favBarAt');
const [barAt, setBarAt] = createSignal<{ x: number; y: number }>(
  savedAt && typeof savedAt === 'object' && Number.isFinite((savedAt as { x: number }).x) ? (savedAt as { x: number; y: number }) : { x: 420, y: 72 },
);

/** A wide screen's starred tools in a small bar over the chart, dragged by its
 *  grip wherever it is out of the way; a phone keeps them in its bottom bar. */
export function FavBar() {
  let bar!: HTMLDivElement;
  const clamp = (p: { x: number; y: number }) => ({ x: Math.min(Math.max(0, p.x), innerWidth - (bar?.offsetWidth ?? 120)), y: Math.min(Math.max(0, p.y), innerHeight - (bar?.offsetHeight ?? 34)) });
  const grab = (e: PointerEvent) => {
    e.preventDefault();
    const from = { x: e.clientX - barAt().x, y: e.clientY - barAt().y };
    const move = (m: PointerEvent) => setBarAt(clamp({ x: m.clientX - from.x, y: m.clientY - from.y }));
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      writePref('favBarAt', JSON.stringify(barAt()));
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  return (
    <div class="favbar" ref={bar} style={{ left: `${clamp(barAt()).x}px`, top: `${clamp(barAt()).y}px` }} onPointerDown={(e) => e.stopPropagation()}>
      <span class="grip" aria-hidden="true" onPointerDown={grab} />
      <For each={drawFavs()}>
        {(k) => (
          <button classList={{ on: armedTool() === k }} data-tip={toolTip(TOOLS.find((t) => t.kind === k)!)} onClick={() => setArmedTool(armedTool() === k ? '' : k)}>
            <Icon name={TOOLS.find((t) => t.kind === k)!.icon} size={16} />
          </button>
        )}
      </For>
      <button class="fx" aria-label={tl('Hide the favourites bar')} data-tip="Hide the favourites bar — the rail's lists show it again" onClick={() => showFavsOnChart(false)}>
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}
