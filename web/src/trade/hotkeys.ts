/**
 * Keys bound to trading lines (`bind alt+1 = buy $500`): listened for on the
 * whole page once any is bound, and done as if typed in the Commands palette.
 * Not while typing in a field, unless the key has Ctrl, Alt or Meta in it.
 *
 * It imports nothing until a bound key is pressed: the app loads it at start
 * when keys are bound, and every byte of it is in everyone's first download.
 */
let on = false;

const binds = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem('tradoor:tradeBinds') ?? '{}') ?? {};
  } catch {
    return {};
  }
};

/** As trade/commands `keyOf`: ctrl, alt, shift, meta, then the key by its place on the keyboard. */
const keyOf = (e: KeyboardEvent) => [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta', /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase() ?? /^Digit(\d)$/.exec(e.code)?.[1] ?? e.key.toLowerCase()].filter(Boolean).join('+');

export function install(): void {
  if (on) return;
  on = true;
  document.addEventListener(
    'keydown',
    (e) => {
      const line = binds()[keyOf(e)];
      if (!line) return;
      const t = e.target;
      const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (typing && !(e.ctrlKey || e.altKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      void import('./command-run').then((m) => m.runLine(line));
    },
    true,
  );
}

install();
