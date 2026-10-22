import type { ToastKind } from '../core/editor';
import { h } from './dom';
import { icons } from './icons';

/* ------------------------------------------------------------------ toasts (non-blocking) */

let toastRoot: HTMLElement | null = null;
export function toast(msg: string, kind: ToastKind = 'info', ms = kind === 'error' ? 6000 : 2600): void {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRoot);
  }
  // collapse duplicates
  for (const el of Array.from(toastRoot.children)) if ((el as HTMLElement).dataset.msg === msg) el.remove();
  const icon = kind === 'error' || kind === 'warn' ? icons.warn : kind === 'success' ? icons.check : icons.info;
  const el = h('div', { class: `toast ${kind}`, 'data-msg': msg, html: icon });
  el.append(h('span', null, msg));
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  el.addEventListener('click', close);
  toastRoot.append(el);
  while (toastRoot.children.length > 4) toastRoot.firstElementChild?.remove();
  setTimeout(close, ms);
}

/* ------------------------------------------------------------------ tooltips */

/** One shared tooltip for all [data-tip] elements; shows the shortcut from [data-key]. */
export function installTooltips(): void {
  const tip = h('div', { class: 'tooltip', role: 'tooltip' });
  document.body.append(tip);
  let timer = 0;
  let current: HTMLElement | null = null;
  const hide = () => {
    clearTimeout(timer);
    tip.classList.remove('show');
    current = null;
  };
  const show = (el: HTMLElement) => {
    const text = el.dataset.tip;
    if (!text) return;
    tip.innerHTML = '';
    tip.append(h('span', null, text));
    if (el.dataset.key) tip.append(h('kbd', null, el.dataset.key));
    const r = el.getBoundingClientRect();
    tip.classList.add('show');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const side = el.closest('.toolbox') ? 'right' : 'bottom';
    let x = side === 'right' ? r.right + 8 : r.left + r.width / 2 - tw / 2;
    let y = side === 'right' ? r.top + r.height / 2 - th / 2 : r.bottom + 6;
    if (y + th > window.innerHeight - 4) y = r.top - th - 6;
    x = Math.max(4, Math.min(window.innerWidth - tw - 4, x));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  document.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return;
    const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    timer = window.setTimeout(() => show(el), 450);
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
}

/* ------------------------------------------------------------------ modal dialogs */

export interface DialogButton {
  label: string;
  primary?: boolean;
  danger?: boolean;
  /** Return false to keep the dialog open. */
  action?: () => boolean | void | Promise<boolean | void>;
}

export interface DialogHandle {
  close(): void;
  el: HTMLElement;
}

let openCount = 0;
export const dialogOpen = () => openCount > 0;

export function openDialog(o: { title: string; body: HTMLElement | string; buttons?: DialogButton[]; width?: number; onClose?: () => void; dismissable?: boolean }): DialogHandle {
  const prevFocus = document.activeElement as HTMLElement | null;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title, style: o.width ? `width:min(${o.width}px, calc(100vw - 32px))` : undefined });
  const body = typeof o.body === 'string' ? h('div', { class: 'modal-text' }, o.body) : o.body;
  const footer = h('div', { class: 'modal-footer' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCount--;
    backdrop.classList.add('out');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => backdrop.remove(), 160);
    prevFocus?.focus?.();
    o.onClose?.();
  };
  const dismissable = o.dismissable !== false;
  const xBtn = h('button', { class: 'icon-btn modal-x', type: 'button', 'aria-label': 'Закрыть', html: icons.close, onclick: () => dismissable && close() });
  box.append(h('div', { class: 'modal-head' }, h('h2', null, o.title), dismissable ? xBtn : null), h('div', { class: 'modal-body' }, body), footer);
  const btns = (o.buttons ?? [{ label: 'OK', primary: true }]).map((b) => {
    const el = h('button', { type: 'button', class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}` }, b.label);
    el.addEventListener('click', async () => {
      el.disabled = true;
      try {
        const r = await b.action?.();
        if (r !== false) close();
      } finally {
        el.disabled = false;
      }
    });
    footer.append(el);
    return { b, el };
  });
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape' && dismissable) {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
      const p = btns.find((x) => x.b.primary);
      if (p) {
        e.preventDefault();
        p.el.click();
      }
    } else if (e.key === 'Tab') {
      // focus trap
      const f = Array.from(box.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((x) => !x.hasAttribute('disabled'));
      if (!f.length) return;
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        f[f.length - 1]!.focus();
      } else if (!e.shiftKey && i === f.length - 1) {
        e.preventDefault();
        f[0]!.focus();
      }
    }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop && dismissable) close();
  });
  backdrop.append(box);
  document.body.append(backdrop);
  openCount++;
  requestAnimationFrame(() => {
    const first = box.querySelector<HTMLElement>('input, select, textarea') ?? btns.find((x) => x.b.primary)?.el ?? xBtn;
    first.focus();
    if (first instanceof HTMLInputElement) first.select();
  });
  return { close, el: box };
}

export function confirmDialog(title: string, text: string, ok = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    openDialog({
      title,
      body: text,
      onClose: () => resolve(result),
      buttons: [
        { label: 'Отмена' },
        { label: ok, primary: true, danger, action: () => void (result = true) },
      ],
    });
  });
}
