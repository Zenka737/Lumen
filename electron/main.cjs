'use strict';
/**
 * Lumen desktop shell (Electron main process).
 *
 * The renderer is the unmodified Vite web build served from the privileged
 * `app://lumen/` scheme (not file://) so module workers, IndexedDB, fetch and
 * localStorage behave exactly like on the web. Native integration is layered on
 * from the outside: menus, dialogs, file associations, quit guard.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell, session, nativeTheme, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const SCHEME = 'app';
const HOST = 'lumen';
const ORIGIN = `${SCHEME}://${HOST}`;
const isMac = process.platform === 'darwin';
const isDev = !!process.env.LUMEN_DEV_URL;
const SMOKE = process.env.LUMEN_SMOKE === '1'; // CI smoke test: load, report, quit
const DIST = path.join(__dirname, '..', 'dist');
const OPENABLE = /\.(png|jpe?g|webp|gif|bmp|avif|lumen)$/i;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.map': 'application/json', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'" + (isDev ? " 'unsafe-inline'" : ''),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:" + (isDev ? ' ws: http://localhost:*' : ''),
  "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
if (process.env.LUMEN_USER_DATA) app.setPath('userData', process.env.LUMEN_USER_DATA); // isolated profile (tests)
if (process.env.LUMEN_DISABLE_GPU === '1') app.disableHardwareAcceleration();

/* ------------------------------------------------------------ single instance */
const pending = []; // files requested before the window was ready
let win = null;
let forceQuit = false;
let crashes = 0;

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    filesFromArgv(argv, cwd).forEach(openPath);
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } else createWindow();
  });
}
app.on('open-file', (e, p) => { e.preventDefault(); openPath(p); }); // macOS: Finder, dock drop
filesFromArgv(process.argv, process.cwd()).forEach((p) => pending.push(p));

function filesFromArgv(argv, cwd) {
  return argv.slice(app.isPackaged ? 1 : 2)
    .filter((a) => !a.startsWith('-') && OPENABLE.test(a))
    .map((a) => path.resolve(cwd || process.cwd(), a))
    .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

/* ------------------------------------------------------------ window state */
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x < a.x + a.width - 80 && s.x + s.width > a.x + 80 && s.y >= a.y - 20 && s.y < a.y + a.height - 80;
    });
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch { return { width: 1440, height: 900 }; }
}
function saveState() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized(), fullscreen: win.isFullScreen() })); } catch { /* ignore */ }
}

/* ------------------------------------------------------------ window */
function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    x: st.x, y: st.y, width: st.width || 1440, height: st.height || 900, minWidth: 900, minHeight: 600,
    show: false, title: 'Lumen', backgroundColor: '#141416',
    titleBarStyle: isMac ? 'default' : undefined,
    icon: isMac ? undefined : path.join(__dirname, '..', 'build', 'icons', '512x512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      webviewTag: false, spellcheck: false, devTools: isDev || !app.isPackaged || process.env.LUMEN_DEVTOOLS === '1',
    },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => { win.show(); if (st.fullscreen) win.setFullScreen(true); });
  let t; const debounced = () => { clearTimeout(t); t = setTimeout(saveState, 400); };
  win.on('resize', debounced); win.on('move', debounced); win.on('close', saveState);

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN) && !(isDev && url.startsWith(process.env.LUMEN_DEV_URL))) e.preventDefault(); });
  wc.on('will-attach-webview', (e) => e.preventDefault());

  // Unsaved-changes guard: the web app's beforeunload handler blocks unload when dirty.
  wc.on('will-prevent-unload', (e) => {
    if (forceQuit) { e.preventDefault(); return; }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Выйти без сохранения', 'Отмена'], defaultId: 1, cancelId: 1,
      message: 'Есть несохранённые изменения', detail: 'Если выйти сейчас, последние правки будут потеряны (черновик сохранён автоматически).',
    });
    if (choice === 0) e.preventDefault(); // ignore beforeunload -> close proceeds
    else app.__quitting = false;
  });

  // Crash recovery: reload the renderer (autosave restores the draft) unless it crash-loops.
  wc.on('render-process-gone', (_e, d) => {
    console.error('[lumen] renderer gone:', d.reason);
    if (d.reason === 'clean-exit' || win.isDestroyed()) return;
    if (++crashes > 3) { dialog.showErrorBox('Lumen', `Процесс отрисовки аварийно завершился (${d.reason}).`); return; }
    setTimeout(() => !win.isDestroyed() && wc.reload(), 500);
  });
  wc.on('unresponsive', () => console.warn('[lumen] window unresponsive'));
  wc.on('console-message', (e) => {
    const lvl = e.level ?? '';
    if (SMOKE || lvl === 'error' || lvl === 3) console.log(`[renderer:${lvl}] ${e.message}`);
  });

  wc.on('did-finish-load', () => {
    crashes = Math.max(0, crashes - 1);
    void wc.executeJavaScript(BRIDGE_JS).then(flushPending).catch((err) => console.error('[lumen] bridge', err));
    if (SMOKE) void smokeCheck();
  });
  void win.loadURL(isDev ? process.env.LUMEN_DEV_URL : `${ORIGIN}/index.html`);
  win.on('closed', () => { win = null; });
}

