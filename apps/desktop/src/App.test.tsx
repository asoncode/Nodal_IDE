// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act as reactAct, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App.js';
import { api } from './api.js';
import { isDesktop, pickFolder, restoreLastProject, listenDesktopActions } from './desktop.js';
import { createNode, emptyGraph, type Graph } from './model.js';

vi.mock('./api.js', () => ({ api: vi.fn() }));
vi.mock('./desktop.js', () => ({ isDesktop: vi.fn(), pickFolder: vi.fn(), restoreLastProject: vi.fn(), listenDesktopActions: vi.fn() }));
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="Source editor" value={value} onChange={event => onChange(event.target.value)}/>,
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => <div aria-label="File comparison">{original} → {modified}</div>,
}));
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, onNodeClick, children }: { nodes: { id: string; data: { node: { label: string } } }[]; onNodeClick: (event: unknown, node: { id: string }) => void; children: React.ReactNode }) => <div aria-label="Workflow graph">{nodes.map(node => <button key={node.id} onClick={() => onNodeClick({}, node)}>{node.data.node.label}</button>)}{children}</div>,
  Background: () => null, BackgroundVariant: { Dots: 'dots' }, Controls: () => null, MiniMap: () => null, Handle: () => null,
  Position: { Left: 'left', Right: 'right' }, applyNodeChanges: vi.fn(), applyEdgeChanges: vi.fn(),
}));

const project = { id: 'project-1', name: 'sample-repo', root: '/tmp/sample-repo', branch: 'main' };
let graph: Graph;
let calls: { method: string; params: Record<string, unknown> }[];
let generation: Graph;

