import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { mkdir, realpath, stat, writeFile as writeDisk } from 'node:fs/promises';
import { z } from 'zod';
import { GraphSchema, type Graph, type ExecutionEvent, type ApprovalRequest } from '../../shared/src/index.js';
import { WorkflowEngine, type ExecutionContext, type NodeResult } from '../../core/src/engine.js';
import { validateGraph } from '../../core/src/validation.js';
import { templates } from '../../core/src/templates.js';
import { Store, digest, redact, type StoredRun } from '../../persistence/src/index.js';
import * as workspace from '../../workspace/src/index.js';
import { checkAvailability, runProvider } from '../../providers/src/index.js';

const id = z.string().min(1).max(200);
const projectParams = z.object({ projectId: id }).strict();
const runParams = z.object({ runId: id }).strict();
const requestSchemas = {
  bootstrap: z.object({}).strict(), providerStatus: z.object({}).strict(),
  openProject: z.object({ path: z.string().min(1).max(4096) }).strict(),
  files: projectParams,
  readFile: projectParams.extend({ path: z.string().min(1).max(4096) }),
  writeFile: projectParams.extend({ path: z.string().min(1).max(4096), content: z.string().max(2 * 1024 * 1024), expectedHash: z.string().length(64) }),
  listGraphs: projectParams,
  saveGraph: projectParams.extend({ graph: GraphSchema }),
  run: projectParams.extend({ graph: GraphSchema }),
  runs: projectParams, inspectRun: runParams, pause: runParams, resume: runParams, cancel: runParams,
  rerun: runParams.extend({ confirmed: z.literal(true) }),
  events: runParams.extend({ after: z.number().int().min(0).default(0) }),
  approve: runParams.extend({ nodeId: id, approved: z.boolean() }),
  diff: projectParams.extend({ runId: id.optional() }),
  generateGraph: projectParams.extend({ graph: GraphSchema, prompt: z.string().min(1).max(20000), provider: z.enum(['codex','claude']) }),
  applyChanges: runParams.extend({ nodeId: id, expectedHead: id, expectedSourceHead: id, approved: z.literal(true) }),
};
type PendingApproval = { request: ApprovalRequest; resolve: (approved: boolean) => void };
type WorkspaceResult = { worktree: workspace.AttemptWorktree; head: string };

