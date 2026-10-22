import { MAX_SIDE, resampleCanvas } from '../core/canvas';
import type { Editor } from '../core/editor';
import { downloadBlob, exportCanvas, type ExportFormat } from '../core/imageio';
import { serializeProject } from '../core/project';
import { flattenToCanvas } from '../core/render';
import { checkbox, select, slider } from './controls';
import { fmtKey, h } from './dom';
import { openDialog, toast } from './overlays';
import { SHORTCUT_SECTIONS } from './shortcuts';

const PRESETS = [
  { id: 'custom', label: 'Свой размер', w: 0, h: 0 },
  { id: 'hd', label: 'Full HD 1920×1080', w: 1920, h: 1080 },
  { id: '4k', label: '4K UHD 3840×2160', w: 3840, h: 2160 },
  { id: 'sq', label: 'Квадрат 1080×1080', w: 1080, h: 1080 },
  { id: 'story', label: 'Сторис 1080×1920', w: 1080, h: 1920 },
  { id: 'a4', label: 'A4 300 dpi 2480×3508', w: 2480, h: 3508 },
  { id: 'web', label: 'Веб 1280×800', w: 1280, h: 800 },
];

function numInput(label: string, value: number, min = 1, max = MAX_SIDE): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { type: 'number', class: 'num wide', min, max, value: String(value), 'aria-label': label });
  return { el: h('label', { class: 'field' }, h('span', null, label), input), input };
}

function clampInt(v: string, def: number): number {
  const n = Math.round(Number(v));
  return isFinite(n) && n >= 1 ? Math.min(MAX_SIDE, n) : def;
}

export function newDocumentDialog(ed: Editor): void {
  const name = h('input', { type: 'text', class: 'text', value: 'Без названия', 'aria-label': 'Имя' });
  const w = numInput('Ширина, px', 1920);
  const hh = numInput('Высота, px', 1080);
  let bg: 'white' | 'transparent' | 'bg' = 'white';
  const preset = select('Шаблон', PRESETS.map((p) => ({ id: p.id, label: p.label })), 'hd', (id) => {
    const p = PRESETS.find((x) => x.id === id);
    if (p && p.w) {
      w.input.value = String(p.w);
      hh.input.value = String(p.h);
    }
  });
  openDialog({
    title: 'Новый документ',
    width: 420,
    body: h(
      'div',
      { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Имя'), name),
      preset,
      h('div', { class: 'row2' }, w.el, hh.el),
      select<'white' | 'transparent' | 'bg'>('Фон', [{ id: 'white', label: 'Белый' }, { id: 'transparent', label: 'Прозрачный' }, { id: 'bg', label: 'Фоновый цвет' }], bg, (v) => (bg = v)),
    ),
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Создать',
        primary: true,
        action: () => {
          const W = clampInt(w.input.value, 1920), H = clampInt(hh.input.value, 1080);
          if (W * H > 120_000_000) {
            toast('Слишком большой документ (максимум ~120 Мп)', 'error');
            return false;
          }
          ed.newDocument(W, H, bg, name.value.trim() || 'Без названия');
          return true;
        },
      },
    ],
  });
}

