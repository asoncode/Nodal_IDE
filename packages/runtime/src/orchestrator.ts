import { createHash, randomUUID } from 'node:crypto';
import { GraphSchema, nodeRole, roleOwnsPath, type ExecutionEvent, type Graph, type NodeAttempt, type WorkflowNode } from '../../shared/src/index.js';
import { validateGraph } from '../../core/src/validation.js';
import type { Proposal, ProposalChange, Store, StoredRun } from '../../persistence/src/index.js';

/**
 * The orchestrator works by rules over recorded data. During a run it can only pause and explain.
 * Between runs it proposes changes that a person applies; it never changes a workflow by itself.
 */
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const text = (value: unknown, key: string) => value && typeof value === 'object' && typeof (value as Record<string, unknown>)[key] === 'string' ? (value as Record<string, string>)[key]! : '';
/** Numbers (durations, timestamps, ports) vary between identical failures; ignore them when comparing. */
export const failureSignature = (result: unknown) => hash(['stdout', 'stderr', 'output', 'error'].map(key => text(result, key)).join('\n').replace(/\d+(\.\d+)?/g, '#').slice(-4000));

type Escalate = { pause: () => void; record: (kind: string, payload: unknown, nodeId?: string) => void };
export class Supervisor {
  private readonly results = new Map<string, unknown>();
  private readonly signatures = new Map<string, string>();
  private attempts = 0;
  private budgetWarned = false;
  constructor(private readonly graph: Graph, private readonly actions: Escalate) {}

  observe(event: ExecutionEvent): void {
    const payload = event.payload as { attempt?: NodeAttempt; result?: { route?: string; output?: unknown; error?: string } };
    if (event.kind === 'node.started' && !payload.attempt?.parentAttemptId) {
      this.attempts++;
      const limit = this.graph.settings.maxTotalAttempts;
      if (!this.budgetWarned && limit >= 5 && this.attempts >= Math.ceil(limit * 0.8)) {
        this.budgetWarned = true;
        this.escalate('budget', `The run has used ${this.attempts} of its ${limit} attempts. Paused so you can review progress before the limit stops it.`);
      }
    }
    if (event.kind !== 'node.completed' || !payload.attempt || !payload.result) return;
    const nodeId = payload.attempt.nodeId;
    this.results.set(nodeId, { ...(payload.result.output as object | undefined), error: payload.result.error });
    const node = this.graph.nodes.find(item => item.id === nodeId);
    if (node?.kind !== 'quality_gate' || payload.result.route !== 'fail') return;
    const sourceId = node.config.predicate.sourceNodeId || this.graph.edges.find(edge => edge.target === node.id && edge.kind !== 'loop')?.source;
    const signature = failureSignature(sourceId ? this.results.get(sourceId) : payload.result);
    const previous = this.signatures.get(node.id);
    this.signatures.set(node.id, signature);
    const looping = this.graph.edges.some(edge => edge.source === node.id && edge.kind === 'loop');
    if (looping && previous === signature) this.escalate('repeated_failure', `${node.label} failed twice in a row with the same evidence. Paused so you can adjust instructions or ownership before another identical attempt.`, node.id);
  }

  private escalate(reason: string, message: string, nodeId?: string) {
    this.actions.record('orchestrator.escalation', { reason, message }, nodeId);
    this.actions.pause();
  }
}

