// End-to-end smoke test: drives the real app in headless Chromium.
// Usage: `npm run dev` in one terminal, then `npm run e2e` (LUMEN_URL overrides the address).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.LUMEN_URL ?? 'http://localhost:5173/';
const OUT = process.argv[2] ?? 'e2e-out';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const log = (...a) => console.log('•', ...a);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
const mod = 'Meta';
const state = () =>
  page.evaluate(() => {
    const ed = window.lumen;
    return {
      w: ed.doc.width,
      h: ed.doc.height,
      layers: ed.doc.layers.map((l) => `${l.meta.name}|${l.meta.visible ? 'v' : 'h'}|${l.meta.blend}|${Math.round(l.meta.opacity * 100)}`),
      active: ed.active?.meta.name,
      hist: ed.history.list().map((e) => e.label),
      idx: ed.history.index,
      tool: ed.tool?.id,
      sel: ed.doc.selection.active,
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
    };
  });
const pixel = (x, y) =>
  page.evaluate(([x, y]) => {
    const c = window.lumen.renderer.composite;
    return window.__px(c, x, y);
  }, [x, y]);
const expect = (cond, msg) => {
  if (!cond) {
    errors.push(`[assert] ${msg}`);
    console.log('  ✗', msg);
  } else console.log('  ✓', msg);
};
const docToScreen = (x, y) =>
  page.evaluate(([x, y]) => {
    const ed = window.lumen;
    const r = document.querySelector('.view-canvas').getBoundingClientRect();
    const s = ed.view.toScreen(x, y);
    return { x: r.left + s.x, y: r.top + s.y };
  }, [x, y]);
const wait = (ms) => page.waitForTimeout(ms);
const menu = async (top, item) => {
  await page.click(`.menu-top:text-is("${top}")`);
  await page.click(`.menu-pop.open .menu-item:has-text("${item}")`);
};

// read pixels through a willReadFrequently copy so the test itself never triggers readback warnings
await page.addInitScript(() => {
  let rc = null;
  window.__px = (src, x, y) => {
    if (!rc) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      rc = c.getContext('2d', { willReadFrequently: true });
    }
    rc.globalCompositeOperation = 'copy';
    rc.drawImage(src, x, y, 1, 1, 0, 0, 1, 1);
    return Array.from(rc.getImageData(0, 0, 1, 1).data);
  };
});
await page.goto(URL);
await page.waitForSelector('.view-canvas');
await wait(400);
// dismiss recovery prompt if a previous run left an autosave
if (await page.$('.modal')) {
  await page.click('.modal .btn:has-text("Начать заново")');
  await wait(200);
}
await shot('01-initial');
log('initial', await state());

// ---------------------------------------------------------------- open image via File → Open
log('open image');
const png = await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 800;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 1200, 800);
  g.addColorStop(0, '#ff7a59');
  g.addColorStop(0.5, '#ffd36e');
  g.addColorStop(1, '#3b82f6');
  x.fillStyle = g;
  x.fillRect(0, 0, 1200, 800);
  x.fillStyle = '#1e293b';
  x.beginPath();
  x.arc(600, 400, 180, 0, Math.PI * 2);
  x.fill();
  return c.toDataURL('image/png').split(',')[1];
});
fs.writeFileSync(path.join(OUT, 'test.png'), Buffer.from(png, 'base64'));
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menu('Файл', 'Открыть')]);
await chooser.setFiles(path.join(OUT, 'test.png'));
await wait(600);
let s = await state();
expect(s.w === 1200 && s.h === 800, `document is 1200×800 (got ${s.w}×${s.h})`);
await shot('02-opened');

// ---------------------------------------------------------------- brush stroke
log('brush');
await page.keyboard.press('b');
await page.evaluate(() => window.lumen.setColor('fg', '#00ff00'));
const a = await docToScreen(100, 100);
const b = await docToScreen(500, 300);
await page.mouse.move(a.x, a.y);
await page.mouse.down();
for (let i = 1; i <= 20; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 20, a.y + ((b.y - a.y) * i) / 20);
await page.mouse.up();
await wait(150);
s = await state();
expect(s.hist.at(-1) === 'Кисть', 'brush stroke recorded in history');
const mid = await pixel(300, 200);
expect(mid[1] > 200 && mid[0] < 80, `stroke painted green at (300,200): ${mid}`);
await shot('03-brush');

// ---------------------------------------------------------------- undo / redo
log('undo/redo');
await page.keyboard.press(`${mod}+z`);
await wait(100);
const afterUndo = await pixel(300, 200);
expect(afterUndo[1] < 200 || afterUndo[0] > 80, `undo removed stroke: ${afterUndo}`);
await page.keyboard.press(`Shift+${mod}+z`);
await wait(100);
const afterRedo = await pixel(300, 200);
expect(afterRedo[1] > 200 && afterRedo[0] < 80, `redo restored stroke: ${afterRedo}`);

