import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphSchema, type Graph } from '../../shared/src/index.js';
import { Store } from '../../persistence/src/index.js';
import { git } from '../../workspace/src/index.js';
import { NodalService } from '../src/service.js';
import { Supervisor, applyChanges } from '../src/orchestrator.js';
const { runProvider, checkAvailability } = vi.hoisted(() => ({ runProvider: vi.fn(), checkAvailability: vi.fn() }));
vi.mock('../../providers/src/index.js', () => ({ runProvider, checkAvailability }));

let root: string, data: string, store: Store, service: NodalService, projectId: string, counter: string;
beforeEach(async () => {
  runProvider.mockReset(); checkAvailability.mockResolvedValue({ id: 'claude', available: true, authentication: 'authenticated', message: 'Signed in.' });
  root = await mkdtemp(join(tmpdir(), 'nodal-orchestrator-')); data = await mkdtemp(join(tmpdir(), 'nodal-orchestrator-data-')); counter = join(data, 'count.txt');
  await git(root, ['init']); await mkdir(join(root, 'src')); await writeFile(join(root, 'src/index.ts'), 'export {};');
  for (const args of [['add', '-A'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']]) { const result = await git(root, args); if (result.exitCode !== 0) throw new Error(result.stderr); }
  store = new Store(':memory:'); projectId = store.addProject(root, 'Orchestrator').id; service = new NodalService(store, data);
  vi.spyOn(service as any, 'permission').mockResolvedValue(true);
});
afterEach(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); });

function loop(test: string, maxIterations: number): Graph {
  return GraphSchema.parse({ id: 'flow', name: 'test loop', nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    { id: 'tests', kind: 'command', label: 'Unit tests', config: { command: process.execPath, args: ['-e', test] } },
    { id: 'gate', kind: 'quality_gate', label: 'Test gate', config: { predicate: { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations } },
    { id: 'end', kind: 'end', label: 'End' },
  ], edges: [{ id: '1', source: 'start', target: 'tests' }, { id: '2', source: 'tests', target: 'gate' }, { id: '3', source: 'gate', target: 'end', sourcePort: 'pass' }, { id: '4', source: 'gate', target: 'tests', kind: 'loop', sourcePort: 'fail' }] });
}
const finish = async (graph: Graph) => { const run = await service.startRun(projectId, graph); await (service as any).tasks.get(run.id); return store.run(run.id); };
const failing = (message: string) => `console.error(${JSON.stringify(message)} + ' after ' + Date.now() + 'ms'); process.exit(1)`;

describe('run supervision', () => {
  it('pauses with an explanation when a looping gate fails twice with the same evidence', async () => {
    const run = await service.startRun(projectId, loop(failing('AssertionError: seeds differ'), 5));
    await vi.waitFor(() => expect(store.run(run.id).status).toBe('paused'), { timeout: 10_000 });
    const escalation = store.eventsByKind(run.id, ['orchestrator.escalation'])[0]!;
    expect(escalation).toMatchObject({ nodeId: 'gate', payload: { reason: 'repeated_failure' } });
    expect(store.attempts(run.id).filter(attempt => attempt.nodeId === 'tests')).toHaveLength(2);
    await service.dispatch('cancel', { runId: run.id }); await (service as any).tasks.get(run.id);
  });
  it('does not pause while each failure differs, and warns once at 80% of the attempt budget', () => {
    const graph = loop('', 5); graph.settings.maxTotalAttempts = 10;
    const pause = vi.fn(), record = vi.fn();
    const supervisor = new Supervisor(graph, { pause, record });
    const event = (kind: string, payload: unknown, nodeId?: string) => supervisor.observe({ eventId: 'e', runId: 'r', sequence: 1, timestamp: 'now', kind, payload, ...(nodeId ? { nodeId } : {}) });
    for (const [index, message] of ['first failure', 'second failure'].entries()) {
      event('node.completed', { attempt: { nodeId: 'tests' }, result: { status: 'failed', output: { stderr: message } } });
      event('node.completed', { attempt: { nodeId: 'gate' }, result: { status: 'succeeded', route: 'fail' } }, 'gate');
      expect(pause).toHaveBeenCalledTimes(0); expect(index).toBeLessThan(2);
    }
    for (let i = 0; i < 9; i++) event('node.started', { attempt: { nodeId: 'tests' } });
    expect(record).toHaveBeenCalledWith('orchestrator.escalation', expect.objectContaining({ reason: 'budget' }), undefined);
    expect(pause).toHaveBeenCalledTimes(1);
  });
  it('writes a run summary when a run finishes', async () => {
    const run = await finish(loop('process.exit(0)', 2));
    expect(store.eventsByKind(run.id, ['orchestrator.summary'])[0]!.payload).toMatchObject({ text: expect.stringContaining('Run succeeded. 4 attempts.') });
  });
});

describe('measured self-improvement', () => {
  it('proposes from repeated evidence, applies as a new revision with a lesson, compares, and reverts exactly', async () => {
    const saved = store.saveGraph(projectId, loop(failing('timeout waiting for simulator'), 1));
    await finish(saved); await finish(saved);
    const insights = await service.dispatch('workflowInsights', { projectId, graphId: saved.id }) as { metrics: { runs: number; steps: { nodeId: string; loopExhausted: number }[] }; proposals: { id: string; title: string; changes: unknown[]; evidence: { count: number }; status: string }[] };
    expect(insights.metrics.runs).toBe(2);
    expect(insights.metrics.steps.find(step => step.nodeId === 'gate')!.loopExhausted).toBe(2);
    const proposal = insights.proposals.find(item => item.title === 'Allow one more iteration for Test gate')!;
    expect(proposal).toMatchObject({ status: 'open', evidence: { count: 2 }, changes: [{ nodeId: 'gate', field: 'config.maxIterations', from: 1, to: 2 }] });
    expect((await service.dispatch('workflowInsights', { projectId, graphId: saved.id }) as typeof insights).proposals.filter(item => item.title === proposal.title)).toHaveLength(1);

    const applied = await service.dispatch('applyProposal', { projectId, proposalId: proposal.id }) as Graph;
    expect(applied.revision).toBe(saved.revision + 1);
    expect(applied.nodes.find(node => node.id === 'gate')).toMatchObject({ config: { maxIterations: 2 } });
    expect(store.lessons(projectId)).toEqual([expect.objectContaining({ source: 'proposal', proposalId: proposal.id, text: expect.stringContaining('Allow one more iteration') })]);

    // The second attempt passes on the new revision.
    const flaky = `const fs=require('fs');const f=${JSON.stringify(counter)};const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));process.exit(n%2===0?1:0)`;
    const next = { ...applied, nodes: applied.nodes.map(node => node.id === 'tests' && node.kind === 'command' ? { ...node, config: { ...node.config, args: ['-e', flaky] } } : node) };
    expect((await finish(next)).status).toBe('succeeded'); expect((await finish(next)).status).toBe('succeeded');
    const after = await service.dispatch('workflowInsights', { projectId, graphId: saved.id }) as { proposals: { id: string; comparison?: { recommendation: string; before: { successRate: number }; after: { successRate: number } } }[] };
    expect(after.proposals.find(item => item.id === proposal.id)!.comparison).toMatchObject({ recommendation: 'keep', before: { successRate: 0 }, after: { successRate: 1 } });

    const reverted = await service.dispatch('revertProposal', { projectId, proposalId: proposal.id }) as Graph;
    expect(reverted.revision).toBe(applied.revision + 1);
    expect(reverted.nodes.find(node => node.id === 'gate')).toMatchObject({ config: { maxIterations: 1 } });
    expect(store.proposal(projectId, proposal.id).status).toBe('reverted');
  });
  it('refuses to apply a proposal to a changed workflow', async () => {
    const graph = loop('process.exit(0)', 1);
    const proposal = { id: 'p', projectId, graphId: graph.id, ruleKey: 'k', baseRevision: 1, title: 't', rationale: 'r', evidence: { runIds: [], count: 2 }, changes: [{ nodeId: 'gate', field: 'config.maxIterations', from: 1, to: 2 }], widensScope: false, status: 'open' as const, createdAt: 'now' };
    expect(() => applyChanges({ ...graph, revision: 2 }, proposal)).toThrow('changed since this proposal');
    expect(() => applyChanges(graph, { ...proposal, changes: [{ ...proposal.changes[0]!, from: 7 }] })).toThrow('changed since this proposal');
  });
});

describe('project memory', () => {
  it('sends lessons to role prompts and the planner', async () => {
    await service.dispatch('saveLesson', { projectId, text: 'Seeds must be passed explicitly to every simulator call.' });
    await expect(service.dispatch('saveLesson', { projectId, text: 'API_KEY=sk-ant-abcdefghijklmnopqrstu' })).rejects.toThrow('credentials');
    runProvider.mockImplementation(async input => { await writeFile(join(input.cwd, 'src/sim.ts'), 'export {};'); return { output: 'done', costUsd: null }; });
    const graph = GraphSchema.parse({ id: 'g', name: 'role', nodes: [
      { id: 'start', kind: 'start', label: 'Start' },
      { id: 'impl', kind: 'agent', label: 'Implement', config: { provider: 'codex', permission: 'scoped-edit', instructions: 'Build it.', role: { id: 'impl', title: 'Engineer', expertise: 'Builds.', owns: ['src'] } } },
      { id: 'tests', kind: 'command', label: 'Tests', config: { command: process.execPath, args: ['-e', 'process.exit(0)'] } },
      { id: 'gate', kind: 'quality_gate', label: 'Gate', config: { predicate: { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 1 } },
      { id: 'end', kind: 'end', label: 'End' },
    ], edges: [{ id: '1', source: 'start', target: 'impl' }, { id: '2', source: 'impl', target: 'tests' }, { id: '3', source: 'tests', target: 'gate' }, { id: '4', source: 'gate', target: 'end', sourcePort: 'pass' }] });
    expect((await finish(graph)).status).toBe('succeeded');
    expect(runProvider.mock.calls[0][0].prompt).toContain('[memory]\nProject lessons (kept by the team; code and tests outrank them):\n- Seeds must be passed explicitly');
    runProvider.mockResolvedValueOnce({ output: JSON.stringify(loop('process.exit(0)', 1)) });
    await service.dispatch('generateGraph', { projectId, graph: loop('process.exit(0)', 1), prompt: 'Add a review', provider: 'claude' });
    expect(runProvider.mock.calls.at(-1)![0].prompt).toContain('Seeds must be passed explicitly');
  });
});
