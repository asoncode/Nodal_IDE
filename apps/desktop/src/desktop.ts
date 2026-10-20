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

export async function listenDesktopActions(handlers: { openFolder: () => void; save: () => void; canClose: () => boolean }): Promise<UnlistenFn> {
  if (!isDesktop()) return () => {};
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const current = getCurrentWindow();
  const unlisten: UnlistenFn[] = [];
  try {
    unlisten.push(await current.listen('nodal:open-folder', handlers.openFolder));
    unlisten.push(await current.listen('nodal:save', handlers.save));
    unlisten.push(await current.onCloseRequested(event => { if (!handlers.canClose()) event.preventDefault(); }));
    return () => unlisten.forEach(stop => stop());
  } catch (error) {
    unlisten.forEach(stop => stop());
    throw error;
  }
}