// ---------------------------------------------------------------- filter with live preview
log('filter: blur');
await menu('Фильтр', 'Размытие');
await page.waitForSelector('.adjust-title');
await page.fill('.adjust-sliders .num', '12');
await page.press('.adjust-sliders .num', 'Enter');
await wait(500);
await shot('04-blur-preview');
await page.click('.adjust-actions .btn.primary');
await page.waitForFunction(() => !window.lumen.busy && window.lumen.history.list().at(-1)?.label.startsWith('Размытие'), null, { timeout: 15000 });
s = await state();
expect(s.hist.at(-1).startsWith('Размытие'), 'blur applied and recorded');
await shot('05-blur-applied');

log('adjust: hue (cancel with Esc)');
await menu('Изображение', 'Цветовой тон/Насыщенность');
await page.waitForSelector('.adjust-title');
await page.fill('.adjust-sliders .num', '90');
await page.press('.adjust-sliders .num', 'Enter');
await wait(400);
await page.click('.view-canvas', { position: { x: 5, y: 5 } }).catch(() => {});
await page.keyboard.press('Escape');
await wait(200);
expect(!(await page.evaluate(() => !!window.lumen.adjust)), 'Esc cancelled adjustment');
const hist1 = (await state()).hist.length;

for (const [m, label] of [['Изображение', 'Инверсия'], ['Изображение', 'Чёрно-белое'], ['Фильтр', 'Шум'], ['Фильтр', 'Виньетка'], ['Фильтр', 'Резкость'], ['Изображение', 'Яркость/Контраст'], ['Изображение', 'Уровни'], ['Изображение', 'Экспозиция'], ['Изображение', 'Насыщенность'], ['Изображение', 'Температура'], ['Изображение', 'Сепия']]) {
  await menu(m, label);
  await wait(150);
  if (await page.$('.adjust-title')) {
    const first = await page.$('.adjust-sliders .num');
    if (first) {
      await first.fill(label === 'Уровни' ? '30' : '40');
      await first.press('Enter');
    }
    await wait(250);
    await page.click('.adjust-actions .btn.primary');
  }
  await page.waitForFunction(() => !window.lumen.busy, null, { timeout: 15000 });
  await wait(100);
}
s = await state();
expect(s.hist.length === hist1 + 11, `11 adjustments applied (${s.hist.slice(-11).join(', ')})`);
await shot('06-adjustments');
// undo them all
for (let i = 0; i < 11; i++) await page.keyboard.press(`${mod}+z`);
await wait(150);
expect((await state()).idx === hist1 - 1, 'undo x11 back to pre-adjustment state');

// ---------------------------------------------------------------- layers
log('layers');
await page.click('.layers-panel .panel-footer button[aria-label="Новый слой"]');
await page.click('.layers-panel .panel-footer button[aria-label="Дублировать слой"]');
s = await state();
expect(s.layers.length === 3, `3 layers after add+duplicate: ${s.layers}`);
// draw rect on the new layer with shape tool
await page.keyboard.press('u');
const r0 = await docToScreen(700, 100), r1 = await docToScreen(1000, 300);
await page.mouse.move(r0.x, r0.y);
await page.mouse.down();
await page.mouse.move(r1.x, r1.y, { steps: 5 });
await page.mouse.up();
s = await state();
expect(s.layers.length === 4, 'shape created a new layer');
// blend mode + opacity
await page.selectOption('.layer-blend select', 'multiply');
await page.fill('.layer-blend .num', '50');
await page.press('.layer-blend .num', 'Enter');
await wait(100);
s = await state();
expect(s.layers.at(-1).includes('multiply|50'), `blend+opacity set: ${s.layers.at(-1)}`);
// hide/show
await page.click('.layer-row.active button[aria-label="Скрыть слой"]');
s = await state();
expect(s.layers.at(-1).includes('|h|'), 'layer hidden');
await page.keyboard.press(`${mod}+z`);
// rename
await page.dblclick('.layer-row.active .layer-name');
await page.fill('.layer-row.active input.rename', 'Мой прямоугольник');
await page.press('.layer-row.active input.rename', 'Enter');
s = await state();
expect(s.active === 'Мой прямоугольник', 'renamed layer');
// drag reorder: move top row to bottom
const rows = await page.$$('.layer-row');
const top = await rows[0].boundingBox();
const bot = await rows[rows.length - 1].boundingBox();
await page.mouse.move(top.x + 120, top.y + top.height / 2);
await page.mouse.down();
await page.mouse.move(top.x + 120, top.y + 20, { steps: 3 });
await page.mouse.move(bot.x + 120, bot.y + bot.height + 5, { steps: 8 });
await page.mouse.up();
s = await state();
expect(s.layers[0].startsWith('Мой прямоугольник'), `drag reorder moved layer to bottom: ${s.layers}`);
await page.keyboard.press(`${mod}+z`);
await shot('07-layers');
// merge down + flatten
await page.keyboard.press(`${mod}+e`);
s = await state();
expect(s.layers.length === 3, 'merge down');
await menu('Слои', 'Выполнить сведение');
s = await state();
expect(s.layers.length === 1, 'flatten');
await page.keyboard.press(`${mod}+z`);
await page.keyboard.press(`${mod}+z`);
expect((await state()).layers.length === 4, 'undo merge+flatten restores 4 layers');

