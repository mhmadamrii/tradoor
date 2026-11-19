/**
 * The TP and SL handles on a position's entry line, on hover: stacked just left
 * of its label, the take profit on the side its price goes — above a long's
 * entry, below a short's. Loaded with the first entry line, not at start.
 */
import { digitsFor } from '../lib/alerts';
import { formatPrice } from '../lib/format';
import { doc } from '../workspace/store';
import type { DrawingShape } from '../engine/protocol';

type Shape = Pick<DrawingShape, 'points' | 'label' | 'style'>;

/** A chart label's width as the engine draws it: monospace, a character about 0.57 of its size (0.55 to 0.6 across faces), at the chart's text size less one. */
const labelWidth = (text: string): number => text.length * (Number(doc.theme.fontPx ?? 11) - 1) * 0.57;

export default function LiveEntry(props: {
  shape: Shape | undefined;
  market: string;
  y: number;
  /** From the chart's right edge to the price axis. */
  axisRight: number;
  onEnter: () => void;
  onLeave: () => void;
  onDrag: (e: PointerEvent, side: 'tp' | 'sl') => void;
}) {
  // The label is drawn right-aligned by the axis, named and priced: the handles go just before it.
  const right = () => {
    const at = props.shape?.points[0]?.price ?? 0;
    return props.axisRight + 6 + labelWidth(`${props.shape?.label ?? ''}  ${formatPrice(at, digitsFor(props.market, at))}`) + 9;
  };
  return (
    <div class="live-entry" classList={{ short: props.shape?.style?.long === 0 }} style={{ right: `${right()}px`, top: `${props.y - 21}px` }} onPointerEnter={props.onEnter} onPointerLeave={props.onLeave}>
      <button class="tp" data-tip="Drag up or down to where the take profit goes" onPointerDown={(e) => props.onDrag(e, 'tp')}>
        TP
      </button>
      <button class="sl" data-tip="Drag up or down to where the stop goes" onPointerDown={(e) => props.onDrag(e, 'sl')}>
        SL
      </button>
    </div>
  );
}
