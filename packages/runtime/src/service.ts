import { RoleSchema, type Role, type VerifiedHandoff } from '../../shared/src/roles.js';
import { enforceConsumedHandoffs, enforceOwnership, roleContext, roleUsage, validateRole, verifyProduced, verifyCommittedHandoffs } from './roles.js';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { mkdir, realpath, stat, writeFile as writeDisk } from 'node:fs/promises';
import { z } from 'zod';
import { GraphSchema, type Graph, type ExecutionEvent, type ApprovalRequest } from '../../shared/src/index.js';
import { WorkflowEngine, type ExecutionContext, type NodeResult } from '../../core/src/engine.js';
import { validateGraph } from '../../core/src/validation.js';
import { featureBuilder, templates } from '../../core/src/templates.js';
import { Store, digest, redact, type StoredRun } from '../../persistence/src/index.js';
import * as workspace from '../../workspace/src/index.js';
import { checkAvailability, runProvider } from '../../providers/src/index.js';
import { ChatRuntime } from './chat.js';
import { upstreamContext } from './context.js';
import { runTool, type ToolOutput } from './tools.js';
import { playbookGraph, type RoleNode } from '../../core/src/playbook.js';
import { TerminalRuntime } from './terminals.js';
import type { GenerationResult, GenerationSnapshot } from '../../shared/src/generation.js';
import { PlanningOptionsSchema, TeamPlanSchema, type PlanningOptions } from '../../shared/src/team.js';
import { planningContext, planningSchema, planningInstructions, assertApprovedTeam } from './planning.js';
import { validateTeamPlan, withHandoffEdges } from '../../core/src/team.js';
import type { CreateTerminalInput, TerminalOwner, TerminalScope } from '../../shared/src/terminal.js';
import { CHAT_ATTACHMENT_LIMITS, isChatTextFilename, type ChatAttachmentInput, type CreateChatInput } from '../../shared/src/chat.js';
// Writing a full workflow as schema-checked JSON took 60–90s per request in live runs; leave room for larger graphs.
const PLANNING_TIMEOUT_MS = 5 * 60_000;
// The schema alone cannot express the engine's wiring rules, and planners otherwise invent
// retry-only "fix" nodes or omit gate ports. These mirror core/src/validation.ts.
export const PLANNING_RULES = `Wiring rules (the graph is rejected if any is broken):
- Exactly one "start" (no incoming edges) and at least one "end" (no outgoing edges). Unique node and edge ids; no self-edges.
- Every node except start needs an incoming "control" edge, must be reachable from start through control edges, and must have a control path to an end.
- A node runs only after ALL sources of its incoming non-loop edges finish. Never wire an input from a node that runs only on a retry.
- Non-loop edges must form a DAG (no cycles).
- sourcePort: edges leaving a "condition" use "true" or "false" (both required). Every edge leaving a "quality_gate" uses "pass", "fail", or "inconclusive", and each gate needs a "pass" control edge. Omit sourcePort on all other edges.
- Quality loop: the retry edge is {"kind":"loop","sourcePort":"fail"} from the gate back to an earlier node on the main path, normally the implementing agent, whose instructions say to use previous test evidence to fix failures. Do not create separate fix nodes entered only by a loop edge.
- One loop edge per gate, and a looping gate has no other "fail" edge. Nodes between a loop target and its gate may only exit through that gate. Two loops must not share nodes: run looped stages one after another, each starting from its own agent.
- Test gate predicate: config.predicate = {"sourceNodeId": "<upstream command node id>", "field": "exitCode", "operator": "eq", "value": 0}. sourceNodeId must be upstream of the gate.
- No "join" with mode "first_success" inside a loop. Use only "control" and "loop" edges (artifact edges need typed ports).
Design guidance:
- Every step automatically receives the results of all earlier steps (plans, summaries, failing test output) and starts from the code the nearest earlier coding step committed. Do not add nodes only to pass information along.
- Parallelize independent work (for example backend and frontend after a shared plan): fan out from a "parallel" node to one agent per branch, give each branch its own test command and quality gate loop, send each gate's "pass" edge to a "join" (mode "all_success"), then a "merge" node whose config.sourceNodeIds lists the branch agents. Later coding or command steps must come after that merge; a step cannot start from two code branches.
- Deterministic tool steps need no model and no approval: {"kind":"tool","config":{"tool":"search","query":"...","paths":["src"]}}. Tools: search (query, regex, caseSensitive), symbols (name), read (paths), list, git (mode log|diff|blame), test-impact, validate (path, optional JSON schema), step-output (nodeId of an earlier step). Results expose "count" (and "valid" for validate), so a gate can check {"field":"count","operator":"eq","value":0}. Use a tool step whenever no judgment is needed: search before an agent reads, validate contracts instead of asking a reviewer.
- Represent each specialist as a role node: {"kind":"role","config":{"role":<role>,"playbook":{"nodes":[...],"edges":[...]}}}. The playbook is the role's internal workflow with its own start and end, using only start, end, agent, command, tool, condition, and quality_gate steps on one code lineage. Inner agents work as the role, so they never set their own "role". Give each coding role an inner test command and quality_gate loop back to its implementing agent, plus an orienting tool step first. The team level then shows only roles, gates, merges, reviews, and approvals.
- A review that can send work back goes after the test gates: a scoped-edit agent that addresses review findings (on the first pass it does final polish), then a read-only reviewer whose instructions end with "Reply with a final line VERDICT: PASS or VERDICT: FAIL", then a quality_gate with config.predicate = {"sourceNodeId": "<reviewer id>", "field": "output", "operator": "contains", "value": "VERDICT: PASS"} whose fail loop returns to the addressing agent. Test gates stay the authority; the review gate adds to them.
Valid example with a bounded loop: ${JSON.stringify(featureBuilder)}`;

