import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphSchema, type Graph } from '../../shared/src/index.js';
import { Store } from '../../persistence/src/index.js';
import { git } from '../../workspace/src/index.js';
import { NodalService, parseConsult } from '../src/service.js';
import { validateGraph } from '../../core/src/validation.js';
const { runProvider } = vi.hoisted(() => ({ runProvider: vi.fn() }));
vi.mock('../../providers/src/index.js', () => ({ runProvider, checkAvailability: vi.fn() }));

let root: string, data: string, store: Store, service: NodalService, projectId: string;
beforeEach(async () => {
  runProvider.mockReset();
  root = await mkdtemp(join(tmpdir(), 'nodal-collab-')); data = await mkdtemp(join(tmpdir(), 'nodal-collab-data-'));
  await git(root, ['init']); await mkdir(join(root, 'docs')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'docs/brief.md'), 'Seeded simulator.'); await writeFile(join(root, 'src/index.ts'), 'export {};');
  for (const args of [['add', '-A'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']]) { const result = await git(root, args); if (result.exitCode !== 0) throw new Error(result.stderr); }
  store = new Store(':memory:'); projectId = store.addProject(root, 'Collaboration').id; service = new NodalService(store, data);
  vi.spyOn(service as any, 'permission').mockResolvedValue(true);
});
afterEach(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); });

const pass = (id: string, source: string) => [{ id, kind: 'command', label: `${source} tests`, config: { command: process.execPath, args: ['-e', 'process.exit(0)'] } }, { id: `${id}-gate`, kind: 'quality_gate', label: `${source} gate`, config: { predicate: { sourceNodeId: id, field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 1 } }];
function team(): Graph {
  return GraphSchema.parse({ id: 'g', name: 'architect and implementer', nodes: [
    { id: 'start', kind: 'start', label: 'Start' },
    { id: 'arch', kind: 'agent', label: 'Architecture', config: { provider: 'claude', permission: 'scoped-edit', instructions: 'Design decisions.', role: { id: 'arch', title: 'Architect', expertise: 'Designs the simulator.', owns: ['docs'], produces: [{ name: 'decisions', path: 'docs/decisions.json', required: true }] } } },
    ...pass('arch-tests', 'Architecture'),
    { id: 'impl', kind: 'agent', label: 'Implementation', config: { provider: 'codex', permission: 'scoped-edit', instructions: 'Implement the simulator.', role: { id: 'impl', title: 'Simulation engineer', expertise: 'Builds the simulator.', owns: ['src'] } } },
    ...pass('impl-tests', 'Implementation'),
    { id: 'end', kind: 'end', label: 'End' },
  ], edges: [
    { id: '1', source: 'start', target: 'arch' }, { id: '2', source: 'arch', target: 'arch-tests' }, { id: '3', source: 'arch-tests', target: 'arch-tests-gate' },
    { id: '4', source: 'arch-tests-gate', target: 'impl', sourcePort: 'pass' }, { id: '5', source: 'impl', target: 'impl-tests' }, { id: '6', source: 'impl-tests', target: 'impl-tests-gate' },
    { id: '7', source: 'impl-tests-gate', target: 'end', sourcePort: 'pass' },
  ] });
}
const finish = async (graph: Graph) => { const run = await service.startRun(projectId, graph); await (service as any).tasks.get(run.id); return store.run(run.id); };
const decisions = JSON.stringify({ decisions: [{ decision: 'Seeds range from 1 to 100', rationale: 'matched counterfactual comparisons' }] });

describe('team collaboration', () => {
  it('answers a consult read-only, continues the asking role, and gives it a verified-facts ledger', async () => {
    runProvider.mockImplementation(async input => {
      if (input.prompt.startsWith('You are the Architect')) { expect(input.permissionMode).toBe('read-only'); return { output: 'Use seeds 1 to 100.', costUsd: null }; }
      if (input.prompt.includes('Design decisions.')) { await writeFile(join(input.cwd, 'docs/decisions.json'), decisions); return { output: 'Designed.', costUsd: null }; }
      await writeFile(join(input.cwd, 'src/sim.ts'), 'export const seeds = 100;');
      if (!input.prompt.includes('[consult 1]')) return { output: 'Need the seed range.\n```consult\n{"role": "arch", "question": "Which seed range should the simulator use?"}\n```', costUsd: null };
      return { output: 'Implemented with seeds 1 to 100.', costUsd: null };
    });
    const graph = team(); expect(validateGraph(graph).errors).toEqual([]);
    const run = await finish(graph);
    expect(run.status).toBe('succeeded');
    expect(store.consults(run.id)).toEqual([expect.objectContaining({ fromRoleId: 'impl', toRoleId: 'arch', question: 'Which seed range should the simulator use?', answer: 'Use seeds 1 to 100.' })]);
    const continued = runProvider.mock.calls.map(call => call[0].prompt as string).find(prompt => prompt.includes('[consult 1]'))!;
    expect(continued).toContain('Use seeds 1 to 100.');
    const ledger = store.ledgers(run.id).at(-1)!.text;
    expect(ledger).toContain('Architect (arch) owns docs'); expect(ledger).toContain('Simulation engineer (impl) owns src');
    expect(ledger).toContain('Architecture tests: exit 0');
    expect(ledger).toMatch(/Seeds range from 1 to 100 \(because matched counterfactual comparisons\) \[arch @ [0-9a-f]{12}\]/);
    expect(continued).toContain(ledger);
  });
  it('fails a decision record that does not match the built-in schema', async () => {
    runProvider.mockImplementation(async input => { await writeFile(join(input.cwd, 'docs/decisions.json'), '{"decisions":[{"decision":"no rationale"}]}'); return { output: 'done', costUsd: null }; });
    const run = await finish(team());
    expect(run.status).toBe('failed');
    expect(store.attempts(run.id).find(attempt => attempt.nodeId === 'arch')!.error).toContain('schema validation');
  });
  it('answers unknown-role consults without a provider call and stops at two consults per step', async () => {
    runProvider.mockImplementation(async input => {
      if (input.prompt.includes('Design decisions.')) { await writeFile(join(input.cwd, 'docs/decisions.json'), decisions); return { output: 'Designed.', costUsd: null }; }
      await writeFile(join(input.cwd, 'src/sim.ts'), 'export {};');
      return { output: 'Still unsure.\n```consult\n{"role": "ghost", "question": "Anyone there?"}\n```', costUsd: null };
    });
    const run = await finish(team());
    expect(run.status).toBe('succeeded');
    expect(store.consults(run.id)).toHaveLength(2);
    expect(store.consults(run.id)[0]).toMatchObject({ toRoleId: 'ghost', provider: 'none', answer: expect.stringContaining('No role "ghost"') });
    expect(runProvider.mock.calls.filter(call => (call[0].prompt as string).includes('Implement the simulator.'))).toHaveLength(3);
    expect(runProvider.mock.calls.some(call => (call[0].prompt as string).startsWith('You are the'))).toBe(false);
  });
  it('accepts only a well-formed consult block at the end of a reply', () => {
    expect(parseConsult('text\n```consult\n{"role":"x","question":"q?"}\n```')).toEqual({ role: 'x', question: 'q?' });
    expect(parseConsult('```consult\n{"role":"x"}\n```')).toBeUndefined();
    expect(parseConsult('```consult\n{"role":"x","question":"q"}\n```\nmore text after')).toBeUndefined();
  });
});
