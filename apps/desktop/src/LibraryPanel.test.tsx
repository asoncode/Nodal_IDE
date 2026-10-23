// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LibraryPanel from './LibraryPanel.js';
import { api } from './api.js';
import { emptyGraph, type Graph } from './model.js';
vi.mock('./api.js', () => ({ api: vi.fn() }));

const item = (version: number) => ({ kind: 'workflow', slug: 'backend-build', name: 'Backend build', version, changelog: version === 2 ? 'More iterations' : '', origin: { project: 'node-app', exportedAt: 'now' }, parameters: [{ name: 'backendDir', kind: 'path', description: 'API folder', default: 'backend' }] });
let calls: { method: string; params: Record<string, unknown> }[]; let problems: string[];
const imported: Graph = { ...emptyGraph(), id: 'new', name: 'Backend build' };
beforeEach(() => {
  calls = []; problems = [];
  vi.mocked(api).mockImplementation(async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ method, params });
    if (method === 'libraryInfo') return { location: '/Users/me/Nodal/Library', items: [item(1), item(2)], errors: [] } as T;
    if (method === 'listRoles') return [] as T;
    if (method === 'libraryCandidates') return [{ kind: 'path', value: 'server', suggestedName: 'serverDir' }, { kind: 'command', value: 'python3 -m pytest', suggestedName: 'testCommand' }] as T;
    if (method === 'previewImport') { const bindings = (params.bindings as Record<string, string> | undefined) ?? { backendDir: 'backend' }; return { item: item(params.version as number), bindings, missing: [], result: { kind: 'workflow', graph: imported, problems } } as T; }
    if (method === 'exportToLibrary') return { ...item(3), name: params.name } as T;
    return {} as T;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('library panel', () => {
  it('previews an item with bound parameters and applies only a valid result', async () => {
    const onApply = vi.fn();
    render(<LibraryPanel projectId="p" graph={emptyGraph()} onApplyWorkflow={onApply}/>);
    fireEvent.click(await screen.findByRole('button', { name: /Backend build/ }));
    const card = await screen.findByRole('article', { name: 'Import Backend build' });
    fireEvent.change(within(card).getByLabelText('Parameter backendDir'), { target: { value: 'server' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Preview with these values' }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: 'previewImport', params: { slug: 'backend-build', version: 2, bindings: { backendDir: 'server' } } }));
    fireEvent.click(await within(card).findByRole('button', { name: 'Apply to canvas' }));
    expect(onApply).toHaveBeenCalledWith(imported);
    problems = ['End is unreachable.'];
    fireEvent.click(within(card).getByRole('button', { name: 'Preview with these values' }));
    expect(await within(card).findByText('End is unreachable.')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Apply to canvas' })).toBeDisabled();
  });
  it('offers an update for a workflow imported from an older version, using its bindings', async () => {
    const graph: Graph = { ...emptyGraph(), name: 'Backend build', origin: { library: 'backend-build', version: 1, bindings: { backendDir: 'server' } } };
    render(<LibraryPanel projectId="p" graph={graph} onApplyWorkflow={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview update' }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: 'previewImport', params: { version: 2, bindings: { backendDir: 'server' } } }));
  });
  it('saves the workflow with the chosen parameters, named from its existing bindings', async () => {
    const graph: Graph = { ...emptyGraph(), name: 'Backend build', origin: { library: 'backend-build', version: 2, bindings: { backendDir: 'server' } } };
    render(<LibraryPanel projectId="p" graph={graph} onApplyWorkflow={vi.fn()}/>);
    expect(await screen.findByLabelText('Parameter name for server')).toHaveValue('backendDir');
    fireEvent.change(screen.getByLabelText('Changelog'), { target: { value: 'Raised iterations' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow to library' }));
    await waitFor(() => expect(calls.find(call => call.method === 'exportToLibrary')?.params).toMatchObject({ kind: 'workflow', name: 'Backend build', changelog: 'Raised iterations', parameters: [{ name: 'backendDir', kind: 'path', value: 'server' }, { name: 'testCommand', kind: 'command', value: 'python3 -m pytest' }] }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved Backend build as version 3.');
  });
});
