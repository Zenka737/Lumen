// Real screenshots of the running desktop app for the website (website/assets/).
// Renders a procedural (copyright-free) landscape, opens it in Lumen via the CLI, captures the window.
import { _electron as electron, chromium } from 'playwright-core';
import electronPath from 'electron';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'lumen-shots-'));
const photo = join(tmp, 'Закат.png');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600" viewBox="0 0 2400 1600">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2b5a"/><stop offset=".45" stop-color="#c8577a"/><stop offset=".7" stop-color="#ffb36b"/><stop offset="1" stop-color="#ffd9a0"/></linearGradient>
<radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff6d8"/><stop offset=".35" stop-color="#ffd27a"/><stop offset="1" stop-color="#ffb36b" stop-opacity="0"/></radialGradient>
<linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e58a6e"/><stop offset="1" stop-color="#2a2550"/></linearGradient></defs>
<rect width="2400" height="1600" fill="url(#s)"/><circle cx="1500" cy="980" r="420" fill="url(#sun)"/><circle cx="1500" cy="980" r="120" fill="#fff4cf"/>
<path d="M0 1010 L260 760 L480 900 L760 600 L1040 880 L1240 760 L1500 960 L1760 720 L2050 900 L2400 700 L2400 1100 L0 1100Z" fill="#3b2a55" opacity=".85"/>
<path d="M0 1060 L340 880 L640 1000 L900 860 L1200 1010 L1520 900 L1900 1040 L2200 920 L2400 990 L2400 1120 L0 1120Z" fill="#251c3e"/>
<rect y="1100" width="2400" height="500" fill="url(#w)"/>
<g fill="#fff3c9" opacity=".55">${Array.from({ length: 26 }, (_, i) => `<rect x="${1500 - 300 + (i * 37) % 600}" y="${1120 + i * 17}" width="${120 - i * 3}" height="4" rx="2"/>`).join('')}</g></svg>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 2400, height: 1600 } });
await p.setContent(`<body style="margin:0">${svg}</body>`);
writeFileSync(photo, await p.screenshot());
await b.close();

const exe = process.argv[2];
const app = await electron.launch({ executablePath: exe || electronPath, args: [...(exe ? [] : ['.']), photo], env: { ...process.env, LUMEN_USER_DATA: join(tmp, 'profile') } });
const win = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 900); w.center(); });
await win.waitForFunction(() => window.lumen?.doc.width === 2400, null, { timeout: 30000 });
await win.evaluate(() => window.lumen.addLayer?.());
if (await win.evaluate(() => document.documentElement.dataset.theme) !== 'dark') await win.getByRole('button', { name: 'Переключить тему' }).click();
await win.mouse.move(5, 450);
await win.waitForTimeout(800);
mkdirSync('website/assets', { recursive: true });
await win.screenshot({ path: 'website/assets/screenshot.png' });
await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
copyFileSync('build/icon.svg', 'website/assets/icon.svg');
copyFileSync('build/icons/64x64.png', 'website/assets/icon-64.png');
console.log('website/assets/screenshot.png written', resolve('website/assets'));