beforeEach(() => {
  vi.mocked(isDesktop).mockReturnValue(false); vi.mocked(pickFolder).mockResolvedValue(null); vi.mocked(restoreLastProject).mockResolvedValue(true); vi.mocked(listenDesktopActions).mockResolvedValue(() => {});
  graph = emptyGraph(); graph.name = 'Command workflow';
  const command = createNode('command', 1); command.id = 'command-1'; command.label = 'Check Node';
  graph.nodes.splice(1, 0, command);
  graph.edges = [{ id: 'a', source: graph.nodes[0].id, target: command.id, kind: 'control' }, { id: 'b', source: command.id, target: graph.nodes[2].id, kind: 'control' }];
  generation = { ...structuredClone(graph), id: 'generated', name: 'Generated plan' };
  calls = [];
  vi.mocked(api).mockImplementation(async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ method, params });
    const results: Record<string, unknown> = {
      bootstrap: { projects: [project], templates: [], providers: [] }, files: params.projectId === 'plain-folder' ? ['notes.txt'] : ['src/example.ts'], listGraphs: params.projectId === 'plain-folder' ? [] : [graph], runs: [],
      openProject: { id: 'plain-folder', name: 'plain-folder', root: '/tmp/plain-folder', isGitRepository: false },
      readFile: { content: 'export const answer = 1;', hash: 'a'.repeat(64) }, writeFile: { content: params.content, hash: 'b'.repeat(64) },
      saveGraph: params.graph, generateGraph: { graph: generation, summary: 'A validated plan.' },
      run: { id: 'run-1', projectId: project.id, graph, status: 'running', createdAt: new Date().toISOString() },
      inspectRun: { run: { id: 'run-1', projectId: project.id, graph, status: 'running', createdAt: new Date().toISOString() }, attempts: [], checkpoints: [], approvals: [{ id: 'approval-1', nodeId: 'command-1', decision: 'pending', message: 'Run node --version with your user privileges?', scope: { command: 'node', args: ['--version'] } }] },
      events: [{ eventId: 'event-1', sequence: 1, runId: 'run-1', nodeId: 'command-1', timestamp: new Date().toISOString(), kind: 'command.output', payload: { text: 'v24.0.0' } }],
      approve: { accepted: true },
    };
    if (!(method in results)) throw new Error(`Unexpected API call: ${method}`);
    return results[method] as T;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

async function ready() {
  render(<App/>);
  await screen.findByRole('button', { name: 'Check Node' });
}

describe('workspace flows', () => {
  it('saves node configuration through the real graph document contract', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Check Node' }));
    fireEvent.change(screen.getByLabelText('Executable'), { target: { value: 'npm' } });
    fireEvent.change(screen.getByLabelText('Arguments (one per line)'), { target: { value: 'test\n--\n--run' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some(call => call.method === 'saveGraph')).toBe(true));
    const saved = calls.find(call => call.method === 'saveGraph')!.params.graph as Graph;
    const command = saved.nodes.find(node => node.id === 'command-1');
    expect(command?.kind).toBe('command');
    expect(command?.config).toMatchObject({ command: 'npm', args: ['test', '--', '--run'], requireApproval: true });
    expect(saved.edges).toEqual(graph.edges);
  });

  it('undoes and redoes a node edit without changing the saved document', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Check Node' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Check runtime version' } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Check Node');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Check runtime version');
    expect(calls.some(call => call.method === 'saveGraph')).toBe(false);
  });

  it('blocks execution when a graph has lost its required start node', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run workflow' }));
    await screen.findByRole('alert');
    expect(calls.some(call => call.method === 'run')).toBe(false);
  });

  it('opens a repository file and saves with its original hash to prevent silent overwrites', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'src/example.ts' }));
    const editor = await screen.findByRole('textbox', { name: 'Source editor' });
    fireEvent.change(editor, { target: { value: 'export const answer = 42;' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(call => call.method === 'writeFile')?.params).toEqual({ projectId: project.id, path: 'src/example.ts', content: 'export const answer = 42;', expectedHash: 'a'.repeat(64) }));
  });

  it('shows runtime events and requires an explicit decision for command approval', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Run workflow' }));
    await screen.findByText('command.output');
    fireEvent.click(screen.getByRole('button', { name: /Approvals/ }));
    await screen.findByText('Run node --version with your user privileges?');
    expect(calls.some(call => call.method === 'approve')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.find(call => call.method === 'approve')?.params).toEqual({ runId: 'run-1', nodeId: 'command-1', approved: true }));
  });

  it('keeps generated graphs in preview until the user explicitly applies them', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    const dialog = screen.getByRole('dialog', { name: 'Generate workflow' });
    fireEvent.change(within(dialog).getByLabelText('What should this workflow do?'), { target: { value: 'Check Node version with approval' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate preview' }));
    await within(dialog).findByText('Generated plan');
    expect(calls.some(call => call.method === 'run')).toBe(false);
    expect(screen.getByLabelText('Workflow name')).toHaveProperty('value', 'Command workflow');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply to canvas' }));
    expect(screen.getByLabelText('Workflow name')).toHaveProperty('value', 'Generated plan');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the native folder chooser directly and shows ordinary folder files', async () => {
    vi.mocked(isDesktop).mockReturnValue(true); vi.mocked(pickFolder).mockResolvedValue('/tmp/plain-folder');
    await ready(); fireEvent.click(screen.getByRole('button', { name: 'Open Folder' }));
    await screen.findByRole('button', { name: 'notes.txt' });
    expect(pickFolder).toHaveBeenCalledOnce(); expect(calls.find(call => call.method === 'openProject')?.params).toEqual({ path: '/tmp/plain-folder' });
    expect(screen.queryByRole('dialog', { name: 'Open Folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check Node' })).toBeNull();
    await screen.findByText('Select a file in Explorer to start editing.');
  });

  it('treats native chooser cancellation as a no-op', async () => {
    vi.mocked(isDesktop).mockReturnValue(true); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Open Folder' }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalledOnce());
    expect(calls.some(call => call.method === 'openProject')).toBe(false); expect(screen.getByRole('button', { name: 'src/example.ts' })).toBeTruthy();
  });

  it('keeps unsaved code when another folder is declined', async () => {
    vi.mocked(isDesktop).mockReturnValue(true); vi.mocked(pickFolder).mockResolvedValue('/tmp/plain-folder'); vi.spyOn(window, 'confirm').mockReturnValue(false);
    await ready(); fireEvent.click(screen.getByRole('button', { name: 'src/example.ts' }));
    const editor = await screen.findByRole('textbox', { name: 'Source editor' }); fireEvent.change(editor, { target: { value: 'unsaved code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open Folder' }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith('Discard unsaved edits and open another folder?'));
    expect(calls.some(call => call.method === 'openProject')).toBe(false); expect(editor).toHaveProperty('value', 'unsaved code');
  });

  it('leaves a New Window empty instead of restoring another window’s project', async () => {
    vi.mocked(restoreLastProject).mockResolvedValue(false); render(<App/>);
    await screen.findByRole('heading', { name: 'Open a folder' });
    expect(calls.some(call => call.method === 'files' || call.method === 'listGraphs')).toBe(false);
    expect(screen.queryByRole('button', { name: 'src/example.ts' })).toBeNull();
  });

  it('handles native Save using the latest buffer and avoids duplicate keyboard saves', async () => {
    vi.mocked(isDesktop).mockReturnValue(true); await ready();
    const handlers = vi.mocked(listenDesktopActions).mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'src/example.ts' }));
    const editor = await screen.findByRole('textbox', { name: 'Source editor' }); fireEvent.change(editor, { target: { value: 'updated code' } });
    fireEvent.keyDown(window, { key: 's', metaKey: true }); expect(calls.some(call => call.method === 'writeFile')).toBe(false);
    await reactAct(async () => handlers.save());
    await waitFor(() => expect(calls.filter(call => call.method === 'writeFile')).toHaveLength(1));
    expect(calls.find(call => call.method === 'writeFile')?.params.content).toBe('updated code');
  });

  it('protects dirty files when the native window closes', async () => {
    await ready(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const handlers = vi.mocked(listenDesktopActions).mock.calls[0][0]; expect(handlers.canClose()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'src/example.ts' })); const editor = await screen.findByRole('textbox', { name: 'Source editor' });
    fireEvent.change(editor, { target: { value: 'unsaved code' } }); expect(handlers.canClose()).toBe(false); expect(confirm).toHaveBeenCalledOnce();
  });

});
