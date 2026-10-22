import { loadAutosave } from '../core/autosave';
import type { Editor } from '../core/editor';
import { docFromRecord } from '../core/project';
import { BrushTool } from '../tools/brush';
import { TOOL_GROUPS } from '../tools/index';
import { MarqueeTool } from '../tools/selection';
import { createCanvasView } from './canvasView';
import { comboFromEvent, createCommands, MENUS, normCombo, type Command } from './commands';
import { newDocumentDialog } from './dialogs';
import { clear, fmtKey, h, isTypingTarget } from './dom';
import { icons } from './icons';
import { dialogOpen, openDialog, toast } from './overlays';
import { createColorPanel } from './panels/color';
import { createHistoryPanel } from './panels/history';
import { createLayersPanel } from './panels/layers';
import { createPropertiesPanel } from './panels/properties';

const LS = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(`lumen.${k}`);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(`lumen.${k}`, v);
    } catch {
      /* private mode */
    }
  },
};

export function mountApp(root: HTMLElement, ed: Editor): void {
  /* ----------------------------------------------------------- theme */
  const applyTheme = (t: 'dark' | 'light') => {
    document.documentElement.dataset.theme = t;
    LS.set('theme', t);
    themeBtn.innerHTML = t === 'dark' ? icons.sun : icons.moon;
    themeBtn.dataset.tip = t === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    ed.renderer?.readTheme();
  };
  const themeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Переключить тему' });
  themeBtn.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

  /* ----------------------------------------------------------- file opening */
  const openFiles = async (files: File[], asLayer: boolean) => {
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const isProject = /\.lumen$|\.json$/i.test(f.name);
      await ed.openFile(f, isProject ? false : asLayer || i > 0);
    }
  };

  const shell = h('div', { class: 'app' });
  const commands = createCommands(ed, {
    toggleTheme: () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
    togglePanels: () => shell.classList.toggle('panels-hidden'),
    toggleRulers: () => {
      rulers.setVisible(!rulers.visible);
      LS.set('rulers', rulers.visible ? '1' : '0');
    },
    openFiles: (f, l) => void openFiles(f, l),
  });

  /* ----------------------------------------------------------- menubar */
  const menubar = buildMenubar(commands);
  const docTitle = h('span', { class: 'doc-title' });
  const saveState = h('span', { class: 'save-state', 'data-tip': 'Автосохранение в браузере' });
  const topbar = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand', html: icons.logo }, h('span', null, 'Lumen')),
    menubar,
    h('div', { class: 'top-center' }, docTitle, saveState),
    h(
      'div',
      { class: 'top-actions' },
      iconBtn(icons.undo, 'Отменить', () => ed.undo(), fmtKey('mod+z')),
      iconBtn(icons.redo, 'Повторить', () => ed.redo(), fmtKey('shift+mod+z')),
      iconBtn(icons.keyboard, 'Горячие клавиши', () => commands.get('help.shortcuts')!.run(), '?'),
      themeBtn,
      h('button', { class: 'btn primary small', type: 'button', onclick: () => commands.get('file.export')!.run(), 'data-tip': 'Экспорт изображения', 'data-key': fmtKey('shift+mod+s'), html: icons.download }, h('span', null, 'Экспорт')),
      iconBtn(icons.panel, 'Панели', () => shell.classList.toggle('panels-open'), 'Tab', 'panels-toggle'),
    ),
  );

  /* ----------------------------------------------------------- options bar */
  const optionsBar = h('div', { class: 'optionsbar', role: 'toolbar', 'aria-label': 'Параметры инструмента' });
  const renderOptions = () => {
    clear(optionsBar);
    const t = ed.tool;
    if (!t) return;
    optionsBar.append(h('span', { class: 'opt-tool', html: t.icon }, h('span', null, t.label)), t.options());
  };
  ed.events.on('tool', renderOptions);
  ed.events.on('toolOptions', renderOptions);
  // brush-like tools show a "Маска" badge: refresh when the paint target changes
  let lastTarget = ed.paintTarget();
  ed.events.on('doc', () => {
    const t = ed.paintTarget();
    if (t !== lastTarget) {
      lastTarget = t;
      renderOptions();
    }
  });

  /* ----------------------------------------------------------- toolbox */
  const toolbox = h('nav', { class: 'toolbox', 'aria-label': 'Инструменты' });
  const toolBtns = new Map<string, HTMLButtonElement>();
  TOOL_GROUPS.forEach((g, gi) => {
    if (gi) toolbox.append(h('span', { class: 'tb-sep' }));
    for (const id of g) {
      const t = ed.tools.find((x) => x.id === id);
      if (!t) continue;
      const b = h('button', { class: 'tool-btn', type: 'button', 'aria-label': t.label, 'data-tip': t.label, 'data-key': t.key.toUpperCase(), 'aria-pressed': 'false' });
      b.innerHTML = t.icon;
      b.addEventListener('click', () => (ed.tool === t && t instanceof MarqueeTool ? t.cycle() : ed.setTool(id)));
      toolBtns.set(id, b);
      toolbox.append(b);
    }
  });
  const fgSw = h('button', { class: 'tb-color fg', type: 'button', 'aria-label': 'Основной цвет', 'data-tip': 'Основной цвет' });
  const bgSw = h('button', { class: 'tb-color bg', type: 'button', 'aria-label': 'Фоновый цвет', 'data-tip': 'Фоновый цвет' });
  const colorStack = h('div', { class: 'tb-colors' }, bgSw, fgSw, h('button', { class: 'tb-swap', type: 'button', html: icons.swap, 'aria-label': 'Поменять цвета', 'data-tip': 'Поменять цвета', 'data-key': 'X', onclick: () => ed.swapColors() }), h('button', { class: 'tb-reset', type: 'button', 'aria-label': 'Цвета по умолчанию', 'data-tip': 'Чёрный/белый', 'data-key': 'D', onclick: () => ed.resetColors() }));
  const openPanel = (id: string) => {
    shell.classList.add('panels-open');
    const sec = panelsEl.querySelector<HTMLElement>(`[data-panel="${id}"]`);
    sec?.classList.remove('collapsed');
    sec?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const openColor = () => openPanel('color');
  fgSw.addEventListener('click', openColor);
  bgSw.addEventListener('click', openColor);
  toolbox.append(h('span', { class: 'tb-grow' }), colorStack);
  const syncToolbox = () => {
    for (const [id, b] of toolBtns) {
      const on = ed.tool?.id === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      const t = ed.tools.find((x) => x.id === id)!;
      if (b.innerHTML !== t.icon) b.innerHTML = t.icon;
    }
  };
  ed.events.on('tool', syncToolbox);
  const syncColors = () => {
    fgSw.style.background = ed.fg;
    bgSw.style.background = ed.bg;
  };
  ed.events.on('colors', syncColors);

  /* ----------------------------------------------------------- panels */
  const panelsEl = h('aside', { class: 'panels', 'aria-label': 'Панели' });
  const section = (id: string, title: string, icon: string, body: HTMLElement, opts: { grow?: boolean } = {}) => {
    const collapsed = LS.get(`panel.${id}`) === '0';
    const head = h('button', { class: 'panel-head', type: 'button', 'aria-expanded': String(!collapsed), html: icons.chevronDown }, h('span', { class: 'panel-icon', html: icon }), h('span', null, title));
    const sec = h('section', { class: `panel${collapsed ? ' collapsed' : ''}${opts.grow ? ' grow' : ''}`, 'data-panel': id }, head, h('div', { class: 'panel-body' }, body));
    head.addEventListener('click', () => {
      const c = sec.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', String(!c));
      LS.set(`panel.${id}`, c ? '0' : '1');
    });
    return sec;
  };
  panelsEl.append(
    section('color', 'Цвет', icons.palette, createColorPanel(ed)),
    section('props', 'Свойства и коррекция', icons.sliders, createPropertiesPanel(ed)),
    section('layers', 'Слои', icons.layers, createLayersPanel(ed), { grow: true }),
    section('history', 'История', icons.history, createHistoryPanel(ed)),
  );
  // properties auto-expands when an adjustment starts
  ed.events.on('adjust', () => {
    if (!ed.adjust) return;
    shell.classList.add('panels-open');
    panelsEl.querySelector('[data-panel="props"]')?.classList.remove('collapsed');
  });

  // resizable panel column
  const splitter = h('div', { class: 'splitter', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Ширина панелей', tabindex: '0' });
  const setPanelW = (w: number) => {
    const c = Math.max(240, Math.min(520, Math.round(w)));
    shell.style.setProperty('--panel-w', `${c}px`);
    LS.set('panelW', String(c));
  };
  setPanelW(Number(LS.get('panelW')) || 300);
  splitter.addEventListener('pointerdown', (e) => {
    splitter.setPointerCapture(e.pointerId);
    shell.classList.add('resizing');
    const move = (ev: PointerEvent) => setPanelW(window.innerWidth - ev.clientX);
    const up = () => {
      shell.classList.remove('resizing');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
  splitter.addEventListener('keydown', (e) => {
    const cur = parseInt(shell.style.getPropertyValue('--panel-w')) || 300;
    if (e.key === 'ArrowLeft') setPanelW(cur + 16);
    if (e.key === 'ArrowRight') setPanelW(cur - 16);
  });
  splitter.addEventListener('dblclick', () => setPanelW(300));

  /* ----------------------------------------------------------- status bar */
  const zoomInput = h('input', { class: 'zoom-input', type: 'text', 'aria-label': 'Масштаб, %' });
  const sizeEl = h('span', { class: 'st' });
  const cursorEl = h('span', { class: 'st mono' });
  const selEl = h('span', { class: 'st' });
  const histEl = h('span', { class: 'st' });
  zoomInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') zoomInput.blur();
  });
  zoomInput.addEventListener('change', () => {
    const v = parseFloat(zoomInput.value.replace(',', '.'));
    if (isFinite(v) && v > 0) {
      ed.view.zoomAt(v / 100, ed.view.width / 2, ed.view.height / 2);
      ed.viewChanged();
    } else syncStatus();
  });
  const statusbar = h(
    'footer',
    { class: 'statusbar' },
    h('span', { class: 'st zoom' }, iconBtn(icons.zoom, 'Отдалить', () => commands.get('view.zoomOut')!.run(), fmtKey('mod+-'), 'tiny'), zoomInput, h('span', null, '%'), iconBtn(icons.fitScreen, 'Подогнать', () => ed.fit(), fmtKey('mod+0'), 'tiny')),
    sizeEl,
    cursorEl,
    selEl,
    h('span', { class: 'grow' }),
    histEl,
  );
  const syncStatus = () => {
    if (document.activeElement !== zoomInput) zoomInput.value = String(+(ed.view.zoom * 100).toFixed(ed.view.zoom < 0.1 ? 1 : 0));
    sizeEl.textContent = `${ed.doc.width} × ${ed.doc.height} px · ${ed.doc.layers.length} ${plural(ed.doc.layers.length, 'слой', 'слоя', 'слоёв')}`;
    const b = ed.doc.selection.bounds(ed.doc.width, ed.doc.height);
    selEl.textContent = b ? `Выделение: ${b.w} × ${b.h}` : '';
    histEl.textContent = `История: ${ed.history.index + 1}/${ed.history.length}`;
    docTitle.textContent = ed.doc.name;
    document.title = `${ed.doc.name} — Lumen`;
  };
  ed.events.on('view', syncStatus);
  ed.events.on('doc', syncStatus);
  ed.events.on('selection', syncStatus);
  ed.events.on('history', syncStatus);
  ed.events.on('cursor', (c) => {
    cursorEl.textContent = c ? `X: ${Math.floor(c.x)}  Y: ${Math.floor(c.y)}` : '';
  });
  ed.events.on('saved', ({ time, ok }) => {
    saveState.textContent = ok ? `Сохранено ${new Date(time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Автосохранение не удалось';
    saveState.classList.toggle('err', !ok);
  });
  ed.events.on('doc', () => {
    if (ed.revision !== ed.savedRevision) saveState.textContent = 'Изменён';
  });

  /* ----------------------------------------------------------- layout */
  const { root: viewport, rulers } = createCanvasView(ed, (files) => void openFiles(files, true), () => openPanel('props'));
  rulers.setVisible(LS.get('rulers') !== '0');
  const scrim = h('div', { class: 'scrim', onclick: () => shell.classList.remove('panels-open') });
  shell.append(topbar, optionsBar, h('main', { class: 'workspace' }, toolbox, viewport, splitter, panelsEl, scrim), statusbar);
  root.append(shell);

  /* ----------------------------------------------------------- keyboard */
  const keymap = new Map<string, Command>();
  for (const c of commands.values()) for (const k of c.keys ?? []) keymap.set(normCombo(k), c);
  window.addEventListener('keydown', (e) => {
    if (dialogOpen() || e.defaultPrevented) return;
    const typing = isTypingTarget(e.target);
    const combo = comboFromEvent(e);
    if (typing) return;
    // Esc/Enter for adjustments
    if (ed.adjust && e.key === 'Escape') {
      e.preventDefault();
      return ed.cancelAdjust();
    }
    if (ed.adjust && e.key === 'Enter') {
      e.preventDefault();
      return void ed.applyAdjust();
    }
    if (ed.tool?.keydown?.(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      if (ed.doc.selection.active) ed.deselect();
      shell.classList.remove('panels-open');
      return;
    }
    const cmd = keymap.get(combo);
    if (cmd) {
      // allow native copy/paste inside panels' text, but we already returned for typing targets
      if (combo === 'tab' && (e.target as HTMLElement)?.closest?.('.panels, .topbar, .optionsbar, .modal')) return;
      e.preventDefault();
      if (cmd.enabled && !cmd.enabled()) return;
      try {
        cmd.run();
      } catch (err) {
        ed.reportError(err);
      }
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const k = combo.replace(/^shift\+/, '');
    if (k === '[' || k === ']') {
      const t = ed.tool;
      if (t instanceof BrushTool) {
        const s = t.settings.size;
        const step = s < 10 ? 1 : s < 50 ? 5 : s < 200 ? 10 : 25;
        t.setSize(s + (k === ']' ? step : -step));
      }
      e.preventDefault();
      return;
    }
    if (combo === 'x') return ed.swapColors();
    if (combo === 'd') return ed.resetColors();
    const base = combo === 'shift+m' ? 'm' : combo;
    const same = ed.tools.filter((t) => t.key === base);
    if (same.length) {
      e.preventDefault();
      const cur = ed.tool ? same.indexOf(ed.tool) : -1;
      if (cur >= 0 && same.length === 1 && ed.tool instanceof MarqueeTool) ed.tool.cycle();
      // tools sharing a key (G: fill / gradient) cycle on repeated presses
      else ed.setTool(same[cur >= 0 ? (cur + 1) % same.length : 0]!.id);
    }
  });

  /* ----------------------------------------------------------- clipboard paste */
  window.addEventListener('paste', (e) => {
    if (isTypingTarget(e.target) || dialogOpen()) return;
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    e.preventDefault();
    if (files.length) void openFiles(files.map((f) => new File([f], f.name && f.name !== 'image.png' ? f.name : 'Вставка.png', { type: f.type })), true);
    else if (!ed.pasteInternal()) toast('В буфере обмена нет изображения', 'warn');
  });
  window.addEventListener('copy', (e) => {
    if (isTypingTarget(e.target) || dialogOpen()) return;
    e.preventDefault();
    void ed.copy(false);
  });
  window.addEventListener('cut', (e) => {
    if (isTypingTarget(e.target) || dialogOpen()) return;
    e.preventDefault();
    void ed.cut();
  });

  /* ----------------------------------------------------------- unload guard */
  window.addEventListener('beforeunload', (e) => {
    if (ed.revision !== ed.savedRevision && ed.history.length > 0) {
      void ed.autosaveNow();
      e.preventDefault();
      e.returnValue = '';
    }
  });

  applyTheme((LS.get('theme') as 'dark' | 'light' | null) ?? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  renderOptions();
  syncToolbox();
  syncColors();
  syncStatus();
}

/** Offers to restore an autosaved document; resolves true if restored. */
export async function offerRecovery(ed: Editor): Promise<boolean> {
  let rec;
  try {
    rec = await loadAutosave();
  } catch {
    return false;
  }
  if (!rec || !rec.layers?.length) return false;
  return new Promise((resolve) => {
    let restored = false;
    const when = new Date(rec.savedAt).toLocaleString('ru-RU');
    openDialog({
      title: 'Восстановить несохранённую работу?',
      width: 440,
      body: h('div', { class: 'form' }, h('p', null, `Найдена автосохранённая копия «${rec.name}» (${rec.width} × ${rec.height}, слоёв: ${rec.layers.length}).`), h('p', { class: 'hint' }, `Сохранено: ${when}`)),
      onClose: () => resolve(restored),
      buttons: [
        { label: 'Начать заново', action: () => void ed.discardAutosave() },
        {
          label: 'Восстановить',
          primary: true,
          action: async () => {
            try {
              const doc = await docFromRecord(rec);
              ed.loadDoc(doc);
              ed.savedRevision = ed.revision;
              restored = true;
              toast('Документ восстановлен', 'success');
            } catch (e) {
              ed.reportError(e);
            }
          },
        },
      ],
    });
  });
}

function iconBtn(icon: string, tip: string, onClick: () => void, key?: string, extra = ''): HTMLButtonElement {
  const b = h('button', { class: `icon-btn ${extra}`, type: 'button', 'aria-label': tip, 'data-tip': tip, 'data-key': key });
  b.innerHTML = icon;
  b.addEventListener('click', onClick);
  return b;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function buildMenubar(commands: Map<string, Command>): HTMLElement {
  const bar = h('nav', { class: 'menubar', role: 'menubar' });
  let openIdx = -1;
  const tops: HTMLButtonElement[] = [];
  const pops: HTMLElement[] = [];
  const close = () => {
    if (openIdx < 0) return;
    pops[openIdx]!.classList.remove('open');
    tops[openIdx]!.classList.remove('open');
    tops[openIdx]!.setAttribute('aria-expanded', 'false');
    openIdx = -1;
  };
  const open = (i: number, focusFirst = false) => {
    close();
    openIdx = i;
    const pop = pops[i]!;
    // refresh enabled states
    pop.querySelectorAll<HTMLButtonElement>('.menu-item').forEach((b) => {
      const c = commands.get(b.dataset.cmd!);
      b.disabled = !!c?.enabled && !c.enabled();
    });
    pop.classList.add('open');
    tops[i]!.classList.add('open');
    tops[i]!.setAttribute('aria-expanded', 'true');
    if (focusFirst) pop.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus();
  };
  MENUS.forEach((m, i) => {
    const top = h('button', { class: 'menu-top', type: 'button', role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, m.label);
    const pop = h('div', { class: 'menu-pop', role: 'menu' });
    for (const id of m.items) {
      if (id === '-') {
        pop.append(h('div', { class: 'menu-sep', role: 'separator' }));
        continue;
      }
      const c = commands.get(id);
      if (!c) continue;
      const item = h('button', { class: 'menu-item', type: 'button', role: 'menuitem', 'data-cmd': id }, h('span', null, c.label), c.keys?.[0] ? h('span', { class: 'menu-key' }, fmtKey(c.keys[0])) : null);
      item.addEventListener('click', () => {
        close();
        try {
          c.run();
        } catch (e) {
          console.error(e);
        }
      });
      pop.append(item);
    }
    top.addEventListener('click', () => (openIdx === i ? close() : open(i)));
    top.addEventListener('pointerenter', () => {
      if (openIdx >= 0 && openIdx !== i) open(i);
    });
    top.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(i, true);
      }
    });
    pop.addEventListener('keydown', (e) => {
      const items = Array.from(pop.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)'));
      const cur = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') items[(cur + 1) % items.length]?.focus();
      else if (e.key === 'ArrowUp') items[(cur - 1 + items.length) % items.length]?.focus();
      else if (e.key === 'ArrowRight') open((i + 1) % MENUS.length, true);
      else if (e.key === 'ArrowLeft') open((i - 1 + MENUS.length) % MENUS.length, true);
      else if (e.key === 'Escape') {
        close();
        top.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    tops.push(top);
    pops.push(pop);
    bar.append(h('div', { class: 'menu' }, top, pop));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!bar.contains(e.target as Node)) close();
  });
  window.addEventListener('blur', close);
  return bar;
}

export { newDocumentDialog };
