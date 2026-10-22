import type { UnlistenFn } from '@tauri-apps/api/event';

export const isDesktop = () => '__TAURI_INTERNALS__' in window;

export async function pickFolder(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false, title: 'Open Folder' });
  return typeof selected === 'string' ? selected : null;
}

export async function restoreLastProject(): Promise<boolean> {
  if (!isDesktop()) return true;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().label === 'main';
}

export async function listenDesktopActions(handlers: { openFolder: () => void; save: () => void; command?: (id: string) => void; canClose: () => boolean; beforeClose?: () => Promise<void>; onError?: (error: unknown) => void }): Promise<UnlistenFn> {
  if (!isDesktop()) return () => {};
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const current = getCurrentWindow();
  const unlisten: UnlistenFn[] = [];
  let closing = false;
  try {
    unlisten.push(await current.listen('nodal:open-folder', handlers.openFolder));
    unlisten.push(await current.listen('nodal:save', handlers.save));
    if (handlers.command) unlisten.push(await current.listen<string>('nodal:command', event => handlers.command?.(event.payload)));
    unlisten.push(await current.onCloseRequested(async event => {
      if (closing) { event.preventDefault(); return; }
      if (!handlers.canClose()) { event.preventDefault(); return; }
      if (!handlers.beforeClose) return;
      event.preventDefault(); closing = true;
      try { await handlers.beforeClose(); await current.destroy(); }
      catch (error) { closing = false; handlers.onError?.(error); }
    }));
    return () => unlisten.forEach(stop => stop());
  } catch (error) {
    unlisten.forEach(stop => stop());
    throw error;
  }
}