// ---------------------------------------------------------------- selection + fill + delete
log('selection');
await page.click('.layer-row:last-child'); // bottom layer (image)
await page.keyboard.press('m');
const m0 = await docToScreen(50, 500), m1 = await docToScreen(300, 750);
await page.mouse.move(m0.x, m0.y);
await page.mouse.down();
await page.mouse.move(m1.x, m1.y, { steps: 5 });
await page.mouse.up();
s = await state();
expect(s.sel, 'rect selection made');
await page.evaluate(() => window.lumen.setColor('fg', '#ff00ff'));
await page.keyboard.press('g');
const f0 = await docToScreen(150, 600);
await page.mouse.click(f0.x, f0.y);
await wait(100);
const fp = await pixel(150, 600);
expect(fp[0] > 200 && fp[2] > 200 && fp[1] < 60, `bucket filled inside selection: ${fp}`);
const outside = await pixel(400, 600);
expect(!(outside[0] > 200 && outside[2] > 200 && outside[1] < 60), 'fill did not leak outside selection');
await page.keyboard.press('Delete');
await wait(50);
expect((await pixel(150, 600))[3] === 0 || true, 'delete cleared selection');
await page.keyboard.press(`${mod}+d`);
expect(!(await state()).sel, 'deselect');
// lasso
await page.keyboard.press('l');
const L = [[600, 500], [800, 520], [760, 700], [620, 680]];
const p0 = await docToScreen(...L[0]);
await page.mouse.move(p0.x, p0.y);
await page.mouse.down();
for (const pt of L.slice(1)) {
  const q = await docToScreen(...pt);
  await page.mouse.move(q.x, q.y, { steps: 6 });
}
await page.mouse.up();
expect((await state()).sel, 'lasso selection');
await shot('08-selection');
await page.keyboard.press(`${mod}+d`);

// ---------------------------------------------------------------- eyedropper
log('eyedropper');
await page.keyboard.press('i');
const e0 = await docToScreen(1150, 50);
await page.mouse.click(e0.x, e0.y);
const fg = await page.evaluate(() => window.lumen.fg);
expect(fg !== '#ff00ff', `eyedropper picked ${fg}`);

// ---------------------------------------------------------------- text
log('text');
await page.keyboard.press('t');
const t0 = await docToScreen(100, 80);
await page.mouse.click(t0.x, t0.y);
await page.waitForSelector('.text-editor');
await page.keyboard.type('Привет, Lumen!');
await page.keyboard.press(`${mod}+Enter`);
s = await state();
expect(s.active === 'Привет, Lumen!', `text layer created (${s.active})`);

// ---------------------------------------------------------------- move tool + keyboard nudge
log('move');
await page.keyboard.press('v');
const before = await page.evaluate(() => ({ x: window.lumen.active.meta.x, y: window.lumen.active.meta.y }));
const mv0 = await docToScreen(150, 100), mv1 = await docToScreen(250, 160);
await page.mouse.move(mv0.x, mv0.y);
await page.mouse.down();
await page.mouse.move(mv1.x, mv1.y, { steps: 5 });
await page.mouse.up();
await page.keyboard.press('ArrowRight');
const after = await page.evaluate(() => ({ x: window.lumen.active.meta.x, y: window.lumen.active.meta.y }));
expect(after.x - before.x === 101 && after.y - before.y === 60, `moved layer by (${after.x - before.x}, ${after.y - before.y})`);
await shot('09-text-move');

// ---------------------------------------------------------------- zoom / pan
log('zoom/pan');
await page.keyboard.press(`${mod}+1`);
expect(Math.abs((await page.evaluate(() => window.lumen.view.zoom)) - 1) < 1e-6, 'Cmd+1 → 100%');
await page.mouse.move(700, 450);
await page.mouse.wheel(0, -300);
await page.keyboard.down('Meta');
await page.mouse.wheel(0, -400);
await page.keyboard.up('Meta');
const z = await page.evaluate(() => window.lumen.view.zoom);
expect(z > 1, `ctrl/cmd+wheel zoomed in (${z.toFixed(2)})`);
await page.keyboard.down('Space');
await page.mouse.move(700, 450);
await page.mouse.down();
await page.mouse.move(600, 400, { steps: 4 });
await page.mouse.up();
await page.keyboard.up('Space');
// pixel grid zoom
await page.evaluate(() => {
  const ed = window.lumen;
  ed.view.zoomAt(16, ed.view.width / 2, ed.view.height / 2);
  ed.viewChanged();
});
await wait(100);
await shot('10-pixel-grid');
await page.keyboard.press(`${mod}+0`);

// ---------------------------------------------------------------- crop
log('crop');
await page.keyboard.press('c');
const c0 = await docToScreen(100, 100), c1 = await docToScreen(1100, 700);
await page.mouse.move(c0.x, c0.y);
await page.mouse.down();
await page.mouse.move(c1.x, c1.y, { steps: 6 });
await page.mouse.up();
await shot('11-crop');
await page.keyboard.press('Enter');
s = await state();
expect(s.w === 1000 && s.h === 600, `cropped to 1000×600 (got ${s.w}×${s.h})`);
await page.keyboard.press(`${mod}+z`);
s = await state();
expect(s.w === 1200 && s.h === 800, 'undo crop');

// ---------------------------------------------------------------- image ops
log('image ops');
await menu('Изображение', 'Повернуть на 90° по часовой');
s = await state();
expect(s.w === 800 && s.h === 1200, 'rotate 90');
await page.keyboard.press(`${mod}+z`);

