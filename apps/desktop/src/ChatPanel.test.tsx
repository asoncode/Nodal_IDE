// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatPanel, { streamedText } from './ChatPanel.js';
import { api } from './api.js';
import { createNode, emptyGraph } from './model.js';
import type { ChatSession, ChatSnapshot, ChatEvent, CreateChatInput, ChatAttachmentInput } from '../../../packages/shared/src/chat.js';
vi.mock('./api.js', () => ({ api: vi.fn() }));
const project = { id: 'p', name: 'test-project', root: '/tmp/test-project' };
const graph = emptyGraph(); const agent = createNode('agent', 1); agent.id = 'orchestrator'; agent.label = 'Orchestrator'; if (agent.kind === 'agent') { agent.config.provider = 'codex'; agent.config.model = 'node-model'; } graph.nodes.push(agent);
let session: ChatSession, snapshot: ChatSnapshot;
beforeEach(() => {
  session = { id: 'chat', projectId: 'p', provider: 'claude', permission: 'read-only', title: 'Saved conversation', createdAt: 'now', updatedAt: 'now' };
  snapshot = { session, turns: [], events: [] };
  vi.mocked(api).mockImplementation(async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'chats') return [session] as T;
    if (method === 'chatFiles') return [{ path: 'src/index.ts', size: 12 }, { path: 'src/utils.ts', size: 20 }, { path: 'README.md', size: 10 }] as T;
    if (method === 'createChat') { const input = params as unknown as CreateChatInput; session = { ...session, provider: input.provider, permission: input.permission, model: input.model }; snapshot.session = session; return structuredClone(session) as T; }
    if (method === 'inspectChat') return structuredClone(snapshot) as T;
    if (method === 'sendChat') { const turn = { id: 'turn', chatId: session.id, message: params.message as string, output: '', status: 'running' as const, createdAt: 'now', attachments: (params.attachments as ChatAttachmentInput[] | undefined)?.map(file => file.kind === 'upload' ? file : { ...file, name: file.path.split('/').at(-1)!, content: 'Saved source snapshot' }) }; snapshot.turns.push(turn); return turn as T; }
    if (method === 'cancelChat') { snapshot.turns[0].status = 'cancelled'; return { accepted: true } as T; }
    if (method === 'approveChatCommand') { snapshot.turns[0].approval = undefined; snapshot.turns[0].status = 'succeeded'; snapshot.turns[0].output = 'Command approved'; return { accepted: true } as T; }
    throw new Error(`Unexpected ${method}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const open = (extra = {}) => render(<ChatPanel project={project} graph={graph} onClose={() => {}} {...extra}/>);
describe('agent chat sidebar', () => {
  it('creates a repository chat only on send and requires explicit scope consent', async () => {
    open(); await screen.findByRole('option', { name: 'Saved conversation' }); expect(api).not.toHaveBeenCalledWith('createChat', expect.anything());
    fireEvent.change(screen.getByLabelText('Message agent'), { target: { value: 'Explain the architecture' } }); fireEvent.click(screen.getByRole('button', { name: 'Send & approve' }));
    await screen.findByText('Explain the architecture');
    expect(api).toHaveBeenCalledWith('createChat', expect.objectContaining({ projectId: 'p', provider: 'claude', permission: 'read-only', context: undefined }));
    expect(api).toHaveBeenCalledWith('sendChat', expect.objectContaining({ message: 'Explain the architecture', confirmed: true }));
    expect(screen.getByLabelText('Message agent')).toHaveValue('');
    snapshot.turns[0].status = 'succeeded'; snapshot.turns[0].output = 'A local runtime and renderer.';
    await screen.findByText('A local runtime and renderer.');
  });
  it('opens a node context with its configured provider and model', async () => {
    open({ contextRequest: { nodeId: agent.id, version: 1 } });
    expect(screen.getByLabelText('Chat context')).toHaveValue(agent.id); expect(screen.getByLabelText('Chat provider')).toHaveValue('codex'); expect(screen.getByLabelText('Chat model')).toHaveValue('node-model');
    expect(screen.getByText(/Does not control the workflow/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Message agent'), { target: { value: 'What is your role?' } }); fireEvent.click(screen.getByRole('button', { name: 'Send & approve' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('createChat', expect.objectContaining({ context: { graph, nodeId: agent.id, runId: undefined }, provider: 'codex' })));
  });
  it('loads saved history, shows a pending shell approval, and sends its exact identifier', async () => {
    snapshot.turns = [{ id: 't', chatId: 'chat', message: 'Test the change', output: '', status: 'running', createdAt: 'now', approval: { id: 'approval', command: 'node --test', status: 'pending' } }];
    open(); await screen.findByRole('option', { name: 'Saved conversation' }); fireEvent.change(screen.getByLabelText('Chat history'), { target: { value: 'chat' } });
    await screen.findByText('node --test'); fireEvent.click(screen.getByRole('button', { name: 'Approve command' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('approveChatCommand', { projectId: 'p', chatId: 'chat', turnId: 't', approvalId: 'approval', approved: true }));
    await screen.findByText('Command approved');
  });
  it('stops active work and retains the transcript', async () => {
    snapshot.turns = [{ id: 't', chatId: 'chat', message: 'Work', output: '', status: 'running', createdAt: 'now' }];
    open(); await screen.findByRole('option', { name: 'Saved conversation' }); fireEvent.change(screen.getByLabelText('Chat history'), { target: { value: 'chat' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('cancelChat', { projectId: 'p', chatId: 'chat', turnId: 't' }));
    await screen.findByText('Stopped. Partial work is preserved.'); expect(screen.getByText('Work')).toBeInTheDocument();
  });
  it('preserves a failed message and does not send while composing an IME sequence', async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params) => method === 'sendChat' ? Promise.reject(new Error('No provider login')) : implementation(method, params));
    open(); fireEvent.change(screen.getByLabelText('Message agent'), { target: { value: 'Keep this draft' } }); fireEvent.keyDown(screen.getByLabelText('Message agent'), { key: 'Enter', isComposing: true });
    expect(api).not.toHaveBeenCalledWith('sendChat', expect.anything()); fireEvent.click(screen.getByRole('button', { name: 'Send & approve' }));
    await screen.findByRole('alert'); expect(screen.getByLabelText('Message agent')).toHaveValue('Keep this draft');
  });
  it('does not poll a hidden sidebar and ignores a stale session response after New chat', async () => {
    const view = open({ visible: false }); expect(api).not.toHaveBeenCalled();
    view.rerender(<ChatPanel project={project} graph={graph} onClose={() => {}} visible/>);
    await screen.findByRole('option', { name: 'Saved conversation' });
    let resolve: (snapshot: ChatSnapshot) => void = () => {};
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params) => method === 'inspectChat' ? new Promise(done => { resolve = done as typeof resolve; }) : implementation(method, params));
    fireEvent.change(screen.getByLabelText('Chat history'), { target: { value: 'chat' } });
    await waitFor(() => expect(api).toHaveBeenCalledWith('inspectChat', expect.anything())); fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    resolve({ ...snapshot, turns: [{ id: 'old', chatId: 'chat', message: 'Stale message', status: 'succeeded', output: 'Stale answer', createdAt: 'now' }] });
    await waitFor(() => expect(screen.getByLabelText('Chat history')).toHaveValue('')); expect(screen.queryByText('Stale answer')).not.toBeInTheDocument();
  });
  it('replaces cumulative Codex message snapshots without duplicating final text', () => {
    const event = (id: string, sequence: number, text: string): ChatEvent => ({ id, sequence, chatId: 'c', turnId: 't', type: 'message', data: { id: 'message', text }, timestamp: 'now' });
    expect(streamedText([event('1', 1, 'Hello'), event('2', 2, 'Hello world')], 't')).toBe('Hello world');
  });
  it('selects an @ reference with the keyboard without sending and supports removal', async () => {
    open(); const composer = screen.getByLabelText('Message agent');
    fireEvent.change(composer, { target: { value: 'Explain @src', selectionStart: 12 } });
    await screen.findByRole('option', { name: 'src/index.ts' });
    fireEvent.keyDown(composer, { key: 'ArrowDown' }); fireEvent.keyDown(composer, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Remove src/utils.ts' })).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith('sendChat', expect.anything());
    expect(composer).toHaveValue('Explain ');
    fireEvent.click(screen.getByRole('button', { name: 'Remove src/utils.ts' }));
    expect(screen.queryByLabelText('Attached files')).not.toBeInTheDocument();
  });
  it('sends selected reference paths and displays the captured attachment in history', async () => {
    open(); fireEvent.click(screen.getByRole('button', { name: 'Reference project file' }));
    fireEvent.click(await screen.findByRole('option', { name: 'README.md' }));
    fireEvent.change(screen.getByLabelText('Message agent'), { target: { value: 'Explain this file' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send & approve' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('sendChat', expect.objectContaining({ attachments: [{ kind: 'reference', path: 'README.md' }] })));
    await screen.findByText('Saved source snapshot'); expect(screen.queryByLabelText('Attached files')).not.toBeInTheDocument();
  });
  it('uploads multiple files, removes one, and sends actual text with a file-only message', async () => {
    open();
    fireEvent.change(screen.getByLabelText('Upload chat files'), { target: { files: [new File(['# Requirement'], 'notes.md', { type: 'text/markdown' }), new File(['const value = 1;'], 'example.ts')] } });
    await screen.findByRole('button', { name: 'Remove notes.md' }); fireEvent.click(screen.getByRole('button', { name: 'Remove example.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send & approve' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('sendChat', expect.objectContaining({ message: 'Please review the attached files.', attachments: [{ kind: 'upload', name: 'notes.md', content: '# Requirement' }] })));
  });
  it('keeps attachments and message when sending fails', async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params) => method === 'sendChat' ? Promise.reject(new Error('Cannot send this message')) : implementation(method, params));
    open(); fireEvent.change(screen.getByLabelText('Upload chat files'), { target: { files: [new File(['keep me'], 'notes.txt')] } });
    await screen.findByRole('button', { name: 'Remove notes.txt' });
    fireEvent.change(screen.getByLabelText('Message agent'), { target: { value: 'Review these notes' } }); fireEvent.click(screen.getByRole('button', { name: 'Send & approve' }));
    await screen.findByText('Cannot send this message'); expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument(); expect(screen.getByLabelText('Message agent')).toHaveValue('Review these notes');
  });
  it('rejects oversized and binary uploads without losing an existing attachment', async () => {
    open(); const input = screen.getByLabelText('Upload chat files');
    fireEvent.change(input, { target: { files: [new File(['keep'], 'keep.txt')] } }); await screen.findByRole('button', { name: 'Remove keep.txt' });
    fireEvent.change(input, { target: { files: [new File(['x'.repeat(65537)], 'large.txt')] } }); await screen.findByText('large.txt: attachments must be at most 64 KiB each.');
    fireEvent.change(input, { target: { files: [new File(['%PDF'], 'picture.pdf')] } }); await screen.findByText(/Images, PDFs and binary documents are not supported/);
    expect(screen.getByRole('button', { name: 'Remove keep.txt' })).toBeInTheDocument(); expect(api).not.toHaveBeenCalledWith('sendChat', expect.anything());
  });
  it('does not treat email addresses as references and dismisses suggestions with Escape', async () => {
    open(); const composer = screen.getByLabelText('Message agent');
    fireEvent.change(composer, { target: { value: 'me@example.com' } }); expect(api).not.toHaveBeenCalledWith('chatFiles', expect.anything());
    fireEvent.change(composer, { target: { value: '@README', selectionStart: 7 } }); await screen.findByRole('option', { name: 'README.md' });
    fireEvent.keyDown(composer, { key: 'Escape' }); expect(screen.queryByRole('listbox')).not.toBeInTheDocument(); expect(api).not.toHaveBeenCalledWith('sendChat', expect.anything());
  });

});
