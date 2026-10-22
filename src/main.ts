import './styles.css';
import { Editor } from './core/editor';
import { createTools } from './tools/index';
import { mountApp, offerRecovery } from './ui/app';
import { askLargeImage } from './ui/dialogs';
import { installTooltips, toast } from './ui/overlays';

function boot(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app not found');
  const ed = new Editor();
  ed.ui = { toast, askLargeImage };
  ed.tools = createTools(ed);
  ed.newDocument(1600, 1000, 'white', 'Без названия');
  ed.tool = ed.tools.find((t) => t.id === 'brush') ?? ed.tools[0]!;
  // a fresh blank document is not worth autosaving over a previous session
  ed.savedRevision = ed.revision;

  mountApp(root, ed);
  installTooltips();

  // Global safety net: errors become non-blocking toasts instead of a broken UI.
  window.addEventListener('error', (e) => {
    if (!e.error) return; // resource errors / ResizeObserver loop notices
    console.error(e.error);
    toast(`Ошибка: ${e.message}`, 'error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    toast(`Ошибка: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`, 'error');
  });

  void offerRecovery(ed);
  (window as unknown as { lumen: Editor }).lumen = ed; // handy for debugging
  document.getElementById('boot')?.remove();
}

try {
  boot();
} catch (err) {
  console.error(err);
  document.body.innerHTML = `<div style="font:14px system-ui;padding:40px;color:#ddd;background:#18181b;height:100vh">Не удалось запустить Lumen: ${String(err)}</div>`;
}