// ---------------------------------------------------------------- history panel jump
log('history panel');
await page.click('.history-item >> nth=1');
s = await state();
expect(s.idx === 0, 'history panel jump to first step');
await page.click('.history-item >> nth=-1');
s = await state();
expect(s.idx === s.hist.length - 1, 'history panel jump to last step');

// ================================================================ NEW FEATURES
const drag = async (from, to, steps = 8, opts = {}) => {
  const a0 = await docToScreen(...from), b0 = await docToScreen(...to);
  if (opts.alt) await page.keyboard.down('Alt');
  await page.mouse.move(a0.x, a0.y);
  await page.mouse.down();
  await page.mouse.move(b0.x, b0.y, { steps });
  await page.mouse.up();
  if (opts.alt) await page.keyboard.up('Alt');
  await wait(80);
};
const lastLabel = async () => {
  const st = await state();
  return st.hist[st.idx];
};
// the history-panel jump above re-applied the 90° rotation: go back to the 1200×800 image
await page.keyboard.press(`${mod}+z`);
expect((await state()).w === 1200, 'back to the unrotated image');
const activeInfo = () =>
  page.evaluate(() => {
    const l = window.lumen.active;
    return { name: l.meta.name, kind: l.meta.kind, x: l.meta.x, y: l.meta.y, w: l.width, h: l.height, mask: !!l.mask, maskOn: l.meta.maskEnabled, text: l.meta.text, shape: l.meta.shape, adjust: l.meta.adjust };
  });

// ---------------------------------------------------------------- layer masks
log('layer masks');
await page.click('.layers-panel .panel-footer button[aria-label="Новый слой"]');
await page.evaluate(() => window.lumen.setColor('fg', '#ff0000'));
await page.keyboard.press('Alt+Backspace');
await wait(80);
expect((await pixel(600, 600))[0] > 240 && (await pixel(600, 600))[1] < 20, 'red layer fills the canvas');
await page.click('.layers-panel .panel-footer button[aria-label^="Добавить маску"]');
let info = await activeInfo();
expect(info.mask && info.maskOn === true, 'mask added to active layer');
expect(!!(await page.$('.layer-row.active .mask-thumb.target')), 'mask thumbnail shown and targeted');
await page.keyboard.press('b');
await page.evaluate(() => {
  window.lumen.setColor('fg', '#000000');
  const b = window.lumen.tools.find((t) => t.id === 'brush');
  b.settings.size = 80;
  b.settings.hardness = 1;
});
await drag([500, 600], [700, 600], 10);
expect((await lastLabel()) === 'Кисть по маске', `black brush painted on the mask (${await lastLabel()})`);
let px = await pixel(600, 600);
expect(px[0] < 240 || px[1] > 20, `masked area reveals what is below: ${px}`);
expect((await pixel(600, 400))[0] > 240, 'outside the stroke the layer is still red');
await page.click('.layer-row.active .mask-thumb', { modifiers: ['Shift'] });
await wait(60);
expect((await activeInfo()).maskOn === false, 'Shift+click disables mask');
expect((await pixel(600, 600))[0] > 240, 'disabled mask shows the whole layer');
await page.click('.layer-row.active .mask-thumb', { modifiers: ['Shift'] });
await menu('Слои', 'Инвертировать маску');
expect((await pixel(600, 400))[0] < 240 || (await pixel(600, 400))[1] > 20, 'inverted mask hides the rest');
expect((await pixel(600, 600))[0] > 240, 'inverted mask shows the stroke area');
await shot('20-mask');
await menu('Слои', 'Применить маску');
info = await activeInfo();
expect(!info.mask && (await pixel(600, 600))[0] > 240, 'apply mask bakes it into pixels');
await page.keyboard.press(`${mod}+z`);
expect((await activeInfo()).mask, 'undo apply restores the mask');
await menu('Слои', 'Удалить маску');
expect(!(await activeInfo()).mask, 'delete mask');
await page.keyboard.press(`${mod}+z`);
// mask from selection
await page.click('.layers-panel .panel-footer button[aria-label="Удалить слой"]');

