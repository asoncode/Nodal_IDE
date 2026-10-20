import { createRequire } from 'node:module';
import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Codex, type ThreadEvent } from '@openai/codex-sdk';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { redactSecrets, runProcess, isSensitivePath } from '../../workspace/src/index.js';

export type ProviderId = 'codex' | 'claude';
export type ProviderStatus = {
  id: ProviderId; available: boolean; authentication: 'authenticated' | 'missing' | 'unknown'; message: string; version?: string;
};
export type AgentEvent = {
  type: 'session' | 'message' | 'tool_request' | 'tool_result' | 'file_diff' | 'terminal' | 'usage' | 'warning' | 'result';
  data: Record<string, unknown>;
};
export type AgentRunInput = {
  provider: ProviderId; prompt: string; cwd: string;
  permissionMode?: 'read-only' | 'workspace-write';
  model?: string; resumeId?: string; timeoutMs?: number; maxTurns?: number; maxBudgetUsd?: number;
  outputSchema?: Record<string, unknown>;
  allowedTools?: string[]; noTools?: boolean;
  signal?: AbortSignal; onEvent?: (event: AgentEvent) => void | Promise<void>;
};
export type AgentResult = { sessionId?: string; output: string; usage?: Record<string, unknown>; costUsd: number | null };

