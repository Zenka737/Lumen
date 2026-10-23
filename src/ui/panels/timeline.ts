import { ANIM_PROPS, createAnimation, EASINGS, hasKeyframe, neighbourKeyframe, removeKeyframe, setKeyframe, setLength, stateAt, type AnimProp, type Easing } from '../../core/animation';
import { baseState, renderFrame } from '../../core/animRender';
import { createCanvas, ctx2d } from '../../core/canvas';
import type { Editor } from '../../core/editor';
import { encodeGif } from '../../core/gif';
import { downloadBlob } from '../../core/imageio';
import { button, checkbox, select } from '../controls';
import { clear, h } from '../dom';

const PROP_LABELS: Record<AnimProp, { label: string; step: string; unit: string }> = {
  x: { label: 'X', step: '1', unit: 'px' },
  y: { label: 'Y', step: '1', unit: 'px' },
  scale: { label: 'Масштаб', step: '0.05', unit: '×' },
  rotation: { label: 'Поворот', step: '1', unit: '°' },
  opacity: { label: 'Непрозр.', step: '0.05', unit: '' },
};

/** Timeline panel: preview + playback, keyframes of the active layer and WebM / GIF export. */
export function createTimelinePanel(ed: Editor): HTMLElement {
  const root = h('div', { class: 'timeline-panel' });
  let frame = 0;
  let playing = false;
  let loop = true;
  let raf = 0;
  let lastTick = 0;
  let preview: HTMLCanvasElement | null = null;

  const anim = () => ed.doc.animation;
  const bg = '#ffffff';

  /** Composited frame on an opaque background, at `scale` of the document size. */
  const renderTo = (c: HTMLCanvasElement, f: number) => {
    const x = ctx2d(c);
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = bg;
    x.fillRect(0, 0, c.width, c.height);
    x.scale(c.width / ed.doc.width, c.height / ed.doc.height);
    renderFrame(ed.doc, f, x);
    x.restore();
  };
  const drawPreview = () => {
    if (!preview || !anim()) return;
    const k = Math.min(1, 280 / ed.doc.width);
    const w = Math.max(1, Math.round(ed.doc.width * k)), hh = Math.max(1, Math.round(ed.doc.height * k));
    if (preview.width !== w || preview.height !== hh) {
      preview.width = w;
      preview.height = hh;
    }
    renderTo(preview, frame);
  };

  const stop = () => {
    playing = false;
    cancelAnimationFrame(raf);
  };
  const tick = (t: number) => {
    const a = anim();
    if (!playing || !a) return;
    const dt = t - lastTick;
    const step = Math.floor((dt / 1000) * a.fps);
    if (step >= 1) {
      lastTick = t;
      let nf = frame + step;
      if (nf >= a.frames) {
        if (loop) nf %= a.frames;
        else {
          nf = a.frames - 1;
          playing = false;
        }
      }
      setFrame(nf, false);
      if (!playing) render();
    }
    if (playing) raf = requestAnimationFrame(tick);
  };

  let frameLabel: HTMLElement | null = null;
  let scrub: HTMLInputElement | null = null;
  const setFrame = (f: number, rebuild = true) => {
    const a = anim();
    if (!a) return;
    frame = Math.max(0, Math.min(a.frames - 1, Math.round(f)));
    if (scrub) scrub.value = String(frame);
    if (frameLabel) frameLabel.textContent = `${frame + 1} / ${a.frames} · ${(frame / a.fps).toFixed(2)} с`;
    drawPreview();
    if (rebuild) render();
  };

  /* ------------------------------------------------------------------ export */
  const baseName = () => (ed.doc.name || 'lumen').replace(/[\\/:*?"<>|]+/g, '_');
  const exportSize = (): { w: number; h: number } => {
    const k = Math.min(1, 1920 / Math.max(ed.doc.width, ed.doc.height));
    return { w: Math.max(2, Math.round((ed.doc.width * k) / 2) * 2), h: Math.max(2, Math.round((ed.doc.height * k) / 2) * 2) };
  };
  const exportGif = async () => {
    const a = anim();
    if (!a) return;
    const k = Math.min(1, 800 / Math.max(ed.doc.width, ed.doc.height));
    const w = Math.max(1, Math.round(ed.doc.width * k)), hh = Math.max(1, Math.round(ed.doc.height * k));
    const c = createCanvas(w, hh);
    const frames = [];
    ed.events.emit('busy', 'Экспорт GIF…');
    try {
      for (let f = 0; f < a.frames; f++) {
        renderTo(c, f);
        frames.push({ rgba: ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, w, hh).data.slice(), delayMs: 1000 / a.fps });
        if (f % 4 === 3) await new Promise((r) => setTimeout(r, 0));
      }
      const bytes = encodeGif(w, hh, frames, { loop });
      downloadBlob(new Blob([bytes.slice().buffer], { type: 'image/gif' }), `${baseName()}.gif`);
      ed.ui.toast('GIF сохранён', 'success');
    } catch (e) {
      ed.ui.toast(`Не удалось сохранить GIF: ${(e as Error).message}`, 'error');
    } finally {
      ed.events.emit('busy', null);
    }
  };
  const exportWebm = async () => {
    const a = anim();
    if (!a) return;
    if (typeof MediaRecorder === 'undefined') {
      ed.ui.toast('Запись видео недоступна в этой среде', 'error');
      return;
    }
    const { w, h: hh } = exportSize();
    const c = createCanvas(w, hh);
    const stream = (c as HTMLCanvasElement).captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) {
      ed.ui.toast('WebM не поддерживается', 'error');
      return;
    }
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((res) => (rec.onstop = () => res()));
    ed.events.emit('busy', 'Экспорт видео…');
    try {
      rec.start();
      const t0 = performance.now();
      const total = a.frames;
      for (let f = 0; f < total; f++) {
        renderTo(c, f);
        track.requestFrame?.();
        const due = t0 + ((f + 1) * 1000) / a.fps;
        const wait = due - performance.now();
        await new Promise((r) => setTimeout(r, Math.max(0, wait)));
      }
      rec.stop();
      await done;
      downloadBlob(new Blob(chunks, { type: 'video/webm' }), `${baseName()}.webm`);
      ed.ui.toast('Видео сохранено', 'success');
    } catch (e) {
      ed.ui.toast(`Не удалось сохранить видео: ${(e as Error).message}`, 'error');
    } finally {
      ed.events.emit('busy', null);
    }
  };

  /* ------------------------------------------------------------------ ui */
  const numberInput = (value: number, step: string, onChange: (v: number) => void) => {
    const input = h('input', { type: 'number', class: 'num', value: String(Math.round(value * 1000) / 1000), step });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
    });
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (isFinite(v)) onChange(v);
    });
    return input;
  };

  const layerRows = (): HTMLElement => {
    const a = anim()!;
    const l = ed.active;
    if (!l || l.meta.kind === 'adjustment') return h('div', { class: 'hint' }, 'Выберите слой, чтобы анимировать его.');
    const id = l.meta.id;
    const base = baseState(l);
    const now = stateAt(a, id, frame, base);
    const rows = ANIM_PROPS.map((p) => {
      const has = hasKeyframe(a, id, p, frame);
      const value = now[p];
      const toggle = h('button', { type: 'button', class: `kf-btn${has ? ' on' : ''}`, 'data-tip': has ? 'Удалить ключевой кадр' : 'Добавить ключевой кадр', 'aria-pressed': String(has), 'aria-label': `Ключевой кадр: ${PROP_LABELS[p].label}` }, '◆');
      toggle.addEventListener('click', () => {
        if (has) removeKeyframe(a, id, p, frame);
        else setKeyframe(a, id, p, frame, value);
        ed.animationChanged();
      });
      const input = numberInput(value, PROP_LABELS[p].step, (v) => {
        // first edit of a property creates the start state (frame 0) too, so the motion has somewhere to start from
        if (!a.tracks[id]?.[p]?.length && frame > 0) setKeyframe(a, id, p, 0, base[p], 'ease-in-out');
        setKeyframe(a, id, p, frame, v);
        ed.animationChanged();
      });
      const track = a.tracks[id]?.[p] ?? [];
      const strip = h('div', { class: 'kf-strip', role: 'group', 'aria-label': `Ключи: ${PROP_LABELS[p].label}` });
      for (const k of track) {
        const dot = h('button', { type: 'button', class: `kf-dot${k.f === frame ? ' cur' : ''}`, style: `left:${(k.f / Math.max(1, a.frames - 1)) * 100}%`, 'aria-label': `Кадр ${k.f + 1}` });
        dot.addEventListener('click', () => setFrame(k.f));
        strip.append(dot);
      }
      return h('div', { class: 'kf-row' }, toggle, h('span', { class: 'kf-label' }, PROP_LABELS[p].label), input, h('span', { class: 'unit' }, PROP_LABELS[p].unit), strip);
    });
    // easing of the segment starting at the current keyframe
    const here = ANIM_PROPS.map((p) => a.tracks[id]?.[p]?.find((k) => k.f === frame)).filter((k) => !!k);
    const easeSel = here.length
      ? select<Easing>('Кривая', EASINGS, here[0]!.ease, (v) => {
          for (const p of ANIM_PROPS) {
            const k = a.tracks[id]?.[p]?.find((kk) => kk.f === frame);
            if (k) k.ease = v;
          }
          ed.animationChanged();
        })
      : '';
    const prev = neighbourKeyframe(a, id, frame, -1), next = neighbourKeyframe(a, id, frame, 1);
    return h(
      'div',
      { class: 'prop-stack' },
      h('div', { class: 'cp-sub' }, `Слой: ${l.meta.name}`),
      h('div', { class: 'prop-row' }, button('◀ Ключ', () => prev !== null && setFrame(prev), { ghost: true, tip: 'Предыдущий ключевой кадр' }), button('Ключ ▶', () => next !== null && setFrame(next), { ghost: true, tip: 'Следующий ключевой кадр' }), button('Ключи всех свойств', () => {
        for (const p of ANIM_PROPS) setKeyframe(a, id, p, frame, now[p]);
        ed.animationChanged();
      }, { ghost: true, tip: 'Записать все свойства слоя в текущем кадре' })),
      ...rows,
      easeSel,
    );
  };

  const render = () => {
    clear(root);
    const a = anim();
    if (!a) {
      root.append(
        h('div', { class: 'hint' }, 'Анимация двигает, вращает, масштабирует и проявляет слои по ключевым кадрам. Результат можно сохранить в GIF или WebM.'),
        button('Создать анимацию', () => {
          ed.doc.animation = createAnimation(24, 3);
          frame = 0;
          ed.animationChanged();
        }, { primary: true }),
      );
      return;
    }
    scrub = h('input', { type: 'range', class: 'range', min: '0', max: String(a.frames - 1), step: '1', value: String(frame), 'aria-label': 'Кадр' });
    scrub.addEventListener('input', () => setFrame(Number(scrub!.value), false));
    scrub.addEventListener('change', () => render());
    frameLabel = h('span', { class: 'tl-time' }, `${frame + 1} / ${a.frames} · ${(frame / a.fps).toFixed(2)} с`);
    preview = h('canvas', { class: 'tl-preview', 'aria-label': 'Предпросмотр анимации' });
    const play = button(playing ? '⏸ Пауза' : '▶ Играть', () => {
      if (playing) stop();
      else {
        if (frame >= a.frames - 1) frame = 0;
        playing = true;
        lastTick = performance.now();
        raf = requestAnimationFrame(tick);
      }
      render();
    }, { primary: true, tip: 'Воспроизвести / пауза' });
    const fpsIn = numberInput(a.fps, '1', (v) => {
      setLength(a, v, a.frames);
      ed.animationChanged();
    });
    const secIn = numberInput(a.frames / a.fps, '0.5', (v) => {
      setLength(a, a.fps, Math.round(Math.max(0.1, v) * a.fps));
      frame = Math.min(frame, a.frames - 1);
      ed.animationChanged();
    });
    root.append(
      preview,
      h('div', { class: 'prop-row' }, play, button('⏮', () => setFrame(0), { ghost: true, tip: 'В начало' }), frameLabel),
      scrub,
      h('div', { class: 'prop-grid' }, h('label', { class: 'prop-field' }, h('span', null, 'Кадр/с'), fpsIn), h('label', { class: 'prop-field' }, h('span', null, 'Секунд'), secIn)),
      checkbox('Зациклить', loop, (v) => (loop = v)),
      layerRows(),
      h(
        'div',
        { class: 'prop-row' },
        button('Сохранить GIF', () => void exportGif(), { tip: 'Анимированный GIF (до 800 px)' }),
        button('Сохранить WebM', () => void exportWebm(), { tip: 'Видео WebM (до 1920 px)' }),
        button('Удалить', () => {
          stop();
          ed.doc.animation = undefined;
          ed.animationChanged();
        }, { ghost: true, tip: 'Удалить всю анимацию' }),
      ),
    );
    drawPreview();
  };

  let lastKey = '';
  const refresh = (force = false) => {
    const l = ed.active;
    const key = `${l?.meta.id}:${l?.meta.x}:${l?.meta.y}:${l?.meta.opacity}:${JSON.stringify(anim() ?? '')}:${ed.doc.layers.length}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    if (anim()) frame = Math.min(frame, anim()!.frames - 1);
    if (playing) {
      drawPreview();
      return;
    }
    render();
  };
  ed.events.on('animation', () => refresh(true));
  ed.events.on('doc', () => refresh());
  render();
  return root;
}