/** What a run built, what failed, and what remains, from recorded attempts and events only. */
export function runSummary(store: Store, run: StoredRun): string {
  const attempts = store.attempts(run.id).filter(attempt => !attempt.parentAttemptId);
  const latest = new Map<string, NodeAttempt>();
  for (const attempt of attempts) latest.set(attempt.nodeId, attempt);
  const label = (id: string) => run.graph.nodes.find(node => node.id === id)?.label ?? id;
  const built: string[] = [], failed: string[] = [], remaining: string[] = [];
  for (const node of run.graph.nodes) {
    if (node.kind === 'start' || node.kind === 'end') continue;
    const attempt = latest.get(node.id);
    const output = attempt?.output as { changedFiles?: string[]; handoffs?: { name: string }[] } | undefined;
    if (attempt?.state === 'succeeded' && (output?.changedFiles?.length || output?.handoffs?.length)) {
      built.push(`- ${node.label}: ${output.changedFiles?.length ?? 0} files changed${output.changedFiles?.length ? ` (${output.changedFiles.slice(0, 8).join(', ')}${output.changedFiles.length > 8 ? ', …' : ''})` : ''}${output.handoffs?.length ? `; handoffs ${output.handoffs.map(item => item.name).join(', ')}` : ''}`);
    }
    if (attempt?.state === 'failed') failed.push(`- ${node.label}: ${(attempt.error ?? 'failed').slice(0, 300)}`);
    if (!attempt || !['succeeded', 'skipped'].includes(attempt.state) && attempt.state !== 'failed') remaining.push(`- ${label(node.id)}`);
  }
  const consults = store.consults(run.id).length;
  const kinds = store.eventsByKind(run.id, ['loop.routed', 'orchestrator.escalation', 'loop.iteration']);
  return [
    `Run ${run.status}. ${attempts.length} attempts${consults ? `, ${consults} consults` : ''}${kinds.filter(event => event.kind === 'loop.iteration').length ? `, ${kinds.filter(event => event.kind === 'loop.iteration').length} quality-loop retries` : ''}${kinds.filter(event => event.kind === 'loop.routed').length ? `, ${kinds.filter(event => event.kind === 'loop.routed').length} routed failures` : ''}${kinds.filter(event => event.kind === 'orchestrator.escalation').length ? `, ${kinds.filter(event => event.kind === 'orchestrator.escalation').length} escalations` : ''}.`,
    built.length ? `Built:\n${built.join('\n')}` : 'Built: no committed changes.',
    failed.length ? `Failed:\n${failed.join('\n')}` : '',
    remaining.length ? `Did not run:\n${remaining.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

export type StepMetrics = {
  nodeId: string; label: string; kind: WorkflowNode['kind']; roleId?: string; runs: number; attempts: number; failures: number;
  loopExhausted: number; timeouts: number; ownershipViolations: number; flaky: number; denied: number;
  medianDurationMs: number | null; costUsd: number | null;
};
export type WorkflowMetrics = { graphId: string; runs: number; succeeded: number; failed: number; steps: StepMetrics[]; roles: { roleId: string; title: string; attempts: number; failures: number; costUsd: number | null }[] };

/** Per-step and per-role metrics for one workflow, from the most recent 100 runs of it. Unknown cost stays null. */
export function workflowMetrics(store: Store, projectId: string, graph: Graph): WorkflowMetrics {
  const runs = store.runs(projectId).filter(run => run.graph.id === graph.id && !['queued', 'running', 'paused', 'waiting_approval'].includes(run.status));
  const steps = new Map<string, StepMetrics & { durations: number[]; runIds: Set<string>; costKnown: boolean }>();
  const top = (nodeId: string) => nodeId.split('/')[0]!;
  for (const run of runs) {
    const attempts = store.attempts(run.id);
    const usage = store.eventsByKind(run.id, ['role.usage']);
    for (const attempt of attempts) {
      const node = graph.nodes.find(item => item.id === top(attempt.nodeId));
      if (!node) continue;
      const step = steps.get(node.id) ?? { nodeId: node.id, label: node.label, kind: node.kind, roleId: nodeRole(node)?.id, runs: 0, attempts: 0, failures: 0, loopExhausted: 0, timeouts: 0, ownershipViolations: 0, flaky: 0, denied: 0, medianDurationMs: null, costUsd: null, durations: [], runIds: new Set(), costKnown: true };
      if (!step.runIds.has(run.id)) { step.runIds.add(run.id); step.runs++; }
      step.attempts++;
      const error = attempt.error ?? '';
      if (attempt.state === 'failed') step.failures++;
      if (error.includes('Quality loop reached its limit')) step.loopExhausted++;
      if (/exceeded \d+ ms/.test(error)) step.timeouts++;
      if (error.includes('outside its ownership')) step.ownershipViolations++;
      if (/denied|rejected/.test(error)) step.denied++;
      if (attempt.startedAt && attempt.finishedAt) { const ms = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt); if (Number.isFinite(ms) && ms >= 0) step.durations.push(ms); }
      steps.set(node.id, step);
    }
    // Flaky: a command failed and later passed in the same run without its code changing.
    for (const node of graph.nodes.filter(item => item.kind === 'command')) {
      const own = attempts.filter(attempt => attempt.nodeId === node.id);
      if (own.some((failed, index) => failed.state === 'failed' && own.slice(index + 1).some(later => later.state === 'succeeded' && later.sourceCommit && later.sourceCommit === failed.sourceCommit))) steps.get(node.id)!.flaky++;
    }
    for (const event of usage) {
      const nodeId = event.nodeId && top(event.nodeId); const step = nodeId ? steps.get(nodeId) : undefined;
      if (!step) continue;
      const cost = (event.payload as { costUsd?: unknown }).costUsd;
      if (typeof cost === 'number') step.costUsd = (step.costUsd ?? 0) + cost; else step.costKnown = false;
    }
  }
  const list = [...steps.values()].map(({ durations, runIds: _runs, costKnown, ...step }) => {
    const sorted = [...durations].sort((a, b) => a - b);
    return { ...step, medianDurationMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null, costUsd: costKnown ? step.costUsd : null };
  });
  const roles = new Map<string, WorkflowMetrics['roles'][number]>();
  for (const step of list) {
    const role = step.roleId ? nodeRole(graph.nodes.find(node => node.id === step.nodeId)!) : undefined;
    if (!role) continue;
    const entry = roles.get(role.id) ?? { roleId: role.id, title: role.title, attempts: 0, failures: 0, costUsd: 0 as number | null };
    entry.attempts += step.attempts; entry.failures += step.failures; entry.costUsd = entry.costUsd === null || step.costUsd === null ? null : entry.costUsd + step.costUsd;
    roles.set(role.id, entry);
  }
  return { graphId: graph.id, runs: runs.length, succeeded: runs.filter(run => run.status === 'succeeded').length, failed: runs.filter(run => run.status === 'failed').length, steps: list, roles: [...roles.values()] };
}

/** Evidence comes only from runs of the current revision, so an applied change is judged on fresh runs. */
const currentRuns = (store: Store, projectId: string, graph: Graph) => store.runs(projectId).filter(run => run.graph.id === graph.id && run.graph.revision === graph.revision);
const runsWith = (store: Store, projectId: string, graph: Graph, test: (attempt: NodeAttempt) => boolean) =>
  currentRuns(store, projectId, graph).filter(run => store.attempts(run.id).some(test)).map(run => run.id);

/** Deterministic improvement proposals. Each needs at least two runs of evidence and names exactly what changes. */
export function proposeImprovements(store: Store, projectId: string, graph: Graph): Proposal[] {
  const proposals: Proposal[] = [];
  const now = new Date().toISOString();
  const add = (rule: string, node: WorkflowNode, title: string, rationale: string, runIds: string[], changes: ProposalChange[], detail?: string[], widensScope = false) => {
    if (runIds.length < 2) return;
    proposals.push({ id: randomUUID(), projectId, graphId: graph.id, ruleKey: `${graph.id}:${graph.revision}:${rule}:${node.id}`, baseRevision: graph.revision, title, rationale, evidence: { runIds, count: runIds.length, ...(detail ? { detail } : {}) }, changes, widensScope, status: 'open', createdAt: now });
  };
  for (const node of graph.nodes) {
    const top = (attempt: NodeAttempt) => attempt.nodeId === node.id;
    if (node.kind === 'quality_gate' && node.config.maxIterations < 20) {
      const runIds = runsWith(store, projectId, graph, attempt => top(attempt) && (attempt.error ?? '').includes('Quality loop reached its limit'));
      add('loop-limit', node, `Allow one more iteration for ${node.label}`, `${node.label} used all ${node.config.maxIterations} iterations in ${runIds.length} runs. One more iteration gives the fix loop another chance; consider also sharpening the implementing step's instructions.`, runIds, [{ nodeId: node.id, field: 'config.maxIterations', from: node.config.maxIterations, to: node.config.maxIterations + 1 }]);
    }
    if (node.timeoutMs < 86_400_000) {
      const runIds = runsWith(store, projectId, graph, attempt => attempt.nodeId.split('/')[0] === node.id && /exceeded \d+ ms/.test(attempt.error ?? ''));
      const next = Math.min(86_400_000, Math.round(node.timeoutMs * 1.5));
      add('timeout', node, `Give ${node.label} more time`, `${node.label} hit its ${Math.round(node.timeoutMs / 1000)}s timeout in ${runIds.length} runs.`, runIds, [{ nodeId: node.id, field: 'timeoutMs', from: node.timeoutMs, to: next }]);
    }
    if (node.kind === 'command' && node.retry.maxAttempts === 1) {
      const runIds = currentRuns(store, projectId, graph).filter(run => {
        const own = store.attempts(run.id).filter(top);
        return own.some((failed, index) => failed.state === 'failed' && own.slice(index + 1).some(later => later.state === 'succeeded' && later.sourceCommit === failed.sourceCommit));
      }).map(run => run.id);
      add('flaky-retry', node, `Retry ${node.label} once when it fails`, `${node.label} failed and then passed on the same code in ${runIds.length} runs, which suggests a flaky test. A single retry avoids spending a fix iteration on it; fixing the flakiness is still better.`, runIds, [{ nodeId: node.id, field: 'retry.maxAttempts', from: 1, to: 2 }]);
    }
    const role = nodeRole(node);
    if (role) {
      const offending = new Map<string, Set<string>>();
      const runIds = runsWith(store, projectId, graph, attempt => {
        if (attempt.nodeId.split('/')[0] !== node.id) return false;
        const match = /outside its ownership: (.+)$/.exec(attempt.error ?? '');
        if (!match) return false;
        for (const path of match[1]!.split(', ')) { const dir = path.includes('/') ? path.slice(0, path.indexOf('/')) : path; if (!roleOwnsPath(role.owns, path)) offending.set(dir, (offending.get(dir) ?? new Set()).add(attempt.runId)); }
        return true;
      });
      const scopes = [...offending].filter(([, runs]) => runs.size >= 2).map(([dir]) => dir).filter(dir => !role.owns.includes(dir)).slice(0, 5);
      if (scopes.length) add('ownership', node, `Let ${role.title} own ${scopes.join(', ')}`, `${role.title} edited ${scopes.join(', ')} outside its ownership in ${runIds.length} runs, and those attempts failed. Granting ownership widens what this role may change; alternatively assign that area to another role or tighten the instructions.`, runIds, [{ nodeId: node.id, field: 'config.role.owns', from: role.owns, to: [...role.owns, ...scopes] }], scopes, true);
    }
  }
  return proposals;
}