/** Uses the same installed optional native packages as the SDKs, without relying on PATH. */
export async function providerExecutable(id: ProviderId): Promise<string> {
  const sdkRequire = createRequire(import.meta.resolve(id === 'codex' ? '@openai/codex-sdk' : '@anthropic-ai/claude-agent-sdk'));
  let executable: string;
  if (id === 'claude') {
    const suffix = process.platform === 'linux' && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ? '-musl' : '';
    const pkg = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/package.json`);
    executable = path.join(path.dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
  } else {
    const codexRequire = createRequire(sdkRequire.resolve('@openai/codex/package.json'));
    const pkg = codexRequire.resolve(`@openai/codex-${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}/package.json`);
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const target = process.platform === 'darwin' ? `${arch}-apple-darwin` : process.platform === 'win32' ? `${arch}-pc-windows-msvc` : `${arch}-unknown-linux-musl`;
    const root = path.join(path.dirname(pkg), 'vendor', target);
    const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
    executable = path.join(root, 'bin', binary);
    try { await access(executable, constants.X_OK); } catch { executable = path.join(root, 'codex', binary); }
  }
  await access(executable, constants.X_OK);
  return executable;
}

export async function checkAvailability(id: ProviderId): Promise<ProviderStatus> {
  try {
    const executable = await providerExecutable(id);
    const version = await runProcess({ command: executable, args: ['--version'], cwd: tmpdir(), timeoutMs: 10_000 });
    if (version.exitCode !== 0) return { id, available: false, authentication: 'unknown', message: 'Installed provider CLI failed its version check.' };
    const auth = await runProcess({ command: executable, args: id === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], cwd: tmpdir(), timeoutMs: 15_000 });
    let authenticated = false;
    if (id === 'claude') {
      try { authenticated = (JSON.parse(auth.stdout) as { loggedIn?: boolean }).loggedIn === true; } catch { /* Unsupported status shape remains unknown. */ }
    } else authenticated = auth.exitCode === 0 && /logged in/i.test(auth.stdout + auth.stderr);
    return {
      id, available: true, version: version.stdout.trim() || version.stderr.trim(),
      authentication: authenticated ? 'authenticated' : auth.exitCode === 1 ? 'missing' : 'unknown',
      message: authenticated
        ? 'Official CLI reports a local login. Model access, subscription entitlement, and remaining budget are verified only by a requested run.'
        : `No verified CLI login. Authenticate with the official ${id === 'codex' ? 'codex login' : 'claude auth login'} flow, then refresh. No paid request was made.`,
    };
  } catch (error) {
    return { id, available: false, authentication: 'unknown', message: `Provider executable unavailable. Reinstall dependencies including optional native packages. ${redactSecrets((error as Error).message)}` };
  }
}

function safeEvent(event: AgentEvent): AgentEvent {
  const json = JSON.stringify(event);
  if (Buffer.byteLength(json) > 64 * 1024) return { type: 'warning', data: { message: 'Oversized provider event omitted (64 KiB limit).' } };
  // Redact values after decoding so secret text containing JSON escapes cannot corrupt the event.
  return JSON.parse(json, (_key, value) => typeof value === 'string' ? redactSecrets(value) : value) as AgentEvent;
}

/** Public, typed normalization deliberately omits provider reasoning/thinking blocks. */
export function normalizeCodexEvent(event: ThreadEvent): AgentEvent[] {
  if (event.type === 'thread.started') return [{ type: 'session', data: { sessionId: event.thread_id } }];
  if (event.type === 'turn.completed') return [{ type: 'usage', data: { ...event.usage, costUsd: null } }];
  if (event.type === 'error') return [{ type: 'warning', data: { message: event.message } }];
  if (event.type === 'turn.failed') return [{ type: 'warning', data: { message: event.error.message } }];
  if (!('item' in event)) return [];
  const item = event.item;
  if (item.type === 'agent_message') return [{ type: 'message', data: { id: item.id, text: item.text, final: event.type === 'item.completed' } }];
  if (item.type === 'command_execution') return [{ type: 'terminal', data: { id: item.id, command: item.command, output: item.aggregated_output, exitCode: item.exit_code, status: item.status } }];
  if (item.type === 'file_change') return [{ type: 'file_diff', data: { id: item.id, changes: item.changes, status: item.status } }];
  if (item.type === 'mcp_tool_call') return [{ type: event.type === 'item.completed' ? 'tool_result' : 'tool_request', data: { id: item.id, server: item.server, tool: item.tool, status: item.status } }];
  if (item.type === 'error') return [{ type: 'warning', data: { message: item.message } }];
  return [];
}
export function normalizeClaudeMessage(message: SDKMessage): AgentEvent[] {
  if (message.type === 'system' && message.subtype === 'init') return [{ type: 'session', data: { sessionId: message.session_id, model: message.model } }];
  if (message.type === 'assistant') return message.message.content.flatMap((block): AgentEvent[] => {
    if (block.type === 'text') return [{ type: 'message', data: { text: block.text } }];
    if (block.type === 'tool_use') return [{ type: 'tool_request', data: { id: block.id, tool: block.name, input: block.input } }];
    return [];
  });
  if (message.type === 'user' && Array.isArray(message.message.content)) return message.message.content.flatMap((block): AgentEvent[] =>
    block.type === 'tool_result' ? [{ type: 'tool_result', data: { id: block.tool_use_id, content: block.content, isError: block.is_error } }] : []);
  if (message.type === 'result') return [{ type: 'usage', data: { ...message.usage, modelUsage: message.modelUsage, costUsd: message.total_cost_usd, estimate: true } }];
  return [];
}

/** Check file tool paths even for operations the CLI would otherwise auto-allow. */
export async function validateToolPath(cwd: string, candidate: unknown, allowMissing = false): Promise<void> {
  if (candidate !== undefined && typeof candidate !== 'string') throw new Error('Invalid tool path.');
  const root = await realpath(cwd);
  const target = path.resolve(root, typeof candidate === 'string' ? candidate : '.');
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Tool path is outside the approved workspace.');
  if (!relative) return;
  if (relative.split(path.sep).some(part => part.toLowerCase() === '.git') || isSensitivePath(relative)) throw new Error('Access to Git metadata or possible credentials denied.');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error('Linked file access denied.');
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

/** The CLI configuration check reads names only; it never starts MCP servers or a model turn. */
export async function codexConfiguration(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const overrides = [
    'features.hooks=false', 'features.plugins=false', 'features.multi_agent=false', 'notify=[]',
    'sandbox_workspace_write.writable_roots=[]', 'sandbox_workspace_write.exclude_slash_tmp=true',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'shell_environment_policy.experimental_use_profile=false',
    'shell_environment_policy.ignore_default_excludes=false',
    `projects={${JSON.stringify(cwd)}={trust_level="untrusted"}}`,
  ];
  const result = await runProcess({
    command: await providerExecutable('codex'),
    args: [...overrides.flatMap(value => ['-c', value]), 'mcp', 'list', '--json'],
    cwd, signal, timeoutMs: 15_000,
  });
  if (result.exitCode !== 0 || result.truncated || result.cancelled || result.timedOut) throw new Error('Could not verify Codex MCP configuration; no provider turn was started.');
  let servers: unknown;
  try { servers = JSON.parse(result.stdout); } catch { throw new Error('Could not parse Codex MCP configuration; no provider turn was started.'); }
  if (!Array.isArray(servers) || servers.some(server => !server || typeof server.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(server.name))) {
    throw new Error('Unsupported Codex MCP configuration; no provider turn was started.');
  }
  return [...overrides, ...servers.map(server => `mcp_servers.${server.name}.enabled=false`)];
}

export function claudeOptions(input: AgentRunInput, controller: AbortController): Options {
  const writable = input.permissionMode === 'workspace-write';
  const supported = writable ? ['Read', 'Edit', 'Write'] : ['Read'];
  if (input.allowedTools?.some(tool => !supported.includes(tool))) throw new Error('Claude supports only Read, plus Edit/Write with scoped-edit permission.');
  const tools = input.noTools ? [] : input.allowedTools?.length ? [...input.allowedTools] : supported;
  return {
    cwd: input.cwd, model: input.model || undefined, resume: input.resumeId,
    abortController: controller, permissionMode: 'default', settingSources: [],
    tools, allowedTools: [], disallowedTools: ['Bash', 'Agent', 'Task', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Skill'],
    mcpServers: {}, strictMcpConfig: true, plugins: [],
    maxTurns: input.maxTurns ?? 12, maxBudgetUsd: input.maxBudgetUsd,
    outputFormat: input.outputSchema ? { type: 'json_schema', schema: input.outputSchema } : undefined,
    canUseTool: async (name, toolInput) => tools.includes(name)
      ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: 'This tool is not authorized by the node policy.' },
    hooks: { PreToolUse: [{ hooks: [async (event) => {
      if (event.hook_event_name !== 'PreToolUse') return {};
      try {
        if (!tools.includes(event.tool_name)) throw new Error('Tool not authorized.');
        const args = event.tool_input as Record<string, unknown>;
        await validateToolPath(input.cwd, args.file_path ?? args.path, event.tool_name === 'Write');
        return {};
      } catch (error) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: (error as Error).message } };
      }
    }] }] },
  };
}

export async function runProvider(input: AgentRunInput): Promise<AgentResult> {
  if (!input.prompt.trim()) throw new Error('Provider prompt cannot be empty.');
  if (input.provider !== 'codex' && input.provider !== 'claude') throw new Error('Unknown provider.');
  if (input.permissionMode && input.permissionMode !== 'read-only' && input.permissionMode !== 'workspace-write') throw new Error('Unsupported permission mode.');
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('Provider timeout exceeded.')), Math.max(1, Math.min(input.timeoutMs ?? 120_000, 30 * 60_000)));
  const result: AgentResult = { output: '', costUsd: null };
  let completed = false;
  const emit = async (event: AgentEvent) => { await input.onEvent?.(safeEvent(event)); };
  try {
    controller.signal.throwIfAborted();
    input = { ...input, cwd: await realpath(input.cwd) };
    if (input.provider === 'codex') {
      if (input.noTools) throw new Error('Codex SDK cannot enforce a tool-free planning turn. Select Claude for graph generation.');
      if (input.allowedTools?.length) throw new Error('Custom Codex tool allowlists are not supported by this adapter.');
      if (input.maxBudgetUsd !== undefined) throw new Error('Codex SDK does not expose a reliable dollar budget. Use the wall-time limit; spending remains unknown.');
      const configOverrides = await codexConfiguration(input.cwd, controller.signal);
      controller.signal.throwIfAborted();
      const codex = new Codex({ configOverrides });
      const options = {
        workingDirectory: input.cwd, sandboxMode: input.permissionMode ?? 'read-only',
        approvalPolicy: 'never' as const, networkAccessEnabled: false, webSearchMode: 'disabled' as const,
        model: input.model || undefined, additionalDirectories: [],
      };
      const thread = input.resumeId ? codex.resumeThread(input.resumeId, options) : codex.startThread(options);
      const stream = await thread.runStreamed(input.prompt, { signal: controller.signal, outputSchema: input.outputSchema });
      for await (const event of stream.events) {
        for (const normalized of normalizeCodexEvent(event)) await emit(normalized);
        if (event.type === 'thread.started') result.sessionId = event.thread_id;
        if (event.type === 'item.completed' && event.item.type === 'agent_message') result.output = event.item.text;
        if (event.type === 'turn.completed') { result.usage = { ...event.usage }; completed = true; }
        if (event.type === 'turn.failed') throw new Error(event.error.message);
        if (event.type === 'error') throw new Error(event.message);
      }
    } else {
      const session = query({ prompt: input.prompt, options: claudeOptions(input, controller) });
      try {
        for await (const message of session) {
          for (const normalized of normalizeClaudeMessage(message)) await emit(normalized);
          if ('session_id' in message) result.sessionId = message.session_id;
          if (message.type === 'result') {
            result.usage = { ...message.usage, modelUsage: message.modelUsage };
            result.costUsd = message.total_cost_usd;
            if (message.subtype !== 'success') throw new Error(message.errors.join('; ') || message.subtype);
            if (message.is_error) throw new Error(message.result);
            result.output = message.structured_output ? JSON.stringify(message.structured_output) : message.result;
            completed = true;
          }
        }
      } finally { session.close(); }
    }
    controller.signal.throwIfAborted();
    if (!completed) throw new Error('Provider stream ended without a successful final result.');
    if (Buffer.byteLength(result.output) > 512 * 1024) throw new Error('Provider result exceeded the 512 KiB limit.');
    result.output = redactSecrets(result.output);
    await emit({ type: 'result', data: { ...result } });
    return result;
  } catch (error) {
    const message = controller.signal.aborted ? String(controller.signal.reason ?? 'Provider run cancelled.') : (error as Error).message;
    controller.abort(error);
    throw new Error(redactSecrets(message));
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
  }
}

/** Interface used by backend orchestration; no renderer receives SDK or auth access. */
export const providers = Object.fromEntries((['codex', 'claude'] as const).map((id) => [id, {
  id,
  checkAvailability: () => checkAvailability(id),
  run: (input: Omit<AgentRunInput, 'provider'>) => runProvider({ ...input, provider: id }),
}])) as Record<ProviderId, { id: ProviderId; checkAvailability: () => Promise<ProviderStatus>; run: (input: Omit<AgentRunInput, 'provider'>) => Promise<AgentResult> }>;
