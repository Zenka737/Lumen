// Scans release/ for installers and writes website/releases.json + release/SHA256SUMS.txt.
//   node scripts/make-releases.mjs [releaseDir]
// Download URLs: $RELEASE_BASE_URL/<file>, else GitHub Releases of $GITHUB_REPOSITORY (or package.json homepage).
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'release';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = process.env.RELEASE_VERSION || pkg.version;
const repo = process.env.GITHUB_REPOSITORY || (pkg.homepage || '').replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
const base = (process.env.RELEASE_BASE_URL || `https://github.com/${repo}/releases/download/v${version}`).replace(/\/$/, '');

const normArch = (s) => (/universal/.test(s) ? 'universal' : /arm64|aarch64/.test(s) ? 'arm64' : /x64|x86_64|amd64/.test(s) ? 'x64' : 'universal');
function classify(f) {
  if (/\.dmg$/.test(f)) return { os: 'mac', kind: 'dmg' };
  if (/-mac-.*\.zip$/.test(f)) return { os: 'mac', kind: 'zip' };
  if (/-portable\.exe$/.test(f)) return { os: 'win', kind: 'portable' };
  if (/-setup\.exe$/.test(f)) return { os: 'win', kind: 'installer' };
  if (/\.AppImage$/.test(f)) return { os: 'linux', kind: 'appimage' };
  if (/\.deb$/.test(f)) return { os: 'linux', kind: 'deb' };
  if (/\.rpm$/.test(f)) return { os: 'linux', kind: 'rpm' };
  if (/-linux-.*\.tar\.gz$/.test(f)) return { os: 'linux', kind: 'targz' };
  return null;
}
const sha256 = (p) => new Promise((res, rej) => {
  const h = createHash('sha256');
  createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

const files = [];
for (const f of readdirSync(dir).sort()) {
  const c = classify(f);
  if (!c) continue;
  const p = join(dir, f);
  files.push({ ...c, arch: normArch(f.replace(/^Lumen-[\d.]+(-[\w.]+)?-(mac|win|linux)/, '')), file: f, size: statSync(p).size, sha256: await sha256(p), url: `${base}/${encodeURIComponent(f)}` });
}
const out = { name: 'Lumen', version, date: new Date().toISOString().slice(0, 10), files };
mkdirSync('website', { recursive: true });
writeFileSync('website/releases.json', JSON.stringify(out, null, 2) + '\n');
writeFileSync(join(dir, 'SHA256SUMS.txt'), files.map((x) => `${x.sha256}  ${x.file}`).join('\n') + '\n');
console.log(`releases.json: v${version}, ${files.length} files`);
for (const x of files) console.log(`  ${x.os.padEnd(5)} ${x.kind.padEnd(9)} ${x.arch.padEnd(9)} ${(x.size / 1048576).toFixed(1).padStart(6)} MB  ${x.file}`);
