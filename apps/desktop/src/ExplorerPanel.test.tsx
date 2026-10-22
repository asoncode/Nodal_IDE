// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ExplorerPanel, { type ExplorerPanelProps } from './ExplorerPanel.js';
import { api } from './api.js';
vi.mock('./api.js', () => ({ api: vi.fn() }));
const project = { id: 'p', name: 'Example', root: '/tmp/example' };
const original = { path: 'main.ts', content: 'saved', hash: 'h1' };
const calls = (method: string) => vi.mocked(api).mock.calls.filter(call => call[0] === method);
let props: ExplorerPanelProps;
let entries: Array<{ path: string; kind: 'file' | 'directory' }>;
beforeEach(() => {
  entries = [{ path: original.path, kind: 'file' }];
  props = { project, files: ['main.ts'], buffers: [], onOpenFolder: vi.fn(), onOpenFile: vi.fn(), onFilesChange: vi.fn(), onCreated: vi.fn(), onRenamed: vi.fn(), onDeleted: vi.fn() };
  vi.mocked(api).mockImplementation(async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'workspaceEntries') return { entries, truncated: false } as T;
    if (method === 'readFile') return original as T;
    if (['renameFile', 'duplicateFile', 'createFile'].includes(method)) return { ...original, path: params.newPath ?? params.path } as T;
    if (method === 'listTrash') return [{ trashId: 'trash-1', path: 'deleted.ts', deletedAt: '2026-10-21' }] as T;
    if (method === 'restoreTrash') return { ...original, path: 'deleted.ts' } as T;
    return {} as T;
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });
async function mount() { const view = render(<ExplorerPanel {...props}/>); await waitFor(() => expect(props.onFilesChange).toHaveBeenCalled()); return view; }
function actions(path = 'main.ts') { fireEvent.click(screen.getByRole('button', { name: `Actions for ${path}` })); }
function submit(label: string, path: string) { fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value: path } }); fireEvent.click(screen.getByRole('button', { name: 'OK' })); }

