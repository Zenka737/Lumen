'use strict';
// Sandboxed preload: exposes a tiny, explicit bridge. The web app feature-detects `window.lumenDesktop`.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumenDesktop', {
  platform: process.platform,
  isDesktop: true,
  /** Native open dialog; chosen files arrive through onOpenFile. */
  openDialog: () => ipcRenderer.invoke('lumen:open-dialog'),
  /** cb({ name, type, data: Uint8Array }) for files opened via Finder/Explorer, CLI, dock drop, menu. */
  onOpenFile: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('lumen:open-file', (_e, f) => cb({ name: String(f.name), type: String(f.type), data: f.data }));
  },
  ready: () => ipcRenderer.send('lumen:ready'),
  /** macOS: translucent window (vibrancy) behind the glass panels; no-op elsewhere. */
  setGlass: (on) => ipcRenderer.invoke('lumen:set-glass', !!on),
});
