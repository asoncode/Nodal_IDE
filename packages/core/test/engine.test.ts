import { describe, expect, it } from 'vitest';
import { createNode, GraphSchema, type ExecutionEvent, type Graph, type WorkflowEdge, type WorkflowNode } from '../../shared/src/index.js';
import { evaluatePredicate, markInterrupted, WorkflowEngine, type ExecutionContext, type NodeResult } from '../src/engine.js';
import { createCommandGraph, templates } from '../src/templates.js';
import { validateGraph } from '../src/validation.js';

const ok = (output: unknown = { exitCode: 0 }): NodeResult => ({ status: 'succeeded', output });
const fail = (output: unknown = { exitCode: 1 }): NodeResult => ({ status: 'failed', output, error: 'Check failed' });
function edge(source: string, target: string, sourcePort?: string, kind: WorkflowEdge['kind'] = 'control'): WorkflowEdge {
  return { id: `${source}-${target}-${sourcePort ?? 'out'}`, source, target, sourcePort, kind };
}
function graph(nodes: WorkflowNode[], edges: WorkflowEdge[], settings?: Partial<Graph['settings']>): Graph {
  return GraphSchema.parse({ id: 'test', name: 'Test', nodes, edges, settings });
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function parallel(mode: 'all_success' | 'all_settled' | 'first_success' = 'all_success'): Graph {
  const join = createNode('join', 'join');
  if (join.kind === 'join') join.config.mode = mode;
  return graph([
    createNode('start', 'start'), createNode('parallel', 'split'), createNode('command', 'a'),
    createNode('command', 'b'), join, createNode('command', 'after'), createNode('end', 'end'),
  ], [
    edge('start', 'split'), edge('split', 'a'), edge('split', 'b'),
    edge('a', 'join'), edge('b', 'join'), edge('join', 'after'), edge('after', 'end'),
  ]);
}
function qualityLoop(maxIterations = 3): Graph {
  const quality = createNode('quality_gate', 'gate');
  if (quality.kind === 'quality_gate') {
    quality.config.maxIterations = maxIterations;
    quality.config.predicate.sourceNodeId = 'tests';
  }
  return graph([
    createNode('start', 'start'), createNode('agent', 'fix'), createNode('command', 'tests'),
    quality, createNode('end', 'end'),
  ], [edge('start', 'fix'), edge('fix', 'tests'), edge('tests', 'gate'), edge('gate', 'fix', 'fail', 'loop'), edge('gate', 'end', 'pass')]);
}

describe('graph validation', () => {
  it('accepts every editable shipped template and normalizes defaults', () => {
    for (const template of templates) expect(validateGraph(template).errors).toEqual([]);
    expect(createNode('command', 'c').config).toMatchObject({ requireApproval: true });
  });
  it('rejects arbitrary cycles, dangling edges, missing inputs, and malformed branches', () => {
    const input = createCommandGraph();
    input.edges.push(edge('command', 'start'), edge('missing', 'end'));
    const codes = validateGraph(input).errors.map((item) => item.code);
    expect(codes).toContain('cycle');
    expect(codes).toContain('dangling_edge');
    const disconnected = createCommandGraph();
    disconnected.nodes.push(createNode('command', 'orphan'));
    expect(validateGraph(disconnected).errors.map((item) => item.code)).toContain('unreachable');
    const branch = createCommandGraph();
    branch.nodes[1] = createNode('condition', 'command');
    expect(validateGraph(branch).errors.map((item) => item.code)).toContain('condition_port');
  });
  it('rejects incompatible and unconnected required artifact ports', () => {
    const input = createCommandGraph();
    input.nodes[0]!.ports.push({ id: 'out', direction: 'output', kind: 'artifact', required: false, dataType: 'text' });
    input.nodes[1]!.ports.push({ id: 'in', direction: 'input', kind: 'artifact', required: true, dataType: 'diff' });
    expect(validateGraph(input).errors.map((item) => item.code)).toContain('required_port');
    input.edges.push({ ...edge('start', 'command', 'out', 'artifact'), targetPort: 'in' });
    expect(validateGraph(input).errors.map((item) => item.code)).toContain('port_type');
  });
  it('rejects loop targets that are not ancestors and escaping loop branches', () => {
    const input = qualityLoop();
    input.edges.push(edge('fix', 'end'));
    expect(validateGraph(input).errors.map((item) => item.code)).toContain('loop_escape');
    input.edges.find((item) => item.kind === 'loop')!.target = 'end';
    expect(validateGraph(input).errors.map((item) => item.code)).toContain('loop_target');
  });
  it('evaluates data predicates without evaluating code or reading prototypes', () => {
    expect(evaluatePredicate({ sourceNodeId: 'x', field: 'tests.failed', operator: 'eq', value: 0 }, { tests: { failed: 0 } })).toBe(true);
    expect(evaluatePredicate({ sourceNodeId: 'x', field: '__proto__.x', operator: 'exists', value: 0 }, {})).toBe(false);
    expect(evaluatePredicate({ sourceNodeId: 'x', field: 'code', operator: 'gte', value: 0 }, { code: '0' })).toBeUndefined();
  });
});

describe('scheduler execution', () => {
  it('pins its graph snapshot, orders dependencies, and persists monotonic events', async () => {
    const input = createCommandGraph();
    const events: ExecutionEvent[] = [];
    const calls: string[] = [];
    const engine = new WorkflowEngine(input, {
      execute: async (ctx) => {
        expect(ctx.inputs.start).toBeDefined();
        expect(events.some((event) => event.kind === 'node.started' && event.nodeId === ctx.node.id)).toBe(true);
        calls.push(ctx.node.id);
        return ok();
      },
      onEvent: async (event) => { events.push(event); },
    });
    input.nodes[1]!.label = 'changed draft';
    const result = await engine.start();
    expect(result.status).toBe('succeeded');
    expect(calls).toEqual(['command']);
    expect(engine.graph.nodes[1]!.label).toBe('Node version');
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(result.attempts.every((attempt) => attempt.finishedAt)).toBe(true);
    const detached = engine.getSnapshot();
    detached.nodeStates.command = 'failed';
    expect(engine.getSnapshot().nodeStates.command).toBe('succeeded');
  });
  it('selects one conditional route and skips the other without blocking End', async () => {
    const condition = createNode('condition', 'condition');
    if (condition.kind === 'condition') condition.config.predicate.sourceNodeId = 'check';
    const input = graph([
      createNode('start', 'start'), createNode('command', 'check'), condition,
      createNode('command', 'yes'), createNode('command', 'no'), createNode('end', 'end'),
    ], [edge('start', 'check'), edge('check', 'condition'), edge('condition', 'yes', 'true'), edge('condition', 'no', 'false'), edge('yes', 'end'), edge('no', 'end')]);
    const calls: string[] = [];
    const run = await new WorkflowEngine(input, { execute: async ({ node }) => { calls.push(node.id); return ok(); } }).start();
    expect(run.status).toBe('succeeded');
    expect(calls).toEqual(['check', 'yes']);
    expect(run.nodeStates.no).toBe('skipped');
  });
  it('starts independent nodes concurrently, respecting the split cap', async () => {
    for (const cap of [1, 2]) {
      const input = parallel();
      const split = input.nodes.find((node) => node.kind === 'parallel')!;
      if (split.kind === 'parallel') split.config.maxConcurrency = cap;
      let active = 0;
      let peak = 0;
      const run = await new WorkflowEngine(input, { execute: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return ok();
      } }).start();
      expect(run.status).toBe('succeeded');
      expect(peak).toBe(cap);
    }
  });
  it('all_success blocks a failed branch; all_settled can explicitly handle it', async () => {
    for (const mode of ['all_success', 'all_settled'] as const) {
      const run = await new WorkflowEngine(parallel(mode), { execute: async ({ node }) => node.id === 'b' ? fail() : ok() }).start();
      expect(run.status).toBe(mode === 'all_success' ? 'failed' : 'succeeded');
      expect(run.nodeStates.after).toBe(mode === 'all_success' ? 'skipped' : 'succeeded');
    }
  });
  it('first_success proceeds early and lets the remaining branch settle', async () => {
    const release = deferred();
    const continued = deferred();
    const engine = new WorkflowEngine(parallel('first_success'), { execute: async ({ node }) => {
      if (node.id === 'b') await release.promise;
      if (node.id === 'after') continued.resolve();
      return node.id === 'b' ? fail() : ok();
    } });
    const running = engine.start();
    await continued.promise;
    expect(engine.getSnapshot().nodeStates.b).toBe('running');
    release.resolve();
    expect((await running).status).toBe('succeeded');
  });
  it('retains retry attempts without releasing dependents before the retry succeeds', async () => {
    const input = createCommandGraph();
    input.nodes[1]!.retry = { maxAttempts: 2, delayMs: 5 };
    let attempts = 0;
    const engine = new WorkflowEngine(input, { execute: async () => ++attempts === 1 ? fail() : ok() });
    const run = await engine.start();
    expect(run.status).toBe('succeeded');
    expect(run.attempts.filter((attempt) => attempt.nodeId === 'command').map((attempt) => attempt.state)).toEqual(['failed', 'succeeded']);
    expect(run.nodeStates.end).toBe('succeeded');
  });
  it('passes failed machine evidence into the next bounded quality iteration', async () => {
    const contexts: ExecutionContext[] = [];
    const run = await new WorkflowEngine(qualityLoop(), {
      execute: async (ctx) => {
        contexts.push(ctx);
        return ctx.node.id === 'tests' && ctx.attempt.iteration === 1 ? fail({ exitCode: 1, stderr: 'Expected 2, received 3' }) : ok();
      },
    }).start();
    expect(run.status).toBe('succeeded');
    expect(run.attempts.filter((attempt) => attempt.nodeId === 'tests').map((attempt) => attempt.state)).toEqual(['failed', 'succeeded']);
    expect(contexts.find((ctx) => ctx.node.id === 'fix' && ctx.attempt.iteration === 2)?.inputs.tests?.output).toMatchObject({ stderr: 'Expected 2, received 3' });
    expect(contexts.find((ctx) => ctx.node.id === 'fix' && ctx.attempt.iteration === 2)?.inputs.gate?.output).toMatchObject({ verdict: 'fail', iteration: 1 });
  });
  it('fails on loop exhaustion and records the final failed gate attempt', async () => {
    const persistedAttempts: ExecutionEvent[] = [];
    const run = await new WorkflowEngine(qualityLoop(2), {
      execute: async ({ node }) => node.id === 'tests' ? fail() : ok(),
      onEvent: (event) => { if (event.kind === 'node.completed' && event.nodeId === 'gate') persistedAttempts.push(event); },
    }).start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('limit of 2');
    expect(run.attempts.filter((attempt) => attempt.nodeId === 'fix')).toHaveLength(2);
    expect(run.attempts.filter((attempt) => attempt.nodeId === 'gate').at(-1)?.state).toBe('failed');
    expect(persistedAttempts.at(-1)?.payload).toMatchObject({ attempt: { state: 'failed' } });
    expect(run.nodeStates.end).not.toBe('succeeded');
  });
  it('does not let a matching output override failed required machine execution', async () => {
    const run = await new WorkflowEngine(qualityLoop(1), { execute: async ({ node }) => node.id === 'tests' ? fail({ exitCode: 0 }) : ok() }).start();
    expect(run.status).toBe('failed');
    expect(run.attempts.find((attempt) => attempt.nodeId === 'gate')?.output).toMatchObject({ verdict: 'fail' });
  });
  it('enforces a total attempt budget including structural nodes', async () => {
    const input = createCommandGraph();
    input.settings.maxTotalAttempts = 2;
    const run = await new WorkflowEngine(input, { execute: async () => ok() }).start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('limit of 2 node attempts');
    expect(run.attempts).toHaveLength(2);
  });
});