export function exportDialog(ed: Editor): void {
  let format: ExportFormat = 'image/png';
  let quality = 0.92;
  let scale = 100;
  const name = h('input', { type: 'text', class: 'text', value: ed.doc.name, 'aria-label': 'Имя файла' });
  const info = h('div', { class: 'hint' });
  const q = slider({ label: 'Качество', min: 1, max: 100, step: 1, value: 92, unit: '%', onInput: (v) => (quality = v / 100) });
  const sizeInfo = () => {
    const k = scale / 100;
    info.textContent = `Итоговый размер: ${Math.max(1, Math.round(ed.doc.width * k))} × ${Math.max(1, Math.round(ed.doc.height * k))} px${format === 'image/jpeg' ? ' · прозрачность будет заменена белым' : ''}`;
  };
  const setFmt = (v: ExportFormat) => {
    format = v;
    q.el.classList.toggle('disabled', v === 'image/png');
    q.el.querySelectorAll('input').forEach((i) => (i.disabled = v === 'image/png'));
    sizeInfo();
  };
  setFmt('image/png');
  openDialog({
    title: 'Экспорт изображения',
    width: 440,
    body: h(
      'div',
      { class: 'form' },
      h('label', { class: 'field' }, h('span', null, 'Имя файла'), name),
      select<ExportFormat>('Формат', [{ id: 'image/png', label: 'PNG (без потерь, прозрачность)' }, { id: 'image/jpeg', label: 'JPEG' }, { id: 'image/webp', label: 'WebP' }], format, setFmt),
      q.el,
      slider({ label: 'Масштаб', min: 5, max: 200, step: 1, value: 100, unit: '%', onInput: (v) => { scale = v; sizeInfo(); } }).el,
      info,
    ),
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Экспорт',
        primary: true,
        action: async () => {
          ed.setBusy('Экспорт…');
          try {
            let c = flattenToCanvas(ed.doc);
            if (scale !== 100) {
              const k = scale / 100;
              const r = resampleCanvas(c, Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
              c.width = c.height = 1;
              c = r;
            }
            const blob = await exportCanvas(c, format, quality);
            c.width = c.height = 1;
            const ext = format === 'image/png' ? 'png' : format === 'image/jpeg' ? 'jpg' : 'webp';
            if (blob.type !== format) toast('Браузер не поддерживает этот формат — сохранено как PNG', 'warn');
            downloadBlob(blob, `${(name.value.trim() || 'lumen').replace(/[\\/:*?"<>|]+/g, '_')}.${blob.type === format ? ext : 'png'}`);
            toast(`Экспортировано (${(blob.size / 1024).toFixed(0)} КБ)`, 'success');
          } catch (e) {
            ed.reportError(e);
            return false;
          } finally {
            ed.setBusy(null);
          }
          return true;
        },
      },
    ],
  });
}

export async function saveProject(ed: Editor): Promise<void> {
  ed.setBusy('Сохранение проекта…');
  try {
    await new Promise((r) => setTimeout(r, 30));
    const json = JSON.stringify(serializeProject(ed.doc));
    downloadBlob(new Blob([json], { type: 'application/json' }), `${ed.doc.name.replace(/[\\/:*?"<>|]+/g, '_') || 'project'}.lumen`);
    toast('Проект сохранён (.lumen)', 'success');
  } catch (e) {
    ed.reportError(e);
  } finally {
    ed.setBusy(null);
  }
}

export function resizeDialog(ed: Editor, mode: 'image' | 'canvas'): void {
  const W0 = ed.doc.width, H0 = ed.doc.height;
  const w = numInput('Ширина, px', W0);
  const hh = numInput('Высота, px', H0);
  let keep = true;
  w.input.addEventListener('input', () => {
    if (keep) hh.input.value = String(Math.max(1, Math.round((Number(w.input.value) * H0) / W0)));
  });
  hh.input.addEventListener('input', () => {
    if (keep) w.input.value = String(Math.max(1, Math.round((Number(hh.input.value) * W0) / H0)));
  });
  openDialog({
    title: mode === 'image' ? 'Размер изображения' : 'Размер холста',
    width: 400,
    body: h('div', { class: 'form' }, h('div', { class: 'row2' }, w.el, hh.el), checkbox('Сохранять пропорции', keep, (v) => (keep = v)), h('div', { class: 'hint' }, mode === 'image' ? 'Все слои будут масштабированы.' : 'Холст расширяется/обрезается от центра; пиксели слоёв не меняются.')),
    buttons: [
      { label: 'Отмена' },
      {
        label: 'OK',
        primary: true,
        action: () => {
          const W = clampInt(w.input.value, W0), H = clampInt(hh.input.value, H0);
          if (W * H > 120_000_000) {
            toast('Слишком большой размер (максимум ~120 Мп)', 'error');
            return false;
          }
          if (mode === 'image') ed.resizeImage(W, H);
          else ed.canvasSize(W, H);
          return true;
        },
      },
    ],
  });
}

