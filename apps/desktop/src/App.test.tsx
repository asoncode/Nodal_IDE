// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act as reactAct, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App.js';
import { api } from './api.js';
import { isDesktop, pickFolder, restoreLastProject, listenDesktopActions } from './desktop.js';
import { createNode, emptyGraph, language, type Graph } from './model.js';

vi.mock('./api.js', () => ({ api: vi.fn() }));
vi.mock('./desktop.js', () => ({ isDesktop: vi.fn(), pickFolder: vi.fn(), restoreLastProject: vi.fn(), listenDesktopActions: vi.fn() }));
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange, language }: { value: string; onChange: (value: string) => void; language: string }) => <textarea data-language={language} aria-label="Source editor" value={value} onChange={event => onChange(event.target.value)}/>,
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => <div aria-label="File comparison">{original} → {modified}</div>,
}));
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, onNodeClick, children }: { nodes: { id: string; data: { node: { label: string } } }[]; onNodeClick: (event: unknown, node: { id: string }) => void; children: React.ReactNode }) => <div aria-label="Workflow graph">{nodes.map(node => <button key={node.id} onClick={() => onNodeClick({}, node)}>{node.data.node.label}</button>)}{children}</div>,
  Background: () => null, BackgroundVariant: { Dots: 'dots', Cross: 'cross' }, Controls: () => null, MiniMap: () => null, Handle: () => null,
  Position: { Left: 'left', Right: 'right' }, applyNodeChanges: vi.fn(), applyEdgeChanges: vi.fn(),
}));

const project = { id: 'project-1', name: 'sample-repo', root: '/tmp/sample-repo', branch: 'main' };
let graph: Graph;
let calls: { method: string; params: Record<string, unknown> }[];
let generation: Graph;
let workspaceFiles: string[];

