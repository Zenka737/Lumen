import type { Editor } from '../../core/editor';
import { iconButton } from '../controls';
import { clear, h, MOD, SHIFT } from '../dom';
import { icons } from '../icons';

export function createHistoryPanel(ed: Editor): HTMLElement {
  const list = h('div', { class: 'history-list', role: 'listbox', 'aria-label': 'История' });
  const mem = h('span', { class: 'mem' });
  const footer = h(
    'div',
    { class: 'panel-footer' },
    iconButton(icons.undo, 'Отменить', () => ed.undo(), `${MOD}Z`),
    iconButton(icons.redo, 'Повторить', () => ed.redo(), `${SHIFT}${MOD}Z`),
    h('span', { class: 'spacer' }),
    mem,
  );

  const render = () => {
    clear(list);
    const entries = ed.history.list();
    const idx = ed.history.index;
    const item = (label: string, i: number) => {
      const el = h('button', { type: 'button', class: `history-item${i === idx ? ' current' : ''}${i > idx ? ' future' : ''}`, role: 'option', 'aria-selected': String(i === idx) }, h('span', { class: 'dot' }), label);
      el.addEventListener('click', () => {
        ed.cancelAdjust();
        ed.history.jumpTo(i);
      });
      return el;
    };
    list.append(item(ed.history.trimmed ? `Исходное (старые шаги: ${ed.history.trimmed} удалено)` : 'Исходное состояние', -1));
    entries.forEach((e, i) => list.append(item(e.label, i)));
    const mb = ed.history.totalBytes / 1048576;
    mem.textContent = `${entries.length} шаг. · ${mb < 1 ? '<1' : Math.round(mb)} МБ`;
    // scroll only the list (scrollIntoView would also scroll the whole panel column)
    const cur = list.querySelector<HTMLElement>('.current');
    if (cur) {
      const top = cur.offsetTop; // list is position:relative
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + cur.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + cur.offsetHeight - list.clientHeight;
    }
  };
  ed.events.on('history', render);
  render();
  return h('div', { class: 'history-panel' }, list, footer);
}