/** Injected into the page's main world (trusted, ours): wires the preload bridge to the editor. */
const BRIDGE_JS = `(() => {
  if (window.__lumenBridge || !window.lumenDesktop) return true;
  window.__lumenBridge = true;
  const wait = () => new Promise((r) => { const t = () => window.lumen ? r(window.lumen) : setTimeout(t, 50); t(); });
  window.lumenDesktop.onOpenFile(async (f) => {
    const ed = await wait();
    const type = f.name.toLowerCase().endsWith('.lumen') ? 'application/json' : (f.type || '');
    await ed.openFile(new File([f.data], f.name, { type }), false);
  });
  window.lumenDesktop.ready();
  return true;
})()`;

let rendererReady = false;
ipcMain.on('lumen:ready', () => { rendererReady = true; flushPending(); });
function flushPending() { if (!rendererReady) return; while (pending.length) sendFile(pending.shift()); }
function openPath(p) {
  if (!OPENABLE.test(p)) return;
  app.addRecentDocument(p);
  if (win && rendererReady) sendFile(p); else pending.push(p);
  if (!win && app.isReady()) createWindow();
}
function sendFile(p) {
  fs.promises.readFile(p).then((buf) => {
    const ext = path.extname(p).toLowerCase();
    win?.webContents.send('lumen:open-file', { name: path.basename(p), type: MIME[ext] || (ext === '.jpeg' ? 'image/jpeg' : ''), data: new Uint8Array(buf) });
  }).catch((err) => dialog.showErrorBox('Lumen', `Не удалось открыть файл:\n${p}\n${err.message}`));
}

async function smokeCheck() {
  try {
    const ok = await win.webContents.executeJavaScript(`new Promise((r) => { let n = 0; const t = () => { const ed = window.lumen; if (ed && document.querySelector('canvas')) r({ ok: true, w: ed.doc?.width, h: ed.doc?.height, title: document.title }); else if (++n > 200) r({ ok: false }); else setTimeout(t, 50); }; t(); })`);
    console.log('[lumen-smoke]', JSON.stringify(ok));
    const img = await win.webContents.capturePage();
    if (process.env.LUMEN_SMOKE_SHOT) fs.writeFileSync(process.env.LUMEN_SMOKE_SHOT, img.toPNG());
    forceQuit = true; app.exit(ok.ok ? 0 : 2);
  } catch (e) { console.error('[lumen-smoke] failed', e); app.exit(3); }
}

/* ------------------------------------------------------------ native dialogs */
const IMG_FILTER = { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] };
async function openDialog() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Открыть', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Изображения и проекты Lumen', extensions: [...IMG_FILTER.extensions, 'lumen'] }, IMG_FILTER, { name: 'Проект Lumen', extensions: ['lumen'] }],
  });
  if (!r.canceled) r.filePaths.forEach(openPath);
}
ipcMain.handle('lumen:open-dialog', () => openDialog());

function setupDownloads(ses) {
  // The web app saves via <a download>; turn that into a native Save dialog with proper filters.
  ses.on('will-download', (_e, item) => {
    const name = item.getFilename();
    const ext = path.extname(name).slice(1).toLowerCase();
    const filters = ext === 'lumen' ? [{ name: 'Проект Lumen', extensions: ['lumen'] }]
      : [{ name: ext.toUpperCase() || 'Файл', extensions: [ext || '*'] }];
    if (SMOKE || process.env.LUMEN_SAVE_DIR) { // non-interactive (tests)
      const dir = process.env.LUMEN_SAVE_DIR || app.getPath('temp');
      item.setSavePath(path.join(dir, name));
    } else {
      item.setSaveDialogOptions({ title: ext === 'lumen' ? 'Сохранить проект' : 'Экспорт изображения', defaultPath: path.join(app.getPath('pictures'), name), filters });
    }
    item.once('done', (_ev, state) => { if (state === 'completed') app.addRecentDocument(item.getSavePath()); });
  });
}