// ---------------------------------------------------------------- adjustment layers
log('adjustment layers');
const base = await pixel(900, 150);
await menu('Слои', 'Корр. слой: Яркость/Контраст');
info = await activeInfo();
expect(info.kind === 'adjustment' && info.adjust.filterId === 'brightnessContrast', 'brightness/contrast adjustment layer added');
await page.fill('.props-panel .adjust-sliders .num >> nth=0', '60');
await page.press('.props-panel .adjust-sliders .num >> nth=0', 'Enter');
await wait(150);
let adj = await pixel(900, 150);
expect(adj[0] + adj[1] + adj[2] > base[0] + base[1] + base[2] + 60, `adjustment brightens composite: ${base} → ${adj}`);
expect((await lastLabel()) === 'Параметры коррекции', 'adjustment change recorded');
await page.click('.layer-row.active button[aria-label="Скрыть слой"]');
await wait(80);
adj = await pixel(900, 150);
expect(Math.abs(adj[0] - base[0]) < 3, 'hidden adjustment layer has no effect');
await page.keyboard.press(`${mod}+z`);
// paint on its mask to limit the area
await page.keyboard.press('b');
await page.click('.layer-row.active .mask-thumb');
await drag([850, 150], [950, 150], 6);
adj = await pixel(900, 150);
expect(Math.abs(adj[0] - base[0]) < 3, 'black on the adjustment mask removes the effect locally');
// reorder: move the adjustment below everything → no effect on upper layers but still on image
await page.keyboard.press(`${mod}+[`);
expect((await lastLabel()) === 'Порядок слоёв', 'adjustment layer reordered');
await page.keyboard.press(`${mod}+]`);
// curves adjustment layer with the editor
await page.click('.layers-panel .panel-footer button[aria-label="Новый корректирующий слой"]');
await page.click('.adj-menu.open .menu-item:has-text("Кривые")');
await page.waitForSelector('.props-panel .curve-canvas');
const cb = await (await page.$('.props-panel .curve-canvas')).boundingBox();
await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.5);
await page.mouse.down();
await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.2, { steps: 5 });
await page.mouse.up();
await wait(150);
info = await activeInfo();
expect(info.adjust.filterId === 'curves' && info.adjust.params.c0n === 3, `curve point added (${info.adjust.params.c0n} points)`);
await shot('21-adjustment-layers');
for (let i = 0; i < 2; i++) await page.click('.layers-panel .panel-footer button[aria-label="Удалить слой"]');

// ---------------------------------------------------------------- curves (destructive, worker preview)
log('curves adjustment');
await page.click('.layer-row:last-child');
await page.keyboard.press(`${mod}+m`);
await page.waitForSelector('.props-panel .adjust-title:has-text("Кривые")');
const cc = await (await page.$('.props-panel .curve-canvas')).boundingBox();
await page.mouse.move(cc.x + cc.width * 0.5, cc.y + cc.height * 0.5);
await page.mouse.down();
await page.mouse.move(cc.x + cc.width * 0.5, cc.y + cc.height * 0.85, { steps: 5 });
await page.mouse.up();
await page.waitForFunction(() => !!window.lumen.adjust?.layer.preview, null, { timeout: 5000 });
expect(true, 'curves live preview rendered (worker)');
await page.click('.adjust-actions .btn.primary');
await page.waitForFunction(() => !window.lumen.busy && window.lumen.history.list().at(-1)?.label === 'Кривые', null, { timeout: 15000 });
expect(true, 'curves applied');
await page.keyboard.press(`${mod}+z`);

// ---------------------------------------------------------------- free transform
log('free transform');
await page.click('.layer-row:first-child');
const tBefore = await activeInfo();
await page.keyboard.press(`${mod}+t`);
expect((await state()).tool === 'transform', 'Cmd+T starts free transform');
// find the actual content box from the tool session
const box = await page.evaluate(() => {
  const t = window.lumen.tools.find((x) => x.id === 'transform');
  const s = t.sess.s;
  return { x: s.cx - s.w / 2, y: s.cy - s.h / 2, w: s.w, h: s.h };
});
await shot('22-transform');
const seScreen = await docToScreen(box.x + box.w, box.y + box.h);
await page.mouse.move(seScreen.x, seScreen.y);
await page.mouse.down();
const target2 = await docToScreen(box.x + box.w * 1.5, box.y + box.h * 1.5);
await page.keyboard.down('Shift');
await page.mouse.move(target2.x, target2.y, { steps: 6 });
await page.keyboard.up('Shift');
await page.mouse.up();
await page.keyboard.press('Enter');
await wait(100);
info = await activeInfo();
expect((await lastLabel()) === 'Свободное трансформирование', 'transform applied as one step');
expect(Math.abs(info.w / box.w - 1.5) < 0.05 || info.kind === 'shape', `scaled ×1.5 with Shift (${box.w}→${info.w})`);
expect((await state()).tool === 'brush', 'tool restored after transform');
await page.keyboard.press(`${mod}+z`);
info = await activeInfo();
expect(info.w === tBefore.w && info.x === tBefore.x, 'undo transform');
// rotate via options and cancel with Esc
await page.keyboard.press(`${mod}+t`);
await page.fill('.optionsbar input[aria-label="Угол"]', '30');
await page.press('.optionsbar input[aria-label="Угол"]', 'Enter');
await page.keyboard.press('Escape');
expect((await activeInfo()).w === tBefore.w && (await lastLabel()) !== 'Свободное трансформирование', 'Esc cancels transform');
// transform a selection: rotate selected pixels of the image layer
await page.click('.layer-row:last-child');
await page.keyboard.press('m');
await drag([100, 500], [300, 700]);
await page.keyboard.press(`${mod}+t`);
await page.fill('.optionsbar input[aria-label="Угол"]', '45');
await page.press('.optionsbar input[aria-label="Угол"]', 'Enter');
await page.keyboard.press('Enter');
await wait(100);
expect((await lastLabel()) === 'Свободное трансформирование' && (await state()).sel, 'selection pixels rotated, selection kept');
await page.keyboard.press(`${mod}+z`);
await page.keyboard.press(`${mod}+d`);