export function shortcutsDialog(): void {
  const body = h('div', { class: 'shortcuts' });
  for (const sec of SHORTCUT_SECTIONS) {
    body.append(
      h('section', null, h('h3', null, sec.title), ...sec.items.map(([keys, label]) => h('div', { class: 'sc-row' }, h('span', null, label), h('span', { class: 'sc-keys' }, ...keys.split(' / ').map((k) => h('kbd', null, fmtKey(k))))))),
    );
  }
  openDialog({ title: 'Горячие клавиши', body, width: 760, buttons: [{ label: 'Закрыть', primary: true }] });
}

export function aboutDialog(): void {
  openDialog({
    title: 'О программе Lumen',
    width: 420,
    body: h(
      'div',
      { class: 'about' },
      h('p', null, h('b', null, 'Lumen'), ' — фоторедактор в браузере: слои, режимы наложения, кисти с нажимом, выделения, коррекция и фильтры в фоновом потоке, история с ограничением памяти и автосохранение.'),
      h('p', { class: 'hint' }, 'Все данные остаются на вашем устройстве. Автосохранение хранится в IndexedDB браузера.'),
    ),
  });
}

export function askLargeImage(w: number, h0: number, must: boolean): Promise<'downscale' | 'keep' | 'cancel'> {
  return new Promise((resolve) => {
    let r: 'downscale' | 'keep' | 'cancel' = 'cancel';
    const mp = ((w * h0) / 1e6).toFixed(1);
    openDialog({
      title: 'Очень большое изображение',
      width: 440,
      body: h(
        'div',
        { class: 'form' },
        h('p', null, `Размер ${w} × ${h0} px (${mp} Мп).`),
        h('p', { class: 'hint' }, must ? 'Изображение превышает возможности холста браузера и будет уменьшено до 8192 px по длинной стороне.' : 'Работа с таким файлом может быть медленной и требовать много памяти. Рекомендуем уменьшить до 8192 px по длинной стороне.'),
      ),
      onClose: () => resolve(r),
      buttons: [
        { label: 'Отмена' },
        ...(must ? [] : [{ label: 'Оставить как есть', action: () => void (r = 'keep') }]),
        { label: 'Уменьшить', primary: true, action: () => void (r = 'downscale') },
      ],
    });
  });
}

/** Asks for one number; resolves null when cancelled. */
export function promptNumber(title: string, label: string, value: number, min: number, max: number, unit = 'px'): Promise<number | null> {
  return new Promise((resolve) => {
    let result: number | null = null;
    const input = h('input', { type: 'number', class: 'num wide', min, max, step: 'any', value: String(value), 'aria-label': label });
    openDialog({
      title,
      width: 360,
      body: h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', null, `${label}, ${unit}`), input)),
      onClose: () => resolve(result),
      buttons: [
        { label: 'Отмена' },
        {
          label: 'OK',
          primary: true,
          action: () => {
            const v = Number(input.value);
            if (!isFinite(v) || v < min || v > max) {
              toast(`Введите число от ${min} до ${max}`, 'warn');
              return false;
            }
            result = v;
            return true;
          },
        },
      ],
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

/** New guide at an exact position. */
export async function newGuideDialog(ed: Editor): Promise<void> {
  const body = h('div', { class: 'form' });
  let axis: 'h' | 'v' = 'v';
  const pos = h('input', { type: 'number', class: 'num wide', value: String(Math.round(ed.doc.width / 2)), 'aria-label': 'Положение' });
  body.append(
    select<'h' | 'v'>('Ориентация', [{ id: 'v', label: 'Вертикальная' }, { id: 'h', label: 'Горизонтальная' }], axis, (v) => {
      axis = v;
      pos.value = String(Math.round((v === 'v' ? ed.doc.width : ed.doc.height) / 2));
    }),
    h('label', { class: 'field' }, h('span', null, 'Положение, px'), pos),
  );
  openDialog({
    title: 'Новая направляющая',
    width: 360,
    body,
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Добавить',
        primary: true,
        action: () => {
          const v = Number(pos.value);
          if (!isFinite(v)) return false;
          ed.addGuide(axis, v);
          return true;
        },
      },
    ],
  });
}
