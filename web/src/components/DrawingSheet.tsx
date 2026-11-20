/**
 * A phone's drawing tools: a sheet from the bottom in place of the rail down
 * the chart's edge, which took a finger's width of a narrow chart for tools
 * used now and then. Big tiles with their names, grouped, a star on each to
 * keep it in the chart's bottom bar, and the magnet, undo and the drawings'
 * delete along its foot.
 */
import { For, Show } from 'solid-js';
import { armedTool, cycleMagnet, magnet, setArmedTool, setLayersOpen, type ChartController } from '../app/ui';
import { tl, tlf } from '../lib/i18n';
import { Icon } from '../lib/icons';
import { drawFavs, favsOnChart, GROUPS, showFavsOnChart, toggleDrawFav, toolName, TOOLS } from '../panels/DrawingRail';
import './drawing-sheet.css';


const MAGNET_WORD = { off: 'Magnet off', weak: 'Weak magnet', strong: 'Strong magnet' } as const;

export function DrawingSheet(props: { target: () => ChartController | undefined; onClose(): void }) {
  const offline = () => props.target()?.offline() ?? null;
  const count = () => props.target()?.drawingCount() ?? 0;
  const pick = (kind: string) => {
    setArmedTool(kind);
    props.onClose();
  };
  const tile = (kind: string) => {
    const t = TOOLS.find((x) => x.kind === kind)!;
    const fav = () => drawFavs().includes(kind);
    return (
      <div class="ds-tile" classList={{ on: armedTool() === kind }}>
        <button class="ds-pick" disabled={offline() !== null} onClick={() => pick(kind)}>
          <Icon name={t.icon} size={24} />
          <span>{tl(toolName(kind))}</span>
        </button>
        <button class="ds-star" classList={{ on: fav() }} aria-pressed={fav()} aria-label={tlf('Favourite: {0}', tl(toolName(kind)))} onClick={() => toggleDrawFav(kind)}>
          <Icon name="star" size={13} stroke={2} fill={fav()} />
        </button>
      </div>
    );
  };
  return (
    <>
      <div class="mscrim" onClick={() => props.onClose()} />
      <div class="dsheet" role="dialog" aria-label={tl('Drawings')}>
        <header>
          <span class="ds-grab" aria-hidden="true" />
          <span class="ds-title">{tl('Drawings')}</span>
          <button class="ds-x" aria-label={tl('Close')} onClick={() => props.onClose()}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div class="ds-body">
          <Show when={offline()}>{(why) => <p class="ds-note warn">{tlf('Drawings are saved on the tradoor server, which is not reachable ({0}).', why())}</p>}</Show>
          <button class="ds-pan" classList={{ on: armedTool() === '' }} onClick={() => pick('')}>
            <Icon name="pointer" size={16} />
            {tl('Select and pan')}
          </button>
          <Show when={drawFavs().length > 0}>
            <h3>{tl('Favourites')}</h3>
            <div class="ds-grid">
              <For each={drawFavs()}>{(k) => tile(k)}</For>
            </div>
          </Show>
          <For each={GROUPS}>
            {(g) => (
              <>
                <h3>{tl(g.name)}</h3>
                <div class="ds-grid">
                  <For each={g.kinds}>{(k) => tile(k)}</For>
                </div>
              </>
            )}
          </For>
        </div>
        <div class="ds-actions">
          <button
            onClick={() => {
              setLayersOpen(props.target()?.id ?? null);
              props.onClose();
            }}
          >
            <Icon name="layers" size={18} />
            <span>{tl('Layers')}</span>
          </button>
          <button classList={{ on: magnet() !== 'off' }} onClick={cycleMagnet}>
            <Icon name="magnet" size={18} />
            <span>{tl(MAGNET_WORD[magnet()])}</span>
          </button>
          <button disabled={!props.target()?.canUndo()} onClick={() => props.target()?.undo()}>
            <Icon name="undo" size={18} />
            <span>{tl('Undo')}</span>
          </button>
          <button disabled={!props.target()?.canRedo()} onClick={() => props.target()?.redo()}>
            <Icon name="redo" size={18} />
            <span>{tl('Redo')}</span>
          </button>
          <button class="del" disabled={props.target()?.selected() == null} onClick={() => props.target()?.deleteSelected()}>
            <Icon name="trash" size={18} />
            <span>{tl('Delete')}</span>
          </button>
          <button class="del" disabled={count() === 0} onClick={() => props.target()?.clearDrawings()}>
            <Icon name="eraser" size={18} />
            <span>
              {tl('Clear')} {count() > 0 ? count() : ''}
            </span>
          </button>
        </div>
        <label class="ds-toggle">
          <Icon name="star" size={15} />
          <span>{tl("Favourites in the chart's bottom bar")}</span>
          <input type="checkbox" checked={favsOnChart()} onChange={(e) => showFavsOnChart(e.currentTarget.checked)} />
        </label>
      </div>
    </>
  );
}