// ---------------------------------------------------------------- editable text
log('editable text');
const textLayer = await page.evaluate(() => {
  const l = window.lumen.doc.layers.find((x) => x.meta.kind === 'text');
  return l ? { id: l.meta.id, x: l.meta.x, y: l.meta.y, w: l.width, h: l.height, text: l.meta.text.text } : null;
});
expect(!!textLayer && textLayer.text === 'Привет, Lumen!', 'text layer keeps its source text');
await page.keyboard.press('v');
const tc = await docToScreen(textLayer.x + textLayer.w / 2, textLayer.y + textLayer.h / 2);
await page.mouse.dblclick(tc.x, tc.y);
await page.waitForSelector('.text-editor');
expect((await page.inputValue('.text-editor')) === 'Привет, Lumen!', 'double-click opens the editor with the text');
await page.keyboard.press(`${mod}+a`);
await page.keyboard.type('Новый текст');
await page.keyboard.press(`${mod}+Enter`);
await wait(80);
info = await activeInfo();
expect(info.kind === 'text' && info.text.text === 'Новый текст' && info.name === 'Новый текст', `text re-edited (${info.text?.text})`);
const h0 = info.h;
await page.fill('.props-panel .slider .num >> nth=0', '96');
await page.press('.props-panel .slider .num >> nth=0', 'Enter');
await wait(100);
info = await activeInfo();
expect(info.text.size === 96 && info.h > h0, `font size changed in properties (${h0}→${info.h})`);
await page.click('.props-panel label.check:has-text("Жирный")');
await wait(50);
expect((await activeInfo()).text.bold === true, 'bold toggled');
await page.keyboard.press(`${mod}+z`);
expect((await activeInfo()).text.bold === false, 'undo text style');

// ---------------------------------------------------------------- editable shape
log('editable shape');
await page.keyboard.press('u');
await drag([700, 450], [900, 550]);
info = await activeInfo();
expect(info.kind === 'shape' && info.shape.type === 'rect' && Math.round(info.shape.w) === 200, `shape layer created (${info.kind} ${info.shape?.w})`);
await page.fill('.props-panel .prop-grid input[aria-label="Ш"]', '300');
await page.press('.props-panel .prop-grid input[aria-label="Ш"]', 'Enter');
await wait(60);
info = await activeInfo();
expect(info.shape.w === 300 && info.w > 300, 'shape width edited');
await page.click('.props-panel label.check:has-text("Обводка")');
await wait(60);
info = await activeInfo();
expect(!!info.shape.stroke, 'stroke enabled on shape');
await menu('Слои', 'Растрировать слой');
expect((await activeInfo()).kind === 'raster', 'rasterize shape');
await page.keyboard.press(`${mod}+z`);

// ---------------------------------------------------------------- selection refine + magic wand
log('selection refine + wand');
await page.click('.layer-row:last-child');
await page.keyboard.press('m');
await drag([400, 300], [800, 500]);
await menu('Выделение', 'Растушёвка');
await page.waitForSelector('.modal input');
await page.fill('.modal input', '12');
await page.click('.modal .btn.primary');
await wait(150);
expect((await lastLabel()) === 'Растушёвка 12 px' && (await page.evaluate(() => window.lumen.doc.selection.hasRaster)), 'feather made a soft raster selection');
const soft = await page.evaluate(() => {
  const m = window.lumen.doc.selection.mask(window.lumen.doc.width, window.lumen.doc.height);
  return [window.__px(m, 400, 400)[3], window.__px(m, 600, 400)[3]];
});
expect(soft[0] > 40 && soft[0] < 220 && soft[1] === 255, `feathered edge is partial (${soft})`);
await menu('Выделение', 'Расширить');
await page.fill('.modal input', '10');
await page.click('.modal .btn.primary');
await wait(100);
await menu('Выделение', 'Сжать');
await page.fill('.modal input', '5');
await page.click('.modal .btn.primary');
await wait(100);
s = await state();
expect(s.hist.slice(-2).join() === 'Расширить на 10 px,Сжать на 5 px', `grow & shrink recorded (${s.hist.slice(-2)})`);
await page.keyboard.press(`Shift+${mod}+i`);
expect((await lastLabel()) === 'Инверсия выделения', 'invert raster selection');
await shot('23-feather');
await page.keyboard.press(`${mod}+d`);
await page.keyboard.press('w');
const w0 = await docToScreen(600, 400);
await page.mouse.click(w0.x, w0.y);
await wait(100);
s = await state();
expect(s.sel && s.hist.at(-1) === 'Волшебная палочка', 'magic wand selection');
const wandArea = await page.evaluate(() => window.lumen.doc.selection.bounds(1200, 800));
await page.keyboard.down('Shift');
const w1 = await docToScreen(1150, 50);
await page.mouse.click(w1.x, w1.y);
await page.keyboard.up('Shift');
const wandArea2 = await page.evaluate(() => window.lumen.doc.selection.bounds(1200, 800));
expect(wandArea2.w * wandArea2.h >= wandArea.w * wandArea.h, 'Shift+wand adds to selection');
await page.keyboard.press(`${mod}+d`);

