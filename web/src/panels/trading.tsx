/**
 * The order system's panels, behind one lazy import: each the layout makes
 * carries its own list of what to preload into what loads first, and
 * Positions already loads the Trade panel's account picker.
 */
import type { PositionsPanelState, TradePanelState } from '../workspace/model';
import PositionsPanel from './PositionsPanel';
import TradePanel from './TradePanel';

export default function Trading(props: { panel: TradePanelState | PositionsPanelState }) {
  return props.panel.type === 'trade' ? <TradePanel panel={props.panel} /> : <PositionsPanel panel={props.panel} />;
}
