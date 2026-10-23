import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphSchema, createNode, type Graph } from '../../shared/src/index.js';
import { Store } from '../../persistence/src/index.js';
import { git } from '../../workspace/src/index.js';
import { NodalService } from '../src/service.js';
import { upstreamContext } from '../src/context.js';
const { runProvider } = vi.hoisted(() => ({ runProvider: vi.fn() }));
vi.mock('../../providers/src/index.js', () => ({ runProvider, checkAvailability: vi.fn() }));

let root: string, data: string, store: Store, service: NodalService, projectId: string, counter: string;
beforeEach(async () => {
  runProvider.mockReset();
  root = await mkdtemp(join(tmpdir(), 'nodal-economy-')); data = await mkdtemp(join(tmpdir(), 'nodal-economy-data-')); counter = join(data, 'count.txt');
  await git(root, ['init']); await mkdir(join(root, 'docs')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/match.ts'), 'export function simulate() {}\nexport class Pitch {}\n');
  for (const args of [['add', '-A'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']]) { const result = await git(root, args); if (result.exitCode !== 0) throw new Error(result.stderr); }
  store = new Store(':memory:'); projectId = store.addProject(root, 'Economy').id; service = new NodalService(store, data);
  vi.spyOn(service as any, 'permission').mockResolvedValue(true);
});
afterEach(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); });
const finish = async (graph: Graph) => { const run = await service.startRun(projectId, graph); await (service as any).tasks.get(run.id); return store.run(run.id); };
/** Tests fail on the first run only. */
const flaky = () => `const fs=require('fs');const f=${JSON.stringify(counter)};const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));process.exit(n===0?1:0)`;
function graph(settings: Record<string, unknown> = {}, test = 'process.exit(0)'): Graph {
  return GraphSchema.parse({ id: 'g', name: 'economy', settings, nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    { id: 'arch', kind: 'agent', label: 'Architecture', config: { provider: 'claude', permission: 'scoped-edit', instructions: 'Write the design.', role: { id: 'arch', title: 'Architect', expertise: 'Designs.', owns: ['docs'] } } },
    { id: 'arch-tests', kind: 'command', label: 'Design tests', config: { command: process.execPath, args: ['-e', 'process.exit(0)'] } },
    { id: 'arch-gate', kind: 'quality_gate', label: 'Design gate', config: { predicate: { sourceNodeId: 'arch-tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 1 } },
    { id: 'impl', kind: 'agent', label: 'Implementation', config: { provider: 'codex', permission: 'scoped-edit', instructions: 'Implement the design.', role: { id: 'impl', title: 'Engineer', expertise: 'Builds.', owns: ['src'] } } },
    { id: 'tests', kind: 'command', label: 'Unit tests', config: { command: process.execPath, args: ['-e', test] } },
    { id: 'gate', kind: 'quality_gate', label: 'Test gate', config: { predicate: { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 3 } },
    { id: 'end', kind: 'end', label: 'End' },
  ], edges: [
    { id: '1', source: 'start', target: 'arch' }, { id: '2', source: 'arch', target: 'arch-tests' }, { id: '3', source: 'arch-tests', target: 'arch-gate' },
    { id: '4', source: 'arch-gate', target: 'impl', sourcePort: 'pass' }, { id: '5', source: 'impl', target: 'tests' }, { id: '6', source: 'tests', target: 'gate' },
    { id: '7', source: 'gate', target: 'end', sourcePort: 'pass' }, { id: '8', source: 'gate', target: 'impl', kind: 'loop', sourcePort: 'fail' },
  ] });
}
const provider = () => runProvider.mockImplementation(async input => {
  const file = input.prompt.includes('Write the design.') ? 'docs/design.md' : 'src/sim.ts';
  await mkdir(dirname(join(input.cwd, file)), { recursive: true }); await writeFile(join(input.cwd, file), `// ${Math.random()}`);
  return { output: `Done ${file}`, sessionId: `session-${runProvider.mock.calls.length}`, costUsd: null };
});
const trace = (runId: string) => store.events(runId).filter(event => event.kind === 'node.completed').map(event => {
  const payload = event.payload as { attempt: { nodeId: string; state: string } };
  return `${payload.attempt.nodeId}:${payload.attempt.state}`;
});

describe('context economy', () => {
  it('runs the same steps, commands, and gates with context economy on or off', async () => {
    provider();
    const on = await finish(graph({}, flaky()));
    const onPrompts = runProvider.mock.calls.map(call => call[0].prompt as string);
    await rm(counter, { force: true }); runProvider.mockClear(); provider();
    const off = await finish(graph({ contextEconomy: false }, flaky()));
    const offPrompts = runProvider.mock.calls.map(call => call[0].prompt as string);
    expect(on.status).toBe('succeeded'); expect(off.status).toBe('succeeded');
    expect(trace(on.id)).toEqual(trace(off.id));
    expect(trace(on.id)).toEqual(expect.arrayContaining(['tests:failed', 'gate:succeeded', 'tests:succeeded']));
    expect(onPrompts.every(prompt => prompt.includes('[ledger]'))).toBe(true);
    expect(offPrompts.some(prompt => prompt.includes('[ledger]') || prompt.includes('Verified facts'))).toBe(false);
    expect(store.contextUsage(on.id).map(row => row.layer)).toEqual(expect.arrayContaining(['platform', 'ledger', 'role', 'task', 'evidence']));
    expect(store.contextUsage(off.id).map(row => row.layer)).toEqual(['plain', 'plain', 'plain']);
  });
  it('gives each role a deterministic code index of its area and records changed files', async () => {
    provider();
    const run = await finish(graph());
    const implLedger = store.ledgers(run.id).at(-1)!.text;
    expect(implLedger).toContain('Code index for your area'); expect(implLedger).toContain('src/match.ts: simulate (function), Pitch (class)');
    expect((store.attempts(run.id).find(attempt => attempt.nodeId === 'arch')!.output as { changedFiles: string[] }).changedFiles).toEqual(['docs/design.md']);
  });
  it('never resumes sessions unless enabled, and falls back to a fresh turn when resuming fails', async () => {
    provider();
    await finish(graph({}, flaky()));
    expect(runProvider.mock.calls.some(call => call[0].resumeId)).toBe(false);
    await rm(counter, { force: true }); runProvider.mockClear();
    runProvider.mockImplementation(async input => {
      if (input.resumeId) throw new Error('session expired');
      const file = join(input.cwd, input.prompt.includes('Write the design.') ? 'docs/design.md' : 'src/sim.ts');
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, `// ${Math.random()}`);
      return { output: 'done', sessionId: 'session-1', costUsd: null };
    });
    const run = await finish(graph({ resumeOnRetry: true }, flaky()));
    expect(run.status).toBe('succeeded');
    const resumed = runProvider.mock.calls.find(call => call[0].resumeId);
    expect(resumed?.[0]).toMatchObject({ resumeId: 'session-1', prompt: expect.stringContaining('[retry 2]') });
    expect(store.events(run.id).map(event => event.kind)).toContain('session.resume_failed');
  });
});

describe('ancestor digests', () => {
  it('sends full text from the nearest workers and a digest from distant ones', () => {
    const a = createNode('agent', 'a'), b = createNode('agent', 'b'), c = createNode('agent', 'c');
    const graph = GraphSchema.parse({ id: 'g', name: 'chain', nodes: [createNode('start', 'start'), a, b, c, createNode('end', 'end')], edges: [
      { id: '1', source: 'start', target: 'a' }, { id: '2', source: 'a', target: 'b' }, { id: '3', source: 'b', target: 'c' }, { id: '4', source: 'c', target: 'end' }] });
    const long = `PLAN ${'detail '.repeat(500)}END`;
    const text = upstreamContext({ a: { status: 'succeeded', output: { output: long, changedFiles: ['docs/plan.md'] } }, b: { status: 'succeeded', output: { output: long } } }, graph, 40_000, { near: new Set(['b', 'c']) });
    const [distant, recent] = text.split('## Agent (agent): succeeded').slice(1);
    expect(distant).toContain('Changed files: docs/plan.md'); expect(distant).toContain('step-output'); expect(distant).not.toContain('END');
    expect(recent).toContain('END');
  });
});
