import { assertEquals } from 'jsr:@std/assert';
import { engineKind, factoryStyle, lookOf } from './drawing-style.ts';

Deno.test('a look carries colours and widths, not what the drawing does', () => {
  const style = { color: '#ff0000', width: 3, extendLeft: true, extendRight: true, rightArrow: true, pane: 'rsi', fill: '#00ff0033', stats: true };
  assertEquals(lookOf(style), { color: '#ff0000', width: 3, fill: '#00ff0033' });
});

Deno.test('a preset is its kind drawn a set way', () => {
  assertEquals(engineKind('extended'), 'trendline');
  assertEquals(engineKind('rect'), 'rect');
  assertEquals(factoryStyle('extended'), { color: '#2962ff', width: 1.5, extendLeft: true, extendRight: true });
  assertEquals(lookOf({ tool: 'fibchannel', color: '#ff0000' }), { color: '#ff0000' }, 'the tool is not part of the look');
});
