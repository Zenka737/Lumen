// End-to-end check of the desktop app via Playwright's Electron driver.
//   node scripts/verify-electron.mjs                 -> runs `electron .` (needs `vite build` first)
//   node scripts/verify-electron.mjs <executable>    -> runs a packaged app binary
// Verifies: window loads, image opened from CLI arg, brush stroke changes pixels, export through the
// native menu writes a PNG, project save writes .lumen, no console/page errors.
import { _electron as electron, chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exe = process.argv[2];
const outDir = mkdtempSync(join(tmpdir(), 'lumen-verify-'));
const image = resolve('build/icons/256x256.png');
const errors = [];
const log = (...a) => console.log('[verify]', ...a);
// In CDP mode Playwright owns downloads (Electron's own save handler is bypassed), so capture and store them ourselves.
let cdpDownloads = false;
const saveDownloads = (pg) => pg.on('download', (d) => { void d.saveAs(join(outDir, d.suggestedFilename())); });
const waitFile = async (re, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = readdirSync(outDir).find((n) => re.test(n));
    if (f && statSync(join(outDir, f)).size > 0) return join(outDir, f);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no file matching ${re} in ${outDir}`);
};

const launchOnce = async () => electron.launch({
  executablePath: exe || (await import('electron')).default,
  args: [...(exe ? [] : ['.']), image, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
  timeout: 45_000,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ...(process.env.CI ? { LUMEN_DISABLE_GPU: '1' } : {}), LUMEN_SAVE_DIR: outDir, LUMEN_USER_DATA: join(outDir, 'profile') },
});
// Playwright's Electron handshake stalls on Windows CI runners (the app itself launches fine), so there we
// fall back to driving the same window over plain CDP. Main-process-only steps (native menu, quit-guard stub) are skipped.
let app = null, child = null;
if (!process.env.VERIFY_CDP) {
  for (let attempt = 1; attempt <= (process.platform === 'win32' ? 1 : 3); attempt++) {
    try { app = await launchOnce(); break; } catch (e) {
      log(`launch attempt ${attempt} failed: ${String(e.message).split('\n')[0]}`);
      if (process.platform !== 'win32' && attempt >= 3) throw e;
    }
  }
}
let page;
if (app) {
  app.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`));
  app.process().stderr?.on('data', (d) => { const s = String(d); if (/\[lumen\]|error/i.test(s) && !/GPU|gpu_|viz|dbus|Gtk|task_policy_set|process_mac/i.test(s)) errors.push(`main: ${s.trim()}`); });
  page = await app.firstWindow();
} else {
  log('Playwright Electron launch unavailable: driving the window over CDP (no native menu / quit-guard steps)');
  const port = 9333;
  child = spawn(exe || (await import('electron')).default, [...(exe ? [] : ['.']), image, `--remote-debugging-port=${port}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    { env: { ...process.env, ...(process.env.CI ? { LUMEN_DISABLE_GPU: '1' } : {}), LUMEN_SAVE_DIR: outDir, LUMEN_USER_DATA: join(outDir, 'profile-cdp') }, stdio: 'ignore' });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!browser) { child.kill(); throw new Error('could not attach over CDP'); }
  const t0 = Date.now();
  cdpDownloads = true;
  while (!page && Date.now() - t0 < 30000) { page = browser.contexts().flatMap((c) => c.pages()).find((pg) => pg.url().startsWith('app://')); if (!page) await new Promise((r) => setTimeout(r, 300)); }
  if (!page) { child.kill(); throw new Error('no app:// page over CDP'); }
}
if (cdpDownloads) saveDownloads(page);
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.waitForFunction(() => !!window.lumen && !!window.lumenDesktop && !!document.querySelector('canvas'), null, { timeout: 30000 });
log('loaded:', await page.title(), 'origin:', await page.evaluate(() => location.origin));
await page.waitForFunction(() => window.lumen.doc.width === 256 && window.lumen.doc.height === 256, null, { timeout: 15000 });
log('opened image from CLI arg: 256x256');

// Draw a stroke with the brush.
await page.evaluate(() => window.lumen.setTool('brush'));
await page.waitForTimeout(300);
const before = await page.evaluate(() => window.lumen.revision);
const box = await page.evaluate(() => {
  const c = [...document.querySelectorAll('canvas')].map((el) => el.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return { x: c.x, y: c.y, width: c.width, height: c.height };
});
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx - 60, cy - 40); await page.mouse.down();
for (let i = 0; i <= 20; i++) await page.mouse.move(cx - 60 + i * 6, cy - 40 + i * 4);
await page.mouse.up();
await page.waitForFunction((b) => window.lumen.revision !== b, before, { timeout: 5000 });
log('brush stroke recorded, history length =', await page.evaluate(() => window.lumen.history.length));

// Export via the native application menu (exercises the menu -> renderer forwarding).
if (app) await app.evaluate(({ Menu }) => {
  const find = (items) => { for (const it of items) { if (it.label === 'Экспорт…') return it; if (it.submenu) { const r = find(it.submenu.items); if (r) return r; } } };
  find(Menu.getApplicationMenu().items).click();
});
else await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+S' : 'Control+Shift+S');
await page.getByRole('button', { name: 'Экспорт', exact: true }).last().click();
const png = await waitFile(/\.png$/);
log('exported', png, statSync(png).size, 'bytes');

await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
const proj = await waitFile(/\.lumen$/);
log('saved project', proj, statSync(proj).size, 'bytes');

writeFileSync(join(outDir, 'screenshot.png'), await page.screenshot());
log('screenshot', join(outDir, 'screenshot.png'));
// New design features: shapes with corner styles, layer styles, keyframe animation (no console errors, renders)
const feat = await page.evaluate(async () => {
  const ed = window.lumen;
  const mk = (type, extra, x, y) => ed.addShapeLayer({ type, w: 120, h: 90, fill: '#4c6ef5', stroke: null, strokeWidth: 0, radius: 20, ...extra }, x, y, type);
  const a = mk('rect', { cornerStyle: 'smooth', radii: [30, 0, 30, 0] }, 20, 20);
  const b = mk('star', { sides: 6, innerRatio: 0.5, cornerStyle: 'cut' }, 200, 20);
  mk('polygon', { sides: 5 }, 380, 20);
  ed.setLayerFx(a.meta.id, { shadow: { on: true, color: '#000000', opacity: 0.4, dx: 4, dy: 6, blur: 10 }, stroke: { on: true, color: '#ffffff', width: 4, pos: 'center', opacity: 1 } });
  ed.doc.animation = { fps: 10, frames: 10, tracks: { [b.meta.id]: { x: [{ f: 0, v: b.meta.x, ease: 'linear' }, { f: 9, v: b.meta.x + 100, ease: 'linear' }], rotation: [{ f: 0, v: 0, ease: 'linear' }, { f: 9, v: 90, ease: 'linear' }] } } };
  ed.animationChanged();
  await new Promise((r) => setTimeout(r, 400));
  const pv = document.querySelector('.timeline-panel canvas');
  return { layers: ed.doc.layers.length, hasPreview: !!pv, fx: !!ed.doc.find(a.meta.id).meta.fx };
});
if (!feat.hasPreview || !feat.fx || feat.layers < 4) throw new Error('new features not working: ' + JSON.stringify(feat));
log('design features OK:', JSON.stringify(feat));

// Quit guard: make the doc dirty, stub the native confirm (answer "quit without saving"), close.
await page.evaluate(() => window.lumen.setTool('brush'));
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 40, cy + 30); await page.mouse.up();
if (app) await app.evaluate(({ dialog }) => { globalThis.__guard = 0; dialog.showMessageBoxSync = () => { globalThis.__guard++; return 0; }; });
const dirty = await page.evaluate(() => window.lumen.revision !== window.lumen.savedRevision);
await page.evaluate(() => window.close()).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const guard = app ? await app.evaluate(() => globalThis.__guard).catch(() => 'n/a (app exited)') : 'skipped (CDP mode)';
log('dirty =', dirty, 'quit-guard prompts =', guard);
if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); else child.kill();
const real = errors.filter((e) => !/Autofill|DevTools|Electron Security Warning/.test(e));
if (real.length) { console.error('[verify] ERRORS:\n' + real.join('\n')); process.exit(1); }
log('OK — no console errors');