it('renames with the saved hash while leaving unsaved buffer content for its parent to preserve', async () => {
  const buffer = { ...original, content: 'unsaved edits', savedContent: 'saved' }; props.buffers = [buffer];
  await mount(); actions(); fireEvent.click(screen.getByRole('button', { name: 'Rename file' })); submit('Rename file path', 'renamed.ts');
  await waitFor(() => expect(props.onRenamed).toHaveBeenCalledWith('main.ts', { ...original, path: 'renamed.ts' }));
  expect(calls('renameFile')[0][1]).toEqual({ projectId: 'p', path: 'main.ts', newPath: 'renamed.ts', expectedHash: 'h1' });
  expect(buffer.content).toBe('unsaved edits'); expect(props.onCreated).not.toHaveBeenCalled();
});
it('offers explicit recoverable delete confirmation, cancel, and restoration of earlier deletions', async () => {
  props.buffers = [{ ...original, content: 'unsaved', savedContent: 'saved' }];
  await mount(); actions(); fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete file' }); expect(dialog).toHaveTextContent('Nodal Trash'); expect(dialog).toHaveTextContent('Unsaved editor changes will be discarded');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' })); expect(calls('trashFile')).toHaveLength(0);
  actions(); fireEvent.click(screen.getByRole('button', { name: 'Delete file' })); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete file' }));
  await waitFor(() => expect(props.onDeleted).toHaveBeenCalledWith('main.ts'));
  fireEvent.click(screen.getByRole('button', { name: 'Deleted files' })); fireEvent.click(await screen.findByRole('button', { name: 'Restore deleted.ts' }));
  await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith({ ...original, path: 'deleted.ts' }));
});
it('rejects collisions with open editor buffers even when absent from disk and retains the input', async () => {
  props.buffers = [{ ...original, path: 'missing.ts', savedContent: 'saved' }]; await mount();
  actions(); fireEvent.click(screen.getByRole('button', { name: 'Rename file' })); submit('Rename file path', 'missing.ts');
  expect(await screen.findByRole('alert')).toHaveTextContent('already exists or is open'); expect(calls('renameFile')).toHaveLength(0);
  expect(screen.getByRole('textbox', { name: 'Rename file path' })).toHaveValue('missing.ts');
});
it('reports the pending mutation so its parent can prevent edits during deletion', async () => {
  props.onPendingChange = vi.fn();
  const implementation = vi.mocked(api).getMockImplementation()!;
  let complete!: (value: unknown) => void;
  const request = new Promise(resolve => { complete = resolve; });
  vi.mocked(api).mockImplementation((method, params) => method === 'trashFile' ? request as Promise<never> : implementation(method, params));
  await mount(); actions(); fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete file' }));
  await waitFor(() => expect(calls('trashFile')).toHaveLength(1));
  expect(props.onPendingChange).toHaveBeenLastCalledWith(true);
  await act(async () => { complete({ path: 'main.ts', trashId: 'trash-1' }); });
  expect(props.onPendingChange).toHaveBeenLastCalledWith(false);
});
it('blocks destructive operations when the open buffer baseline differs from disk', async () => {
  props.buffers = [{ ...original, hash: 'older', savedContent: 'saved' }]; await mount();
  actions(); fireEvent.click(screen.getByRole('button', { name: 'Rename file' })); submit('Rename file path', 'renamed.ts');
  expect(await screen.findByRole('alert')).toHaveTextContent('changed on disk'); expect(calls('renameFile')).toHaveLength(0);
});
it('creates empty folders, prefills the selected directory, and collapses all folders', async () => {
  entries = []; props.files = []; await mount(); expect(screen.getByText(/This folder is empty/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'New Folder' })); submit('New folder path', 'src');
  const folder = await screen.findByRole('button', { name: 'src' }); expect(folder).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'New File' })); expect(screen.getByRole('textbox', { name: 'New file path' })).toHaveValue('src/');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel file action' })); fireEvent.click(screen.getByRole('button', { name: 'Collapse All' })); expect(folder).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Example' })); fireEvent.click(screen.getByRole('button', { name: 'New File' })); expect(screen.getByRole('textbox', { name: 'New file path' })).toHaveValue('');
});
it('copies relative and absolute paths and reports clipboard failures', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } }); await mount();
  actions(); fireEvent.click(screen.getByRole('button', { name: 'Copy relative path' })); expect(writeText).toHaveBeenCalledWith('main.ts');
  actions(); fireEvent.click(screen.getByRole('button', { name: 'Copy absolute path' })); expect(writeText).toHaveBeenCalledWith('/tmp/example/main.ts');
  writeText.mockRejectedValueOnce(new Error('Unavailable')); actions(); fireEvent.click(screen.getByRole('button', { name: 'Copy relative path' })); expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy path');
});
it('refreshes on focus without dropping dirty buffers or collapsed folders', async () => {
  entries = [{ path: 'src/main.ts', kind: 'file' }]; props.files = ['src/main.ts']; props.buffers = [{ ...original, path: 'src/main.ts', savedContent: 'saved', content: 'dirty' }];
  await mount(); fireEvent.click(screen.getByRole('button', { name: 'src' }));
  fireEvent.focus(window); await waitFor(() => expect(calls('workspaceEntries')).toHaveLength(2));
  expect(screen.getByRole('button', { name: 'src' })).toHaveAttribute('aria-expanded', 'false'); expect(props.onDeleted).not.toHaveBeenCalled();
});
it('ignores stale project mutation completions and duplicate submissions', async () => {
  let finish!: (file: typeof original) => void;
  const implementation = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((method, params, options) => method === 'renameFile' ? new Promise(resolve => { finish = resolve as typeof finish; }) : implementation(method, params, options));
  const view = await mount(); actions(); fireEvent.click(screen.getByRole('button', { name: 'Rename file' })); submit('Rename file path', 'new.ts');
  await waitFor(() => expect(calls('renameFile')).toHaveLength(1)); fireEvent.submit(screen.getByRole('textbox', { name: 'Rename file path' }).closest('form')!); expect(calls('renameFile')).toHaveLength(1);
  view.rerender(<ExplorerPanel {...props} project={{ ...project, id: 'next' }}/>);
  await act(async () => finish({ ...original, path: 'new.ts' })); expect(props.onRenamed).not.toHaveBeenCalled();
});
it('ignores stale entry scans after a project switch', async () => {
  let finish!: (value: unknown) => void;
  const implementation = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((method, params, options) => method === 'workspaceEntries' && params?.projectId === 'p' ? new Promise(resolve => { finish = resolve; }) : implementation(method, params, options));
  const view = render(<ExplorerPanel {...props}/>);
  view.rerender(<ExplorerPanel {...props} project={{ ...project, id: 'next' }}/>);
  await waitFor(() => expect(props.onFilesChange).toHaveBeenCalledTimes(1));
  await act(async () => finish({ entries: [{ path: 'stale.ts', kind: 'file' }], truncated: false })); expect(screen.queryByRole('button', { name: 'stale.ts' })).not.toBeInTheDocument(); expect(props.onFilesChange).toHaveBeenCalledTimes(1);
});
it('creates a file once, retains failed input, and prevents IME Enter from submitting', async () => {
  let finish!: (file: typeof original) => void;
  const implementation = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((method, params, options) => method === 'createFile' ? new Promise(resolve => { finish = resolve as typeof finish; }) : implementation(method, params, options));
  await mount(); fireEvent.click(screen.getByRole('button', { name: 'New File' }));
  const input = screen.getByRole('textbox', { name: 'New file path' });
  fireEvent.change(input, { target: { value: 'new.ts' } }); fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); expect(calls('createFile')).toHaveLength(0);
  fireEvent.submit(input.closest('form')!); fireEvent.submit(input.closest('form')!); expect(calls('createFile')).toHaveLength(1);
  expect(calls('createFile')[0][1]).toEqual({ projectId: 'p', path: 'new.ts' });
  await act(async () => finish({ ...original, path: 'new.ts' })); expect(props.onCreated).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'New File' })); submit('New file path', 'main.ts');
  expect(await screen.findByRole('alert')).toHaveTextContent('already exists'); expect(screen.getByRole('textbox', { name: 'New file path' })).toHaveValue('main.ts');
});
it('supports versioned command requests and reveals a file by expanding parents and clearing the filter', async () => {
  entries = [{ path: 'src/nested/code.ts', kind: 'file' }]; props.files = entries.map(entry => entry.path);
  const view = await mount(); fireEvent.click(screen.getByRole('button', { name: 'Collapse All' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter files' }), { target: { value: 'no matches' } });
  view.rerender(<ExplorerPanel {...props} actionRequest={{ action: 'reveal', path: 'src/nested/code.ts', version: 1 }}/>);
  expect(await screen.findByRole('button', { name: 'src/nested/code.ts' })).toBeInTheDocument(); expect(screen.getByRole('textbox', { name: 'Filter files' })).toHaveValue('');
  view.rerender(<ExplorerPanel {...props} actionRequest={{ action: 'newFile', version: 2 }}/>);
  const input = await screen.findByRole('textbox', { name: 'New file path' }); expect(input).toHaveValue('src/nested/');
  fireEvent.change(input, { target: { value: 'edited.ts' } });
  view.rerender(<ExplorerPanel {...props} actionRequest={{ action: 'newFile', version: 2 }}/>); expect(input).toHaveValue('edited.ts');
});
it.each(['file', 'rename', 'duplicate'] as const)('clears the filter and reveals the result of a successful %s', async kind => {
  await mount();
  if (kind === 'file') fireEvent.click(screen.getByRole('button', { name: 'New File' }));
  else { actions(); fireEvent.click(screen.getByRole('button', { name: kind === 'rename' ? 'Rename file' : 'Duplicate saved file' })); }
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter files' }), { target: { value: 'no match' } });
  const label = kind === 'file' ? 'New file path' : kind === 'rename' ? 'Rename file path' : 'Duplicate file path';
  submit(label, 'src/nested/new.ts');
  expect(await screen.findByRole('button', { name: 'src/nested/new.ts' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Filter files' })).toHaveValue('');
});
it('reveals restored files under collapsed parents and clears the filter', async () => {
  entries = [{ path: 'src/nested/keep.ts', kind: 'file' }]; props.files = entries.map(entry => entry.path);
  const implementation = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((method, params, options) => method === 'listTrash' ? Promise.resolve([{ trashId: 'deleted', path: 'src/nested/deleted.ts', deletedAt: '2026-10-21' }]) : method === 'restoreTrash' ? Promise.resolve({ ...original, path: 'src/nested/deleted.ts' }) : implementation(method, params, options));
  await mount(); fireEvent.click(screen.getByRole('button', { name: 'Collapse All' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter files' }), { target: { value: 'no match' } });
  fireEvent.click(screen.getByRole('button', { name: 'Deleted files' })); fireEvent.click(await screen.findByRole('button', { name: 'Restore src/nested/deleted.ts' }));
  await waitFor(() => expect(props.onCreated).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Close deleted files' }));
  expect(screen.getByRole('button', { name: 'src/nested/deleted.ts' })).toBeInTheDocument(); expect(screen.getByRole('textbox', { name: 'Filter files' })).toHaveValue('');
});