const id = z.string().min(1).max(200);
const projectParams = z.object({ projectId: id }).strict();
const runParams = z.object({ runId: id }).strict();
const chatParams = projectParams.extend({ chatId: id });
const terminalOwner = projectParams.extend({ ownerId: id });
const terminalParams = terminalOwner.extend({ terminalId: id });
const terminalSize = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) };
const chatAttachment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reference'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('upload'), name: z.string().min(1).max(255), content: z.string().max(CHAT_ATTACHMENT_LIMITS.fileBytes) }).strict(),
]);
const requestSchemas = {
  bootstrap: z.object({}).strict(), providerStatus: z.object({}).strict(),
  createTerminal: terminalOwner.extend(terminalSize),
  readTerminal: terminalParams.extend({ after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
  writeTerminal: terminalParams.extend({ data: z.string().max(64 * 1024) }),
  resizeTerminal: terminalParams.extend(terminalSize),
  closeTerminal: terminalParams, closeTerminals: terminalOwner,
  openProject: z.object({ path: z.string().min(1).max(4096) }).strict(),
  files: projectParams, workspaceEntries: projectParams, listTrash: projectParams,
  createFolder: projectParams.extend({ path: z.string().min(1).max(4096) }),
  renameFile: projectParams.extend({ path: z.string().min(1).max(4096), newPath: z.string().min(1).max(4096), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  duplicateFile: projectParams.extend({ path: z.string().min(1).max(4096), newPath: z.string().min(1).max(4096), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  trashFile: projectParams.extend({ path: z.string().min(1).max(4096), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  restoreTrash: projectParams.extend({ trashId: z.string().uuid() }),
  searchWorkspace: projectParams.extend({ query: z.string().min(1).max(200).refine(value => !/[\r\n]/.test(value)), caseSensitive: z.boolean().optional(), wholeWord: z.boolean().optional() }),
  readFile: projectParams.extend({ path: z.string().min(1).max(4096) }),
  createFile: projectParams.extend({ path: z.string().min(1).max(4096) }),
  writeFile: projectParams.extend({ path: z.string().min(1).max(4096), content: z.string().max(2 * 1024 * 1024), expectedHash: z.string().length(64) }),
  listRoles: projectParams,
  saveRole: projectParams.extend({ role: RoleSchema }),
  deleteRole: projectParams.extend({ roleId: id }),
  listGraphs: projectParams,
  saveGraph: projectParams.extend({ graph: GraphSchema }),
  run: projectParams.extend({ graph: GraphSchema }),
  runs: projectParams, inspectRun: runParams, pause: runParams, resume: runParams, cancel: runParams,
  rerun: runParams.extend({ confirmed: z.literal(true) }),
  events: runParams.extend({ after: z.number().int().min(0).default(0) }),
  approve: runParams.extend({ nodeId: id, approved: z.boolean() }),
  diff: projectParams.extend({ runId: id.optional() }),
  generateGraph: projectParams.extend({ graph: GraphSchema, prompt: z.string().min(1).max(20000), provider: z.enum(['codex','claude']), planning: PlanningOptionsSchema.optional() }),
  startGeneration: projectParams.extend({ graph: GraphSchema, prompt: z.string().trim().min(1).max(20000), provider: z.enum(['codex','claude']), planning: PlanningOptionsSchema.optional() }),
  inspectGeneration: projectParams.extend({ generationId: id }),
  cancelGeneration: projectParams.extend({ generationId: id }),
  applyChanges: runParams.extend({ nodeId: id, expectedHead: id, expectedSourceHead: id, approved: z.literal(true) }),
  createChat: projectParams.extend({ provider: z.enum(['claude', 'codex']), model: z.string().trim().min(1).max(200).optional(), permission: z.enum(['read-only', 'scoped-edit']).default('read-only'), context: z.object({ graph: GraphSchema, nodeId: id, runId: id.optional() }).strict().optional() }),
  chats: projectParams, inspectChat: chatParams,
  chatFiles: projectParams,
  sendChat: chatParams.extend({ message: z.string().trim().min(1).max(20000), attachments: z.array(chatAttachment).max(CHAT_ATTACHMENT_LIMITS.count).default([]), confirmed: z.literal(true) }),
  cancelChat: chatParams.extend({ turnId: id }),
  approveChatCommand: chatParams.extend({ turnId: id, approvalId: id, approved: z.boolean() }),
  chatDiff: chatParams,
  applyChatChanges: chatParams.extend({ expectedHead: id, expectedSourceHead: id, approved: z.literal(true) }),
};
type PendingApproval = { request: ApprovalRequest; resolve: (approved: boolean) => void };
type WorkspaceResult = { worktree: workspace.AttemptWorktree; head: string };
/** Present when a step runs inside a role node's playbook. */
type ExecutionScope = { baseHead: string; parentAttemptId: string };

export class NodalService {
  private engines = new Map<string, WorkflowEngine>();
  private tasks = new Map<string, Promise<unknown>>();
  private executions = new Map<string, Set<Promise<NodeResult>>>();
  private pending = new Map<string, PendingApproval>();
  private generation = new Set<AbortController>();
  private generationJobs = new Map<string, { snapshot: GenerationSnapshot; controller: AbortController }>();
  private closed = false;
  private chat: ChatRuntime;
  private terminals: TerminalRuntime;
  constructor(readonly store: Store, readonly dataDir: string) { store.recover(); this.chat = new ChatRuntime(store, dataDir); this.terminals = new TerminalRuntime(projectId => store.project(projectId).root); }
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
      case 'createTerminal': return this.terminals.create(params as unknown as CreateTerminalInput);
      case 'readTerminal': return this.terminals.read(params as unknown as TerminalScope & { after: number });
      case 'writeTerminal': return this.terminals.write(params as unknown as TerminalScope & { data: string });
      case 'resizeTerminal': return this.terminals.resize(params as unknown as TerminalScope & { cols: number; rows: number });
      case 'closeTerminal': return this.terminals.closeTerminal(params as unknown as TerminalScope);
      case 'closeTerminals': return this.terminals.closeTerminals(params as unknown as TerminalOwner);
      case 'createChat': return this.chat.create(params as unknown as CreateChatInput);
      case 'chats': return this.chat.list(projectId);
      case 'inspectChat': return this.chat.inspect(projectId, params.chatId as string);
      case 'chatFiles': return (await workspace.listFiles(this.store.project(projectId).root)).filter(file => !workspace.isSensitivePath(file.path) && isChatTextFilename(file.path) && file.size <= CHAT_ATTACHMENT_LIMITS.fileBytes);
      case 'sendChat': return this.chat.send(projectId, params.chatId as string, params.message as string, params.attachments as ChatAttachmentInput[]);
      case 'cancelChat': return this.chat.cancel(projectId, params.chatId as string, params.turnId as string);
      case 'approveChatCommand': return this.chat.approveCommand(projectId, params.chatId as string, params.turnId as string, params.approvalId as string, params.approved as boolean);
      case 'chatDiff': return this.chat.diff(projectId, params.chatId as string);
      case 'applyChatChanges': return this.chat.apply(projectId, params.chatId as string, params.expectedHead as string, params.expectedSourceHead as string);
      case 'bootstrap': return { projects: this.store.projects(), templates, providers: await this.providerStatus() };
      case 'providerStatus': return this.providerStatus();
      case 'openProject': {
        const root = await realpath(params.path as string);
        if (!(await stat(root)).isDirectory()) throw new Error('Choose a folder, not a file.');
        const repo = await workspace.inspectRepository(root).catch(() => undefined);
        return this.store.addProject(root, basename(root), repo?.branch, !!repo);
      }
      case 'files': return (await workspace.listFiles(this.store.project(projectId).root)).map(f => f.path);
      case 'workspaceEntries': return workspace.workspaceEntries(this.store.project(projectId).root);
      case 'createFolder': return workspace.createFolder(this.store.project(projectId).root, params.path as string);
      case 'renameFile': return workspace.renameFile(this.store.project(projectId).root, params.path as string, params.newPath as string, params.expectedHash as string);
      case 'duplicateFile': return workspace.duplicateFile(this.store.project(projectId).root, params.path as string, params.newPath as string, params.expectedHash as string);
      case 'trashFile': return workspace.trashFile(this.store.project(projectId).root, this.dataDir, projectId, params.path as string, params.expectedHash as string);
      case 'restoreTrash': return workspace.restoreTrash(this.store.project(projectId).root, this.dataDir, projectId, params.trashId as string);
      case 'listTrash': return workspace.listTrash(this.store.project(projectId).root, this.dataDir, projectId);
      case 'searchWorkspace': return workspace.searchWorkspace(this.store.project(projectId).root, params.query as string, { caseSensitive: params.caseSensitive as boolean | undefined, wholeWord: params.wholeWord as boolean | undefined });
      case 'readFile': return workspace.readFile(this.store.project(projectId).root, params.path as string);
      case 'createFile': return workspace.createFile(this.store.project(projectId).root, params.path as string);
      case 'writeFile': {
        const result = await workspace.writeFile(this.store.project(projectId).root, params.path as string, params.content as string, params.expectedHash as string);
        return { ...result, content: params.content, path: params.path };
      }
      case 'listRoles': return this.store.roles(projectId);
      case 'saveRole': return this.store.saveRole(projectId, validateRole(params.role as Role));
      case 'deleteRole': this.store.deleteRole(projectId, params.roleId as string); return { deleted: true };
      case 'listGraphs': return this.store.graphs(projectId);
      case 'saveGraph': return this.store.saveGraph(projectId, params.graph as Graph);
      case 'run': return this.startRun(projectId, params.graph as Graph);
      case 'runs': return this.store.runs(projectId);
      case 'inspectRun': return { run: this.store.run(runId), attempts: this.store.attempts(runId), approvals: this.store.approvals(runId), checkpoints: this.store.checkpoints(runId), handoffs: this.store.handoffs(runId) };
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
      case 'generateGraph': return this.generateGraph(projectId, params.graph as Graph, params.prompt as string, params.provider as 'codex' | 'claude', params.planning as PlanningOptions | undefined);
      case 'startGeneration': return this.startGeneration(projectId, params.graph as Graph, params.prompt as string, params.provider as 'codex' | 'claude', params.planning as PlanningOptions | undefined);
      case 'inspectGeneration': return structuredClone(this.generationJob(projectId, params.generationId as string).snapshot);
      case 'cancelGeneration': return this.cancelGeneration(projectId, params.generationId as string);
      default: throw new Error('Unsupported method');
    }
  }
  private engine(id: string) { const e = this.engines.get(id); if (!e) throw new Error('This run is historical or interrupted. Review it and explicitly start a new run.'); return e; }
  async startRun(projectId: string, input: Graph, parentRunId?: string): Promise<StoredRun> {
    const validation = validateGraph(input);
    if (!validation.valid) throw new Error(validation.errors.map(e => e.message).join('\n'));
    const graph = structuredClone(validation.graph!);
    for (const node of graph.nodes) if ((node.kind === 'agent' || node.kind === 'role') && node.config.role) validateRole(node.config.role);
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
      for (const e of run.graph.edges.filter(e => e.target === id && e.kind === 'control')) walk(e.source);
    };
    for (const e of run.graph.edges.filter(e => e.target === ctx.node.id && e.kind === 'control')) walk(e.source);
    // Retain the prior attempt's changes when a quality loop returns to the coding node.
    const previous = this.store.attempts(ctx.runId).filter(a => a.nodeId === ctx.node.id && a.state === 'succeeded').at(-1)?.output as WorkspaceResult | undefined;
    if (previous?.head && ctx.attempt.iteration > 1) return [previous];
    return [...found.values()];
  }
  private async execute(ctx: ExecutionContext, run: StoredRun, scope?: ExecutionScope): Promise<NodeResult> {
    const node = ctx.node; const project = this.store.project(run.projectId);
    const inputs = this.upstreamWorkspaces(ctx, run);
    if (inputs.length > 1 && node.kind !== 'merge') return { status: 'failed', error: 'Multiple coding branches require an explicit Merge node before execution.' };
    if (node.kind === 'tool') return this.executeTool(ctx, run, inputs[0]?.head ?? scope?.baseHead ?? run.repositorySha!, scope);
    if (node.kind === 'role') return scope ? { status: 'failed', error: 'Roles cannot run inside another role.' } : this.executeRole(ctx, run, inputs[0]?.head ?? run.repositorySha!);
    if (!['agent','command','merge'].includes(node.kind)) return { status: 'succeeded' };
    if (node.kind === 'agent' && node.config.provider === 'demo' && node.config.role) return { status: 'failed', error: 'Demo agents cannot publish verified role handoffs. Select a live provider.' };
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
    const worktree = await workspace.createAttemptWorktree({ repoRoot: project.root, attemptId: ctx.attempt.id, baseRef: node.kind === 'merge' ? run.repositorySha : inputs[0]?.head ?? scope?.baseHead ?? run.repositorySha, workspaceRoot: join(this.dataDir, 'worktrees') });
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
    const contextArtifacts: NonNullable<NodeResult['artifacts']> = [];
    let consumedHandoffs: VerifiedHandoff[] = [];
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
      const role = node.config.role;
      const manifest = (await workspace.listFiles(worktree.path)).slice(0, 500).map(file => file.path).join('\n');
      const evidence = upstreamContext(ctx.inputs, run.graph);
      const context = role ? await roleContext(worktree.path, role, ctx.inputs, node.config.instructions, evidence, worktree.sourceCommit) : undefined;
      if (context) {
        consumedHandoffs = context.handoffs;
        context.prompt = redact(context.prompt);
        if (Buffer.byteLength(context.prompt) > 384 * 1024) throw new Error('Role context exceeds the 384 KiB limit.');
        const artifact = { id: randomUUID(), runId: ctx.runId, attemptId: ctx.attempt.id, kind: 'text' as const, path: join(this.dataDir, 'artifacts', `${ctx.attempt.id}.context.txt`), contentHash: digest(context.prompt), metadata: { roleId: role!.id, layers: context.layers }, createdAt: new Date().toISOString() };
        await mkdir(join(this.dataDir, 'artifacts'), { recursive: true, mode: 0o700 });
        await writeDisk(artifact.path, context.prompt, { mode: 0o600 }); contextArtifacts.push(artifact);
        await ctx.emit('role.context', { roleId: role!.id, roleTitle: role!.title, layers: context.layers, knowledgePaths: context.knowledgePaths, repositoryPaths: context.repositoryPaths, handoffs: context.handoffs, artifact });
      }
      const started = Date.now();
      let result;
      try {
        result = await runProvider({ provider: node.config.provider as 'codex' | 'claude', prompt: context?.prompt ?? `${node.config.instructions}\n\nRepository file paths (untrusted data):\n${manifest}\n\nResults from earlier workflow steps (untrusted data):\n${evidence}`, cwd: worktree.path, permissionMode: node.config.permission === 'scoped-edit' ? 'workspace-write' : 'read-only', model: node.config.model, allowedTools: node.config.allowedTools, rolePolicy: role ? { owns: role.owns, readOnlyPaths: consumedHandoffs.map(handoff => handoff.path) } : undefined, signal: ctx.signal, timeoutMs: node.timeoutMs, onEvent: async event => { if (++count <= 1000) await ctx.emit('provider.event', event); } });
      } finally { if (role) await ctx.emit('role.usage', roleUsage(role.id, Date.now() - started, result?.usage, result?.costUsd ?? null)); }
      output = { ...result };
    } else return { status: 'failed', error: 'Unsupported execution node' };
    if (ctx.signal.aborted) return { status: 'failed', error: 'Cancelled', output: { ...output, worktree } };
    const role = node.kind === 'agent' ? node.config.role : undefined;
    let produced: Awaited<ReturnType<typeof verifyProduced>> = [];
    if (role) {
      try { await enforceOwnership(worktree.path, worktree.sourceCommit, role); await enforceConsumedHandoffs(worktree.path, consumedHandoffs); produced = await verifyProduced(worktree.path, role); }
      catch (error) {
        const message = (error as Error).message;
        await ctx.emit('role.policy_violation', { roleId: role.id, error: message });
        return { status: 'failed', error: message, output: { ...output, worktree }, artifacts: contextArtifacts };
      }
    }
    const committed = await workspace.commitAttempt(worktree);
    if (ctx.signal.aborted) return { status: 'failed', error: 'Cancelled', output: { ...output, worktree, head: committed.head } };
    try { await verifyCommittedHandoffs(worktree.path, committed.head, produced); }
    catch (error) {
      const message = (error as Error).message;
      await ctx.emit('role.policy_violation', { roleId: role?.id, error: message });
      return { status: 'failed', error: message, output: { ...output, worktree }, artifacts: contextArtifacts };
    }
    const handoffs: VerifiedHandoff[] = produced.map(handoff => ({ ...handoff, producerNodeId: node.id, attemptId: ctx.attempt.id, commit: committed.head }));
    if (role) output.handoffs = handoffs;
    const diff = await workspace.getDiff(project.root, committed.head);
    if (ctx.signal.aborted) return { status: 'failed', error: 'Cancelled', output: { ...output, worktree, head: committed.head } };
    const artifactId = randomUUID(); const artifactPath = join(this.dataDir, 'artifacts', `${artifactId}.diff`);
    await mkdir(join(this.dataDir, 'artifacts'), { recursive: true, mode: 0o700 });
    await writeDisk(artifactPath, redact(diff), { mode: 0o600 });
    for (const handoff of handoffs) { this.store.saveHandoff(ctx.runId, handoff); await ctx.emit('handoff.verified', handoff); }
    return { status: succeeded ? 'succeeded' : 'failed', error: succeeded ? undefined : 'Command did not pass its required exit status.', output: { ...output, worktree, head: committed.head }, artifacts: [...contextArtifacts, { id: artifactId, runId: ctx.runId, attemptId: ctx.attempt.id, kind: 'diff', path: artifactPath, contentHash: digest(redact(diff)), metadata: { nodeId: node.id }, createdAt: new Date().toISOString() }] };
  }
  /** Read-only and deterministic for a commit, so results are cached and need no approval prompt. */
  private async executeTool(ctx: ExecutionContext, run: StoredRun, commit: string, scope?: ExecutionScope): Promise<NodeResult> {
    if (ctx.node.kind !== 'tool') return { status: 'failed', error: 'Not a tool step.' };
    const config = ctx.node.config;
    const baseCommit = scope?.baseHead ?? run.repositorySha!;
    const cacheable = config.tool !== 'step-output';
    const key = digest(JSON.stringify({ config, commit, baseCommit }));
    type Stored = { status: 'succeeded' | 'failed'; output: ToolOutput; error?: string };
    const cached = cacheable ? this.store.toolResult<Stored>(key) : undefined;
    const result = cached ?? await runTool(config, {
      root: this.store.project(run.projectId).root, commit, baseCommit, inputs: ctx.inputs,
      index: async (blob, compute) => { const known = this.store.fileIndex<Awaited<ReturnType<typeof compute>>>(blob); if (known) return known; const value = await compute(); this.store.saveFileIndex(blob, value); return value; },
    });
    if (cacheable && !cached) this.store.saveToolResult(key, config.tool, commit, result);
    await ctx.emit('tool.result', { tool: config.tool, commit, count: result.output.count, truncated: result.output.truncated, cached: !!cached, ...(result.error ? { error: result.error } : {}) });
    return { status: result.status, output: result.output, ...(result.error ? { error: result.error } : {}) };
  }

  /**
   * Runs a role's playbook as a scoped child of this run. The child inherits the run's commit lineage,
   * cannot exceed the remaining attempt budget or the role step's timeout, and publishes only after
   * ownership and produced handoffs are verified for everything the playbook changed.
   */
  private async executeRole(ctx: ExecutionContext, run: StoredRun, baseHead: string): Promise<NodeResult> {
    if (ctx.node.kind !== 'role') return { status: 'failed', error: 'Not a role step.' };
    const node = ctx.node as RoleNode;
    const role = validateRole(node.config.role);
    const remaining = Math.max(1, run.graph.settings.maxTotalAttempts - this.store.attempts(ctx.runId).length);
    const graph = playbookGraph(node, { maxTotalAttempts: remaining, timeoutMs: node.timeoutMs });
    const childRun: StoredRun = { ...run, graph };
    const scope: ExecutionScope = { baseHead, parentAttemptId: ctx.attempt.id };
    let last: WorkspaceResult | undefined;
    const summaries: string[] = [];
    const engine = new WorkflowEngine(graph, {
      runId: ctx.runId,
      execute: async inner => {
        const result = await this.execute({ ...inner, inputs: { ...ctx.inputs, ...inner.inputs } }, childRun, scope);
        const output = result.output as (Partial<WorkspaceResult> & { output?: unknown }) | undefined;
        if (result.status === 'succeeded' && output?.worktree && output.head) last = { worktree: output.worktree, head: output.head };
        if (result.status === 'succeeded' && inner.node.kind === 'agent' && typeof output?.output === 'string') summaries.push(`## ${inner.node.label}\n${output.output}`);
        return result;
      },
      onEvent: async event => {
        // Child run-level events must not change the parent run's status; steps are tagged with their role attempt.
        const payload = event.payload as Record<string, unknown>;
        const kind = event.kind.startsWith('run.') ? `role.${event.kind}` : event.kind;
        const tagged = payload?.attempt ? { ...payload, attempt: { ...(payload.attempt as object), parentAttemptId: ctx.attempt.id } } : payload;
        this.store.appendEvent({ ...event, kind, payload: tagged, ...(kind !== event.kind ? { nodeId: node.id, attemptId: ctx.attempt.id } : {}) });
      },
    });
    const stop = () => void engine.cancel(String(ctx.signal.reason ?? 'Role step stopped.'));
    ctx.signal.addEventListener('abort', stop, { once: true });
    let snapshot;
    try { snapshot = await engine.start(); } finally { ctx.signal.removeEventListener('abort', stop); }
    const output: Record<string, unknown> = { output: summaries.join('\n\n').slice(-16_000), roleId: role.id, playbook: { status: snapshot.status, attempts: snapshot.attempts.length } };
    if (snapshot.status !== 'succeeded') return { status: 'failed', error: `${role.title} playbook ${snapshot.status}: ${snapshot.error ?? 'no successful End path'}`, output };
    if (!last) {
      if (role.produces.some(handoff => handoff.required)) return { status: 'failed', error: `${role.title} produced no committed changes, so its required handoffs cannot be verified.`, output };
      return { status: 'succeeded', output };
    }
    const workspaceResult = last as WorkspaceResult;
    let produced: Awaited<ReturnType<typeof verifyProduced>>;
    try {
      // Everything the playbook changed since the role started, including inner command steps, must stay in the role's area.
      await enforceOwnership(workspaceResult.worktree.path, baseHead, role);
      produced = await verifyProduced(workspaceResult.worktree.path, role);
      await verifyCommittedHandoffs(workspaceResult.worktree.path, workspaceResult.head, produced);
    } catch (error) {
      const message = (error as Error).message;
      await ctx.emit('role.policy_violation', { roleId: role.id, error: message });
      return { status: 'failed', error: message, output: { ...output, worktree: workspaceResult.worktree } };
    }
    const handoffs: VerifiedHandoff[] = produced.map(handoff => ({ ...handoff, producerNodeId: node.id, attemptId: ctx.attempt.id, commit: workspaceResult.head }));
    for (const handoff of handoffs) { this.store.saveHandoff(ctx.runId, handoff); await ctx.emit('handoff.verified', handoff); }
    const diff = await workspace.getDiff(this.store.project(run.projectId).root, workspaceResult.head);
    const artifactId = randomUUID(); const artifactPath = join(this.dataDir, 'artifacts', `${artifactId}.diff`);
    await mkdir(join(this.dataDir, 'artifacts'), { recursive: true, mode: 0o700 });
    await writeDisk(artifactPath, redact(diff), { mode: 0o600 });
    return { status: 'succeeded', output: { ...output, worktree: workspaceResult.worktree, head: workspaceResult.head, handoffs }, artifacts: [{ id: artifactId, runId: ctx.runId, attemptId: ctx.attempt.id, kind: 'diff', path: artifactPath, contentHash: digest(redact(diff)), metadata: { nodeId: node.id }, createdAt: new Date().toISOString() }] };
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
  private pruneGenerationJobs() {
    const finished = [...this.generationJobs.values()].filter(job => job.snapshot.status !== 'running');
    for (const job of finished.slice(0, Math.max(0, finished.length - 32))) this.generationJobs.delete(job.snapshot.id);
  }
  private generationJob(projectId: string, generationId: string) {
    this.store.project(projectId);
    const job = this.generationJobs.get(generationId);
    if (!job || job.snapshot.projectId !== projectId) throw new Error('Generation not found for this project.');
    return job;
  }
  private startGeneration(projectId: string, graph: Graph, prompt: string, provider: 'codex' | 'claude', planning?: PlanningOptions): GenerationSnapshot {
    this.store.project(projectId);
    if (this.closed) throw new Error('Runtime is closing.');
    if ([...this.generationJobs.values()].some(job => job.snapshot.projectId === projectId && job.snapshot.status === 'running')) throw new Error('This project already has a generation in progress. Wait for it to finish or cancel it before trying again.');
    if (this.generation.size >= 4) throw new Error('Too many active generations. Wait for a preview to finish.');
    const controller = new AbortController();
    const snapshot: GenerationSnapshot = { id: randomUUID(), projectId, provider, status: 'running', createdAt: new Date().toISOString() };
    this.generationJobs.set(snapshot.id, { snapshot, controller });
    void this.generateGraph(projectId, graph, prompt, provider, planning, controller).then(result => {
      if (controller.signal.aborted || snapshot.status !== 'running') return;
      snapshot.status = 'succeeded'; snapshot.result = result; snapshot.finishedAt = new Date().toISOString();
    }).catch(error => {
      if (controller.signal.aborted || snapshot.status !== 'running') return;
      snapshot.status = 'failed'; snapshot.error = redact(error instanceof Error ? error.message : String(error)).slice(0, 4000); snapshot.finishedAt = new Date().toISOString();
    }).finally(() => this.pruneGenerationJobs());
    return structuredClone(snapshot);
  }
  private cancelGeneration(projectId: string, generationId: string): GenerationSnapshot {
    const { snapshot, controller } = this.generationJob(projectId, generationId);
    if (snapshot.status === 'running') {
      snapshot.status = 'cancelled'; snapshot.finishedAt = new Date().toISOString();
      controller.abort(new Error('Graph generation cancelled.'));
      this.pruneGenerationJobs();
    }
    return structuredClone(snapshot);
  }
  private async generateGraph(projectId: string, current: Graph, prompt: string, provider: 'codex' | 'claude', planning?: PlanningOptions, controller = new AbortController()): Promise<GenerationResult> {
    this.store.project(projectId);
    if (this.closed) throw new Error('Runtime is closing.');
    this.generation.add(controller);
    try {
      const status = await checkAvailability(provider);
      controller.signal.throwIfAborted();
      if (!status.available) throw new Error(`${provider === 'claude' ? 'Claude' : 'Codex'} is unavailable. ${status.message} No model request was made.`);
      if (status.authentication === 'missing') throw new Error(`Sign in with ${status.loginCommand ?? (provider === 'claude' ? 'claude auth login' : 'codex login')}, then try again. ${status.message} No model request was made.`);
      const cwd = join(this.dataDir, 'planner'); await mkdir(cwd, { recursive: true, mode: 0o700 });
      if (planning?.team) {
        const issues = validateTeamPlan(planning.team);
        if (issues.length) throw new Error(issues.map(issue => issue.message).join('; '));
      }
      const context = await planningContext(this.store.project(projectId).root, planning?.briefPaths ?? [], this.store.roles(projectId));
      controller.signal.throwIfAborted();
      const schema = planningSchema(planning);
      let instruction = `${planningInstructions(current, prompt, PLANNING_RULES, context, planning)}\nSchema: ${JSON.stringify(schema)}`;
      for (let attempt = 1; attempt <= 2; attempt++) {
        controller.signal.throwIfAborted();
        const response = await runProvider({ provider, prompt: instruction, cwd, permissionMode: 'read-only', signal: controller.signal, timeoutMs: PLANNING_TIMEOUT_MS, noTools: true, outputSchema: schema, maxTurns: 6 });
        controller.signal.throwIfAborted();
        try {
          const text = response.output.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
          const parsed: unknown = JSON.parse(text);
          if (planning?.stage === 'team') {
            const team = TeamPlanSchema.parse(parsed);
            const issues = validateTeamPlan(team);
            if (issues.length) throw new Error(issues.map(issue => issue.message).join('; '));
            return { graph: current, team, summary: team.summary, attempts: attempt };
          }
          const check = validateGraph(withHandoffEdges(GraphSchema.parse(parsed)));
          if (!check.valid) throw new Error(check.errors.map(e => e.message).join('; '));
          if (planning?.team) assertApprovedTeam(check.graph!, planning.team);
          return { graph: check.graph!, summary: `${check.graph!.nodes.length} nodes, concurrency ${check.graph!.settings.maxConcurrency}, up to ${check.graph!.settings.maxTotalAttempts} attempts. Review every command and permission before applying.`, attempts: attempt };
        } catch (error) { instruction = `Correct this invalid graph response; return JSON only. Error: ${String(error)}\n${instruction}\nInvalid response: ${response.output.slice(0,30000)}`; }
      }
      throw new Error('Provider returned an invalid graph after two attempts. Your draft was not changed.');
    } finally { this.generation.delete(controller); }
  }
  async close() {
    this.closed = true;
    for (const { snapshot } of this.generationJobs.values()) if (snapshot.status === 'running') this.cancelGeneration(snapshot.projectId, snapshot.id);
    for (const c of this.generation) c.abort();
    for (const e of this.engines.values()) e.cancel();
    await Promise.allSettled([...this.tasks.values(), this.chat.close(), this.terminals.close()]);
  }
}
