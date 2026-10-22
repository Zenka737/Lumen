import type { Editor } from '../core/editor';
import { IMAGE_ACCEPT, pickFiles } from '../core/imageio';
import { FILTER_LIST } from '../filters/filters';
import { aboutDialog, exportDialog, newDocumentDialog, newGuideDialog, promptNumber, resizeDialog, saveProject, shortcutsDialog } from './dialogs';
import { ADJUSTMENT_LAYER_TYPES } from '../core/editor';
import { FILTERS } from '../filters/filters';
import type { TransformTool } from '../tools/transform';
import { isMac } from './dom';
import { confirmDialog } from './overlays';

export interface Command {
  id: string;
  label: string;
  /** e.g. "mod+shift+z"; first is displayed. */
  keys?: string[];
  run(): void;
  enabled?(): boolean;
}

export interface MenuDef {
  label: string;
  items: (string | '-')[];
}

export interface AppHooks {
  toggleTheme(): void;
  togglePanels(): void;
  toggleRulers(): void;
  openFiles(files: File[], asLayer: boolean): void;
}

export function createCommands(ed: Editor, app: AppHooks): Map<string, Command> {
  const hasSel = () => ed.doc.selection.active;
  const idx = () => ed.doc.indexOf(ed.doc.activeId);
  const hasMask = () => !!ed.active?.mask;
  const editable = () => ed.active?.meta.kind === 'text' || ed.active?.meta.kind === 'shape';
  const refine = async (title: string, label: string, def: number, fn: (v: number) => void) => {
    if (!hasSel()) return ed.ui.toast('Сначала создайте выделение', 'warn');
    const v = await promptNumber(title, label, def, 0, 500);
    if (v !== null && v > 0) {
      ed.setBusy(`${title}…`);
      try {
        fn(v);
      } finally {
        ed.setBusy(null);
      }
    }
  };
  const list: Command[] = [
    // file
    { id: 'file.new', label: 'Новый документ…', keys: ['alt+mod+n'], run: () => newDocumentDialog(ed) },
    { id: 'file.open', label: 'Открыть…', keys: ['mod+o'], run: async () => app.openFiles(await pickFiles(`${IMAGE_ACCEPT},.lumen,application/json`), false) },
    { id: 'file.place', label: 'Поместить изображение как слой…', keys: ['shift+mod+p'], run: async () => app.openFiles(await pickFiles(IMAGE_ACCEPT, true), true) },
    { id: 'file.save', label: 'Сохранить проект (.lumen)', keys: ['mod+s'], run: () => void saveProject(ed) },
    { id: 'file.export', label: 'Экспорт…', keys: ['shift+mod+s', 'alt+shift+mod+s'], run: () => exportDialog(ed) },
    {
      id: 'file.clearAutosave',
      label: 'Очистить автосохранение',
      run: async () => {
        if (await confirmDialog('Очистить автосохранение?', 'Резервная копия в браузере будет удалена. Текущий документ останется открытым.', 'Очистить', true)) {
          await ed.discardAutosave();
          ed.savedRevision = -1;
          ed.ui.toast('Автосохранение очищено', 'success');
        }
      },
    },
    // edit
    { id: 'edit.undo', label: 'Отменить', keys: ['mod+z'], run: () => ed.undo(), enabled: () => ed.history.canUndo || !!ed.adjust },
    { id: 'edit.redo', label: 'Повторить', keys: ['shift+mod+z', 'mod+y'], run: () => ed.redo(), enabled: () => ed.history.canRedo },
    { id: 'edit.cut', label: 'Вырезать', keys: ['mod+x'], run: () => void ed.cut() },
    { id: 'edit.copy', label: 'Копировать', keys: ['mod+c'], run: () => void ed.copy(false) },
    { id: 'edit.copyMerged', label: 'Копировать совмещённые данные', keys: ['shift+mod+c'], run: () => void ed.copy(true) },
    { id: 'edit.paste', label: 'Вставить', keys: [], run: () => pasteFromClipboard(ed, app) },
    { id: 'edit.clear', label: 'Очистить', keys: ['delete', 'backspace'], run: () => ed.clearPixels() },
    { id: 'edit.fillFg', label: 'Залить основным цветом', keys: ['alt+delete', 'alt+backspace'], run: () => ed.fillWith(ed.fg) },
    { id: 'edit.fillBg', label: 'Залить фоновым цветом', keys: ['mod+delete', 'mod+backspace'], run: () => ed.fillWith(ed.bg) },
    { id: 'edit.transform', label: 'Свободное трансформирование', keys: ['mod+t', 'alt+mod+t'], run: () => (ed.tools.find((t) => t.id === 'transform') as TransformTool | undefined)?.start() },
    // select
    { id: 'select.all', label: 'Выделить всё', keys: ['mod+a'], run: () => ed.selectAll() },
    { id: 'select.none', label: 'Снять выделение', keys: ['mod+d'], run: () => ed.deselect(), enabled: hasSel },
    { id: 'select.invert', label: 'Инвертировать', keys: ['shift+mod+i'], run: () => ed.invertSelection() },
    { id: 'select.feather', label: 'Растушёвка…', keys: ['shift+f6'], run: () => void refine('Растушёвка', 'Радиус', 10, (v) => ed.featherSelection(v)), enabled: hasSel },
    { id: 'select.grow', label: 'Расширить…', run: () => void refine('Расширить выделение', 'На', 5, (v) => ed.growSelection(Math.round(v))), enabled: hasSel },
    { id: 'select.shrink', label: 'Сжать…', run: () => void refine('Сжать выделение', 'На', 5, (v) => ed.growSelection(-Math.round(v))), enabled: hasSel },
    { id: 'select.wand', label: 'Волшебная палочка', keys: [], run: () => ed.setTool('wand') },
    { id: 'select.fromMask', label: 'Загрузить маску как выделение', run: () => ed.selectionFromMask(), enabled: hasMask },
    // image
    { id: 'image.size', label: 'Размер изображения…', keys: ['alt+mod+i'], run: () => resizeDialog(ed, 'image') },
    { id: 'image.canvas', label: 'Размер холста…', keys: ['alt+mod+c'], run: () => resizeDialog(ed, 'canvas') },
    { id: 'image.rotCW', label: 'Повернуть на 90° по часовой', run: () => ed.rotate(90) },
    { id: 'image.rotCCW', label: 'Повернуть на 90° против часовой', run: () => ed.rotate(-90) },
    { id: 'image.rot180', label: 'Повернуть на 180°', run: () => ed.rotate(180) },
    { id: 'image.flipH', label: 'Отразить по горизонтали', run: () => ed.flip('h') },
    { id: 'image.flipV', label: 'Отразить по вертикали', run: () => ed.flip('v') },
    { id: 'image.cropSel', label: 'Кадрировать по выделению', run: () => { const b = ed.doc.selection.bounds(ed.doc.width, ed.doc.height); if (b) ed.crop(b); }, enabled: hasSel },
    // layer
    { id: 'layer.new', label: 'Новый слой', keys: ['shift+mod+n', 'alt+shift+n'], run: () => void ed.addLayer() },
    { id: 'layer.duplicate', label: 'Дублировать слой', keys: ['mod+j'], run: () => ed.duplicateLayer() },
    { id: 'layer.delete', label: 'Удалить слой', run: () => ed.deleteLayer(), enabled: () => ed.doc.layers.length > 1 },
    { id: 'layer.up', label: 'Поднять слой', keys: ['mod+]'], run: () => ed.moveLayer(idx(), idx() + 1), enabled: () => idx() < ed.doc.layers.length - 1 },
    { id: 'layer.down', label: 'Опустить слой', keys: ['mod+['], run: () => ed.moveLayer(idx(), idx() - 1), enabled: () => idx() > 0 },
    { id: 'layer.flipH', label: 'Отразить слой по горизонтали', run: () => ed.flip('h', true) },
    { id: 'layer.flipV', label: 'Отразить слой по вертикали', run: () => ed.flip('v', true) },
    { id: 'layer.mask.reveal', label: 'Маска: показать всё', run: () => ed.addMask('reveal'), enabled: () => !hasMask() },
    { id: 'layer.mask.hide', label: 'Маска: скрыть всё', run: () => ed.addMask('hide'), enabled: () => !hasMask() },
    { id: 'layer.mask.selection', label: 'Маска из выделения', run: () => ed.addMask('selection'), enabled: () => !hasMask() && hasSel() },
    { id: 'layer.mask.edit', label: 'Рисовать по маске / по слою', keys: ['mod+\\'], run: () => ed.setMaskEdit(!ed.maskEdit), enabled: hasMask },
    { id: 'layer.mask.toggle', label: 'Включить/выключить маску', run: () => ed.toggleMask(), enabled: hasMask },
    { id: 'layer.mask.invert', label: 'Инвертировать маску', run: () => ed.invertLayerMask(), enabled: hasMask },
    { id: 'layer.mask.apply', label: 'Применить маску', run: () => ed.applyMask(), enabled: hasMask },
    { id: 'layer.mask.delete', label: 'Удалить маску', run: () => ed.deleteMask(), enabled: hasMask },
    { id: 'layer.rasterize', label: 'Растрировать слой', run: () => void ed.rasterizeLayer(), enabled: editable },
    ...ADJUSTMENT_LAYER_TYPES.map((id) => ({ id: `layer.adj.${id}`, label: `Корр. слой: ${FILTERS[id]!.label}`, run: () => void ed.addAdjustmentLayer(id) })),
    { id: 'layer.mergeDown', label: 'Объединить с нижним', keys: ['mod+e'], run: () => ed.mergeDown(), enabled: () => idx() > 0 },
    { id: 'layer.flatten', label: 'Выполнить сведение', keys: ['shift+mod+e'], run: () => ed.flatten(), enabled: () => ed.doc.layers.length > 1 },
    // view
    { id: 'view.zoomIn', label: 'Приблизить', keys: ['mod+=', 'shift+mod+='], run: () => { ed.view.stepZoom(1); ed.viewChanged(); } },
    { id: 'view.zoomOut', label: 'Отдалить', keys: ['mod+-'], run: () => { ed.view.stepZoom(-1); ed.viewChanged(); } },
    { id: 'view.fit', label: 'Подогнать под экран', keys: ['mod+0'], run: () => ed.fit() },
    { id: 'view.actual', label: 'Реальный размер (100%)', keys: ['mod+1'], run: () => ed.actualPixels() },
    { id: 'view.grid', label: 'Пиксельная сетка (при увеличении)', run: () => { if (ed.renderer) { ed.renderer.showPixelGrid = !ed.renderer.showPixelGrid; ed.renderer.markView(); } } },
    { id: 'view.rulers', label: 'Линейки', keys: ['mod+r'], run: () => app.toggleRulers() },
    {
      id: 'view.guides',
      label: 'Показать/скрыть направляющие',
      keys: ['mod+;'],
      run: () => {
        if (!ed.renderer) return;
        ed.renderer.showGuides = !ed.renderer.showGuides;
        ed.renderer.markView();
        ed.ui.toast(ed.renderer.showGuides ? 'Направляющие показаны' : 'Направляющие скрыты');
      },
    },
    { id: 'view.snap', label: 'Привязка', keys: ['shift+mod+;'], run: () => { ed.snapEnabled = !ed.snapEnabled; ed.ui.toast(ed.snapEnabled ? 'Привязка включена' : 'Привязка выключена'); } },
    { id: 'view.newGuide', label: 'Новая направляющая…', run: () => void newGuideDialog(ed) },
    { id: 'view.clearGuides', label: 'Удалить направляющие', run: () => ed.clearGuides(), enabled: () => ed.doc.guides.length > 0 },
    { id: 'view.panels', label: 'Показать/скрыть панели', keys: ['tab'], run: () => app.togglePanels() },
    { id: 'view.theme', label: 'Светлая/тёмная тема', run: () => app.toggleTheme() },
    // help
    { id: 'help.shortcuts', label: 'Горячие клавиши', keys: ['?', 'shift+/'], run: () => shortcutsDialog() },
    { id: 'help.about', label: 'О программе', run: () => aboutDialog() },
  ];
  for (const f of FILTER_LIST) list.push({ id: `filter.${f.id}`, label: f.params.length || f.custom ? `${f.label}…` : f.label, keys: f.id === 'curves' ? ['mod+m'] : f.id === 'levels' ? ['mod+l'] : undefined, run: () => ed.startAdjust(f.id) });
  return new Map(list.map((c) => [c.id, c]));
}

