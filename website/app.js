/* Lumen download page: detects OS/arch, renders the file list from releases.json, RU/EN toggle. */
(() => {
  'use strict';
  const T = {
    ru: {
      skip: 'К загрузке', nav: 'Навигация', navFeatures: 'Возможности', navDownload: 'Скачать', navInstall: 'Установка',
      eyebrow: 'Бесплатно · без регистрации · работает офлайн', title: 'Фоторедактор, который просто работает',
      lead: 'Слои и режимы наложения, кисти с нажимом пера, выделения, коррекция и фильтры в фоновом потоке. Нативное приложение для macOS, Windows и Linux.',
      downloadGeneric: 'Скачать', downloadFor: 'Скачать для {os}', otherPlatforms: 'Другие платформы', shotAlt: 'Окно Lumen: фотография на холсте, панели слоёв и коррекции',
      f1t: 'Слои и маски', f1: 'Режимы наложения, прозрачность, сведение и проекты .lumen.',
      f2t: 'Кисти с нажимом', f2: 'Сглаживание штриха, жёсткость, поток, ластик и заливка.',
      f3t: 'Коррекция', f3: 'Уровни, кривые, цветовой тон, экспозиция — без лагов, в отдельном потоке.',
      f4t: 'Нативно', f4: 'Открытие двойным щелчком, системные диалоги, меню, автосохранение.',
      platform: 'Платформа', loading: 'Загрузка списка файлов…', allSums: 'Все контрольные суммы (SHA256SUMS.txt)',
      version: 'Версия {v} · {d}', noFiles: 'Для этой платформы пока нет сборок.', loadError: 'Не удалось загрузить список файлов. Откройте страницу релизов на GitHub.',
      recommended: 'Рекомендуем', copy: 'Копировать', copied: 'Скопировано', download: 'Скачать',
      gInstaller: 'Установщик', gPortable: 'Portable', gDmg: 'Образ диска (.dmg)', gZip: 'Архив (.zip)',
      hInstaller: 'Ставится в систему: ярлыки, ассоциации файлов, удаление через «Приложения».', hPortable: 'Без установки, запускается из любой папки.',
      hDmg: 'Обычный способ: открыть и перетащить в «Программы».', hZip: 'Для ручной установки и автоматизации.',
      gAppimage: 'AppImage — любой дистрибутив', gDeb: '.deb — Ubuntu, Debian, Mint, Pop!_OS', gRpm: '.rpm — Fedora, RHEL, openSUSE', gTargz: 'tar.gz — портативный архив',
      aArm: 'Apple Silicon (M1–M4)', aIntel: 'Intel', aUni: 'Universal (любой Mac)', aX64: 'x64 (Intel / AMD)', aArm64: 'ARM64', aWinUni: 'x64 + ARM64 (автовыбор)',
      size: '{n} МБ', metaFor: 'Версия {v} · {s} · {f}', detected: 'Определено: {os}',
      osMac: 'macOS', osMacArm: 'macOS (Apple Silicon)', osMacIntel: 'macOS (Intel)', osWin: 'Windows', osWinArm: 'Windows (ARM)', osLinux: 'Linux', osLinuxArm: 'Linux (ARM64)',
      m1: 'Откройте .dmg и перетащите Lumen в «Программы».',
      m2: 'Сборка пока без подписи Apple. При первом запуске: щёлкните Lumen правой кнопкой → <b>Открыть</b> → <b>Открыть</b>. Или в Терминале:',
      m3: 'Universal работает на любом Mac; Apple Silicon и Intel — версии поменьше.',
      w1: 'Установщик (.exe) ставит Lumen для текущего пользователя, создаёт ярлыки и связывает файлы.',
      w2: 'Portable — один .exe без установки, можно запускать с флешки.',
      w3: 'Сборка без подписи, поэтому SmartScreen может показать «Windows защитила ваш компьютер»: нажмите <b>Подробнее</b> → <b>Выполнить в любом случае</b>.',
      l0: 'Ubuntu, Debian, Mint, Fedora, openSUSE, Arch и др.; GNOME, KDE, XFCE и любые другие окружения.',
      l1: 'Если AppImage не стартует на Ubuntu 22.04+, установите <code>libfuse2</code> (<code>sudo apt install libfuse2t64</code>) или запустите с <code>--appimage-extract-and-run</code>.',
      verify: 'Проверка файла: <code>shasum -a 256 файл</code> (macOS), <code>sha256sum файл</code> (Linux), <code>Get-FileHash файл</code> (Windows) — сравните с SHA-256 выше.',
      webToo: 'Также работает в браузере — та же программа.', switchLang: 'Switch to English',
    },
    en: {
      skip: 'Skip to download', nav: 'Navigation', navFeatures: 'Features', navDownload: 'Download', navInstall: 'Install',
      eyebrow: 'Free · no sign-up · works offline', title: 'A photo editor that just works',
      lead: 'Layers and blend modes, pressure-sensitive brushes, selections, adjustments and filters on a background thread. A native app for macOS, Windows and Linux.',
      downloadGeneric: 'Download', downloadFor: 'Download for {os}', otherPlatforms: 'Other platforms', shotAlt: 'Lumen window: a photo on the canvas with layer and adjustment panels',
      f1t: 'Layers', f1: 'Blend modes, opacity, flatten, and .lumen project files.',
      f2t: 'Pressure brushes', f2: 'Stroke smoothing, hardness, flow, eraser and fill.',
      f3t: 'Adjustments', f3: 'Levels, curves, hue, exposure — lag-free, on a worker thread.',
      f4t: 'Native', f4: 'Double-click to open, system dialogs, menus, autosave.',
      platform: 'Platform', loading: 'Loading files…', allSums: 'All checksums (SHA256SUMS.txt)',
      version: 'Version {v} · {d}', noFiles: 'No builds for this platform yet.', loadError: 'Could not load the file list. Please open the GitHub releases page.',
      recommended: 'Recommended', copy: 'Copy', copied: 'Copied', download: 'Download',
      gInstaller: 'Installer', gPortable: 'Portable', gDmg: 'Disk image (.dmg)', gZip: 'Archive (.zip)',
      hInstaller: 'Installs system-wide for you: shortcuts, file associations, uninstall from Settings.', hPortable: 'No installation; runs from any folder.',
      hDmg: 'The usual way: open it and drag to Applications.', hZip: 'For manual installs and automation.',
      gAppimage: 'AppImage — any distro', gDeb: '.deb — Ubuntu, Debian, Mint, Pop!_OS', gRpm: '.rpm — Fedora, RHEL, openSUSE', gTargz: 'tar.gz — portable archive',
      aArm: 'Apple Silicon (M1–M4)', aIntel: 'Intel', aUni: 'Universal (any Mac)', aX64: 'x64 (Intel / AMD)', aArm64: 'ARM64', aWinUni: 'x64 + ARM64 (auto)',
      size: '{n} MB', metaFor: 'Version {v} · {s} · {f}', detected: 'Detected: {os}',
      osMac: 'macOS', osMacArm: 'macOS (Apple Silicon)', osMacIntel: 'macOS (Intel)', osWin: 'Windows', osWinArm: 'Windows (ARM)', osLinux: 'Linux', osLinuxArm: 'Linux (ARM64)',
      m1: 'Open the .dmg and drag Lumen to Applications.',
      m2: 'The build is not signed by Apple yet. On first launch, right-click Lumen → <b>Open</b> → <b>Open</b>. Or in Terminal:',
      m3: 'Universal runs on any Mac; the Apple Silicon and Intel builds are smaller.',
      w1: 'The installer (.exe) installs Lumen for the current user, creates shortcuts and file associations.',
      w2: 'Portable is a single .exe with no installation — run it from a USB stick.',
      w3: 'The build is unsigned, so SmartScreen may say “Windows protected your PC”: click <b>More info</b> → <b>Run anyway</b>.',
      l0: 'Ubuntu, Debian, Mint, Fedora, openSUSE, Arch and more; GNOME, KDE, XFCE or any other desktop.',
      l1: 'If the AppImage does not start on Ubuntu 22.04+, install <code>libfuse2</code> (<code>sudo apt install libfuse2t64</code>) or run it with <code>--appimage-extract-and-run</code>.',
      verify: 'Verify a file: <code>shasum -a 256 file</code> (macOS), <code>sha256sum file</code> (Linux), <code>Get-FileHash file</code> (Windows) — compare with the SHA-256 above.',
      webToo: 'Also runs in the browser — the same app.', switchLang: 'Переключить на русский',
    },
  };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  let lang = store.get('lumen.lang') || ((navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en');
  const qp = location.search.match(/[?&]lang=(ru|en)/); if (qp) lang = qp[1];
  const t = (k, vars) => (T[lang][k] ?? T.ru[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => vars?.[n] ?? '');
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- platform detection */
  const env = { os: 'mac', arch: 'arm64', sure: false };
  const ua = navigator.userAgent;
  const plat = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  if (/win/.test(plat) || /Windows/.test(ua)) { env.os = 'win'; env.arch = /ARM64|aarch64/i.test(ua) ? 'arm64' : 'x64'; }
  else if (/linux|x11|cros/.test(plat) && !/Android/.test(ua)) { env.os = 'linux'; env.arch = /aarch64|arm64|armv8/i.test(ua + plat) ? 'arm64' : 'x64'; }
  else if (/mac/.test(plat) || /Mac OS X/.test(ua)) {
    env.os = 'mac'; env.arch = 'arm64';
    try { // Safari/Firefox don't expose the CPU; the GPU name does.
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      if (/Intel|AMD|Radeon|NVIDIA/i.test(r)) { env.arch = 'x64'; env.sure = true; } else if (/Apple M|Apple GPU/i.test(r)) env.sure = true;
    } catch { /* ignore */ }
  }
  const mobile = /Android|iPhone|iPad|iPod/.test(ua);
  navigator.userAgentData?.getHighEntropyValues?.(['architecture', 'bitness']).then((v) => {
    if (!v?.architecture) return;
    const a = v.architecture === 'arm' ? 'arm64' : 'x64';
    if (a !== env.arch || !env.sure) { env.arch = a; env.sure = true; render(); }
  }).catch(() => {});

  /* ---------------- data */
  let data = null, active = null, failed = false;
  const ORDER = { mac: ['dmg', 'zip'], win: ['installer', 'portable'], linux: ['appimage', 'deb', 'rpm', 'targz'] };
  const G = { dmg: ['gDmg', 'hDmg'], zip: ['gZip', 'hZip'], installer: ['gInstaller', 'hInstaller'], portable: ['gPortable', 'hPortable'], appimage: ['gAppimage'], deb: ['gDeb'], rpm: ['gRpm'], targz: ['gTargz'] };
  const archLabel = (f) => f.os === 'mac' ? t({ arm64: 'aArm', x64: 'aIntel', universal: 'aUni' }[f.arch]) : f.os === 'win' && f.arch === 'universal' ? t('aWinUni') : t(f.arch === 'arm64' ? 'aArm64' : 'aX64');
  const mb = (b) => t('size', { n: (b / 1048576).toFixed(b > 104857600 ? 0 : 1) });
  const osName = (os, arch) => os === 'mac' ? t(env.sure ? (arch === 'arm64' ? 'osMacArm' : 'osMacIntel') : 'osMac') : os === 'win' ? t(arch === 'arm64' ? 'osWinArm' : 'osWin') : t(arch === 'arm64' ? 'osLinuxArm' : 'osLinux');

  function best(os, arch) {
    const fs = data?.files.filter((f) => f.os === os) || [];
    const pref = os === 'mac' ? [['dmg', env.sure ? arch : 'universal'], ['dmg', 'universal'], ['dmg', arch]]
      : os === 'win' ? [['installer', arch], ['installer', 'universal'], ['portable', arch]]
      : [['appimage', arch], ['deb', arch], ['targz', arch]];
    for (const [k, a] of pref) { const f = fs.find((x) => x.kind === k && x.arch === a); if (f) return f; }
    return fs[0];
  }

  function render() {
    document.documentElement.lang = lang;
    document.title = lang === 'ru' ? 'Lumen — фоторедактор для macOS, Windows и Linux' : 'Lumen — photo editor for macOS, Windows and Linux';
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-attr]').forEach((el) => { const [a, k] = el.dataset.i18nAttr.split(':'); el.setAttribute(a, t(k)); });
    const lb = $('#lang'); lb.textContent = lang === 'ru' ? 'EN' : 'RU'; lb.setAttribute('aria-label', t('switchLang'));
    document.querySelectorAll('.card').forEach((c) => c.classList.toggle('hl', c.dataset.os === env.os));

    const panel = $('#panel');
    if (failed) { panel.innerHTML = `<p class="empty">${esc(t('loadError'))}</p>`; return; }
    if (!data) return;
    $('#version').textContent = t('version', { v: data.version, d: new Date(data.date).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' }) });
    const sums = data.files[0]?.url.replace(/[^/]+$/, 'SHA256SUMS.txt'); if (sums) $('#sums').href = sums;

    // Primary button
    const rec = mobile ? null : best(env.os, env.arch);
    const primary = $('#primary');
    if (rec) {
      primary.href = rec.url; primary.setAttribute('download', '');
      $('#primary-label').textContent = t('downloadFor', { os: osName(env.os, env.arch) });
      $('#primary-meta').textContent = t('metaFor', { v: data.version, s: mb(rec.size), f: rec.file });
    } else { primary.href = '#download'; primary.removeAttribute('download'); $('#primary-label').textContent = t('downloadGeneric'); $('#primary-meta').textContent = ''; }

    // Tabs
    active ||= env.os;
    document.querySelectorAll('.tabs [role=tab]').forEach((b) => { const on = b.dataset.os === active; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    panel.setAttribute('aria-labelledby', `tab-${active}`);
    const files = data.files.filter((f) => f.os === active);
    if (!files.length) { panel.innerHTML = `<p class="empty">${esc(t('noFiles'))}</p>`; return; }
    const recFile = best(active, active === env.os ? env.arch : 'x64');
    const archOrder = { universal: 0, arm64: active === 'mac' ? 1 : 2, x64: active === 'mac' ? 2 : 1 };
    panel.innerHTML = ORDER[active].filter((k) => files.some((f) => f.kind === k)).map((k) => {
      const rows = files.filter((f) => f.kind === k).sort((a, b) => archOrder[a.arch] - archOrder[b.arch]).map((f) => `
        <div class="row${f === recFile ? ' rec' : ''}">
          <div>
            <div class="name">${esc(archLabel(f))}${f === recFile ? `<span class="badge">${esc(t('recommended'))}</span>` : ''}</div>
            <div class="sub"><span>${esc(mb(f.size))}</span><span>v${esc(data.version)}</span><span class="sha" title="SHA-256: ${esc(f.sha256)}">SHA-256 <code>${esc(f.sha256)}</code><button class="copy" type="button" data-sha="${esc(f.sha256)}">${esc(t('copy'))}</button></span></div>
          </div>
          <a class="dl" href="${esc(f.url)}" download aria-label="${esc(t('download'))} ${esc(f.file)}">${esc(t('download'))} <span aria-hidden="true">↓</span></a>
        </div>`).join('');
      const [g, h] = G[k];
      return `<div class="group"><h3>${esc(t(g))}</h3>${h ? `<p class="hint">${esc(t(h))}</p>` : ''}${rows}</div>`;
    }).join('');
  }

  /* ---------------- events */
  $('#lang').addEventListener('click', () => { lang = lang === 'ru' ? 'en' : 'ru'; store.set('lumen.lang', lang); render(); });
  const tabs = [...document.querySelectorAll('.tabs [role=tab]')];
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => { active = b.dataset.os; render(); });
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const n = tabs[(i + d + tabs.length) % tabs.length]; active = n.dataset.os; render(); n.focus();
    });
  });
  $('#panel').addEventListener('click', (e) => {
    const b = e.target.closest('.copy'); if (!b) return;
    navigator.clipboard?.writeText(b.dataset.sha).then(() => { b.textContent = t('copied'); setTimeout(() => { b.textContent = t('copy'); }, 1400); });
  });

  render();
  fetch('releases.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((j) => { data = j; render(); }).catch(() => { failed = true; render(); });
})();
