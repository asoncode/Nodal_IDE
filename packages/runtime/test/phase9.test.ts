import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphSchema, type Graph } from '../../shared/src/index.js';
import { Store } from '../../persistence/src/index.js';
import { git } from '../../workspace/src/index.js';
import { NodalService } from '../src/service.js';
import { runTool } from '../src/tools.js';
import { validateGraph } from '../../core/src/validation.js';
const { runProvider } = vi.hoisted(() => ({ runProvider: vi.fn() }));
vi.mock('../../providers/src/index.js', () => ({ runProvider, checkAvailability: vi.fn() }));

let root: string, data: string, store: Store, service: NodalService, projectId: string, head: string;
const commitAll = async (message: string) => {
  for (const args of [['add', '-A'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', message]]) { const result = await git(root, args); if (result.exitCode !== 0) throw new Error(result.stderr); }
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
};
beforeEach(async () => {
  runProvider.mockReset();
  root = await mkdtemp(join(tmpdir(), 'nodal-phase9-')); data = await mkdtemp(join(tmpdir(), 'nodal-phase9-data-'));
  await git(root, ['init']); await mkdir(join(root, 'src')); await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'src/match.ts'), 'export function simulate() { return 1; } // TODO(contract)\n');
  await writeFile(join(root, 'tests/match.test.ts'), "import { simulate } from '../src/match';\n");
  await writeFile(join(root, 'outside.txt'), 'unchanged');
  head = await commitAll('initial');
  store = new Store(':memory:'); projectId = store.addProject(root, 'Phase 9').id; service = new NodalService(store, data);
  vi.spyOn(service as any, 'permission').mockResolvedValue(true);
});
afterEach(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); });
const finish = async (graph: Graph) => { const run = await service.startRun(projectId, graph); await (service as any).tasks.get(run.id); return store.run(run.id); };
const env = (commit = head) => ({ root, commit, baseCommit: head, inputs: {} });

describe('deterministic tool steps', () => {
  it('returns identical, structured results for a commit with no provider call', async () => {
    const search = { tool: 'search' as const, query: 'TODO(contract)', regex: false, caseSensitive: false, paths: [], maxResults: 100 };
    const first = await runTool(search, env()); const again = await runTool(search, env());
    expect(first).toEqual(again); expect(first.output).toMatchObject({ count: 1, files: ['src/match.ts'] });
    expect((await runTool({ tool: 'test-impact', paths: ['src/match.ts'], maxResults: 10 }, env())).output.tests).toEqual([{ path: 'tests/match.test.ts', reasons: ['name matches src/match.ts', 'references match'] }]);
    const symbols = await runTool({ tool: 'symbols', name: 'simulate', paths: [], maxResults: 10 }, env());
    expect(symbols.output).toMatchObject({ method: 'heuristic', definitions: [{ path: 'src/match.ts', name: 'simulate', kind: 'function', line: 1 }] });
    expect((symbols.output.references as unknown[]).length).toBe(2);
    expect(runProvider).not.toHaveBeenCalled();
  });
  it('fails a required validation and passes a valid one', async () => {
    const missing = await runTool({ tool: 'validate', path: 'contracts/api.json', required: true }, env());
    expect(missing).toMatchObject({ status: 'failed', output: { exists: false, valid: false } });
    await mkdir(join(root, 'contracts')); await writeFile(join(root, 'contracts/api.json'), '{"version":1}');
    const next = await commitAll('contract');
    const schema = { type: 'object', required: ['version'], properties: { version: { const: 2 } } };
    expect(await runTool({ tool: 'validate', path: 'contracts/api.json', schema, required: true }, env(next))).toMatchObject({ status: 'failed', output: { exists: true, valid: false } });
    expect(await runTool({ tool: 'validate', path: 'contracts/api.json', schema: { type: 'object' }, required: true }, env(next))).toMatchObject({ status: 'succeeded', output: { valid: true } });
  });
  it('drives a quality gate from a tool result and caches the result for the same commit', async () => {
    const graph = GraphSchema.parse({ id: 'g', name: 'gate on search', nodes: [
      { id: 'start', kind: 'start', label: 'Start' },
      { id: 'scan', kind: 'tool', label: 'Find open contract TODOs', config: { tool: 'search', query: 'TODO(contract)' } },
      { id: 'gate', kind: 'quality_gate', label: 'No open TODOs', config: { predicate: { sourceNodeId: 'scan', field: 'count', operator: 'eq', value: 0 }, maxIterations: 1 } },
      { id: 'end', kind: 'end', label: 'End' },
    ], edges: [{ id: 'a', source: 'start', target: 'scan' }, { id: 'b', source: 'scan', target: 'gate' }, { id: 'c', source: 'gate', target: 'end', sourcePort: 'pass' }] });
    expect(validateGraph(graph).valid).toBe(true);
    const failed = await finish(graph); expect(failed.status).toBe('failed');
    const second = await finish(graph); expect(second.status).toBe('failed');
    const results = [failed, second].map(run => store.events(run.id).find(event => event.kind === 'tool.result')!.payload);
    expect(results).toEqual([expect.objectContaining({ count: 1, cached: false }), expect.objectContaining({ count: 1, cached: true })]);
    await writeFile(join(root, 'src/match.ts'), 'export function simulate() { return 1; }\n'); await commitAll('resolve');
    expect((await finish(graph)).status).toBe('succeeded');
  });
});

