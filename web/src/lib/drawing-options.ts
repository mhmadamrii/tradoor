/** What the drawing dialog and toolbar need beyond a drawing's style: names,
 *  the level tables (the same defaults the engine draws with), templates and
 *  visibility. Loaded with them, not with the chart. */
import { readJson, writePref } from './prefs';
import { forgetLook, hiddenUnits, lookOf, TEMPLATE_KEY, templates, type Style } from './drawing-style';

export interface Level {
  value: number;
  on: boolean;
  color: string;
  dash: Dash;
}

export type Dash = 'solid' | 'dashed' | 'dotted';

export const KIND_NAMES: Record<string, string> = {
  path: 'Path',
  brush: 'Brush',
  trendline: 'Trendline',
  horizontal: 'Horizontal line',
  vertical: 'Vertical line',
  cross: 'Crossline',
  ray: 'Horizontal ray',
  rect: 'Rectangle',
  fib: 'Fib retracement',
  text: 'Text',
  measure: 'Price range',
  long: 'Long position',
  short: 'Short position',
  channel: 'Parallel channel',
  rotrect: 'Rotated rectangle',
  disk: 'Circle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  arc: 'Arc',
  curve: 'Curve',
  dcurve: 'Double curve',
  marker: 'Arrow marker',
  markup: 'Arrow mark up',
  markdown: 'Arrow mark down',
  pricelabel: 'Price label',
  pricenote: 'Price note',
  callout: 'Callout',
  flag: 'Flag',
  pin: 'Pin',
  regression: 'Regression trend',
  flat: 'Flat top/bottom',
  disjoint: 'Disjoint channel',
  pitchfork: 'Pitchfork',
  schiff: 'Schiff pitchfork',
  mschiff: 'Modified Schiff pitchfork',
};

export const isPosition = (kind: string): boolean => kind === 'long' || kind === 'short';

const CHANNEL_LEVELS: Level[] = [
  { value: -0.25, on: false, color: '#2962ff', dash: 'solid' },
  { value: 0, on: true, color: '', dash: 'solid' },
  { value: 0.25, on: false, color: '#2962ff', dash: 'solid' },
  { value: 0.5, on: true, color: '#ff6d00', dash: 'dashed' },
  { value: 0.75, on: false, color: '#2962ff', dash: 'solid' },
  { value: 1, on: true, color: '', dash: 'solid' },
  { value: 1.25, on: false, color: '#2962ff', dash: 'solid' },
];

const FIB_LEVELS: Level[] = [
  { value: 0, on: true, color: '#787b86', dash: 'solid' },
  { value: 0.236, on: true, color: '#f23645', dash: 'solid' },
  { value: 0.382, on: true, color: '#ff9800', dash: 'solid' },
  { value: 0.5, on: true, color: '#4caf50', dash: 'solid' },
  { value: 0.618, on: true, color: '#089981', dash: 'solid' },
  { value: 0.786, on: true, color: '#00bcd4', dash: 'solid' },
  { value: 1, on: true, color: '#787b86', dash: 'solid' },
  { value: 1.618, on: false, color: '#2962ff', dash: 'solid' },
  { value: 2.618, on: false, color: '#f23645', dash: 'solid' },
  { value: 3.618, on: false, color: '#9c27b0', dash: 'solid' },
  { value: 4.236, on: false, color: '#e91e63', dash: 'solid' },
];

export const serializeLevels = (levels: Level[]): string => levels.map((l) => `${l.value},${l.on ? 1 : 0},${l.color},${l.dash}`).join('|');

export function parseLevels(raw: unknown, kind: string): Level[] {
  if (typeof raw !== 'string' || raw === '') return (kind === 'channel' ? CHANNEL_LEVELS : FIB_LEVELS).map((l) => ({ ...l }));
  return raw.split('|').flatMap((item) => {
    const [v, on, color, dash] = item.split(',');
    const value = Number(v);
    if (!Number.isFinite(value)) return [];
    return [{ value, on: on !== '0', color: color ?? '', dash: dash === 'dashed' || dash === 'dotted' ? dash : 'solid' }];
  });
}

export function saveDefaultStyle(kind: string, style: Style): void {
  const all = templates();
  // A position's legs are prices of its own, no other position's.
  const { legs: _legs, ...kept } = style;
  all[kind] = kept;
  writePref(TEMPLATE_KEY, JSON.stringify(all));
}

/** The next position starts at the size this one was set to, long or short. */
export function rememberSize(style: Style): void {
  const all = templates();
  const size = Object.fromEntries(['sizeBy', 'margin', 'leverage', 'account', 'risk', 'riskUnit'].filter((k) => style[k] !== undefined).map((k) => [k, style[k]!]));
  for (const kind of ['long', 'short']) all[kind] = { ...all[kind], ...size };
  writePref(TEMPLATE_KEY, JSON.stringify(all));
}

export function resetDefaultStyle(kind: string): void {
  const all = templates();
  delete all[kind];
  writePref(TEMPLATE_KEY, JSON.stringify(all));
  forgetLook(kind);
}

// ---------------------------------------------------------------- saved styles

const STYLES_KEY = 'drawingStyles';
export type SavedStyle = { name: string; style: Style };

/** A kind's styles saved by name, the newest first. */
export function savedStyles(kind: string): SavedStyle[] {
  const raw = readJson(STYLES_KEY);
  const list = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[kind] : null;
  return Array.isArray(list) ? list.filter((s): s is SavedStyle => !!s && typeof s.name === 'string' && !!s.style && typeof s.style === 'object') : [];
}

function writeStyles(kind: string, list: SavedStyle[]): void {
  const raw = readJson(STYLES_KEY);
  const all = raw && typeof raw === 'object' ? (raw as Record<string, SavedStyle[]>) : {};
  all[kind] = list;
  writePref(STYLES_KEY, JSON.stringify(all));
}

/** Saved under a name already used, it takes that one's place. */
export function saveStyle(kind: string, name: string, style: Style): void {
  writeStyles(kind, [{ name, style: lookOf(style) }, ...savedStyles(kind).filter((s) => s.name !== name)]);
}

export function deleteStyle(kind: string, name: string): void {
  writeStyles(kind, savedStyles(kind).filter((s) => s.name !== name));
}

/** Timeframe families a drawing can be hidden on, by the timeframe's unit letter. */
export const VISIBILITY_UNITS: { unit: string; label: string }[] = [
  { unit: 'm', label: 'Minutes' },
  { unit: 'h', label: 'Hours' },
  { unit: 'd', label: 'Days' },
  { unit: 'w', label: 'Weeks' },
  { unit: 'M', label: 'Months' },
];

export function withHidden(style: Style, unit: string, hidden: boolean): Style {
  const set = new Set(hiddenUnits(style));
  if (hidden) set.add(unit);
  else set.delete(unit);
  return { ...style, hideOn: [...set].join(',') };
}
