import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../persistence/src/index.js';
import { NodalService } from '../src/service.js';
import { git } from '../../workspace/src/index.js';
import { GraphSchema, createNode } from '../../shared/src/index.js';
import type { ChatSession, ChatSnapshot, ChatTurn, ChatDiff } from '../../shared/src/chat.js';
import { runProvider } from '../../providers/src/index.js';
vi.mock('../../providers/src/index.js', () => ({ runProvider: vi.fn(), checkAvailability: vi.fn() }));
let directory: string, repo: string, data: string, store: Store, service: NodalService, projectId: string;
const dispatch = <T>(method: string, params: Record<string, unknown>) => service.dispatch(method, params) as Promise<T>;
const create = (extra = {}) => dispatch<ChatSession>('createChat', { projectId, provider: 'claude', permission: 'read-only', ...extra });
const inspect = (chatId: string) => dispatch<ChatSnapshot>('inspectChat', { projectId, chatId });
async function waitFor(check: () => Promise<boolean>) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Chat did not settle'); }
async function send(chatId: string, message = 'Explain this project') { return dispatch<ChatTurn>('sendChat', { projectId, chatId, message, confirmed: true }); }
async function settle(chatId: string) { await waitFor(async () => (await inspect(chatId)).turns.at(-1)?.status !== 'running'); return inspect(chatId); }
beforeEach(async () => {
  vi.resetAllMocks(); directory = await mkdtemp(join(tmpdir(), 'nodal-chat-')); repo = join(directory, 'repo'); data = join(directory, 'data'); await mkdir(repo);
  await writeFile(join(repo, 'index.js'), 'export const answer = 1;\n');
  for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'Initial']]) expect((await git(repo, args)).exitCode).toBe(0);
  store = new Store(join(data, 'nodal.sqlite')); service = new NodalService(store, data);
  projectId = (await dispatch<{ id: string }>('openProject', { path: repo })).id;
  vi.mocked(runProvider).mockImplementation(async input => {
    await input.onEvent?.({ type: 'session', data: { sessionId: 'chat-provider-session' } });
    await input.onEvent?.({ type: 'message', data: { text: 'The answer is 1.' } });
    return { sessionId: 'chat-provider-session', output: 'The answer is 1.', costUsd: null };
  });
});
afterEach(async () => { await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
describe('durable chat with mocked provider and real files', () => {
  it('requires per-turn consent, validates ownership, and never creates a workflow run', async () => {
    const chat = await create();
    await expect(dispatch('sendChat', { projectId, chatId: chat.id, message: 'hi' })).rejects.toThrow();
    const other = store.addProject('/tmp/other', 'Other');
    await expect(dispatch('inspectChat', { projectId: other.id, chatId: chat.id })).rejects.toThrow('does not belong');
    expect(runProvider).not.toHaveBeenCalled();
    await send(chat.id); const snapshot = await settle(chat.id);
    expect(snapshot.turns[0]).toMatchObject({ status: 'succeeded', output: 'The answer is 1.' });
    expect(runProvider).toHaveBeenCalledWith(expect.objectContaining({ cwd: await realpath(repo), permissionMode: 'read-only', allowNonGit: true }));
    expect(snapshot.session).not.toHaveProperty('providerSessionId'); expect(store.runs(projectId)).toHaveLength(0);
  });
  it('resumes a conversation and retains its title, history and redacted events after restart', async () => {
    const chat = await create({ provider: 'codex', model: 'configured-model' });
    await send(chat.id, 'First question'); await settle(chat.id);
    await send(chat.id, 'A follow-up'); await settle(chat.id);
    expect(vi.mocked(runProvider).mock.calls[1][0]).toMatchObject({ resumeId: 'chat-provider-session', model: 'configured-model' });
    await service.close(); store.close(); store = new Store(join(data, 'nodal.sqlite')); service = new NodalService(store, data);
    const snapshot = await inspect(chat.id); expect(snapshot.session.title).toBe('First question'); expect(snapshot.turns).toHaveLength(2);
    expect((await dispatch<ChatSession[]>('chats', { projectId }))[0].id).toBe(chat.id);
    expect(snapshot.events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
  });
  it('rejects racing sends and cancels a blocked command without launching it', async () => {
    vi.mocked(runProvider).mockImplementation(async input => {
      const approved = await input.approveCommand!('node --version', input.signal!);
      input.signal!.throwIfAborted();
      return { output: approved ? 'ran' : 'denied', costUsd: null };
    });
    const chat = await create({ permission: 'scoped-edit' }); const turn = await send(chat.id);
    await expect(send(chat.id)).rejects.toThrow('current chat operation');
    await waitFor(async () => !!(await inspect(chat.id)).turns[0].approval);
    const pending = (await inspect(chat.id)).turns[0].approval!;
    await dispatch('cancelChat', { projectId, chatId: chat.id, turnId: turn.id });
    expect((await settle(chat.id)).turns[0].status).toBe('cancelled');
    await expect(dispatch('approveChatCommand', { projectId, chatId: chat.id, turnId: turn.id, approvalId: pending.id, approved: true })).rejects.toThrow('no longer pending');
  });
  it('resolves only the exact command approval and preserves independent node context', async () => {
    const node = createNode('agent', 'orchestrator'); if (node.kind !== 'agent') throw new Error('fixture'); node.label = 'Orchestrator'; node.config.provider = 'claude'; node.config.instructions = 'Plan the implementation'; node.config.model = 'node-model';
    const graph = GraphSchema.parse({ id: 'workflow', name: 'Feature', nodes: [node], edges: [] });
    const chat = await create({ provider: 'codex', permission: 'scoped-edit', context: { graph, nodeId: node.id } });
    expect(chat.provider).toBe('claude'); expect(chat.model).toBe('node-model');
    vi.mocked(runProvider).mockImplementation(async input => {
      expect(input.prompt).toContain('Plan the implementation'); expect(input.resumeId).toBeUndefined();
      const allowed = await input.approveCommand!('node --version', input.signal!); return { output: allowed ? 'approved' : 'denied', costUsd: null };
    });
    const turn = await send(chat.id); await waitFor(async () => !!(await inspect(chat.id)).turns[0].approval);
    const pending = (await inspect(chat.id)).turns[0].approval!;
    await expect(dispatch('approveChatCommand', { projectId, chatId: chat.id, turnId: turn.id, approvalId: 'wrong', approved: true })).rejects.toThrow();
    await dispatch('approveChatCommand', { projectId, chatId: chat.id, turnId: turn.id, approvalId: pending.id, approved: false });
    expect((await settle(chat.id)).turns[0].output).toBe('denied');
    expect(store.runs(projectId)).toHaveLength(0);
  });
  it('keeps edits isolated, rejects stale review heads, and applies only reviewed changes', async () => {
    vi.mocked(runProvider).mockImplementation(async input => { await writeFile(join(input.cwd, 'index.js'), 'export const answer = 42;\n'); return { output: 'Updated answer.', costUsd: null }; });
    const chat = await create({ permission: 'scoped-edit' }); await send(chat.id); const snapshot = await settle(chat.id);
    expect(snapshot.turns[0].status).toBe('succeeded'); expect(snapshot.session.worktreePath).not.toBe(repo);
    expect(await readFile(join(repo, 'index.js'), 'utf8')).toContain('= 1;');
    const preview = await dispatch<ChatDiff>('chatDiff', { projectId, chatId: chat.id }); expect(preview.diff).toContain('+export const answer = 42;');
    await expect(dispatch('applyChatChanges', { projectId, chatId: chat.id, expectedHead: 'stale', expectedSourceHead: preview.sourceHead, approved: true })).rejects.toThrow('Branch changed');
    await expect(dispatch('applyChatChanges', { projectId, chatId: chat.id, expectedHead: preview.head, expectedSourceHead: preview.sourceHead })).rejects.toThrow();
    expect(await dispatch('applyChatChanges', { projectId, chatId: chat.id, expectedHead: preview.head, expectedSourceHead: preview.sourceHead, approved: true })).toMatchObject({ merged: true });
    expect(await readFile(join(repo, 'index.js'), 'utf8')).toContain('= 42;');
  });
  it('handles provider failure without replaying a partial provider session', async () => {
    const chat = await create(); vi.mocked(runProvider).mockImplementationOnce(async input => { await input.onEvent?.({ type: 'session', data: { sessionId: 'partial' } }); throw new Error('fixture provider failure'); });
    await send(chat.id); expect((await settle(chat.id)).turns[0]).toMatchObject({ status: 'failed', error: 'fixture provider failure' });
    await send(chat.id, 'Try another question'); await settle(chat.id);
    expect(vi.mocked(runProvider).mock.calls[1][0].resumeId).toBeUndefined();
  });
  it('marks unfinished turns interrupted on recovery without replaying provider calls', async () => {
    const chat = await create();
    store.saveChatTurn({ id: 'interrupted', chatId: chat.id, message: 'pending', output: '', status: 'running', createdAt: 'now', approval: { id: 'old', command: 'echo pending', status: 'pending' } });
    await service.close(); store.close(); store = new Store(join(data, 'nodal.sqlite')); service = new NodalService(store, data);
    expect((await inspect(chat.id)).turns[0].status).toBe('interrupted'); expect((await inspect(chat.id)).turns[0].approval).toBeUndefined(); expect(runProvider).not.toHaveBeenCalled();
  });
  it('rejects a context from another project and uses the recorded node snapshot', async () => {
    const node = createNode('agent', 'agent'); const graph = GraphSchema.parse({ id: 'g', name: 'Recorded', nodes: [node], edges: [] });
    const other = store.addProject('/tmp/elsewhere', 'Other'); store.createRun({ id: 'other-run', projectId: other.id, graph, status: 'succeeded', createdAt: 'now' });
    await expect(create({ context: { graph, nodeId: node.id, runId: 'other-run' } })).rejects.toThrow('does not belong');
    const recorded = structuredClone(graph); const agent = recorded.nodes[0]; if (agent.kind === 'agent') { agent.config.instructions = 'Recorded instructions'; agent.config.provider = 'codex'; }
    store.createRun({ id: 'own-run', projectId, graph: recorded, status: 'succeeded', createdAt: 'now' });
    const chat = await create({ context: { graph, nodeId: node.id, runId: 'own-run' } }); expect(chat.context?.instructions).toBe('Recorded instructions'); expect(chat.provider).toBe('codex');
  });
  it('sends file snapshots and uploads to the provider and retains their redacted history', async () => {
    const chat = await create();
    const attachments = [
      { kind: 'reference', path: 'index.js' },
      { kind: 'upload', name: 'requirements.md', content: 'Add a useful feature. sk-proj-fixturesecret123456789' },
    ];
    const turn = await dispatch<ChatTurn>('sendChat', { projectId, chatId: chat.id, message: 'Use these files', attachments, confirmed: true });
    await writeFile(join(repo, 'index.js'), 'Changed after sending');
    const saved = (await settle(chat.id)).turns[0];
    expect(turn.attachments?.[0]).toMatchObject({ path: 'index.js', content: 'export const answer = 1;\n' });
    expect(saved.attachments?.[1].content).toBe('Add a useful feature. [REDACTED]');
    const prompt = vi.mocked(runProvider).mock.calls[0][0].prompt;
    expect(prompt).toContain('export const answer = 1;'); expect(prompt).toContain('requirements.md');
    expect(prompt).not.toContain('Changed after sending'); expect(prompt).not.toContain('fixturesecret');
    await expect(readFile(join(repo, 'requirements.md'))).rejects.toThrow();
    await service.close(); store.close(); store = new Store(join(data, 'nodal.sqlite')); service = new NodalService(store, data);
    expect((await inspect(chat.id)).turns[0].attachments).toEqual(saved.attachments);
  });
  it('offers bounded, non-sensitive text files for references', async () => {
    await writeFile(join(repo, '.env'), 'PRIVATE=value'); await writeFile(join(repo, 'picture.png'), 'binary');
    await writeFile(join(repo, 'large.txt'), 'a'.repeat(65537));
    const files = await dispatch<{ path: string }[]>('chatFiles', { projectId });
    expect(files.map(file => file.path)).toEqual(['index.js']);
  });
  it('rejects unsafe references and binary uploads before recording or launching a turn', async () => {
    const chat = await create(); await writeFile(join(repo, '.env'), 'secret'); await symlink(join(repo, 'index.js'), join(repo, 'link.txt'));
    for (const attachment of [
      { kind: 'reference', path: '../outside.txt' }, { kind: 'reference', path: '/tmp/outside.txt' },
      { kind: 'reference', path: '.env' }, { kind: 'reference', path: 'link.txt' },
      { kind: 'upload', name: '../file.txt', content: 'text' },
      { kind: 'upload', name: 'file.txt', content: 'binary\0content' },
      { kind: 'upload', name: 'picture.pdf', content: '%PDF' },
    ]) await expect(dispatch('sendChat', { projectId, chatId: chat.id, message: 'Read it', attachments: [attachment], confirmed: true })).rejects.toThrow();
    expect(runProvider).not.toHaveBeenCalled(); expect((await inspect(chat.id)).turns).toHaveLength(0);
    await send(chat.id); expect((await settle(chat.id)).turns).toHaveLength(1);
  });
  it('enforces attachment counts, UTF-8 byte sizes, and aggregate limits', async () => {
    const chat = await create();
    for (const attachments of [
      Array.from({ length: 9 }, () => ({ kind: 'upload', name: 'tiny.txt', content: 'a' })),
      [{ kind: 'upload', name: 'unicode.txt', content: '界'.repeat(22000) }],
      Array.from({ length: 5 }, () => ({ kind: 'upload', name: 'large.txt', content: 'a'.repeat(65536) })),
    ]) await expect(dispatch('sendChat', { projectId, chatId: chat.id, message: 'Read these', attachments, confirmed: true })).rejects.toThrow();
    expect(runProvider).not.toHaveBeenCalled(); expect((await inspect(chat.id)).turns).toHaveLength(0);
  });

});