const roleNode = (playbookTest: string) => ({
  id: 'sim', kind: 'role', label: 'Simulation engineer', config: {
    role: { id: 'sim', title: 'Simulation engineer', expertise: 'Builds the seeded match simulator.', owns: ['src/**'], produces: [{ name: 'events', path: 'src/events.json', required: true, schema: { type: 'object', required: ['seed'], properties: { seed: { type: 'number' } } } }] },
    playbook: {
      nodes: [
        { id: 'start', kind: 'start', label: 'Start' },
        { id: 'orient', kind: 'tool', label: 'Find simulator code', config: { tool: 'search', query: 'simulate' } },
        { id: 'implement', kind: 'agent', label: 'Implement', config: { provider: 'codex', permission: 'scoped-edit', instructions: 'Implement the simulator.' } },
        { id: 'tests', kind: 'command', label: 'Unit tests', config: { command: process.execPath, args: ['-e', playbookTest] } },
        { id: 'gate', kind: 'quality_gate', label: 'Tests pass', config: { predicate: { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 2 } },
        { id: 'end', kind: 'end', label: 'End' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'orient' }, { id: 'e2', source: 'orient', target: 'implement' }, { id: 'e3', source: 'implement', target: 'tests' },
        { id: 'e4', source: 'tests', target: 'gate' }, { id: 'e5', source: 'gate', target: 'implement', kind: 'loop', sourcePort: 'fail' }, { id: 'e6', source: 'gate', target: 'end', sourcePort: 'pass' },
      ],
    },
  },
});
const teamGraph = (playbookTest = 'process.exit(0)') => GraphSchema.parse({ id: 'team', name: 'role node', nodes: [
  { id: 'start', kind: 'start', label: 'Start' }, roleNode(playbookTest), { id: 'end', kind: 'end', label: 'End' },
], edges: [{ id: 'a', source: 'start', target: 'sim' }, { id: 'b', source: 'sim', target: 'end' }] });

describe('role subgraphs', () => {
  it('runs a playbook as a scoped child and publishes verified work at the role level', async () => {
    runProvider.mockImplementation(async input => { await writeFile(join(input.cwd, 'src/sim.ts'), 'export const seed = 7;'); await writeFile(join(input.cwd, 'src/events.json'), '{"seed":7}'); return { output: 'Implemented simulator', costUsd: null }; });
    const graph = teamGraph(); expect(validateGraph(graph).errors).toEqual([]);
    const run = await finish(graph);
    expect(run.status).toBe('succeeded');
    expect(runProvider.mock.calls[0][0].rolePolicy).toEqual({ owns: ['src/**'], readOnlyPaths: [] });
    expect(runProvider.mock.calls[0][0].prompt).toContain('Role: Simulation engineer');
    const attempts = store.attempts(run.id);
    const role = attempts.find(attempt => attempt.nodeId === 'sim')!;
    expect(attempts.filter(attempt => attempt.parentAttemptId === role.id).map(attempt => attempt.nodeId)).toEqual(expect.arrayContaining(['sim/start', 'sim/orient', 'sim/implement', 'sim/tests', 'sim/gate', 'sim/end']));
    const output = role.output as { head: string; handoffs: { name: string; producerNodeId: string; commit: string }[] };
    expect(output.handoffs).toEqual([expect.objectContaining({ name: 'events', producerNodeId: 'sim', commit: output.head })]);
    expect(store.handoffs(run.id)).toHaveLength(1);
    expect((await git(root, ['show', `${output.head}:src/sim.ts`])).stdout).toBe('export const seed = 7;');
    expect(store.events(run.id).map(event => event.kind)).toEqual(expect.arrayContaining(['role.run.started', 'role.run.completed', 'tool.result', 'handoff.verified']));
  });
  it('loops inside the playbook and stops at its iteration limit', async () => {
    runProvider.mockImplementation(async input => { await writeFile(join(input.cwd, 'src/events.json'), '{"seed":1}'); return { output: 'tried', costUsd: null }; });
    const run = await finish(teamGraph('process.exit(1)'));
    expect(run.status).toBe('failed');
    expect(runProvider).toHaveBeenCalledTimes(2);
    expect(store.attempts(run.id).find(attempt => attempt.nodeId === 'sim')!.error).toContain('playbook failed');
  });
  it('fails the role when any playbook step edits outside its ownership, including commands', async () => {
    runProvider.mockImplementation(async input => { await writeFile(join(input.cwd, 'src/events.json'), '{"seed":3}'); return { output: 'ok', costUsd: null }; });
    const run = await finish(teamGraph("require('fs').writeFileSync('outside.txt', 'changed by a command')"));
    expect(run.status).toBe('failed');
    expect(store.attempts(run.id).find(attempt => attempt.nodeId === 'sim')!.error).toContain('outside.txt');
    expect(store.handoffs(run.id)).toEqual([]);
    expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('unchanged');
  });
});
