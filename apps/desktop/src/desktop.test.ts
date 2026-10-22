// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listenDesktopActions, pickFolder, restoreLastProject } from './desktop.js';
const { open, getCurrentWindow } = vi.hoisted(() => ({ open: vi.fn(), getCurrentWindow: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow }));
beforeEach(() => { vi.resetAllMocks(); Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} }); });
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });
describe('native window bridge', () => {
  it('requests a native single-folder chooser and treats cancellation as a no-op', async () => {
    open.mockResolvedValueOnce('/tmp/project').mockResolvedValueOnce(null);
    expect(await pickFolder()).toBe('/tmp/project'); expect(await pickFolder()).toBe(null);
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, title: 'Open Folder' });
  });
  it('restores the main window only, leaving new windows empty', async () => {
    getCurrentWindow.mockReturnValue({ label: 'workspace-2' }); expect(await restoreLastProject()).toBe(false);
    getCurrentWindow.mockReturnValue({ label: 'main' }); expect(await restoreLastProject()).toBe(true);
  });
  it('routes actions through the current window, guards close, and unregisters every listener', async () => {
    const events = new Map<string, () => void>(); const off = [vi.fn(), vi.fn(), vi.fn()];
    let closing: (event: { preventDefault: () => void }) => void = () => {};
    getCurrentWindow.mockReturnValue({ listen: vi.fn(async (event, callback) => { events.set(event, callback); return off[events.size - 1]; }), onCloseRequested: vi.fn(async callback => { closing = callback; return off[2]; }) });
    const handlers = { openFolder: vi.fn(), save: vi.fn(), canClose: vi.fn(() => false) };
    const stop = await listenDesktopActions(handlers); events.get('nodal:open-folder')!(); events.get('nodal:save')!();
    expect(handlers.openFolder).toHaveBeenCalledOnce(); expect(handlers.save).toHaveBeenCalledOnce();
    const preventDefault = vi.fn(); closing({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce();
    handlers.canClose.mockReturnValue(true); closing({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce();
    stop(); off.forEach(cleanup => expect(cleanup).toHaveBeenCalledOnce());
  });
  it('cleans up partial registration if the native listener setup fails', async () => {
    const off = vi.fn(); const listen = vi.fn().mockResolvedValueOnce(off).mockRejectedValueOnce(new Error('window closed'));
    getCurrentWindow.mockReturnValue({ listen });
    await expect(listenDesktopActions({ openFolder: vi.fn(), save: vi.fn(), canClose: () => true })).rejects.toThrow('window closed');
    expect(off).toHaveBeenCalledOnce();
  });
  it('forwards optional native command payloads and unregisters the command listener', async () => {
    const events = new Map<string, (event: { payload: string }) => void>();
    const off = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    getCurrentWindow.mockReturnValue({ listen: vi.fn(async (name, callback) => { events.set(name, callback); return off[events.size - 1]; }), onCloseRequested: vi.fn(async () => off[3]) });
    const command = vi.fn();
    const stop = await listenDesktopActions({ openFolder() {}, save() {}, command, canClose: () => true });
    events.get('nodal:command')!({ payload: 'quick-open' });
    expect(command).toHaveBeenCalledWith('quick-open');
    stop(); off.forEach(unlisten => expect(unlisten).toHaveBeenCalledOnce());
  });
  it('waits for terminal cleanup before destroying a window and reports cleanup failures', async () => {
    let closing: (event: { preventDefault: () => void }) => Promise<void> = async () => {};
    const destroy = vi.fn(async () => {}); let complete = () => {};
    getCurrentWindow.mockReturnValue({ listen: vi.fn(async () => () => {}), onCloseRequested: vi.fn(async callback => { closing = callback; return () => {}; }), destroy });
    const beforeClose = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    const onError = vi.fn(); const canClose = vi.fn(() => true);
    await listenDesktopActions({ openFolder() {}, save() {}, canClose, beforeClose, onError });
    const event = { preventDefault: vi.fn() }; const request = closing(event);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(destroy).not.toHaveBeenCalled();
    await closing(event); expect(beforeClose).toHaveBeenCalledOnce();
    complete(); await request; expect(destroy).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
  });
  it('keeps a window open if terminal shutdown fails', async () => {
    let closing: (event: { preventDefault: () => void }) => Promise<void> = async () => {};
    const destroy = vi.fn(); const onError = vi.fn();
    getCurrentWindow.mockReturnValue({ listen: vi.fn(async () => () => {}), onCloseRequested: vi.fn(async callback => { closing = callback; return () => {}; }), destroy });
    await listenDesktopActions({ openFolder() {}, save() {}, canClose: () => true, beforeClose: async () => { throw new Error('Runtime unavailable'); }, onError });
    await closing({ preventDefault() {} }); expect(destroy).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Runtime unavailable' }));
  });

});