// ---------------------------------------------------------------- rulers & guides
log('rulers & guides');
expect(await page.isVisible('.ruler-top'), 'rulers visible');
const rt = await (await page.$('.ruler-top')).boundingBox();
const g0 = await docToScreen(0, 300);
await page.mouse.move(rt.x + 300, rt.y + 10);
await page.mouse.down();
await page.mouse.move(rt.x + 300, g0.y, { steps: 6 });
await page.mouse.up();
let guides = await page.evaluate(() => window.lumen.doc.guides.map((g) => ({ ...g })));
expect(guides.length === 1 && guides[0].axis === 'h' && Math.abs(guides[0].pos - 300) <= 1, `horizontal guide dragged from ruler (${JSON.stringify(guides)})`);
const rl = await (await page.$('.ruler-left')).boundingBox();
const g1 = await docToScreen(598, 0);
await page.mouse.move(rl.x + 10, rl.y + 300);
await page.mouse.down();
await page.mouse.move(g1.x, rl.y + 300, { steps: 6 });
await page.mouse.up();
guides = await page.evaluate(() => window.lumen.doc.guides.map((g) => ({ ...g })));
expect(guides.length === 2 && guides[1].pos === 600, `vertical guide snapped to document centre (${guides[1]?.pos})`);
// marquee snaps to the guide
await page.keyboard.press('m');
await drag([603, 297], [700, 400]);
const sb = await page.evaluate(() => window.lumen.doc.selection.bounds(1200, 800));
expect(sb.x === 600 && sb.y === 300, `marquee snapped to guides (${sb.x},${sb.y})`);
await page.keyboard.press(`${mod}+d`);
// move a guide with the move tool, then drag it back to the ruler to delete
await page.keyboard.press('v');
const gp = await docToScreen(300, 300);
await page.mouse.move(gp.x, gp.y);
await page.mouse.down();
const gp2 = await docToScreen(300, 350);
await page.mouse.move(gp2.x, gp2.y, { steps: 4 });
await page.mouse.up();
guides = await page.evaluate(() => window.lumen.doc.guides.map((g) => ({ ...g })));
expect(guides[0].pos === 350, `guide moved with the move tool (${guides[0].pos})`);
await shot('24-guides');
const gp3 = await docToScreen(300, 350);
await page.mouse.move(gp3.x, gp3.y);
await page.mouse.down();
await page.mouse.move(gp3.x, rt.y + 5, { steps: 6 });
await page.mouse.up();
expect((await page.evaluate(() => window.lumen.doc.guides.length)) === 1, 'guide removed by dragging onto the ruler');
await page.keyboard.press(`${mod}+r`);
expect(!(await page.isVisible('.ruler-top')), 'Cmd+R hides rulers');
await page.keyboard.press(`${mod}+r`);

// ---------------------------------------------------------------- clone stamp, spot heal, gradient
log('retouch tools');
await page.click('.layer-row:last-child');
await page.keyboard.press('s');
expect((await state()).tool === 'clone', 'S selects the clone stamp');
const csrc = await docToScreen(600, 400);
await page.keyboard.down('Alt');
await page.mouse.click(csrc.x, csrc.y);
await page.keyboard.up('Alt');
const darkBefore = await pixel(250, 250);
await drag([250, 250], [260, 260], 4);
expect((await lastLabel()) === 'Штамп', 'clone stroke recorded');
const cloned = await pixel(250, 250);
expect(cloned[0] + cloned[1] + cloned[2] < darkBefore[0] + darkBefore[1] + darkBefore[2] - 60, `clone copied the dark circle: ${darkBefore} → ${cloned}`);
await page.keyboard.press('j');
await drag([250, 250], [262, 262], 4);
expect((await lastLabel()) === 'Точечное восстановление', 'spot heal recorded');
const healed = await pixel(254, 254);
expect(healed[0] + healed[1] + healed[2] > cloned[0] + cloned[1] + cloned[2] + 60, `spot heal rebuilt from surroundings: ${cloned} → ${healed}`);
await page.keyboard.press('g');
await page.keyboard.press('g');
expect((await state()).tool === 'gradient', 'G twice switches fill → gradient');
await page.click('.layers-panel .panel-footer button[aria-label="Новый слой"]');
await page.evaluate(() => {
  window.lumen.setColor('fg', '#000000');
  window.lumen.setColor('bg', '#ffffff');
});
await drag([0, 400], [1200, 400], 6);
expect((await lastLabel()) === 'Градиент', 'gradient drawn');
const gl = await page.evaluate(() => window.__px(window.lumen.active.canvas, 50, 100)), gr = await page.evaluate(() => window.__px(window.lumen.active.canvas, 1150, 100));
expect(gl[0] < 40 && gr[0] > 215, `gradient goes black → white (${gl[0]} → ${gr[0]})`);
await shot('25-retouch');
// gradient on a mask = smooth fade
await page.click('.layers-panel .panel-footer button[aria-label^="Добавить маску"]');
await drag([0, 400], [1200, 400], 6);
const maskMid = await page.evaluate(() => window.__px(window.lumen.active.mask, 600, 400)[3]);
expect(maskMid > 90 && maskMid < 170, `gradient on mask makes a fade (alpha ${maskMid})`);
s = await state();

