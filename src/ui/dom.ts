type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> | null | undefined;

/**
 * Hyperscript helper. `on*` props become listeners, `class`/`style`/`html` are special,
 * everything else becomes an attribute (booleans toggle presence).
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
      else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = Boolean(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function clear(el: Element): void {
  // replaceChildren is atomic: blur handlers fired by removing a focused input can't corrupt the loop
  el.replaceChildren();
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl+';
export const SHIFT = isMac ? '⇧' : 'Shift+';
export const ALT = isMac ? '⌥' : 'Alt+';

/** Formats "mod+shift+z" style combos for display. */
export function fmtKey(combo: string): string {
  return combo
    .split('+')
    .map((p) => {
      const k = p.toLowerCase();
      if (k === 'mod') return MOD;
      if (k === 'shift') return SHIFT;
      if (k === 'alt') return ALT;
      if (k === 'space') return 'Пробел';
      if (k === 'enter') return 'Enter';
      if (k === 'esc') return 'Esc';
      if (k === 'del') return 'Del';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join('');
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLSelectElement) return false;
  if (t instanceof HTMLInputElement) return !['range', 'checkbox', 'radio', 'button', 'color'].includes(t.type);
  return false;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void } {
  let t = 0;
  const d = (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}
