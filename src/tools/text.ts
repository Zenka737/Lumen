import type { Layer } from '../core/document';
import type { Editor } from '../core/editor';
import type { TextAlign, TextData } from '../core/types';
import { fontCss, TEXT_LINE_HEIGHT, textPad } from '../core/vector';
import { checkbox, select, slider } from '../ui/controls';
import { h } from '../ui/dom';
import { icons } from '../ui/icons';
import type { Tool, ToolPointer } from './tool';

export const FONTS = [
  { id: 'Inter, system-ui, sans-serif', label: 'Sans (Inter/System)' },
  { id: 'Georgia, "Times New Roman", serif', label: 'Serif (Georgia)' },
  { id: '"SF Mono", Menlo, Consolas, monospace', label: 'Моноширинный' },
  { id: '"Helvetica Neue", Arial, sans-serif', label: 'Helvetica / Arial' },
  { id: 'Impact, "Arial Black", sans-serif', label: 'Impact' },
  { id: '"Comic Sans MS", "Comic Neue", cursive', label: 'Comic' },
];

export const ALIGNS: { id: TextAlign; label: string }[] = [
  { id: 'left', label: 'По левому краю' },
  { id: 'center', label: 'По центру' },
  { id: 'right', label: 'По правому краю' },
];

/**
 * Text tool: click to place a floating editor, click an existing text layer (or
 * double-click it with any tool) to edit it again. Text layers stay editable: they keep
 * their source text and style and are re-rendered on every change.
 * Commit: Ctrl/⌘+Enter, click elsewhere or switching tools. Esc cancels.
 */
export class TextTool implements Tool {
  readonly id = 'text';
  readonly label = 'Текст';
  readonly key = 't';
  readonly icon = icons.text;
  font = FONTS[0]!.id;
  size = 48;
  bold = false;
  italic = false;
  align: TextAlign = 'left';
  /** Colour of the text being edited (null = use the main colour). */
  private color: string | null = null;
  private editor: { ta: HTMLTextAreaElement; x: number; y: number; layer: Layer | null } | null = null;
  private committing = false;
  constructor(private ed: Editor) {}
  get active(): boolean {
    return !!this.editor;
  }
  get editingLayer(): Layer | null {
    return this.editor?.layer ?? null;
  }
  cursor(): string {
    return 'text';
  }
  private data(text: string): TextData {
    return { text, font: this.font, size: this.size, color: this.color ?? this.ed.fg, bold: this.bold, italic: this.italic, align: this.align };
  }

  /** Topmost visible text layer under a document point. */
  hitText(x: number, y: number): Layer | null {
    const ls = this.ed.doc.layers;
    for (let i = ls.length - 1; i >= 0; i--) {
      const l = ls[i]!;
      if (!l.meta.visible || l.meta.kind !== 'text' || !l.meta.text) continue;
      if (x >= l.meta.x && y >= l.meta.y && x < l.meta.x + l.width && y < l.meta.y + l.height) return l;
    }
    return null;
  }

  down(p: ToolPointer): void {
    if (this.editor) {
      this.commit();
      return;
    }
    const hit = this.hitText(p.x, p.y);
    if (hit) return this.edit(hit);
    this.open(p.x, p.y, '', null);
  }

  /** Opens the in-place editor on an existing text layer. */
  edit(layer: Layer): void {
    const t = layer.meta.text;
    if (!t) return;
    if (layer.meta.locked) {
      this.ed.ui.toast('Слой заблокирован', 'warn');
      return;
    }
    if (this.editor) this.commit();
    if (this.ed.tool !== (this as Tool)) this.ed.setTool(this.id);
    this.ed.selectLayer(layer.meta.id);
    Object.assign(this, { font: t.font, size: t.size, bold: t.bold, italic: t.italic, align: t.align });
    this.color = t.color;
    const pad = textPad(t.size);
    this.open(layer.meta.x + pad, layer.meta.y + pad, t.text, layer);
    layer.editing = true;
    this.ed.redraw();
    this.ed.events.emit('toolOptions', undefined);
  }

