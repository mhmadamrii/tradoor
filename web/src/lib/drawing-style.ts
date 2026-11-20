/**
 * How a drawing looks and behaves, as the flat `style` object it is saved with.
 * The engine reads the same keys (see `DrawingStyle::set` in the render crate);
 * anything left out falls back to the theme and to what suits the kind — a
 * fib's and a channel's levels included. What only the settings dialog needs
 * lives in drawing-options, so it loads with the dialog.
 */
import { readJson, writePref } from './prefs';

export type Style = Record<string, string | number | boolean>;

/** Tools that are another kind drawn a set way: a ray is a trendline carried on
 *  past its second end. Saved as that kind, so its settings are that kind's. */
export const PRESETS: Record<string, { kind: string; style: Style }> = {
  trendray: { kind: 'trendline', style: { extendRight: true } },
  extended: { kind: 'trendline', style: { extendLeft: true, extendRight: true } },
  infoline: { kind: 'trendline', style: { stats: true, priceLabels: true } },
  angle: { kind: 'trendline', style: { angle: true } },
  arrow: { kind: 'trendline', style: { rightArrow: true } },
  highlighter: { kind: 'brush', style: { color: '#ffeb3b59', width: 8 } },
  fibchannel: { kind: 'channel', style: { levels: '0,1,,solid|0.236,1,,solid|0.382,1,,solid|0.5,1,,solid|0.618,1,,solid|0.786,1,,solid|1,1,,solid', fillOn: false } },
  pricerange: { kind: 'measure', style: { axis: 'p' } },
  daterange: { kind: 'measure', style: { axis: 't' } },
  forecast: { kind: 'trendline', style: { rightArrow: true, stats: true, priceLabels: true, color: '#26a69a', width: 2 } },
};

/** The kind the engine draws for a tool. */
export const engineKind = (tool: string): string => PRESETS[tool]?.kind ?? tool;

/** What a fresh drawing of each kind looks like before anyone changes it. */
export function factoryStyle(kind: string): Style {
  const preset = PRESETS[kind];
  if (preset) return { ...factoryStyle(preset.kind), ...preset.style };
  switch (kind) {
    case 'long':
    case 'short':
      // Sized by its margin, so moving the stop changes what it risks and not its size. The target
      // in a quiet grey, the stop a faint red: the price is what stands out.
      return { sizeBy: 'margin', margin: 100, leverage: 10, account: 1000, risk: 1, riskUnit: '%', lot: 1, profitLine: '#d1d4dc', stopLine: '#f2364566', profitFill: '#d1d4dc1a', stopFill: '#f236451a' };
    case 'channel':
    case 'regression':
    case 'flat':
    case 'disjoint':
    case 'pitchfork':
    case 'schiff':
    case 'mschiff':
      return { color: '#2962ff', width: 1, fillOn: true, fill: '#2962ff1f' };
    case 'fib':
    case 'fibext':
      return { width: 1, fillOn: true, fill: '#2962ff14', extendRight: false };
    case 'fibtime':
    case 'fibcircles':
    case 'fibfan':
    case 'gannfan':
      return { color: '#2962ff', width: 1 };
    case 'barspattern':
      return { color: '#2962ff', width: 1 };
    case 'avwap':
      return { color: '#ff9800', width: 1.5 };
    case 'vprofile':
      return { color: '#2962ff', width: 1, fillOn: true, fill: '#2962ff55' };
    case 'gannbox':
      return { color: '#2962ff', width: 1, fillOn: true, fill: '#2962ff14' };
    case 'signpost':
    case 'comment':
      return { color: '#2962ff', textSize: 13 };
    case 'rect':
    case 'rotrect':
    case 'disk':
    case 'ellipse':
    case 'triangle':
      return { color: '#9c27b0', width: 1, fillOn: true, fill: '#9c27b033' };
    case 'arc':
    case 'curve':
    case 'dcurve':
      return { color: '#2962ff', width: 1.5 };
    case 'trendline':
    case 'ray':
    case 'horizontal':
    case 'vertical':
    case 'cross':
      return { color: '#2962ff', width: 1.5 };
    case 'text':
      return { textColor: '#2962ff', textSize: 14 };
    case 'callout':
      return { color: '#2962ff', textSize: 13 };
    case 'marker':
    case 'pricelabel':
    case 'pricenote':
    case 'flag':
    case 'pin':
      return { color: '#2962ff', width: 1.5 };
    default:
      return {};
  }
}

// ---------------------------------------------------------------- templates

export const TEMPLATE_KEY = 'drawingTemplates';

export function templates(): Record<string, Style> {
  const raw = readJson(TEMPLATE_KEY);
  return raw && typeof raw === 'object' ? (raw as Record<string, Style>) : {};
}

// ---------------------------------------------------------------- the last look

/** What a drawing looks like, as against what it does: these carry from one
 *  drawing to the next of its kind, and make a saved style. Extending a line,
 *  its arrows, a position's size and the like stay with the drawing. */
export const LOOK_KEYS = ['color', 'width', 'dash', 'fill', 'fillOn', 'textColor', 'textSize', 'textBg', 'levels', 'levelLabels', 'profitFill', 'stopFill', 'profitLine', 'stopLine'];

export const lookOf = (style: Style): Style => Object.fromEntries(LOOK_KEYS.filter((k) => style[k] !== undefined).map((k) => [k, style[k]!]));

const LOOK_KEY = 'drawingLastLook';

export function lastLooks(): Record<string, Style> {
  const raw = readJson(LOOK_KEY);
  return raw && typeof raw === 'object' ? (raw as Record<string, Style>) : {};
}

/** A drawing restyled: the next one from the same tool starts looking like it.
 *  A preset's drawing carries its tool's name (`tool`), so a fib channel's
 *  levels never become a plain channel's. */
export function rememberLook(kind: string, style: Style): void {
  const all = lastLooks();
  all[typeof style.tool === 'string' ? style.tool : kind] = lookOf(style);
  writePref(LOOK_KEY, JSON.stringify(all));
}

export function forgetLook(kind: string): void {
  const all = lastLooks();
  delete all[kind];
  writePref(LOOK_KEY, JSON.stringify(all));
}

/** The style a new drawing from `tool` starts with: the factory one, the saved
 *  default over it, the look of the last from that tool restyled over both, and
 *  over all of it what makes a preset that tool (a ray's extension, a range's
 *  axis) — its colours and widths are a look like any other. */
export function defaultStyle(tool: string): Style {
  const preset = PRESETS[tool];
  const defining = preset ? Object.fromEntries(Object.entries(preset.style).filter(([k]) => !LOOK_KEYS.includes(k))) : {};
  return { ...factoryStyle(tool), ...(templates()[tool] ?? {}), ...(lastLooks()[tool] ?? {}), ...defining, ...(preset ? { tool } : {}) };
}

// ---------------------------------------------------------------- visibility

export const hiddenUnits = (style: Style): string[] => (typeof style.hideOn === 'string' && style.hideOn ? style.hideOn.split(',') : []);

export const visibleOn = (style: Style, timeframe: string): boolean => !hiddenUnits(style).includes(timeframe.slice(-1));