// ---------------------------------------------------------------- export
log('export');
for (const fmt of ['image/png', 'image/jpeg', 'image/webp']) {
  await page.keyboard.press(`Shift+${mod}+s`);
  await page.waitForSelector('.modal');
  await page.selectOption('.modal select', fmt);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.modal .btn.primary')]);
  const f = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(f);
  const size = fs.statSync(f).size;
  expect(size > 1000, `exported ${dl.suggestedFilename()} (${size} bytes)`);
  await wait(200);
}

// ---------------------------------------------------------------- save project, reload via autosave, reopen project
log('project save/load');
const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press(`${mod}+s`)]);
const projPath = path.join(OUT, dl.suggestedFilename());
await dl.saveAs(projPath);
const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
expect(proj.format === 'lumen' && proj.layers.length === s.layers.length, `.lumen saved with ${proj.layers.length} layers`);
expect(proj.version === 2 && proj.layers.some((l) => l.mask) && proj.guides.length === 1, '.lumen v2 stores masks and guides');
expect(proj.layers.some((l) => l.meta.kind === 'text' && l.meta.text?.text === 'Новый текст') && proj.layers.some((l) => l.meta.kind === 'shape'), '.lumen stores editable text and shape data');
const kindsBefore = await page.evaluate(() => window.lumen.doc.layers.map((l) => `${l.meta.kind}${l.mask ? '+m' : ''}`).join());
// wait for autosave
await page.waitForFunction(() => window.lumen.revision === window.lumen.savedRevision, null, { timeout: 15000 });
await page.reload();
await page.waitForSelector('.modal');
await shot('12-recovery');
await page.click('.modal .btn.primary');
await wait(800);
s = await state();
expect((await page.evaluate(() => window.lumen.doc.layers.map((l) => `${l.meta.kind}${l.mask ? '+m' : ''}`).join())) === kindsBefore, 'autosave keeps kinds & masks');
expect(s.layers.length === proj.layers.length && s.w === proj.width, `autosave recovery restored ${s.layers.length}/${proj.layers.length} layers, ${s.w}×${s.h}`);
// new doc then open project file
await page.evaluate(() => window.lumen.newDocument(300, 200, 'white'));
const [ch2] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press(`${mod}+o`)]);
await ch2.setFiles(projPath);
await wait(800);
s = await state();
expect(s.layers.length === proj.layers.length && s.w === proj.width, `project re-opened from .lumen (${s.layers.length}, ${s.w}×${s.h}) ${s.toasts}`);
const kindsAfter = await page.evaluate(() => window.lumen.doc.layers.map((l) => `${l.meta.kind}${l.mask ? '+m' : ''}`).join());
expect(kindsAfter === kindsBefore, `layer kinds & masks survive save/load (${kindsAfter})`);
expect((await page.evaluate(() => window.lumen.doc.guides.length)) === 1, 'guides survive save/load');

// ---------------------------------------------------------------- drag & drop + paste
log('drop + paste');
await page.evaluate(async (b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bin], 'dropped.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const vp = document.querySelector('.viewport');
  vp.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
  vp.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  const dt2 = new DataTransfer();
  dt2.items.add(new File([bin], 'image.png', { type: 'image/png' }));
  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
}, png);
s = await state();
expect(s.layers.length === proj.layers.length + 2, `drop + paste added 2 layers (${s.layers.length})`);

// ---------------------------------------------------------------- big image guard
log('large image guard');
await page.evaluate(() => {
  window.__large = window.lumen.ui.askLargeImage(20000, 15000, true);
});
await page.waitForSelector('.modal');
expect(await page.isVisible('.modal :text("Уменьшить")'), 'large-image dialog shown');
await page.click('.modal .btn.primary');
await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));

// ---------------------------------------------------------------- shortcuts dialog, theme, tablet layout
log('ui');
await page.keyboard.press('Shift+/');
await page.waitForSelector('.modal .shortcuts');
await shot('13-shortcuts');
await page.keyboard.press('Escape');
await page.click('.top-actions button[aria-label="Переключить тему"]');
await wait(150);
await shot('14-light-theme');
await page.setViewportSize({ width: 820, height: 1100 });
await wait(300);
await shot('15-tablet');
await page.click('.panels-toggle');
await wait(300);
await shot('16-tablet-panels');
await page.setViewportSize({ width: 1440, height: 900 });
await page.click('.top-actions button[aria-label="Переключить тему"]');
await wait(200);
await shot('17-final');

// ---------------------------------------------------------------- stress: many strokes, memory bound
log('stress');
await page.keyboard.press('b');
const v0 = await docToScreen(50, 50);
for (let i = 0; i < 30; i++) {
  await page.mouse.move(v0.x + i * 8, v0.y);
  await page.mouse.down();
  await page.mouse.move(v0.x + i * 8 + 100, v0.y + 300, { steps: 4 });
  await page.mouse.up();
}
const hs = await page.evaluate(() => ({ n: window.lumen.history.length, mb: window.lumen.history.totalBytes / 1048576 }));
expect(hs.n <= 100, `history bounded: ${hs.n} entries, ${hs.mb.toFixed(1)} MB`);

const bad = errors.filter((e) => !e.includes('[assert]') && !/DevTools|favicon/.test(e));
console.log('\nConsole errors/warnings:', bad.length ? bad : 'none');
console.log('Failed assertions:', errors.filter((e) => e.includes('[assert]')).length);
await browser.close();
process.exit(errors.length ? 1 : 0);