/* ------------------------------------------------------------ menu */
function key(accel) { // forward to the web app's own keyboard handler
  return () => {
    if (!win) return;
    const parts = accel.split('+');
    const keyCode = parts.pop();
    const modifiers = parts.map((m) => ({ CmdOrCtrl: isMac ? 'meta' : 'control', Shift: 'shift', Alt: 'alt' }[m]));
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
}
function item(label, accel, extra = {}) {
  return { label, accelerator: accel, registerAccelerator: false, click: key(accel), ...extra };
}
function buildMenu() {
  const t = [];
  if (isMac) t.push({ label: app.name, submenu: [
    { role: 'about', label: 'О программе Lumen' }, { type: 'separator' },
    { label: 'Проверить обновления…', click: () => checkUpdates(true), visible: updaterEnabled() },
    { role: 'services', label: 'Службы' }, { type: 'separator' },
    { role: 'hide', label: 'Скрыть Lumen' }, { role: 'hideOthers', label: 'Скрыть остальные' }, { role: 'unhide', label: 'Показать все' },
    { type: 'separator' }, { role: 'quit', label: 'Завершить Lumen' },
  ] });
  t.push({ label: 'Файл', submenu: [
    item('Новый документ…', 'CmdOrCtrl+Alt+N'),
    { label: 'Открыть…', accelerator: 'CmdOrCtrl+O', click: openDialog },
    { role: 'recentDocuments', label: 'Открыть недавние', submenu: [{ role: 'clearRecentDocuments', label: 'Очистить' }], visible: isMac || process.platform === 'win32' },
    item('Поместить как слой…', 'CmdOrCtrl+Shift+P'),
    { type: 'separator' },
    item('Сохранить проект (.lumen)', 'CmdOrCtrl+S'),
    item('Экспорт…', 'CmdOrCtrl+Shift+S'),
    { type: 'separator' },
    isMac ? { role: 'close', label: 'Закрыть окно' } : { role: 'quit', label: 'Выход' },
  ] });
  t.push({ label: 'Правка', submenu: [
    item('Отменить', 'CmdOrCtrl+Z'), item('Повторить', 'CmdOrCtrl+Shift+Z'), { type: 'separator' },
    { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' },
    { type: 'separator' }, item('Выделить всё', 'CmdOrCtrl+A'), item('Снять выделение', 'CmdOrCtrl+D'), item('Инвертировать выделение', 'CmdOrCtrl+Shift+I'),
  ] });
  t.push({ label: 'Изображение', submenu: [item('Размер изображения…', 'CmdOrCtrl+Alt+I'), item('Размер холста…', 'CmdOrCtrl+Alt+C')] });
  t.push({ label: 'Слой', submenu: [item('Новый слой', 'CmdOrCtrl+Shift+N'), item('Дублировать', 'CmdOrCtrl+J'), item('Объединить с нижним', 'CmdOrCtrl+E'), item('Выполнить сведение', 'CmdOrCtrl+Shift+E')] });
  t.push({ label: 'Вид', submenu: [
    item('Приблизить', 'CmdOrCtrl+='), item('Отдалить', 'CmdOrCtrl+-'), item('Подогнать под экран', 'CmdOrCtrl+0'),
    { type: 'separator' }, { role: 'togglefullscreen', label: 'Полный экран' },
    ...(isDev || !app.isPackaged ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : []),
  ] });
  t.push({ role: 'windowMenu', label: 'Окно' });
  t.push({ role: 'help', label: 'Справка', submenu: [
    { label: 'Сайт Lumen', click: () => shell.openExternal(process.env.LUMEN_HOMEPAGE || 'https://github.com/') },
    ...(!isMac ? [{ label: 'Проверить обновления…', click: () => checkUpdates(true), visible: updaterEnabled() }, { role: 'about', label: 'О программе' }] : []),
  ] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

/* ------------------------------------------------------------ auto-update (opt-in) */
function updaterEnabled() {
  if (!app.isPackaged || SMOKE) return false;
  return !!process.env.LUMEN_UPDATE_URL || fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
}
function checkUpdates(interactive) {
  if (!updaterEnabled()) return;
  try {
    const { autoUpdater } = require('electron-updater');
    if (process.env.LUMEN_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.LUMEN_UPDATE_URL });
    autoUpdater.autoDownload = true;
    autoUpdater.on('error', (e) => console.warn('[lumen] update error', e?.message));
    if (interactive) autoUpdater.once('update-not-available', () => dialog.showMessageBox(win, { message: 'У вас последняя версия Lumen.' }));
    void autoUpdater.checkForUpdatesAndNotify();
  } catch (e) { console.warn('[lumen] updater unavailable', e.message); }
}

/* ------------------------------------------------------------ boot */
app.setName('Lumen');
app.setAboutPanelOptions({ applicationName: 'Lumen', applicationVersion: app.getVersion(), copyright: '© Lumen contributors' });
app.on('web-contents-created', (_e, c) => c.on('will-attach-webview', (ev) => ev.preventDefault()));

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  protocol.handle(SCHEME, async (req) => {
    const u = new URL(req.url);
    if (u.host !== HOST) return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.promises.readFile(file);
      const headers = new Headers({ 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Opener-Policy': 'same-origin' });
      return new Response(body, { status: 200, headers });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(perm)));
  ses.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders, ...(d.url.startsWith(ORIGIN) ? {} : { 'Content-Security-Policy': [CSP] }) } }));
  // No remote content: block every non-local request.
  ses.webRequest.onBeforeRequest((d, cb) => {
    const ok = /^(app|data|blob|devtools|chrome-extension):/.test(d.url) || (isDev && /^(https?|wss?):\/\/(localhost|127\.0\.0\.1)/.test(d.url));
    cb({ cancel: !ok });
  });
  setupDownloads(ses);
  buildMenu();
  createWindow();
  setTimeout(() => checkUpdates(false), 5000);
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('before-quit', () => { app.__quitting = true; });
app.on('window-all-closed', () => { if (!isMac || SMOKE) app.quit(); });
process.on('uncaughtException', (e) => console.error('[lumen] uncaught', e));