  private open(x: number, y: number, text: string, layer: Layer | null): void {
    if (!this.ed.viewEl) return;
    const ta = h('textarea', { class: 'text-editor', spellcheck: 'false', 'aria-label': 'Ввод текста', placeholder: 'Введите текст…' });
    ta.value = text;
    this.editor = { ta, x, y, layer };
    this.layout();
    ta.addEventListener('input', () => this.layout());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.cancel();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.commit();
      }
    });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.ed.viewEl.append(ta);
    ta.focus({ preventScroll: true });
    if (text) ta.select();
    requestAnimationFrame(() => {
      if (this.editor?.ta === ta && document.activeElement !== ta) ta.focus({ preventScroll: true });
    });
    this.unsubView = this.ed.events.on('view', () => this.layout());
  }
  private unsubView: (() => void) | null = null;

  /** Positions/sizes the floating textarea to match the document zoom. */
  private layout(): void {
    const e = this.editor;
    if (!e) return;
    const v = this.ed.view;
    const s = v.toScreen(e.x, e.y);
    const px = this.size * v.zoom;
    Object.assign(e.ta.style, {
      left: `${s.x}px`,
      top: `${s.y}px`,
      font: fontCss(this, px),
      lineHeight: String(TEXT_LINE_HEIGHT),
      color: this.color ?? this.ed.fg,
      textAlign: this.align,
    });
    e.ta.style.height = '0px';
    e.ta.style.width = '0px';
    e.ta.style.width = `${Math.max(px * 2, e.ta.scrollWidth + px)}px`;
    e.ta.style.height = `${Math.max(px * 1.3, e.ta.scrollHeight)}px`;
  }

  commit(): void {
    const e = this.editor;
    if (!e || this.committing) return;
    this.committing = true;
    const text = e.ta.value.replace(/\s+$/, '');
    this.teardown();
    try {
      if (e.layer) {
        if (!this.ed.doc.layers.includes(e.layer)) return;
        if (!text) this.ed.deleteLayer(e.layer.meta.id);
        else this.ed.updateText(e.layer.meta.id, this.data(text));
        return;
      }
      if (!text) return;
      const t = this.data(text);
      const pad = textPad(t.size);
      // textarea has 2px padding; align layer so glyphs land where they were typed
      this.ed.addTextLayer(t, e.x - pad, e.y - pad + 2 / this.ed.view.zoom);
      this.ed.pushRecent(t.color);
    } finally {
      this.committing = false;
    }
  }

  cancel(): void {
    this.teardown();
  }
  private teardown(): void {
    const e = this.editor;
    this.editor = null;
    this.unsubView?.();
    this.unsubView = null;
    e?.ta.remove();
    if (e?.layer) {
      this.color = null;
      e.layer.editing = false;
      this.ed.redraw();
    }
  }
  deactivate(): void {
    this.commit();
  }

  options(): HTMLElement {
    const refresh = () => this.layout();
    const colorIn = h('input', { type: 'color', class: 'color-input', value: this.color ?? this.ed.fg, 'aria-label': 'Цвет текста', 'data-tip': 'Цвет текста' });
    colorIn.addEventListener('input', () => {
      this.color = colorIn.value;
      refresh();
    });
    return h(
      'div',
      { class: 'opts' },
      select('Шрифт', FONTS, this.font, (v) => {
        this.font = v;
        refresh();
      }),
      slider({ label: 'Размер', min: 6, max: 400, step: 1, value: this.size, unit: 'px', compact: true, onInput: (v) => { this.size = v; refresh(); } }).el,
      colorIn,
      checkbox('Жирный', this.bold, (v) => { this.bold = v; refresh(); }),
      checkbox('Курсив', this.italic, (v) => { this.italic = v; refresh(); }),
      select<TextAlign>('', ALIGNS, this.align, (v) => { this.align = v; refresh(); }),
      h('span', { class: 'hint' }, this.editor?.layer ? 'Правка слоя · Ctrl/⌘+Enter — готово, Esc — отмена' : 'Щелчок — новый текст или правка существующего · Ctrl/⌘+Enter — готово'),
    );
  }
}
