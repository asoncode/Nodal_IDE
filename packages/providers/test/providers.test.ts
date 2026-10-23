import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ThreadEvent } from '@openai/codex-sdk';
import { claudeOptions, normalizeCodexEvent, normalizeClaudeMessage, providerLoginCommand, runProvider, validateToolPath } from '../src/index.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const { startThread, runStreamed, query } = vi.hoisted(() => ({
  startThread: vi.fn(), runStreamed: vi.fn(), query: vi.fn(),
}));
vi.mock('@openai/codex-sdk', () => ({ Codex: class {
  startThread = startThread;
  resumeThread = startThread;
} }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query }));
afterEach(() => vi.clearAllMocks());

describe('provider policy and event adapters (SDK mocks, no network)', () => {
  it('quotes bundled login commands without expanding shell metacharacters', () => {
    expect(providerLoginCommand('codex', "/Applications/Nodal's $app/codex", 'darwin')).toBe("'/Applications/Nodal'\\''s $app/codex' login");
    expect(providerLoginCommand('claude', 'C:\\Nodal App\\claude.exe', 'win32')).toBe("& 'C:\\Nodal App\\claude.exe' auth login");
  });
  it('uses restrictive Codex defaults and preserves real final usage shape', async () => {
    startThread.mockReturnValue({ runStreamed });
    runStreamed.mockResolvedValue({ events: (async function* (): AsyncGenerator<ThreadEvent> {
      yield { type: 'thread.started', thread_id: 'fixture-thread' };
      yield { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'Fixture answer' } };
      yield { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } };
    })() });
    const result = await runProvider({ provider: 'codex', prompt: 'test fixture', cwd: tmpdir() });
    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: 'read-only', networkAccessEnabled: false, approvalPolicy: 'never', webSearchMode: 'disabled' }));
    expect(result).toMatchObject({ sessionId: 'fixture-thread', output: 'Fixture answer', costUsd: null });
  });
  it('does not count an abruptly ended stream as success', async () => {
    startThread.mockReturnValue({ runStreamed });
    runStreamed.mockResolvedValue({ events: (async function* () { yield { type: 'turn.started' }; })() });
    await expect(runProvider({ provider: 'codex', prompt: 'fixture', cwd: tmpdir() })).rejects.toThrow('without a successful final result');
  });
  it('never starts a session after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runProvider({ provider: 'claude', prompt: 'fixture', cwd: tmpdir(), signal: controller.signal })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('propagates in-flight cancellation to the Codex SDK', async () => {
    const controller = new AbortController();
    startThread.mockReturnValue({ runStreamed });
    runStreamed.mockImplementation(async (_prompt, options) => ({ events: (async function* () {
      yield { type: 'thread.started', thread_id: 'cancel-fixture' };
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    })() }));
    await expect(runProvider({
      provider: 'codex', cwd: tmpdir(), prompt: 'fixture', signal: controller.signal,
      onEvent: event => { if (event.type === 'session') setTimeout(() => controller.abort(new Error('cancel fixture')), 0); },
    })).rejects.toThrow('cancel fixture');
    expect(runStreamed.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it('awaits event persistence and aborts the SDK when persistence fails', async () => {
    startThread.mockReturnValue({ runStreamed });
    runStreamed.mockResolvedValue({ events: (async function* () { yield { type: 'thread.started', thread_id: 'fixture' }; })() });
    await expect(runProvider({
      provider: 'codex', cwd: tmpdir(), prompt: 'fixture',
      onEvent: async () => { throw new Error('storage unavailable'); },
    })).rejects.toThrow('storage unavailable');
    expect(runStreamed.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it('redacts decoded event strings without corrupting JSON escape sequences', async () => {
    const original = process.env.NODAL_TEST_SECRET;
    process.env.NODAL_TEST_SECRET = 'fixture-"quoted"-secret';
    try {
      startThread.mockReturnValue({ runStreamed });
      runStreamed.mockResolvedValue({ events: (async function* () {
        yield { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: process.env.NODAL_TEST_SECRET } };
        yield { type: 'turn.completed', usage: {} };
      })() });
      const events: unknown[] = [];
      const result = await runProvider({ provider: 'codex', cwd: tmpdir(), prompt: 'fixture', onEvent: event => { events.push(event); } });
      expect(result.output).toBe('[REDACTED]');
      expect(JSON.stringify(events)).not.toContain('quoted');
    } finally {
      if (original === undefined) delete process.env.NODAL_TEST_SECRET;
      else process.env.NODAL_TEST_SECRET = original;
    }
  });
  it.each(['success', 'error_max_turns'])('closes Claude streams after %s final results', async subtype => {
    const close = vi.fn();
    const session = Object.assign((async function* () {
      yield { type: 'result', subtype, session_id: 'claude-fixture', result: 'answer', is_error: false, usage: { input_tokens: 1 }, modelUsage: {}, total_cost_usd: 0.01, errors: ['turn limit'] };
    })(), { close });
    query.mockReturnValue(session);
    const run = runProvider({ provider: 'claude', cwd: tmpdir(), prompt: 'fixture', maxBudgetUsd: 0.1, maxTurns: 2 });
    if (subtype === 'success') await expect(run).resolves.toMatchObject({ output: 'answer', costUsd: 0.01, sessionId: 'claude-fixture' });
    else await expect(run).rejects.toThrow('turn limit');
    expect(close).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]![0].options).toMatchObject({ maxBudgetUsd: 0.1, maxTurns: 2 });
  });
  it('omits provider reasoning and thinking while retaining action summaries', () => {
    expect(normalizeCodexEvent({ type: 'item.completed', item: { type: 'reasoning', id: 'private', text: 'not emitted' } })).toEqual([]);
    expect(normalizeClaudeMessage({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'not emitted' }, { type: 'text', text: 'Public output' }] } } as unknown as SDKMessage)).toEqual([{ type: 'message', data: { text: 'Public output' } }]);
  });
  it('restricts Claude to file tools and excludes project settings/MCP', () => {
    const options = claudeOptions({ provider: 'claude', cwd: tmpdir(), prompt: 'fixture' }, new AbortController());
    expect(options.permissionMode).toBe('default');
    expect(options.tools).toEqual(['Read']);
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.disallowedTools).toContain('Bash');
    expect(claudeOptions({ provider: 'claude', cwd: tmpdir(), prompt: 'fixture', permissionMode: 'workspace-write' }, new AbortController()).tools).toEqual(['Read', 'Edit', 'Write']);
  });
  it('enforces tool-free Claude planning and rejects unsupported Codex planning', async () => {
    expect(claudeOptions({ provider: 'claude', cwd: tmpdir(), prompt: 'plan', noTools: true }, new AbortController()).tools).toEqual([]);
    expect(() => claudeOptions({ provider: 'claude', cwd: tmpdir(), prompt: 'read', allowedTools: ['Grep'] }, new AbortController())).toThrow('only Read');
    await expect(runProvider({ provider: 'codex', cwd: tmpdir(), prompt: 'plan', noTools: true })).rejects.toThrow('Select Claude');
    expect(startThread).not.toHaveBeenCalled();
  });
  it('lets tool-free planning return its schema result through the SDK StructuredOutput tool', async () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const planner = claudeOptions({ provider: 'claude', cwd: tmpdir(), prompt: 'plan', noTools: true, outputSchema: schema }, new AbortController());
    const hook = planner.hooks!.PreToolUse![0].hooks[0] as any;
    const call = (tool_name: string) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input: { name: 'Plan' } });
    expect(await hook(call('StructuredOutput'))).toEqual({});
    expect(await planner.canUseTool!('StructuredOutput', { name: 'Plan' }, {} as any)).toMatchObject({ behavior: 'allow' });
    expect(await hook(call('Read'))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    const withoutSchema = claudeOptions({ provider: 'claude', cwd: tmpdir(), prompt: 'plan', noTools: true }, new AbortController());
    expect(await (withoutSchema.hooks!.PreToolUse![0].hooks[0] as any)(call('StructuredOutput'))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
  it('rejects out-of-scope and linked file tool arguments, permits new scoped files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nodal-provider-test-'));
    try {
      await writeFile(path.join(root, 'normal.txt'), 'fixture');
      await symlink(tmpdir(), path.join(root, 'link'));
      await expect(validateToolPath(root, 'normal.txt')).resolves.toBeUndefined();
      await expect(validateToolPath(root, 'new/sub/file.txt', true)).resolves.toBeUndefined();
      await expect(validateToolPath(root, '../outside')).rejects.toThrow('outside');
      await expect(validateToolPath(root, 'link/file', true)).rejects.toThrow('Linked');
      await expect(validateToolPath(root, '.env', true)).rejects.toThrow('credentials');
      await expect(validateToolPath(root, '.git/config', true)).rejects.toThrow('Git metadata');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps shell tools disabled except in an explicitly approved editing chat', async () => {
    const approve = vi.fn(async () => false); const controller = new AbortController();
    const readOnly = claudeOptions({ provider: 'claude', prompt: 'read', cwd: tmpdir(), approveCommand: approve }, controller);
    expect(readOnly.tools).toEqual(['Read']); expect(readOnly.disallowedTools).toContain('Bash');
    const editing = claudeOptions({ provider: 'claude', prompt: 'edit', cwd: tmpdir(), permissionMode: 'workspace-write', approveCommand: approve }, controller);
    expect(editing.tools).toContain('Bash'); expect(editing.disallowedTools).not.toContain('Bash');
    const hook = editing.hooks!.PreToolUse![0].hooks[0] as any;
    const request = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node --version' } };
    expect(await hook(request)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(approve).toHaveBeenCalledWith('node --version', controller.signal);
    approve.mockResolvedValue(true);
    expect(await hook(request)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    controller.abort();
    expect(await hook(request)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(approve).toHaveBeenCalledTimes(2);
  });

});