function setField(node: Record<string, unknown>, field: string, value: unknown) {
  const keys = field.split('.'); let target = node;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
}
function getField(node: Record<string, unknown>, field: string): unknown {
  return field.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, node);
}

/** Applies a proposal only to the exact revision and values it was computed from. The result must validate. */
export function applyChanges(graph: Graph, proposal: Proposal): Graph {
  if (graph.revision !== proposal.baseRevision) throw new Error(`The workflow changed since this proposal (revision ${proposal.baseRevision} → ${graph.revision}). Review its current metrics instead.`);
  const next = structuredClone(graph);
  for (const change of proposal.changes) {
    const node = next.nodes.find(item => item.id === change.nodeId) as unknown as Record<string, unknown> | undefined;
    if (!node) throw new Error(`Step ${change.nodeId} no longer exists.`);
    if (JSON.stringify(getField(node, change.field)) !== JSON.stringify(change.from)) throw new Error(`Step ${change.nodeId} changed since this proposal.`);
    setField(node, change.field, change.to);
  }
  const check = validateGraph(GraphSchema.parse(next));
  if (!check.valid) throw new Error(`The proposal would make the workflow invalid: ${check.errors.map(error => error.message).join('; ')}`);
  return check.graph!;
}

export type Comparison = { before: { runs: number; successRate: number | null; attemptsPerRun: number | null }; after: { runs: number; successRate: number | null; attemptsPerRun: number | null }; recommendation: 'keep' | 'revert' | 'insufficient data' };
/** Before/after comparison of an applied proposal, from runs of the base and applied revisions. */
export function compareProposal(store: Store, projectId: string, proposal: Proposal): Comparison | undefined {
  if (proposal.status !== 'applied' || proposal.appliedRevision === undefined) return undefined;
  const finished = store.runs(projectId).filter(run => run.graph.id === proposal.graphId && ['succeeded', 'failed', 'cancelled'].includes(run.status));
  const side = (revision: number) => {
    const runs = finished.filter(run => run.graph.revision === revision);
    const attempts = runs.reduce((sum, run) => sum + store.attempts(run.id).filter(attempt => !attempt.parentAttemptId).length, 0);
    return { runs: runs.length, successRate: runs.length ? runs.filter(run => run.status === 'succeeded').length / runs.length : null, attemptsPerRun: runs.length ? attempts / runs.length : null };
  };
  const before = side(proposal.baseRevision), after = side(proposal.appliedRevision);
  let recommendation: Comparison['recommendation'] = 'insufficient data';
  if (after.runs >= 2 && before.runs >= 1) {
    const better = after.successRate! > before.successRate!, worse = after.successRate! < before.successRate!;
    recommendation = better ? 'keep' : worse ? 'revert' : after.attemptsPerRun! <= before.attemptsPerRun! ? 'keep' : 'revert';
  }
  return { before, after, recommendation };
}
