import {
  type ApprovalRequest, type Artifact, type ExecutionEvent, type Graph, type NodeAttempt,
  type NodeState, type Predicate, type QualityVerdict, type WorkflowEdge,
  type WorkflowNode, type WorkflowRun,
} from '../../shared/src/index.js';
import { descendants, loopRegion, validateGraph } from './validation.js';

export interface NodeResult {
  status: 'succeeded' | 'failed';
  output?: unknown;
  error?: string;
  artifacts?: Artifact[];
  route?: string;
}
export interface ExecutionContext {
  runId: string;
  node: WorkflowNode;
  attempt: NodeAttempt;
  inputs: Record<string, NodeResult>;
  signal: AbortSignal;
  emit: (kind: string, payload: unknown) => Promise<void>;
}
export interface EngineOptions {
  runId?: string;
  execute: (context: ExecutionContext) => Promise<NodeResult>;
  onEvent?: (event: ExecutionEvent) => Promise<void> | void;
}

const terminal = new Set<NodeState>(['succeeded', 'failed', 'skipped', 'cancelled', 'interrupted']);
const now = () => new Date().toISOString();
const id = () => globalThis.crypto.randomUUID();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const clone = <T>(value: T): T => structuredClone(value);

/** Reads own JSON properties only; graph predicates never evaluate source code. */
export function readField(value: unknown, field: string): unknown {
  if (!field) return value;
  let current = value;
  for (const key of field.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) return undefined;
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function evaluatePredicate(predicate: Predicate, output: unknown): boolean | undefined {
  const actual = readField(output, predicate.field);
  if (predicate.operator === 'exists') return actual !== undefined && actual !== null;
  if (actual === undefined) return undefined;
  switch (predicate.operator) {
    case 'eq': return JSON.stringify(actual) === JSON.stringify(predicate.value);
    case 'neq': return JSON.stringify(actual) !== JSON.stringify(predicate.value);
    case 'contains':
      if (typeof actual === 'string' && typeof predicate.value === 'string') return actual.includes(predicate.value);
      if (Array.isArray(actual)) return actual.some((item) => JSON.stringify(item) === JSON.stringify(predicate.value));
      return undefined;
    default: {
      if (typeof actual !== 'number' || typeof predicate.value !== 'number') return undefined;
      if (predicate.operator === 'gt') return actual > predicate.value;
      if (predicate.operator === 'gte') return actual >= predicate.value;
      if (predicate.operator === 'lt') return actual < predicate.value;
      return actual <= predicate.value;
    }
  }
}

/**
 * Scheduling and public event ordering are deterministic; injected side effects
 * may complete in any order. A graph snapshot is pinned when constructed.
 */
export class WorkflowEngine {
  readonly graph: Graph;
  private readonly options: EngineOptions;
  private readonly run: WorkflowRun;
  private readonly results = new Map<string, NodeResult>();
  private readonly loopFeedback = new Map<string, Record<string, NodeResult>>();
  private readonly iterations = new Map<string, number>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly approvals = new Map<string, (approved: boolean) => void>();
  private readonly parallelScopes = new Map<string, Set<string>>();
  private readonly controlWaiters = new Set<() => void>();
  private sequence = 0;
  private eventQueue: Promise<void> = Promise.resolve();
  private wake?: () => void;
  private paused = false;
  private cancelled = false;
  private fatalError?: string;
  private started = false;
  private runTimer?: ReturnType<typeof setTimeout>;

  constructor(input: unknown, options: EngineOptions) {
    const validation = validateGraph(input);
    if (!validation.valid || !validation.graph) throw new Error(validation.errors.map((error) => error.message).join('\n'));
    this.graph = clone(validation.graph);
    this.options = options;
    this.run = {
      id: options.runId ?? id(), graphId: this.graph.id, graphRevision: this.graph.revision,
      status: 'queued', createdAt: now(),
      nodeStates: Object.fromEntries(this.graph.nodes.map((node) => [node.id, 'pending'])),
      attempts: [],
    };
    const edges = this.graph.edges.filter((edge) => edge.kind !== 'loop');
    for (const node of this.graph.nodes) {
      this.iterations.set(node.id, 1);
      if (node.kind === 'parallel') {
        // A join closes a split scope. Downstream serial work has no split cap.
        const scope = new Set<string>();
        const pending = edges.filter((edge) => edge.source === node.id).map((edge) => edge.target);
        while (pending.length) {
          const next = pending.pop()!;
          if (scope.has(next)) continue;
          const child = this.graph.nodes.find((item) => item.id === next)!;
          if (child.kind === 'join') continue;
          scope.add(next);
          pending.push(...edges.filter((edge) => edge.source === next).map((edge) => edge.target));
        }
        this.parallelScopes.set(node.id, scope);
      }
    }
  }

  getSnapshot(): WorkflowRun { return clone(this.run); }
  getResults(): Record<string, NodeResult> { return clone(Object.fromEntries(this.results)); }

  async pause(): Promise<void> {
    if (!this.started || this.isFinished()) return;
    this.paused = true;
    this.run.status = 'paused';
    await this.emit('run.status', { status: 'paused' });
    this.notify();
  }

  async resume(): Promise<void> {
    if (!this.paused || this.isFinished()) return;
    this.paused = false;
    this.run.status = 'running';
    await this.emit('run.status', { status: 'running' });
    this.notify();
  }

  async cancel(reason = 'Stopped by user'): Promise<void> {
    if (this.isFinished()) return;
    this.cancelled = true;
    this.run.error = reason;
    for (const controller of this.controllers.values()) controller.abort(new Error(reason));
    this.notify();
  }

  approve(nodeId: string, approved: boolean): boolean {
    const resolve = this.approvals.get(nodeId);
    if (!resolve) return false;
    this.approvals.delete(nodeId);
    resolve(approved);
    return true;
  }

  async start(): Promise<WorkflowRun> {
    if (this.started) throw new Error('This engine has already started. Create a new engine for a new run.');
    this.started = true;
    this.run.status = 'running';
    this.run.startedAt = now();
    this.runTimer = setTimeout(() => {
      this.fatalError = `Workflow exceeded ${this.graph.settings.timeoutMs} ms.`;
      for (const controller of this.controllers.values()) controller.abort(new Error(this.fatalError));
      this.notify();
    }, this.graph.settings.timeoutMs);
    try {
      await this.emit('run.started', { graph: this.graph, run: this.getSnapshot() });
      while (true) {
        if (this.cancelled || this.fatalError) {
          for (const controller of this.controllers.values()) controller.abort(new Error(this.fatalError ?? this.run.error));
          await Promise.all([...this.active.values()]);
          for (const node of this.graph.nodes) {
            if (!terminal.has(this.run.nodeStates[node.id]!)) await this.setState(node.id, 'cancelled');
          }
          break;
        }
        let changed = false;
        if (!this.paused) {
          for (const node of this.graph.nodes) {
            if (this.cancelled || this.fatalError || this.paused) break;
            if (this.run.nodeStates[node.id] !== 'pending') continue;
            const readiness = this.readiness(node);
            if (readiness === 'skip') {
              await this.setState(node.id, 'skipped');
              changed = true;
            } else if (readiness === 'ready' && this.hasCapacity(node.id)) {
              // Reserve capacity synchronously, before any awaited state event.
              this.run.nodeStates[node.id] = 'ready';
              const task = this.runNode(node).catch((error: unknown) => {
                this.fatalError = message(error);
              }).finally(() => {
                this.active.delete(node.id);
                this.notify();
              });
              this.active.set(node.id, task);
              changed = true;
            }
          }
        }
        if (!this.active.size && this.graph.nodes.every((node) => terminal.has(this.run.nodeStates[node.id]!))) break;
        if (!changed) {
          if (!this.active.size && !this.paused) {
            this.fatalError = 'No runnable nodes remain. Dependencies could not be satisfied.';
            continue;
          }
          await new Promise<void>((resolve) => { this.wake = resolve; });
        }
      }
      const endSucceeded = this.graph.nodes.some((node) => node.kind === 'end' && this.run.nodeStates[node.id] === 'succeeded');
      const unhandledFailure = this.graph.nodes.some((node) => this.run.nodeStates[node.id] === 'failed' && !this.failureHandled(node.id));
      this.run.status = this.cancelled ? 'cancelled' : this.fatalError || unhandledFailure || !endSucceeded ? 'failed' : 'succeeded';
      this.run.error ??= this.fatalError;
      if (this.run.status === 'failed' && !this.run.error) {
        this.run.error = this.run.attempts.findLast((attempt) => attempt.state === 'failed')?.error ?? 'No successful End path was reached.';
      }
      this.run.finishedAt = now();
      await this.emit('run.completed', { run: this.getSnapshot() });
    } catch (error) {
      this.run.status = 'failed';
      this.run.error = `Execution event persistence failed: ${message(error)}`;
      this.run.finishedAt = now();
      for (const controller of this.controllers.values()) controller.abort(error);
      await Promise.allSettled([...this.active.values()]);
    } finally {
      clearTimeout(this.runTimer);
    }
    return this.getSnapshot();
  }

  private isFinished(): boolean {
    return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(this.run.status);
  }
  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
    for (const waiter of this.controlWaiters) waiter();
  }
  private emit(kind: string, payload: unknown, nodeId?: string, attemptId?: string): Promise<void> {
    const event: ExecutionEvent = {
      eventId: id(), runId: this.run.id, sequence: ++this.sequence, timestamp: now(),
      kind, payload: clone(payload), ...(nodeId ? { nodeId } : {}), ...(attemptId ? { attemptId } : {}),
    };
    this.eventQueue = this.eventQueue.then(() => this.options.onEvent?.(event));
    return this.eventQueue;
  }
  private async setState(nodeId: string, state: NodeState): Promise<void> {
    this.run.nodeStates[nodeId] = state;
    await this.emit('node.state', { state }, nodeId);
  }
  private hasCapacity(nodeId: string): boolean {
    if (this.active.has(nodeId)) return false;
    if (this.active.size >= this.graph.settings.maxConcurrency) return false;
    for (const [splitId, scope] of this.parallelScopes) {
      if (!scope.has(nodeId)) continue;
      const split = this.graph.nodes.find((node) => node.id === splitId)!;
      if (split.kind === 'parallel' && [...this.active.keys()].filter((id) => scope.has(id)).length >= split.config.maxConcurrency) return false;
    }
    return true;
  }
  private edgeActive(edge: WorkflowEdge): boolean | undefined {
    const state = this.run.nodeStates[edge.source]!;
    if (!terminal.has(state)) return undefined;
    if (state === 'skipped' || state === 'cancelled' || state === 'interrupted') return false;
    if (edge.kind === 'artifact') return true;
    const route = this.results.get(edge.source)?.route;
    return route === undefined || edge.sourcePort === route;
  }
  private readiness(node: WorkflowNode): 'ready' | 'wait' | 'skip' {
    if (node.kind === 'start') return 'ready';
    const incoming = this.graph.edges.filter((edge) => edge.target === node.id && edge.kind !== 'loop');
    const controls = incoming.filter((edge) => edge.kind === 'control');
    const selected = incoming.filter((edge) => this.edgeActive(edge) === true);
    const unsettled = incoming.some((edge) => this.edgeActive(edge) === undefined);
    const requiredArtifacts = incoming.filter((edge) => edge.kind === 'artifact' &&
      node.ports.some((port) => port.id === edge.targetPort && port.required));
    if (requiredArtifacts.some((edge) => this.edgeActive(edge) === undefined)) return 'wait';
    if (requiredArtifacts.some((edge) => this.run.nodeStates[edge.source] !== 'succeeded')) return 'skip';
    if (node.kind === 'join' && node.config.mode === 'first_success') {
      const artifacts = incoming.filter((edge) => edge.kind === 'artifact');
      if (artifacts.some((edge) => this.edgeActive(edge) === undefined)) return 'wait';
      if (artifacts.some((edge) => this.run.nodeStates[edge.source] !== 'succeeded')) return 'skip';
      if (selected.some((edge) => edge.kind === 'control' && this.run.nodeStates[edge.source] === 'succeeded')) return 'ready';
      return unsettled ? 'wait' : 'skip';
    }
    if (unsettled) return 'wait';
    if (!controls.some((edge) => this.edgeActive(edge))) return 'skip';
    if (node.kind === 'quality_gate' || node.kind === 'condition' || (node.kind === 'join' && node.config.mode === 'all_settled')) return 'ready';
    return selected.every((edge) => this.run.nodeStates[edge.source] === 'succeeded') ? 'ready' : 'skip';
  }
  private failureHandled(nodeId: string): boolean {
    return this.graph.edges.some((edge) => {
      if (edge.source !== nodeId || edge.kind === 'loop' || this.edgeActive(edge) !== true || this.run.nodeStates[edge.target] !== 'succeeded') return false;
      const target = this.graph.nodes.find((node) => node.id === edge.target)!;
      return target.kind === 'condition' || target.kind === 'quality_gate' ||
        (target.kind === 'join' && target.config.mode !== 'all_success');
    });
  }
  private inputs(nodeId: string): Record<string, NodeResult> {
    const ancestors = descendants(nodeId, this.graph.edges.filter((edge) => edge.kind !== 'loop').map((edge) => ({ ...edge, source: edge.target, target: edge.source })));
    return clone({
      ...this.loopFeedback.get(nodeId),
      ...Object.fromEntries([...this.results].filter(([key]) => ancestors.has(key) && key !== nodeId)),
    });
  }

  private async runNode(node: WorkflowNode): Promise<void> {
    await this.emit('node.state', { state: 'ready' }, node.id);
    let final: NodeResult = { status: 'failed', error: 'No attempt completed.' };
    for (let retry = 1; retry <= node.retry.maxAttempts; retry++) {
      while (this.paused && !this.cancelled && !this.fatalError) {
        await new Promise<void>((resolve) => {
          const wake = () => { this.controlWaiters.delete(wake); resolve(); };
          this.controlWaiters.add(wake);
        });
      }
      if (this.cancelled || this.fatalError) return;
      if (this.run.attempts.length >= this.graph.settings.maxTotalAttempts) {
        this.fatalError = `Workflow reached the limit of ${this.graph.settings.maxTotalAttempts} node attempts.`;
        this.notify();
        return;
      }
      const controller = new AbortController();
      this.controllers.set(node.id, controller);
      const attempt: NodeAttempt = {
        id: id(), runId: this.run.id, nodeId: node.id,
        iteration: this.iterations.get(node.id)!, attemptIndex: this.run.attempts.filter((item) => item.nodeId === node.id).length + 1,
        state: 'running', startedAt: now(),
        ...(node.kind === 'agent' ? { provider: node.config.provider, ...(node.config.model ? { model: node.config.model } : {}) } : {}),
      };
      this.run.attempts.push(attempt);
      await this.setState(node.id, 'running');
      await this.emit('node.started', { attempt }, node.id, attempt.id);
      const timer = setTimeout(() => controller.abort(new Error(`Node exceeded ${node.timeoutMs} ms.`)), node.timeoutMs);
      const context: ExecutionContext = {
        runId: this.run.id, node: clone(node), attempt,
        inputs: this.inputs(node.id), signal: controller.signal,
        emit: (kind, payload) => {
          // Late subprocess chunks must not append events after the attempt ends.
          if (controller.signal.aborted) return Promise.resolve();
          return this.emit(kind, payload, node.id, attempt.id);
        },
      };
      let abortListener: (() => void) | undefined;
      try {
        if (controller.signal.aborted || this.cancelled || this.fatalError) throw controller.signal.reason ?? new Error('Run stopped');
        final = await Promise.race([
          node.disabled ? Promise.resolve({ status: 'succeeded' as const, output: { disabled: true } }) : this.executeNode(context),
          new Promise<never>((_, reject) => {
            abortListener = () => reject(controller.signal.reason ?? new Error('Aborted'));
            controller.signal.addEventListener('abort', abortListener, { once: true });
            if (controller.signal.aborted) abortListener();
          }),
        ]);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!final || !['succeeded', 'failed'].includes(final.status)) throw new Error('Executor returned an invalid result.');
      } catch (error) {
        final = { status: 'failed', error: message(error) };
      } finally {
        clearTimeout(timer);
        if (abortListener) controller.signal.removeEventListener('abort', abortListener);
        this.controllers.delete(node.id);
        this.approvals.delete(node.id);
      }
      attempt.state = this.cancelled ? 'cancelled' : final.status;
      attempt.finishedAt = now();
      if (final.error) attempt.error = final.error;
      if (final.output !== undefined) attempt.output = clone(final.output);
      this.results.set(node.id, clone(final));
      const willRetry = !this.cancelled && !this.fatalError && final.status === 'failed' && retry < node.retry.maxAttempts;
      await this.setState(node.id, willRetry ? 'ready' : attempt.state);
      await this.emit('node.completed', { attempt, result: final }, node.id, attempt.id);
      if (this.cancelled || this.fatalError || final.status === 'succeeded') break;
      if (retry < node.retry.maxAttempts) {
        await this.emit('node.retry', { nextAttempt: attempt.attemptIndex + 1, delayMs: node.retry.delayMs }, node.id);
        if (node.retry.delayMs) await this.retryDelay(node.retry.delayMs);
      }
    }
    if (!this.cancelled && !this.fatalError && node.kind === 'quality_gate' && final.route === 'fail') {
      const loop = this.graph.edges.find((edge) => edge.source === node.id && edge.kind === 'loop');
      if (loop && this.iterations.get(node.id)! < node.config.maxIterations) {
        const region = loopRegion(this.graph, loop);
        const iteration = this.iterations.get(node.id)! + 1;
        this.loopFeedback.set(loop.target, clone(Object.fromEntries([...this.results].filter(([nodeId]) => region.has(nodeId)))));
        for (const nodeId of region) {
          this.iterations.set(nodeId, iteration);
          this.results.delete(nodeId);
          this.run.nodeStates[nodeId] = 'pending';
        }
        for (const nodeId of region) await this.emit('node.state', { state: 'pending' }, nodeId);
        await this.emit('loop.iteration', { iteration, maxIterations: node.config.maxIterations, target: loop.target }, node.id);
      } else if (loop) {
        await this.setState(node.id, 'failed');
        const error = `Quality loop reached its limit of ${node.config.maxIterations} iterations.`;
        this.results.set(node.id, { ...final, status: 'failed', error, route: undefined });
        const attempt = this.run.attempts.findLast((item) => item.nodeId === node.id)!;
        attempt.state = 'failed';
        attempt.error = error;
        this.fatalError = error;
        await this.emit('loop.exhausted', { iteration: this.iterations.get(node.id), error, attempt }, node.id, attempt.id);
      }
    }
  }

  private async retryDelay(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.controlWaiters.delete(interrupt);
        resolve();
      };
      const interrupt = () => { if (this.cancelled || this.fatalError) finish(); };
      const timer = setTimeout(finish, delayMs);
      this.controlWaiters.add(interrupt);
      interrupt();
    });
  }

  private async executeNode(context: ExecutionContext): Promise<NodeResult> {
    const { node } = context;
    if (['start', 'end', 'parallel', 'join'].includes(node.kind)) {
      return { status: 'succeeded', output: { completed: true } };
    }
    if (node.kind === 'approval') {
      const approved = await this.waitForApproval(context, node.config.message);
      return { status: approved ? 'succeeded' : 'failed', output: { approved }, ...(approved ? {} : { error: 'Approval rejected.' }) };
    }
    if (node.kind === 'condition' || node.kind === 'quality_gate') {
      const sourceNodeId = node.config.predicate.sourceNodeId ||
        this.graph.edges.find((edge) => edge.target === node.id && edge.kind !== 'loop')?.source;
      const source = sourceNodeId ? context.inputs[sourceNodeId] : undefined;
      const evaluated = evaluatePredicate(node.config.predicate, source?.output);
      if (node.kind === 'condition') {
        if (evaluated === undefined) return { status: 'failed', error: `Condition field "${node.config.predicate.field}" is missing or incompatible.` };
        return { status: 'succeeded', route: String(evaluated), output: { value: evaluated } };
      }
      const verdict = source?.status === 'failed' ? 'fail' : evaluated === undefined ? 'inconclusive' : evaluated ? 'pass' : 'fail';
      const evidenceArtifact = source?.artifacts?.find((artifact) => ['test_result', 'log', 'json'].includes(artifact.kind));
      const output: QualityVerdict = {
        verdict,
        checks: evaluated === undefined ? [] : [{
          id: `${node.config.predicate.sourceNodeId || 'upstream'}:${node.config.predicate.field}`,
          status: verdict === 'pass' ? 'pass' : 'fail',
          ...(evidenceArtifact ? { evidenceArtifactId: evidenceArtifact.id } : {}),
        }],
        defects: verdict === 'pass' ? [] : [{
          severity: 'high', summary: source?.error ?? `Acceptance check returned ${verdict}.`,
          ...(evidenceArtifact ? { evidenceArtifactId: evidenceArtifact.id } : {}),
        }],
        nextInstructions: verdict === 'pass' ? '' : 'Inspect the upstream output and correct the failing acceptance check.',
        iteration: this.iterations.get(node.id)!, maxIterations: node.config.maxIterations,
      };
      if (verdict === 'inconclusive' && node.config.inconclusive === 'approval') {
        const approved = await this.waitForApproval(context, 'The quality check is inconclusive. Continue through the inconclusive branch?');
        if (!approved) return { status: 'failed', output, error: 'Inconclusive quality result rejected.' };
      }
      const hasExit = this.graph.edges.some((edge) => edge.source === node.id && edge.sourcePort === verdict);
      const loopExhausted = verdict === 'fail' &&
        this.graph.edges.some((edge) => edge.source === node.id && edge.kind === 'loop') &&
        this.iterations.get(node.id)! >= node.config.maxIterations;
      if (loopExhausted) {
        return { status: 'failed', route: verdict, output, error: `Quality loop reached its limit of ${node.config.maxIterations} iterations.` };
      }
      return {
        status: verdict === 'pass' || hasExit ? 'succeeded' : 'failed', route: verdict, output,
        ...(!hasExit && verdict !== 'pass' ? { error: `Quality check is ${verdict}; no configured handling path.` } : {}),
      };
    }
    return this.options.execute(context);
  }

  private async waitForApproval(context: ExecutionContext, prompt: string): Promise<boolean> {
    const request: ApprovalRequest = {
      id: id(), runId: this.run.id, nodeId: context.node.id, message: prompt,
      decision: 'pending', requestedAt: now(), scope: { attemptId: context.attempt.id },
    };
    let abortApproval: (() => void) | undefined;
    const response = new Promise<boolean>((resolve) => {
      this.approvals.set(context.node.id, resolve);
      abortApproval = () => {
        this.approvals.delete(context.node.id);
        resolve(false);
      };
      context.signal.addEventListener('abort', abortApproval, { once: true });
      if (context.signal.aborted) abortApproval();
    });
    context.attempt.state = 'waiting_approval';
    await this.setState(context.node.id, 'waiting_approval');
    if (!this.paused) {
      this.run.status = 'waiting_approval';
      await this.emit('run.status', { status: 'waiting_approval' });
    }
    await this.emit('approval.requested', request, context.node.id, context.attempt.id);
    const approved = await response;
    if (abortApproval) context.signal.removeEventListener('abort', abortApproval);
    await this.emit('approval.resolved', { ...request, decision: approved ? 'approved' : 'rejected', resolvedAt: now() }, context.node.id, context.attempt.id);
    if (!this.paused && !this.cancelled && !this.fatalError && !context.signal.aborted && !this.approvals.size) {
      this.run.status = 'running';
      await this.emit('run.status', { status: 'running' });
    }
    if (!context.signal.aborted) context.attempt.state = 'running';
    return approved;
  }
}

/** Restart recovery never guesses whether an external side effect completed. */
export function markInterrupted(input: WorkflowRun): WorkflowRun {
  const run = clone(input);
  if (['queued', 'running', 'paused', 'waiting_approval'].includes(run.status)) {
    run.status = 'interrupted';
    run.error = 'The runtime stopped before completion. Review side effects before starting a new run.';
    for (const attempt of run.attempts) {
      if (['ready', 'running', 'waiting_approval'].includes(attempt.state)) attempt.state = 'interrupted';
    }
    for (const [nodeId, state] of Object.entries(run.nodeStates)) {
      if (['ready', 'running', 'waiting_approval'].includes(state)) run.nodeStates[nodeId] = 'interrupted';
    }
  }
  return run;
}
