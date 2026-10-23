// End-to-end check of the desktop app via Playwright's Electron driver.
//   node scripts/verify-electron.mjs                 -> runs `electron .` (needs `vite build` first)
//   node scripts/verify-electron.mjs <executable>    -> runs a packaged app binary
// Verifies: window loads, image opened from CLI arg, brush stroke changes pixels, export through the
// native menu writes a PNG, project save writes .lumen, no console/page errors.
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exe = process.argv[2];
const outDir = mkdtempSync(join(tmpdir(), 'lumen-verify-'));
const image = resolve('build/icons/256x256.png');
const errors = [];
const log = (...a) => console.log('[verify]', ...a);
const waitFile = async (re, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = readdirSync(outDir).find((n) => re.test(n));
    if (f && statSync(join(outDir, f)).size > 0) return join(outDir, f);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no file matching ${re} in ${outDir}`);
};

const app = await electron.launch({
  executablePath: exe || electronPath,
  args: [...(exe ? [] : ['.']), image, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
  timeout: 60_000,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ...(process.env.CI ? { LUMEN_DISABLE_GPU: '1' } : {}), LUMEN_SAVE_DIR: outDir, LUMEN_USER_DATA: join(outDir, 'profile') },
});
app.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`));
app.process().stderr?.on('data', (d) => { const s = String(d); if (/\[lumen\]|error/i.test(s) && !/GPU|gpu_|viz|dbus|Gtk/i.test(s)) errors.push(`main: ${s.trim()}`); });
const page = await app.firstWindow();
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
await app.evaluate(({ Menu }) => {
  const find = (items) => { for (const it of items) { if (it.label === 'Экспорт…') return it; if (it.submenu) { const r = find(it.submenu.items); if (r) return r; } } };
  find(Menu.getApplicationMenu().items).click();
});
await page.getByRole('button', { name: 'Экспорт', exact: true }).last().click();
const png = await waitFile(/\.png$/);
log('exported', png, statSync(png).size, 'bytes');

await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
const proj = await waitFile(/\.lumen$/);
log('saved project', proj, statSync(proj).size, 'bytes');

writeFileSync(join(outDir, 'screenshot.png'), await page.screenshot());
log('screenshot', join(outDir, 'screenshot.png'));
// Quit guard: make the doc dirty, stub the native confirm (answer "quit without saving"), close.
await page.evaluate(() => window.lumen.setTool('brush'));
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 40, cy + 30); await page.mouse.up();
await app.evaluate(({ dialog }) => { globalThis.__guard = 0; dialog.showMessageBoxSync = () => { globalThis.__guard++; return 0; }; });
const dirty = await page.evaluate(() => window.lumen.revision !== window.lumen.savedRevision);
await page.evaluate(() => window.close()).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const guard = await app.evaluate(() => globalThis.__guard).catch(() => 'n/a (app exited)');
log('dirty =', dirty, 'quit-guard prompts =', guard);
await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
const real = errors.filter((e) => !/Autofill|DevTools|Electron Security Warning/.test(e));
if (real.length) { console.error('[verify] ERRORS:\n' + real.join('\n')); process.exit(1); }
log('OK — no console errors');
