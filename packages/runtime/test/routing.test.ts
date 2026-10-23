import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphSchema, type Graph } from '../../shared/src/index.js';
import { Store } from '../../persistence/src/index.js';
import { git } from '../../workspace/src/index.js';
import { NodalService } from '../src/service.js';
import { validateGraph } from '../../core/src/validation.js';
import { WorkflowEngine } from '../../core/src/engine.js';
const { runProvider } = vi.hoisted(() => ({ runProvider: vi.fn() }));
vi.mock('../../providers/src/index.js', () => ({ runProvider, checkAvailability: vi.fn() }));

const role = (id: string, owns: string) => ({ id, title: `${id.toUpperCase()} engineer`, expertise: `Builds ${owns}.`, owns: [owns] });
function teamGraph(test: string, routing?: { fallback?: string }): Graph {
  return GraphSchema.parse({ id: 'g', name: 'routed team', nodes: [
    { id: 'start', kind: 'start', label: 'Start' }, { id: 'split', kind: 'parallel', label: 'Split' },
    { id: 'a', kind: 'agent', label: 'A', config: { role: role('a', 'src/a'), provider: 'codex', permission: 'scoped-edit', instructions: 'Build A.' } },
    { id: 'b', kind: 'agent', label: 'B', config: { role: role('b', 'src/b'), provider: 'codex', permission: 'scoped-edit', instructions: 'Build B.' } },
    { id: 'join', kind: 'join', label: 'Join' }, { id: 'merge', kind: 'merge', label: 'Merge', config: { sourceNodeIds: ['a', 'b'] } },
    { id: 'tests', kind: 'command', label: 'Integration tests', config: { command: process.execPath, args: ['-e', test] } },
    { id: 'gate', kind: 'quality_gate', label: 'Integration gate', config: { predicate: { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 3, ...(routing ? { routing: 'owner', ...(routing.fallback ? { fallbackTargetId: routing.fallback } : {}) } : {}) } },
    { id: 'end', kind: 'end', label: 'End' },
  ], edges: [
    { id: '1', source: 'start', target: 'split' }, { id: '2', source: 'split', target: 'a' }, { id: '3', source: 'split', target: 'b' },
    { id: '4', source: 'a', target: 'join' }, { id: '5', source: 'b', target: 'join' }, { id: '6', source: 'join', target: 'merge' },
    { id: '7', source: 'merge', target: 'tests' }, { id: '8', source: 'tests', target: 'gate' }, { id: '9', source: 'gate', target: 'end', sourcePort: 'pass' },
    { id: 'la', source: 'gate', target: 'a', kind: 'loop', sourcePort: 'fail' }, ...(routing ? [{ id: 'lb', source: 'gate', target: 'b', kind: 'loop', sourcePort: 'fail' }] : []),
  ] });
}

describe('owner routing validation', () => {
  it('allows several loop targets only with owner routing, to role steps, with a valid fallback', () => {
    expect(validateGraph(teamGraph('process.exit(0)', { fallback: 'a' })).errors).toEqual([]);
    const unrouted = teamGraph('process.exit(0)', {}); const gate = unrouted.nodes.find(node => node.id === 'gate');
    if (gate?.kind === 'quality_gate') delete gate.config.routing;
    expect(validateGraph(unrouted).errors.map(error => error.code)).toContain('multiple_loops');
    const badFallback = teamGraph('process.exit(0)', { fallback: 'merge' });
    expect(validateGraph(badFallback).errors.map(error => error.code)).toContain('routing_fallback');
  });
  it('falls back when the router attributes nothing and contains router errors', async () => {
    const graph = teamGraph('process.exit(0)', { fallback: 'a' });
    let gateRuns = 0; const ran: string[] = [];
    const engine = new WorkflowEngine(graph, {
      execute: async ({ node }) => { ran.push(node.id); if (node.id === 'tests') return { status: 'succeeded', output: { exitCode: ++gateRuns > 2 ? 0 : 1 } }; return { status: 'succeeded' }; },
      routeFailure: async () => { if (gateRuns === 1) return []; throw new Error('router unavailable'); },
    });
    expect((await engine.start()).status).toBe('succeeded');
    expect(ran.filter(id => id === 'a')).toHaveLength(3); expect(ran.filter(id => id === 'b')).toHaveLength(1);
  });
});

let root: string, data: string, store: Store, service: NodalService, projectId: string, counter: string;
beforeEach(async () => {
  runProvider.mockReset();
  root = await mkdtemp(join(tmpdir(), 'nodal-routing-')); data = await mkdtemp(join(tmpdir(), 'nodal-routing-data-')); counter = join(data, 'runs.txt');
  await git(root, ['init']); await mkdir(join(root, 'src/a'), { recursive: true }); await mkdir(join(root, 'src/b'), { recursive: true });
  await writeFile(join(root, 'src/a/a.ts'), 'export const a = 1;'); await writeFile(join(root, 'src/b/b.ts'), 'export const b = 1;');
  for (const args of [['add', '-A'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']]) { const result = await git(root, args); if (result.exitCode !== 0) throw new Error(result.stderr); }
  store = new Store(':memory:'); projectId = store.addProject(root, 'Routing').id; service = new NodalService(store, data);
  vi.spyOn(service as any, 'permission').mockResolvedValue(true);
  runProvider.mockImplementation(async input => { const file = input.prompt.includes('Build A.') ? 'src/a/a.ts' : 'src/b/b.ts'; await writeFile(join(input.cwd, file), `export const value = ${Math.random()};`); return { output: 'done', costUsd: null }; });
});
afterEach(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); });

describe('owner-routed integration failures', () => {
  it('re-runs only the role that owns the failing file, and records why', async () => {
    // Fails once, naming a file B owns, then passes.
    const test = `const fs=require('fs');const f=${JSON.stringify(counter)};const n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));if(n===0){console.error('TypeError at src/b/b.ts:1:14');process.exit(1)}`;
    const graph = teamGraph(test, { fallback: 'a' });
    expect(validateGraph(graph).errors).toEqual([]);
    const run = await service.startRun(projectId, graph); await (service as any).tasks.get(run.id);
    expect(store.run(run.id).status).toBe('succeeded');
    const prompts = runProvider.mock.calls.map(call => call[0].prompt as string);
    expect(prompts.filter(prompt => prompt.includes('Build A.'))).toHaveLength(1);
    expect(prompts.filter(prompt => prompt.includes('Build B.'))).toHaveLength(2);
    expect(store.events(run.id).find(event => event.kind === 'loop.routed')?.payload).toMatchObject({ paths: ['src/b/b.ts'], owners: ['b'] });
  });
});