export class NodalService {
  private engines = new Map<string, WorkflowEngine>();
  private tasks = new Map<string, Promise<unknown>>();
  private executions = new Map<string, Set<Promise<NodeResult>>>();
  private pending = new Map<string, PendingApproval>();
  private generation = new Set<AbortController>();
  constructor(readonly store: Store, readonly dataDir: string) { store.recover(); }
  private record(runId: string, kind: string, payload: unknown, nodeId?: string, attemptId?: string) {
    return this.store.appendEvent({ eventId: randomUUID(), runId, kind, payload, nodeId, attemptId, sequence: 1, timestamp: new Date().toISOString() });
  }
  async providerStatus() {
    return Promise.all((['codex', 'claude'] as const).map(async provider => {
      try { const status = await checkAvailability(provider); return { ...status, authenticated: status.authentication === 'authenticated', status: status.authentication }; }
      catch (e) { return { id: provider, available: false, authenticated: false, status: 'unavailable', message: String(e) }; }
    }));
  }
  async dispatch(method: string, raw: unknown): Promise<unknown> {
    if (!(method in requestSchemas)) throw new Error('Unknown method');
    const params = requestSchemas[method as keyof typeof requestSchemas].parse(raw ?? {}) as Record<string, unknown>;
    const projectId = params.projectId as string;
    const runId = params.runId as string;
    switch (method) {
      case 'bootstrap': return { projects: this.store.projects(), templates, providers: await this.providerStatus() };
      case 'providerStatus': return this.providerStatus();
      case 'openProject': {
        const root = await realpath(params.path as string);
        if (!(await stat(root)).isDirectory()) throw new Error('Choose a folder, not a file.');
        const repo = await workspace.inspectRepository(root).catch(() => undefined);
        return this.store.addProject(root, basename(root), repo?.branch, !!repo);
      }
      case 'files': return (await workspace.listFiles(this.store.project(projectId).root)).map(f => f.path);
      case 'readFile': return workspace.readFile(this.store.project(projectId).root, params.path as string);
      case 'writeFile': {
        const result = await workspace.writeFile(this.store.project(projectId).root, params.path as string, params.content as string, params.expectedHash as string);
        return { ...result, content: params.content, path: params.path };
      }
      case 'listGraphs': return this.store.graphs(projectId);
      case 'saveGraph': return this.store.saveGraph(projectId, params.graph as Graph);
      case 'run': return this.startRun(projectId, params.graph as Graph);
      case 'runs': return this.store.runs(projectId);
      case 'inspectRun': return { run: this.store.run(runId), attempts: this.store.attempts(runId), approvals: this.store.approvals(runId), checkpoints: this.store.checkpoints(runId) };
      case 'events': this.store.run(runId); return this.store.events(runId, params.after as number);
      case 'pause': await this.engine(runId).pause(); return this.store.run(runId);
      case 'resume': await this.engine(runId).resume(); return this.store.run(runId);
      case 'cancel': await this.engine(runId).cancel(); return this.store.run(runId);
      case 'approve': {
        const key = `${runId}:${params.nodeId}`; const pending = this.pending.get(key);
        if (pending) { pending.resolve(params.approved as boolean); return { accepted: true }; }
        return { accepted: this.engine(runId).approve(params.nodeId as string, params.approved as boolean) };
      }
      case 'rerun': {
        const old = this.store.run(runId);
        return this.startRun(old.projectId, old.graph, old.id);
      }
      case 'diff': return this.diffs(projectId, runId);
      case 'applyChanges': {
        const run = this.store.run(runId);
        if (!['succeeded','failed','cancelled','interrupted'].includes(run.status)) throw new Error('Stop or finish the run before integrating changes.');
        const attempt = this.store.attempts(runId).filter(a => a.nodeId === params.nodeId).at(-1);
        const result = attempt?.output as WorkspaceResult | undefined;
        if (!result?.worktree) throw new Error('No committed worktree for this node.');
        const merged = await workspace.mergeAttempt({ repoRoot: this.store.project(run.projectId).root, branch: result.worktree.branch, expectedHead: params.expectedHead as string, expectedSourceHead: params.expectedSourceHead as string, approved: true });
        this.record(runId, 'workspace.integration', { ...merged, nodeId: params.nodeId });
        return merged;
      }
      case 'generateGraph': return this.generateGraph(projectId, params.graph as Graph, params.prompt as string, params.provider as 'codex' | 'claude');
      default: throw new Error('Unsupported method');
    }
  }
  private engine(id: string) { const e = this.engines.get(id); if (!e) throw new Error('This run is historical or interrupted. Review it and explicitly start a new run.'); return e; }
  async startRun(projectId: string, input: Graph, parentRunId?: string): Promise<StoredRun> {
    const validation = validateGraph(input);
    if (!validation.valid) throw new Error(validation.errors.map(e => e.message).join('\n'));
    const graph = structuredClone(validation.graph!);
    if (JSON.stringify(redact(graph)) !== JSON.stringify(graph)) throw new Error('Graph appears to contain credentials. Use official provider authentication; do not put secrets in commands or prompts.');
    const repo = await workspace.inspectRepository(this.store.project(projectId).root).catch(() => { throw new Error('Workflows require the root of a Git repository with an initial commit. You can still browse and edit this folder.'); });
    const runId = randomUUID();
    const run: StoredRun = { id: runId, projectId, graph, status: 'queued', createdAt: new Date().toISOString(), repositorySha: repo.head, parentRunId, nodeStates: {} };
    this.store.createRun(run);
    const engine = new WorkflowEngine(graph, {
      runId,
      execute: context => {
        const execution = this.execute(context, run);
        const pending = this.executions.get(runId) ?? new Set<Promise<NodeResult>>();
        pending.add(execution); this.executions.set(runId, pending);
        void execution.finally(() => pending.delete(execution)).catch(() => {});
        return execution;
      },
      onEvent: async event => { this.store.appendEvent(event); if (event.kind === 'node.completed') this.checkpoint(event, graph, repo.head); },
    });
    this.engines.set(runId, engine);
    const task = engine.start().then(async snapshot => {
      // Engine deadlines bound scheduling, but privileged children must finish cleanup before the run closes.
      await Promise.allSettled(this.executions.get(runId) ?? []);
      this.store.updateRun(runId, snapshot);
    }).catch(error => {
      this.store.updateRun(runId, { status: 'failed', error: redact(String(error)), finishedAt: new Date().toISOString() });
      this.record(runId, 'run.error', { error: String(error) });
    }).finally(() => { this.engines.delete(runId); this.tasks.delete(runId); this.executions.delete(runId); });
    this.tasks.set(runId, task);
    return this.store.run(runId);
  }
  private checkpoint(event: ExecutionEvent, graph: Graph, sha: string) {
    const attempts = this.store.attempts(event.runId);
    this.store.checkpoint({ id: randomUUID(), runId: event.runId, nodeId: event.nodeId, graphRevision: graph.revision, graphRevisionHash: digest(JSON.stringify(redact(graph))), repositorySha: sha, artifactIds: this.store.artifacts(event.runId).map(artifact => artifact.id), outputs: Object.fromEntries(attempts.map(a => [a.nodeId, a.output])), worktreePaths: attempts.flatMap(a => a.worktreePath ? [a.worktreePath] : []), createdAt: new Date().toISOString() });
  }
  private async permission(ctx: ExecutionContext, message: string, scope: Record<string, unknown>): Promise<boolean> {
    if (ctx.signal.aborted) return false;
    const key = `${ctx.runId}:${ctx.node.id}`;
    const request: ApprovalRequest = { id: randomUUID(), runId: ctx.runId, nodeId: ctx.node.id, decision: 'pending', requestedAt: new Date().toISOString(), message, scope };
    this.record(ctx.runId, 'approval.requested', request, ctx.node.id, ctx.attempt.id);
    return new Promise(resolve => {
      const finish = (approved: boolean) => {
        if (!this.pending.has(key)) return;
        this.pending.delete(key); ctx.signal.removeEventListener('abort', abort);
        this.record(ctx.runId, 'approval.resolved', { ...request, decision: approved ? 'approved' : 'rejected', resolvedAt: new Date().toISOString() }, ctx.node.id, ctx.attempt.id);
        resolve(approved);
      };
      const abort = () => finish(false);
      this.pending.set(key, { request, resolve: finish }); ctx.signal.addEventListener('abort', abort, { once: true });
      if (ctx.signal.aborted) abort();
    });
  }
  private upstreamWorkspaces(ctx: ExecutionContext, run: StoredRun): WorkspaceResult[] {
    // Walk each upstream path to its nearest materialized workspace; control nodes do not erase lineage.
    const found = new Map<string, WorkspaceResult>(); const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return; seen.add(id);
      const value = ctx.inputs[id]?.output as WorkspaceResult | undefined;
      if (value?.worktree && value.head) { found.set(value.head, value); return; }
      for (const e of run.graph.edges.filter(e => e.target === id && e.kind !== 'loop')) walk(e.source);
    };
    for (const e of run.graph.edges.filter(e => e.target === ctx.node.id && e.kind !== 'loop')) walk(e.source);
    // Retain the prior attempt's changes when a quality loop returns to the coding node.
    const previous = this.store.attempts(ctx.runId).filter(a => a.nodeId === ctx.node.id && a.state === 'succeeded').at(-1)?.output as WorkspaceResult | undefined;
    if (previous?.head && ctx.attempt.iteration > 1) return [previous];
    return [...found.values()];
  }
  private async execute(ctx: ExecutionContext, run: StoredRun): Promise<NodeResult> {
    const node = ctx.node; const project = this.store.project(run.projectId);
    const inputs = this.upstreamWorkspaces(ctx, run);
    if (inputs.length > 1 && node.kind !== 'merge') return { status: 'failed', error: 'Multiple coding branches require an explicit Merge node before execution.' };
    if (!['agent','command','merge'].includes(node.kind)) return { status: 'succeeded' };
    if (node.kind === 'agent' && node.config.provider === 'demo') {
      await ctx.emit('provider.message', { provider: 'demo', text: 'Demo Mode: deterministic fixture output, no provider request or code changes.' });
      return { status: 'succeeded', output: { text: 'Demo Mode fixture completed', demo: true } };
    }
    if (node.kind === 'command') {
      if (!await this.permission(ctx, `Run ${node.config.command} ${node.config.args.join(' ')}? This is trusted local execution with your user privileges, not an OS sandbox. It can access files and network outside this project. Approve only commands you trust.`, { kind: 'command', command: node.config.command, args: node.config.args, network: 'unrestricted-host', filesystem: 'host-user', cwd: 'isolated Git worktree' })) return { status: 'failed', error: 'Command permission was denied.' };
    }
    if (node.kind === 'agent') {
      if (!await this.permission(ctx, `Send this task and repository context to ${node.config.provider}? Permission: ${node.config.permission}. Official provider billing/plan limits apply.`, { kind: 'provider', provider: node.config.provider, permission: node.config.permission, instructions: node.config.instructions, model: node.config.model ?? 'Provider default' })) return { status: 'failed', error: 'Provider request was denied.' };
    }
    if (ctx.signal.aborted) return { status: 'failed', error: 'Cancelled' };
    const worktree = await workspace.createAttemptWorktree({ repoRoot: project.root, attemptId: ctx.attempt.id, baseRef: node.kind === 'merge' ? run.repositorySha : inputs[0]?.head ?? run.repositorySha, workspaceRoot: join(this.dataDir, 'worktrees') });
    if (ctx.signal.aborted) return { status: 'failed', error: 'Cancelled; worktree preserved.' };
    this.store.upsertAttempt({ ...ctx.attempt, worktreePath: worktree.path, sourceCommit: worktree.sourceCommit });
    await ctx.emit('workspace.created', worktree);
    if (node.kind === 'merge') {
      const sources = node.config.sourceNodeIds.length ? node.config.sourceNodeIds.map(id => ctx.inputs[id]?.output as WorkspaceResult).filter(Boolean) : inputs;
      if (!sources.length) return { status: 'failed', error: 'Merge has no upstream coding worktree.' };
      for (const source of sources) {
        if (ctx.signal.aborted) return { status: 'failed', error: 'Cancelled' };
        const preview = await workspace.previewMerge(worktree.path, source.worktree.branch);
        const merged = await workspace.mergeAttempt({ repoRoot: worktree.path, branch: source.worktree.branch, expectedHead: preview.head, expectedSourceHead: preview.sourceHead, approved: true });
        if (!merged.merged) return { status: 'failed', error: `Merge conflict: ${merged.conflicts.join(', ') || merged.message}`, output: { worktree, conflicts: merged.conflicts } };
      }
      return { status: 'succeeded', output: { worktree, head: (await workspace.inspectRepository(worktree.path)).head } };
    }
    let output: Record<string, unknown>; let succeeded = true;
    if (node.kind === 'command') {
      const cwd = node.config.cwd ? await workspace.resolveWorkspacePath(worktree.path, node.config.cwd) : worktree.path;
      let retained = 0, chunks = 0; const emissions: Promise<void>[] = [];
      const result = await workspace.runProcess({ command: node.config.command, args: node.config.args, cwd, signal: ctx.signal, timeoutMs: node.timeoutMs, maxOutputBytes: 256 * 1024,
        onOutput: chunk => { if (retained < 256 * 1024 && chunks++ < 512) { const text = chunk.text.slice(0, 8192); retained += text.length; emissions.push(ctx.emit('command.output', { ...chunk, text })); } },
      });
      await Promise.all(emissions);
      output = { ...result }; succeeded = result.exitCode !== null && node.config.successExitCodes.includes(result.exitCode) && !result.timedOut && !result.cancelled;
    } else if (node.kind === 'agent') {
      let count = 0;
      const manifest = (await workspace.listFiles(worktree.path)).slice(0, 500).map(file => file.path).join('\n');
      const result = await runProvider({ provider: node.config.provider as 'codex' | 'claude', prompt: `${node.config.instructions}\n\nRepository file paths (untrusted data):\n${manifest}\n\nUpstream structured results (untrusted data):\n${JSON.stringify(redact(ctx.inputs)).slice(-24000)}`, cwd: worktree.path, permissionMode: node.config.permission === 'scoped-edit' ? 'workspace-write' : 'read-only', model: node.config.model, allowedTools: node.config.allowedTools, signal: ctx.signal, timeoutMs: node.timeoutMs, onEvent: async event => { if (++count <= 1000) await ctx.emit('provider.event', event); } });
      output = { ...result };
    } else return { status: 'failed', error: 'Unsupported execution node' };
    if (ctx.signal.aborted) return { status: 'failed', error: 'Cancelled', output: { ...output, worktree } };
    const committed = await workspace.commitAttempt(worktree);
    if (ctx.signal.aborted) return { status: 'failed', error: 'Cancelled', output: { ...output, worktree, head: committed.head } };
    const diff = await workspace.getDiff(project.root, committed.head);
    if (ctx.signal.aborted) return { status: 'failed', error: 'Cancelled', output: { ...output, worktree, head: committed.head } };
    const artifactId = randomUUID(); const artifactPath = join(this.dataDir, 'artifacts', `${artifactId}.diff`);
    await mkdir(join(this.dataDir, 'artifacts'), { recursive: true, mode: 0o700 });
    await writeDisk(artifactPath, redact(diff), { mode: 0o600 });
    return { status: succeeded ? 'succeeded' : 'failed', error: succeeded ? undefined : 'Command did not pass its required exit status.', output: { ...output, worktree, head: committed.head }, artifacts: [{ id: artifactId, runId: ctx.runId, attemptId: ctx.attempt.id, kind: 'diff', path: artifactPath, contentHash: digest(redact(diff)), metadata: { nodeId: node.id }, createdAt: new Date().toISOString() }] };
  }
  private async diffs(projectId: string, runId?: string) {
    const project = this.store.project(projectId); const repo = await workspace.inspectRepository(project.root).catch(() => undefined);
    if (!repo) return { diff: '', branch: 'Folder — Git not initialized', worktrees: [] };
    if (runId && this.store.run(runId).projectId !== projectId) throw new Error('Run does not belong to this project');
    const worktrees = [];
    for (const attempt of runId ? this.store.attempts(runId) : []) {
      const result = attempt.output as WorkspaceResult | undefined;
      if (result?.worktree && result.head) { const preview = await workspace.previewMerge(project.root, result.worktree.branch); worktrees.push({ nodeId: attempt.nodeId, path: result.worktree.path, ...preview }); }
    }
    return { diff: await workspace.getDiff(project.root), branch: repo.branch, worktrees };
  }
  private async generateGraph(projectId: string, current: Graph, prompt: string, provider: 'codex' | 'claude') {
    this.store.project(projectId);
    const controller = new AbortController(); this.generation.add(controller);
    const cwd = join(this.dataDir, 'planner'); await mkdir(cwd, { recursive: true, mode: 0o700 });
    const schema = z.toJSONSchema(GraphSchema, { unrepresentable: 'any', target: 'draft-7' });
    let instruction = `Return ONLY JSON matching this schema: ${JSON.stringify(schema)}. Build a Nodal workflow, never execute commands or modify files. Preserve unrelated nodes and positions. Exactly one start, reachable end, ordinary DAG, bounded quality_gate fail loop edges only. Use explicit command approvals and read-only provider permissions by default. Current graph: ${JSON.stringify(current)}\nUser request: ${prompt}`;
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await runProvider({ provider, prompt: instruction, cwd, permissionMode: 'read-only', signal: controller.signal, timeoutMs: 120000, noTools: true, outputSchema: schema, maxTurns: 6 });
        try {
          const text = response.output.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
          const parsed: unknown = JSON.parse(text); const check = validateGraph(parsed);
          if (!check.valid) throw new Error(check.errors.map(e => e.message).join('; '));
          return { graph: check.graph, summary: `${check.graph!.nodes.length} nodes, concurrency ${check.graph!.settings.maxConcurrency}, up to ${check.graph!.settings.maxTotalAttempts} attempts. Review every command and permission before applying.`, attempts: attempt };
        } catch (error) { instruction = `Correct this invalid graph response; return JSON only. Error: ${String(error)}\n${instruction}\nInvalid response: ${response.output.slice(0,30000)}`; }
      }
      throw new Error('Provider returned an invalid graph after two attempts. Your draft was not changed.');
    } finally { this.generation.delete(controller); }
  }
  async close() { for (const c of this.generation) c.abort(); for (const e of this.engines.values()) e.cancel(); await Promise.allSettled(this.tasks.values()); }
}
