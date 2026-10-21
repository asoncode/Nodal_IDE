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
      createFile: { path: params.path, content: '', hash: 'c'.repeat(64) },
      readFile: { content: 'export const answer = 1;', hash: 'a'.repeat(64) }, writeFile: { content: params.content, hash: 'b'.repeat(64) },
      saveGraph: params.graph, generateGraph: { graph: generation, summary: 'A validated plan.' },
      run: { id: 'run-1', projectId: project.id, graph, status: 'running', createdAt: new Date().toISOString() },
      inspectRun: { run: { id: 'run-1', projectId: project.id, graph, status: 'running', createdAt: new Date().toISOString() }, attempts: [], checkpoints: [], approvals: [{ id: 'approval-1', nodeId: 'command-1', decision: 'pending', message: 'Run node --version with your user privileges?', scope: { command: 'node', args: ['--version'] } }] },
      events: [{ eventId: 'event-1', sequence: 1, runId: 'run-1', nodeId: 'command-1', timestamp: new Date().toISOString(), kind: 'command.output', payload: { text: 'v24.0.0' } }],
      approve: { accepted: true }, chats: [], closeTerminals: { closed: true },
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

  it.each([['src/main.cpp', 'cpp'], ['script.py', 'python'], ['README.MD', 'markdown']])('creates %s and opens an empty saved editor with %s syntax', async (path, syntax) => {
    await ready();
    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'missing' } });
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
    expect(screen.getByLabelText('Search files')).toHaveProperty('value', '');
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
    fireEvent.change(input, { target: { value: 'src/example.ts' } });
    fireEvent.submit(input.closest('form')!);
    await screen.findByRole('alert');
    expect(input).toHaveProperty('value', 'src/example.ts');
    expect(screen.queryByRole('textbox', { name: 'Source editor' })).toBeNull();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'New file path' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New File' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel new file' }));
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
    await screen.findByText('This file is already open. Close it before creating it again.');
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
