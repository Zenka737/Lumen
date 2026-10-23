// Headless-ish smoke test of a packaged build: launches the app with LUMEN_SMOKE=1, which loads the
// editor, prints `[lumen-smoke] {...}` and exits. Fails on non-zero exit, missing marker or renderer errors.
//   node scripts/smoke-packaged.mjs [path/to/executable]   (Linux: run under xvfb-run)
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const guess = {
  darwin: ['release/mac-arm64/Lumen.app/Contents/MacOS/Lumen', 'release/mac/Lumen.app/Contents/MacOS/Lumen', 'release/mac-universal/Lumen.app/Contents/MacOS/Lumen'],
  win32: ['release/win-unpacked/Lumen.exe', 'release/win-arm64-unpacked/Lumen.exe'],
  linux: ['release/linux-unpacked/lumen', 'release/linux-arm64-unpacked/lumen'],
}[process.platform] ?? [];
const exe = process.argv[2] ? resolve(process.argv[2]) : guess.map((p) => resolve(p)).find(existsSync);
if (!exe || !existsSync(exe)) { console.error('smoke: executable not found', exe ?? guess); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), 'lumen-smoke-'));
const args = process.platform === 'linux' ? ['--no-sandbox', ...(process.env.CI ? ['--disable-gpu'] : [])] : [];
const env = { ...process.env, ...(process.env.CI ? { LUMEN_DISABLE_GPU: '1' } : {}), LUMEN_SMOKE: '1', LUMEN_USER_DATA: join(tmp, 'profile'), LUMEN_SMOKE_SHOT: join(tmp, 'smoke.png') };
console.log('smoke: launching', exe);
const child = spawn(exe, args, { env });
let out = '';
child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
const timer = setTimeout(() => { console.error('smoke: timeout'); child.kill('SIGKILL'); }, 90_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  const ok = /\[lumen-smoke\] \{"ok":true/.test(out);
  const errs = out.split('\n').filter((l) => /\[renderer:(error|3)\]|\[lumen\] (uncaught|renderer gone|bridge)/.test(l));
  console.log(`smoke: exit=${code} loaded=${ok} rendererErrors=${errs.length} screenshot=${env.LUMEN_SMOKE_SHOT}`);
  process.exit(code === 0 && ok && errs.length === 0 ? 0 : 1);
});
