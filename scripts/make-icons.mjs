// Generates the Lumen app icon from a hand-written SVG: PNG set, .icns (macOS), .ico (Windows).
// Usage: node scripts/make-icons.mjs   (needs playwright-core chromium; iconutil on macOS for .icns)
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const OUT = 'build';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26262c"/><stop offset="1" stop-color="#121215"/></linearGradient>
  <linearGradient id="orb" x1="0.15" y1="0.1" x2="0.85" y2="0.95"><stop offset="0" stop-color="#ffd36e"/><stop offset=".5" stop-color="#ff7a59"/><stop offset="1" stop-color="#7b6cff"/></linearGradient>
  <radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ff9a6a" stop-opacity=".45"/><stop offset="1" stop-color="#ff9a6a" stop-opacity="0"/></radialGradient>
  <radialGradient id="core" cx=".42" cy=".38" r=".6"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity=".78"/></radialGradient>
  <linearGradient id="hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#hl)"/>
<rect x="101.5" y="101.5" width="821" height="821" rx="184.5" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="3"/>
<circle cx="512" cy="512" r="330" fill="url(#glow)"/>
<circle cx="512" cy="512" r="250" fill="url(#orb)"/>
<path d="M512 262a250 250 0 0 1 0 500a250 250 0 0 0 0-500z" fill="#000" fill-opacity=".10"/>
<circle cx="512" cy="512" r="108" fill="url(#core)"/>
<circle cx="430" cy="400" r="34" fill="#fff" fill-opacity=".35"/>
</svg>`;

mkdirSync(join(OUT, 'icons'), { recursive: true });
writeFileSync(join(OUT, 'icon.svg'), svg);
const browser = await chromium.launch();
const page = await browser.newPage();
const render = async (size) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
};
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const png = {};
for (const s of sizes) { png[s] = await render(s); writeFileSync(join(OUT, 'icons', `${s}x${s}.png`), png[s]); }
writeFileSync(join(OUT, 'icon.png'), png[1024]);
await browser.close();

// ICO with embedded PNGs (Vista+ format).
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + 16 * icoSizes.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoSizes.length, 4);
let offset = header.length;
icoSizes.forEach((s, i) => {
  const e = 6 + i * 16, len = png[s].length;
  header.writeUInt8(s >= 256 ? 0 : s, e); header.writeUInt8(s >= 256 ? 0 : s, e + 1);
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(len, e + 8); header.writeUInt32LE(offset, e + 12); offset += len;
});
writeFileSync(join(OUT, 'icon.ico'), Buffer.concat([header, ...icoSizes.map((s) => png[s])]));

// ICNS via iconutil (macOS only); electron-builder can also derive it from icon.png elsewhere.
if (process.platform === 'darwin') {
  const set = join(OUT, 'icon.iconset');
  rmSync(set, { recursive: true, force: true }); mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(set, `icon_${s}x${s}.png`), png[s]);
    writeFileSync(join(set, `icon_${s}x${s}@2x.png`), png[s * 2]);
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(OUT, 'icon.icns')]);
  rmSync(set, { recursive: true, force: true });
}
console.log('icons written to', OUT, existsSync(join(OUT, 'icon.icns')) ? '(+icns)' : '');