describe('run control and failure boundaries', () => {
  it('pauses at a safe boundary and resumes pending work', async () => {
    const input = createCommandGraph();
    const started = deferred();
    const release = deferred();
    const completed = deferred();
    const engine = new WorkflowEngine(input, {
      execute: async () => { started.resolve(); await release.promise; return ok(); },
      onEvent: (event) => { if (event.kind === 'node.completed' && event.nodeId === 'command') completed.resolve(); },
    });
    const running = engine.start();
    await started.promise;
    await engine.pause();
    release.resolve();
    await completed.promise;
    expect(engine.getSnapshot().status).toBe('paused');
    expect(engine.getSnapshot().nodeStates.end).toBe('pending');
    await engine.resume();
    expect((await running).status).toBe('succeeded');
  });
  it('cancels active callbacks and never starts downstream nodes', async () => {
    const started = deferred();
    let signal: AbortSignal | undefined;
    const engine = new WorkflowEngine(createCommandGraph(), { execute: async (ctx) => {
      signal = ctx.signal;
      started.resolve();
      return new Promise<NodeResult>(() => {});
    } });
    const running = engine.start();
    await started.promise;
    await engine.cancel();
    const run = await running;
    expect(signal?.aborted).toBe(true);
    expect(run.status).toBe('cancelled');
    expect(run.attempts.some((attempt) => attempt.nodeId === 'end')).toBe(false);
  });
  it('cancels promptly during retry delay and never creates a second attempt', async () => {
    const input = createCommandGraph();
    input.nodes[1]!.retry = { maxAttempts: 2, delayMs: 60_000 };
    const retrying = deferred();
    const engine = new WorkflowEngine(input, {
      execute: async () => fail(),
      onEvent: (event) => { if (event.kind === 'node.retry') retrying.resolve(); },
    });
    const running = engine.start();
    await retrying.promise;
    await engine.cancel();
    const run = await running;
    expect(run.status).toBe('cancelled');
    expect(run.attempts.filter((attempt) => attempt.nodeId === 'command')).toHaveLength(1);
  });
  it('times out an uncooperative callback and records failure, never success', async () => {
    const input = createCommandGraph();
    input.nodes[1]!.timeoutMs = 10;
    const run = await new WorkflowEngine(input, { execute: async () => new Promise<NodeResult>(() => {}) }).start();
    expect(run.status).toBe('failed');
    expect(run.attempts.find((attempt) => attempt.nodeId === 'command')?.error).toContain('exceeded 10 ms');
  });
  it('enforces the whole-run wall time limit', async () => {
    const input = createCommandGraph();
    input.settings.timeoutMs = 100;
    const run = await new WorkflowEngine(input, { execute: async () => new Promise<NodeResult>(() => {}) }).start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Workflow exceeded 100 ms');
    expect(run.nodeStates.end).toBe('cancelled');
  });
  it('pauses retries as well as downstream scheduling', async () => {
    const input = createCommandGraph();
    input.nodes[1]!.retry.maxAttempts = 2;
    const retrying = deferred();
    let calls = 0;
    const engine = new WorkflowEngine(input, {
      execute: async () => ++calls === 1 ? fail() : ok(),
      onEvent: (event) => { if (event.kind === 'node.retry') retrying.resolve(); },
    });
    const running = engine.start();
    await retrying.promise;
    await engine.pause();
    expect(calls).toBe(1);
    await engine.resume();
    expect((await running).status).toBe('succeeded');
    expect(calls).toBe(2);
  });
  it('durably requests approval before allowing continuation and records rejection', async () => {
    for (const approved of [true, false]) {
      const input = graph([createNode('start', 'start'), createNode('approval', 'approval'), createNode('end', 'end')], [edge('start', 'approval'), edge('approval', 'end')]);
      const requested = deferred();
      const events: ExecutionEvent[] = [];
      const engine = new WorkflowEngine(input, {
        execute: async () => ok(),
        onEvent: (event) => { events.push(event); if (event.kind === 'approval.requested') requested.resolve(); },
      });
      const running = engine.start();
      await requested.promise;
      expect(engine.getSnapshot().nodeStates.approval).toBe('waiting_approval');
      expect(engine.getSnapshot().nodeStates.end).toBe('pending');
      expect(engine.approve('approval', approved)).toBe(true);
      expect(engine.approve('approval', approved)).toBe(false);
      expect((await running).status).toBe(approved ? 'succeeded' : 'failed');
      expect(events.some((event) => event.kind === 'approval.resolved')).toBe(true);
    }
  });
  it('resolves a cancelled approval without leaving its attempt running', async () => {
    const input = graph([createNode('start', 'start'), createNode('approval', 'approval'), createNode('end', 'end')], [edge('start', 'approval'), edge('approval', 'end')]);
    const requested = deferred();
    const events: ExecutionEvent[] = [];
    const engine = new WorkflowEngine(input, {
      execute: async () => ok(),
      onEvent: (event) => { events.push(event); if (event.kind === 'approval.requested') requested.resolve(); },
    });
    const running = engine.start();
    await requested.promise;
    await engine.cancel();
    const run = await running;
    expect(run.status).toBe('cancelled');
    expect(run.attempts.find((attempt) => attempt.nodeId === 'approval')?.state).toBe('cancelled');
    expect(events.find((event) => event.kind === 'approval.resolved')?.payload).toMatchObject({ decision: 'rejected' });
    expect(engine.approve('approval', true)).toBe(false);
  });
  it('refuses to execute when the durable event sink fails', async () => {
    let calls = 0;
    const run = await new WorkflowEngine(createCommandGraph(), {
      execute: async () => { calls++; return ok(); },
      onEvent: () => { throw new Error('Disk full'); },
    }).start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Disk full');
    expect(calls).toBe(0);
  });
  it('marks interrupted external attempts without replaying side effects', async () => {
    const initial = new WorkflowEngine(createCommandGraph(), { execute: async () => ok() }).getSnapshot();
    initial.status = 'running';
    initial.nodeStates.command = 'running';
    initial.attempts.push({
      id: 'attempt', runId: initial.id, nodeId: 'command', state: 'running',
      startedAt: new Date().toISOString(), iteration: 1, attemptIndex: 1,
    });
    const recovered = markInterrupted(initial);
    expect(recovered.status).toBe('interrupted');
    expect(recovered.nodeStates.command).toBe('interrupted');
    expect(recovered.attempts[0]?.state).toBe('interrupted');
    expect(initial.status).toBe('running');
  });
});