export const MENUS: MenuDef[] = [
  { label: 'Файл', items: ['file.new', 'file.open', 'file.place', '-', 'file.save', 'file.export', '-', 'file.clearAutosave'] },
  { label: 'Правка', items: ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.copyMerged', 'edit.paste', 'edit.clear', '-', 'edit.fillFg', 'edit.fillBg', '-', 'edit.transform'] },
  { label: 'Изображение', items: ['image.size', 'image.canvas', '-', 'image.rotCW', 'image.rotCCW', 'image.rot180', 'image.flipH', 'image.flipV', '-', 'image.cropSel', '-', ...FILTER_LIST.filter((f) => f.group === 'adjust').map((f) => `filter.${f.id}`)] },
  { label: 'Слои', items: ['layer.new', 'layer.duplicate', 'layer.delete', '-', ...ADJUSTMENT_LAYER_TYPES.map((id) => `layer.adj.${id}`), '-', 'layer.mask.reveal', 'layer.mask.hide', 'layer.mask.selection', 'layer.mask.edit', 'layer.mask.toggle', 'layer.mask.invert', 'layer.mask.apply', 'layer.mask.delete', '-', 'layer.up', 'layer.down', 'layer.flipH', 'layer.flipV', 'layer.rasterize', '-', 'layer.mergeDown', 'layer.flatten'] },
  { label: 'Выделение', items: ['select.all', 'select.none', 'select.invert', '-', 'select.feather', 'select.grow', 'select.shrink', '-', 'select.wand', 'select.fromMask'] },
  { label: 'Фильтр', items: FILTER_LIST.filter((f) => f.group === 'filter').map((f) => `filter.${f.id}`) },
  { label: 'Вид', items: ['view.zoomIn', 'view.zoomOut', 'view.fit', 'view.actual', '-', 'view.rulers', 'view.guides', 'view.snap', 'view.newGuide', 'view.clearGuides', '-', 'view.grid', 'view.panels', 'view.theme'] },
  { label: 'Справка', items: ['help.shortcuts', 'help.about'] },
];

/** Paste via the async Clipboard API (menu); keyboard paste uses the paste event. */
async function pasteFromClipboard(ed: Editor, app: AppHooks): Promise<void> {
  try {
    if (navigator.clipboard && 'read' in navigator.clipboard) {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await it.getType(type);
          app.openFiles([new File([blob], 'Вставка.png', { type })], true);
          return;
        }
      }
    }
  } catch {
    /* permission denied → fall back to internal clipboard */
  }
  if (!ed.pasteInternal()) ed.ui.toast(`Буфер обмена пуст. Используйте ${isMac ? '⌘' : 'Ctrl+'}V`, 'warn');
}

/** Normalises a KeyboardEvent into "alt+shift+mod+key" form. */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod');
  let k = e.key.toLowerCase();
  // use physical key for letters/digits so layouts (e.g. Russian ЙЦУКЕН) and Alt-modified keys still work
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (e.code === 'BracketLeft') k = '[';
  else if (e.code === 'BracketRight') k = ']';
  else if (e.code === 'Equal') k = '=';
  else if (e.code === 'Minus') k = '-';
  else if (e.code === 'Slash') k = '/';
  else if (e.code === 'Semicolon') k = ';';
  else if (e.code === 'Backslash') k = '\\';
  parts.push(k);
  return parts.join('+');
}

/** Normalises a declared combo to the same canonical order. */
export function normCombo(c: string): string {
  const ps = c.toLowerCase().split('+');
  const key = ps.pop() || '+';
  const mods = ['alt', 'shift', 'mod'].filter((m) => ps.includes(m));
  return [...mods, key === '' ? '+' : key].join('+');
}