beforeEach(() => {
  vi.mocked(isDesktop).mockReturnValue(false); vi.mocked(pickFolder).mockResolvedValue(null); vi.mocked(restoreLastProject).mockResolvedValue(true); vi.mocked(listenDesktopActions).mockResolvedValue(() => {});
  graph = emptyGraph(); graph.name = 'Command workflow';
  const command = createNode('command', 1); command.id = 'command-1'; command.label = 'Check Node';
  graph.nodes.splice(1, 0, command);
  graph.edges = [{ id: 'a', source: graph.nodes[0].id, target: command.id, kind: 'control' }, { id: 'b', source: command.id, target: graph.nodes[2].id, kind: 'control' }];
  generation = { ...structuredClone(graph), id: 'generated', name: 'Generated plan' };
  calls = []; workspaceFiles = ['src/example.ts'];
  vi.mocked(api).mockImplementation(async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ method, params });
    const results: Record<string, unknown> = {
      bootstrap: { projects: [project], templates: [], providers: [] }, files: params.projectId === 'plain-folder' ? ['notes.txt'] : workspaceFiles, listGraphs: params.projectId === 'plain-folder' ? [] : [graph], runs: [],
      openProject: { id: 'plain-folder', name: 'plain-folder', root: '/tmp/plain-folder', isGitRepository: false },
      workspaceEntries: { entries: [...(params.projectId === 'plain-folder' ? ['notes.txt'] : workspaceFiles).map(path => ({ path, kind: 'file' })), ...(params.projectId === 'plain-folder' ? [] : [{ path: 'src', kind: 'directory' }])], truncated: false },
      listTrash: [], createFolder: { path: params.path, kind: 'directory' },
      renameFile: { path: params.newPath, content: 'export const answer = 1;', hash: 'a'.repeat(64) },
      duplicateFile: { path: params.newPath, content: 'export const answer = 1;', hash: 'a'.repeat(64) },
      trashFile: { trashId: 'deleted-1', path: params.path },
      searchWorkspace: { matches: [{ path: 'src/example.ts', line: 8, column: 3, preview: 'export const answer = 1;' }], truncated: false },
      createFile: { path: params.path, content: '', hash: 'c'.repeat(64) },
      readFile: { content: 'export const answer = 1;', hash: 'a'.repeat(64) }, writeFile: { content: params.content, hash: 'b'.repeat(64) },
      saveGraph: params.graph,
      providerStatus: [{ id: 'claude', available: true, authenticated: true, status: 'authenticated', message: 'Signed in' }, { id: 'codex', available: true, authenticated: true, status: 'authenticated', message: 'Signed in' }],
      startGeneration: { id: 'generation-1', projectId: project.id, provider: 'claude', status: 'running', createdAt: new Date().toISOString() },
      inspectGeneration: { id: 'generation-1', projectId: project.id, provider: 'claude', status: 'succeeded', result: { graph: generation, summary: 'A validated plan.', attempts: 1 }, createdAt: new Date().toISOString() },
      cancelGeneration: { id: 'generation-1', projectId: project.id, provider: 'claude', status: 'cancelled', createdAt: new Date().toISOString() },
      run: { id: 'run-1', projectId: project.id, graph, status: 'running', createdAt: new Date().toISOString() },
      inspectRun: { run: { id: 'run-1', projectId: project.id, graph, status: 'running', createdAt: new Date().toISOString() }, attempts: [], checkpoints: [], approvals: [{ id: 'approval-1', nodeId: 'command-1', decision: 'pending', message: 'Run node --version with your user privileges?', scope: { command: 'node', args: ['--version'] } }] },
      events: [{ eventId: 'event-1', sequence: 1, runId: 'run-1', nodeId: 'command-1', timestamp: new Date().toISOString(), kind: 'command.output', payload: { text: 'v24.0.0' } }],
      approve: { accepted: true }, chatFiles: [], chats: [], closeTerminals: { closed: true },
    };
    if (!(method in results)) throw new Error(`Unexpected API call: ${method}`);
    return results[method] as T;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

async function ready() {
  render(<App/>);
  await screen.findByRole('button', { name: 'Check Node' });
  // Startup work finishes a tick after the graph renders; actions are disabled until then.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false));
}

describe('workspace flows', () => {
  it('edits and saves a functional role snapshot on an agent step', async () => {
    const agent = createNode('agent', 3); agent.id = 'ui-agent'; agent.label = 'Build interface';
    graph.nodes.splice(1, 0, agent);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Build interface' }));
    fireEvent.change(screen.getByLabelText('Role title'), { target: { value: 'UI engineer' } });
    fireEvent.change(screen.getByLabelText('Expertise and standards'), { target: { value: 'Build accessible interfaces.' } });
    fireEvent.change(screen.getByLabelText('Owned paths (one per line)'), { target: { value: 'src/**' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply role to step' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some(call => call.method === 'saveGraph')).toBe(true));
    const saved = calls.find(call => call.method === 'saveGraph')!.params.graph as Graph;
    expect(saved.nodes.find(node => node.id === 'ui-agent')?.config).toMatchObject({ role: { title: 'UI engineer', expertise: 'Build accessible interfaces.', owns: ['src/**'] } });
    expect(calls.some(call => call.method === 'listRoles')).toBe(false);
  });

  it('shows real ownership coverage for the current draft', async () => {
    const agent = createNode('agent', 3); agent.id = 'ui-agent'; agent.label = 'Build interface';
    if (agent.kind !== 'agent') throw new Error('Expected agent');
    agent.config.permission = 'scoped-edit';
    agent.config.role = { id: 'ui', title: 'UI engineer', expertise: 'Build interfaces.', knowledge: [], owns: ['src/**'], produces: [], consumes: [], skills: [] };
    graph.nodes.splice(1, 0, agent);
    workspaceFiles = ['src/example.ts', 'README.md'];
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Team' }));
    expect(screen.getByText(/1 listed files without an editing owner/)).toBeTruthy();
    expect(screen.getByText('README.md', { selector: 'code' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit role for Build interface' }));
    expect(screen.getByLabelText('Role title')).toHaveProperty('value', 'UI engineer');
  });

  it('opens a role playbook from the inspector and saves edits to its steps in the workflow', async () => {
    const role = createNode('role', 2); role.id = 'role-1'; role.label = 'Simulation';
    graph.nodes.splice(2, 0, role); graph.edges = [...graph.edges.filter(edge => edge.id !== 'b'), { id: 'b', source: 'command-1', target: 'role-1', kind: 'control' }, { id: 'c', source: 'role-1', target: graph.nodes.at(-1)!.id, kind: 'control' }];
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    fireEvent.click(screen.getByRole('button', { name: /Open playbook/ }));
    expect(screen.getByRole('tab', { name: /Simulation playbook/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Implement' }));
    fireEvent.change(screen.getByLabelText('Step task'), { target: { value: 'Build the seeded simulator.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some(call => call.method === 'saveGraph')).toBe(true));
    const saved = (calls.find(call => call.method === 'saveGraph')!.params.graph as Graph).nodes.find(node => node.id === 'role-1');
    expect(saved?.kind === 'role' && saved.config.playbook.nodes.find(step => step.id === 'implement')).toMatchObject({ config: { instructions: 'Build the seeded simulator.' } });
  });

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

  it.each([['src/main.cpp', 'cpp'], ['script.py', 'python'], ['README.MD', 'markdown']])('creates %s and opens an empty saved editor with %s syntax', async (path, syntax) => {
    await ready();
    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'missing' } });
    fireEvent.click(screen.getByRole('button', { name: 'New File' }));
    const input = screen.getByRole('textbox', { name: 'New file path' });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: path } });
    fireEvent.submit(input.closest('form')!);
    const editor = await screen.findByRole('textbox', { name: 'Source editor' });
    expect(editor).toHaveProperty('value', '');
    expect(editor.getAttribute('data-language')).toBe(syntax);
    expect(calls.find(call => call.method === 'createFile')?.params).toEqual({ projectId: project.id, path });
    expect(screen.getByRole('button', { name: path })).toBeTruthy();
    expect(screen.getByLabelText('Filter files')).toHaveProperty('value', '');
    expect(screen.queryByRole('textbox', { name: 'New file path' })).toBeNull();
    fireEvent.change(editor, { target: { value: 'new content' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(call => call.method === 'writeFile')?.params).toEqual({ projectId: project.id, path, content: 'new content', expectedHash: 'c'.repeat(64) }));
  });

  it('keeps the path open when Enter confirms an IME composition', async () => {
    await ready(); fireEvent.click(screen.getByRole('button', { name: 'New File' }));
    const input = screen.getByRole('textbox', { name: 'New file path' });
    fireEvent.change(input, { target: { value: 'notes.md' } });
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    fireEvent(input, event);
    expect(event.defaultPrevented).toBe(true);
    expect(calls.some(call => call.method === 'createFile')).toBe(false);
    expect(input).toHaveProperty('value', 'notes.md');
  });

  it('keeps a failed creation draft and allows cancellation without opening the existing file', async () => {
    await ready();
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params) => {
      if (method !== 'createFile') return implementation(method, params);
      calls.push({ method, params: params ?? {} });
      return Promise.reject(new Error('File already exists'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'New File' }));
    const input = screen.getByRole('textbox', { name: 'New file path' });
    fireEvent.change(input, { target: { value: 'created-elsewhere.ts' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByRole('alert');
    expect(input).toHaveProperty('value', 'created-elsewhere.ts');
    expect(screen.queryByRole('textbox', { name: 'Source editor' })).toBeNull();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'New file path' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New File' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel file action' }));
    expect(screen.queryByRole('textbox', { name: 'New file path' })).toBeNull();
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === 'createFile')).toHaveLength(1);
  });

  it('preserves unsaved content when creating a path that is already open', async () => {
    await ready(); fireEvent.click(screen.getByRole('button', { name: 'src/example.ts' }));
    const editor = await screen.findByRole('textbox', { name: 'Source editor' });
    fireEvent.change(editor, { target: { value: 'unsaved code' } });
    fireEvent.click(screen.getByRole('button', { name: 'New File' }));
    const input = screen.getByRole('textbox', { name: 'New file path' });
    fireEvent.change(input, { target: { value: 'src/example.ts' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByText('That path already exists or is open in the editor. Choose another path.');
    expect(editor).toHaveProperty('value', 'unsaved code');
    expect(input).toHaveProperty('value', 'src/example.ts');
    expect(calls.some(call => call.method === 'createFile')).toBe(false);
  });

  it('submits only one creation while a request is pending and ignores a result after switching folders', async () => {
    vi.mocked(isDesktop).mockReturnValue(true); vi.mocked(pickFolder).mockResolvedValue('/tmp/plain-folder');
    await ready();
    const implementation = vi.mocked(api).getMockImplementation()!;
    let resolveCreation!: (value: unknown) => void;
    const pending = new Promise(resolve => { resolveCreation = resolve; });
    vi.mocked(api).mockImplementation((method, params) => {
      if (method !== 'createFile') return implementation(method, params);
      calls.push({ method, params: params ?? {} });
      return pending as Promise<never>;
    });
    fireEvent.click(screen.getByRole('button', { name: 'New File' }));
    const input = screen.getByRole('textbox', { name: 'New file path' });
    fireEvent.change(input, { target: { value: 'later.py' } });
    fireEvent.submit(input.closest('form')!); fireEvent.submit(input.closest('form')!);
    expect(calls.filter(call => call.method === 'createFile')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open Folder' }));
    await screen.findByRole('button', { name: 'notes.txt' });
    await reactAct(async () => { resolveCreation({ path: 'later.py', content: '', hash: 'c'.repeat(64) }); });
    expect(screen.queryByRole('button', { name: 'later.py' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Source editor' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'New file path' })).toBeNull();
  });

  it('re-checks a folder saved as not a repository, so a later git init lets workflows run', async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    let initialized = false;
    vi.mocked(api).mockImplementation(async (method, params) => {
      if (method === 'bootstrap') return { projects: [{ ...project, isGitRepository: false }], templates: [], providers: [] } as never;
      if (method === 'openProject' && (params as { path?: string })?.path === project.root) { calls.push({ method, params: params as Record<string, unknown> }); return { ...project, isGitRepository: initialized } as never; }
      return implementation(method, params);
    });
    render(<App/>);
    await waitFor(() => expect(calls.some(call => call.method === 'listGraphs')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run workflow' })).toHaveProperty('disabled', false));
    expect(calls.filter(call => call.method === 'openProject')).toHaveLength(1); // re-checked on load
    initialized = true; // The user runs git init and commits while Nodal is open.
    fireEvent.click(screen.getByRole('button', { name: 'Run workflow' }));
    await waitFor(() => expect(calls.some(call => call.method === 'run')).toBe(true));
    expect(screen.queryByText(/Workflows require a Git repository/)).toBeNull();
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
    fireEvent.click(within(dialog).getByLabelText('Plan a specialist team first'));
    fireEvent.change(within(dialog).getByLabelText('What should this workflow do?'), { target: { value: 'Check Node version with approval' } });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Generate preview' })).toHaveProperty('disabled', false));
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

  it('renames an open dirty file while preserving edits and saving against the original disk hash', async () => {
    await ready(); fireEvent.click(screen.getByRole('button', { name: 'src/example.ts' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Source editor' }), { target: { value: 'unsaved rename content' } });
    fireEvent.keyDown(screen.getByRole('button', { name: 'src/example.ts' }), { key: 'F2' });
    const path = screen.getByRole('textbox', { name: 'Rename file path' });
    fireEvent.change(path, { target: { value: 'src/renamed.ts' } }); fireEvent.submit(path.closest('form')!);
    await screen.findByRole('tab', { name: 'renamed.ts' });
    expect(screen.queryByRole('tab', { name: 'example.ts' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Source editor' })).toHaveProperty('value', 'unsaved rename content');
    expect(calls.find(call => call.method === 'renameFile')?.params).toEqual({ projectId: project.id, path: 'src/example.ts', newPath: 'src/renamed.ts', expectedHash: 'a'.repeat(64) });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(call => call.method === 'writeFile')?.params).toEqual({ projectId: project.id, path: 'src/renamed.ts', content: 'unsaved rename content', expectedHash: 'a'.repeat(64) }));
  });

  it('keeps an open dirty buffer when deletion is cancelled, and closes it only after confirmed trash succeeds', async () => {
    await ready(); fireEvent.click(screen.getByRole('button', { name: 'src/example.ts' }));
    const editor = await screen.findByRole('textbox', { name: 'Source editor' });
    fireEvent.change(editor, { target: { value: 'unsaved code' } });
    fireEvent.keyDown(screen.getByRole('button', { name: 'src/example.ts' }), { key: 'Delete' });
    let dialog = screen.getByRole('dialog', { name: 'Delete file' });
    expect(dialog.textContent).toContain('Unsaved editor changes will be discarded.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some(call => call.method === 'trashFile')).toBe(false);
    expect(editor).toHaveProperty('value', 'unsaved code');
    fireEvent.keyDown(screen.getByRole('button', { name: 'src/example.ts' }), { key: 'Delete' });
    dialog = screen.getByRole('dialog', { name: 'Delete file' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'example.ts' })).toBeNull());
    expect(calls.find(call => call.method === 'trashFile')?.params).toEqual({ projectId: project.id, path: 'src/example.ts', expectedHash: 'a'.repeat(64) });
    expect(screen.queryByRole('button', { name: 'src/example.ts' })).toBeNull();
  });

  it('saves all dirty files without saving a graph, guards closing, and reopens a closed editor', async () => {
    workspaceFiles.push('src/second.ts'); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'src/example.ts' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Source editor' }), { target: { value: 'first dirty' } });
    fireEvent.click(screen.getByRole('button', { name: 'src/second.ts' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Source editor' }), { target: { value: 'second dirty' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close other editors' }));
    expect(confirm).toHaveBeenCalledWith('Discard unsaved edits in src/example.ts?');
    expect(screen.getByRole('tab', { name: 'example.ts' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close all editors' }));
    expect(confirm).toHaveBeenLastCalledWith('Discard unsaved edits in 2 files?');
    expect(screen.getByRole('tab', { name: 'second.ts' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save All' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'writeFile')).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save All' }).hasAttribute('disabled')).toBe(false));
    expect(calls.filter(call => call.method === 'writeFile').map(call => call.params)).toEqual([
      { projectId: project.id, path: 'src/example.ts', content: 'first dirty', expectedHash: 'a'.repeat(64) },
      { projectId: project.id, path: 'src/second.ts', content: 'second dirty', expectedHash: 'a'.repeat(64) },
    ]);
    expect(calls.some(call => call.method === 'saveGraph')).toBe(false);
    confirm.mockClear(); fireEvent.click(screen.getByRole('button', { name: 'Close all editors' }));
    expect(confirm).not.toHaveBeenCalled(); expect(screen.queryByRole('tab', { name: 'second.ts' })).toBeNull();
    fireEvent.keyDown(window, { key: 't', ctrlKey: true, shiftKey: true });
    await screen.findByRole('tab', { name: 'second.ts' });
  });

  it('stops Save All after a folder switch while the first old-project write is pending', async () => {
    workspaceFiles.push('src/second.ts'); vi.mocked(isDesktop).mockReturnValue(true);
    vi.mocked(pickFolder).mockResolvedValue('/tmp/plain-folder'); vi.spyOn(window, 'confirm').mockReturnValue(true);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'src/example.ts' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Source editor' }), { target: { value: 'old first' } });
    fireEvent.click(screen.getByRole('button', { name: 'src/second.ts' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Source editor' }), { target: { value: 'old second' } });
    const implementation = vi.mocked(api).getMockImplementation()!;
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementation((method, params) => {
      if (method !== 'writeFile') return implementation(method, params);
      calls.push({ method, params: params ?? {} });
      return new Promise(resolve => { finish = resolve; });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save All' }));
    expect(calls.filter(call => call.method === 'writeFile')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open Folder' }));
    await screen.findByRole('button', { name: 'notes.txt' });
    await reactAct(async () => finish({ hash: 'b'.repeat(64) }));
    expect(calls.filter(call => call.method === 'writeFile').map(call => call.params)).toEqual([
      { projectId: project.id, path: 'src/example.ts', content: 'old first', expectedHash: 'a'.repeat(64) },
    ]);
    expect(screen.queryByRole('tab', { name: 'example.ts' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'second.ts' })).toBeNull();
  });

  it('opens filtered files with Quick Open keyboard selection and runs a command from the palette', async () => {
    workspaceFiles.push('src/second.ts'); await ready();
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    const quickOpen = screen.getByRole('combobox', { name: 'Quick Open' });
    fireEvent.change(quickOpen, { target: { value: 'second' } }); fireEvent.keyDown(quickOpen, { key: 'Enter' });
    await screen.findByRole('tab', { name: 'second.ts' });
    expect(calls.find(call => call.method === 'readFile')?.params).toEqual({ projectId: project.id, path: 'src/second.ts' });
    expect(screen.queryByRole('dialog', { name: 'Quick Open' })).toBeNull();
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true });
    const commands = screen.getByRole('combobox', { name: 'Command Palette' });
    fireEvent.change(commands, { target: { value: 'Find in Files' } }); fireEvent.keyDown(commands, { key: 'Enter' });
    expect(screen.getByRole('textbox', { name: 'Search repository' })).toBe(document.activeElement);
    expect(screen.queryByRole('dialog', { name: 'Command Palette' })).toBeNull();
  });

  it('focuses repository search from its shortcut and opens a saved-file match', async () => {
    await ready(); fireEvent.keyDown(window, { key: 'f', ctrlKey: true, shiftKey: true });
    const query = screen.getByRole('textbox', { name: 'Search repository' });
    expect(query).toBe(document.activeElement);
    fireEvent.change(query, { target: { value: 'answer' } }); fireEvent.submit(query.closest('form')!);
    fireEvent.click(await screen.findByRole('button', { name: /src\/example.ts:8/ }));
    await screen.findByRole('textbox', { name: 'Source editor' });
    expect(calls.find(call => call.method === 'searchWorkspace')?.params).toEqual({ projectId: project.id, query: 'answer', caseSensitive: false, wholeWord: false });
    expect(screen.getByRole('tab', { name: 'example.ts' })).toBeTruthy();
  });

  it('routes optional native command IDs through the latest app actions', async () => {
    vi.mocked(isDesktop).mockReturnValue(true); await ready();
    const handlers = vi.mocked(listenDesktopActions).mock.calls[0][0];
    reactAct(() => handlers.command?.('quick-open'));
    expect(screen.getByRole('combobox', { name: 'Quick Open' })).toBeTruthy();
    reactAct(() => handlers.command?.('search'));
    expect(screen.getByRole('textbox', { name: 'Search repository' })).toBeTruthy();
  });

});


describe('chat integration', () => {
  it('opens the sidebar from a workflow agent and restores the inspector on close', async () => {
    const agent = createNode('agent', 1); agent.id = 'orchestrator'; agent.label = 'Orchestrator';
    if (agent.kind === 'agent') { agent.config.provider = 'codex'; agent.config.model = 'configured-model'; }
    graph.nodes.push(agent);
    await ready(); fireEvent.click(screen.getByRole('button', { name: 'Orchestrator' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chat with this agent' }));
    expect(screen.getByLabelText('Chat context')).toHaveProperty('value', agent.id);
    expect(screen.getByLabelText('Chat provider')).toHaveProperty('value', 'codex');
    expect(screen.getByLabelText('Chat model')).toHaveProperty('value', 'configured-model');
    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
    expect(screen.getByLabelText('Instructions')).toHaveProperty('value', agent.kind === 'agent' ? agent.config.instructions : '');
    expect(calls.some(call => call.method === 'createChat' || call.method === 'sendChat')).toBe(false);
  });
});


describe('terminal integration', () => {
  it('opens the terminal panel and leaves shell keyboard controls intact', async () => {
    await ready(); fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(screen.getByText('Run commands in your project folder using your local shell.')).toBeTruthy();
    expect(calls.some(call => call.method === 'createTerminal')).toBe(false);
    const terminal = document.createElement('div'); terminal.className = 'xterm'; const input = document.createElement('textarea'); terminal.append(input); document.body.append(terminal);
    try {
      fireEvent.keyDown(input, { key: 'b', ctrlKey: true });
      expect(screen.getByRole('button', { name: 'Toggle sidebar' }).getAttribute('aria-pressed')).toBe('true');
      fireEvent.keyDown(input, { key: '`', code: 'Backquote', ctrlKey: true });
      expect(screen.getByRole('button', { name: 'Toggle panel' }).getAttribute('aria-pressed')).toBe('false');
      fireEvent.keyDown(input, { key: '`', code: 'Backquote', ctrlKey: true });
      expect(screen.getByRole('button', { name: 'Toggle panel' }).getAttribute('aria-pressed')).toBe('true');
    } finally { terminal.remove(); }
  });
});

describe('file languages', () => {
  it.each(['py', 'src.py/readme', 'src/readme'])('keeps extensionless %s as plain text', path => { expect(language(path)).toBe('plaintext'); });
  it.each(['cpp', 'cc', 'cxx', 'hpp'])('recognizes .%s regardless of case', extension => { expect(language(`src/main.${extension.toUpperCase()}`)).toBe('cpp'); });
  it.each(['c', 'h'])('recognizes .%s as C', extension => { expect(language(`src/main.${extension}`)).toBe('c'); });
});
