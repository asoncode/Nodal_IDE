import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { GraphSchema, RoleSchema } from '../../shared/src/index.js';
import { Store, type StoredRun } from '../../persistence/src/index.js';
import { git } from '../../workspace/src/index.js';
import { NodalService } from '../src/service.js';
import type { ExecutionContext, NodeResult } from '../../core/src/engine.js';
const { runProvider } = vi.hoisted(() => ({ runProvider: vi.fn() }));
vi.mock('../../providers/src/index.js', () => ({ runProvider, checkAvailability: vi.fn() }));
let root: string, data: string, store: Store, service: NodalService, run: StoredRun;
const role = RoleSchema.parse({ id: 'api', title: 'API engineer', expertise: 'Implement the contract.', owns: ['src/**'], produces: [{ name: 'contract', path: 'src/contract.json', required: true, schema: { type: 'object', required: ['ready'], properties: { ready: { const: true } } } }] });
beforeEach(async () => {
  runProvider.mockReset(); root = await mkdtemp(join(tmpdir(), 'nodal-role-exec-')); data = await mkdtemp(join(tmpdir(), 'nodal-role-data-'));
  await mkdir(join(root, 'src')); await writeFile(join(root, 'outside.txt'), 'unchanged'); await writeFile(join(root, 'src/base.ts'), 'existing');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']]) { const result = await git(root, args); if (result.exitCode !== 0) throw new Error(result.stderr); }
  const source = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(); store = new Store(':memory:'); const project = store.addProject(root, 'Role test'); service = new NodalService(store, data);
  vi.spyOn(service as any, 'permission').mockResolvedValue(true);
  const graph = GraphSchema.parse({ id: 'g', name: 'test', nodes: [{ id: 'agent', kind: 'agent', label: 'Role', config: { role, provider: 'claude', permission: 'scoped-edit', instructions: 'Build the contract.' } }], edges: [] });
  run = { id: 'r', projectId: project.id, graph, status: 'running', createdAt: 'now', repositorySha: source }; store.createRun(run);
});
afterEach(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); });
async function execute(): Promise<NodeResult> {
  const attempt = { id: randomUUID(), runId: run.id, nodeId: 'agent', state: 'running' as const, iteration: 1, attemptIndex: 1, startedAt: 'now' };
  const ctx: ExecutionContext = { runId: run.id, node: run.graph.nodes[0], attempt, inputs: {}, signal: new AbortController().signal, emit: async (kind, payload) => { store.appendEvent({ eventId: randomUUID(), runId: run.id, nodeId: 'agent', attemptId: attempt.id, kind, payload, sequence: 1, timestamp: 'now' }); } };
  return (service as any).execute(ctx, run);
}

describe('role runtime publication boundary (mock provider)', () => {
  it('persists context, usage and hash-bound handoffs only after successful verification', async () => {
    runProvider.mockImplementation(async input => { await writeFile(join(input.cwd, 'src/contract.json'), '{"ready":true}'); return { output: 'Created contract', usage: { input_tokens: 11, output_tokens: 4 }, costUsd: null }; });
    const result = await execute(); expect(result.status).toBe('succeeded'); expect(store.handoffs('r')).toHaveLength(1);
    expect(runProvider.mock.calls[0][0].rolePolicy).toEqual({ owns: ['src/**'], readOnlyPaths: [] });
    expect(store.events('r').map(event => event.kind)).toEqual(expect.arrayContaining(['role.context', 'role.usage', 'handoff.verified']));
    expect((result.output as any).handoffs[0].commit).toBe((result.output as any).head);
    const context = result.artifacts!.find(artifact => artifact.kind === 'text')!;
    expect(await readFile(context.path!, 'utf8')).toBe(runProvider.mock.calls[0][0].prompt);
  });
  it('fails an ownership violation before committing or publishing a handoff', async () => {
    runProvider.mockImplementation(async input => { await writeFile(join(input.cwd, 'outside.txt'), 'violating change'); await writeFile(join(input.cwd, 'src/contract.json'), '{"ready":true}'); return { output: 'done', costUsd: null }; });
    const result = await execute(); expect(result.status).toBe('failed'); expect(result.error).toContain('outside.txt'); expect(store.handoffs('r')).toEqual([]);
    expect((result.output as any).head).toBeUndefined();
    const worktree = (result.output as any).worktree.path; expect((await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(run.repositorySha);
    expect(store.events('r').some(event => event.kind === 'role.policy_violation')).toBe(true);
  });
  it('rejects schema-invalid handoffs and never publishes them', async () => {
    runProvider.mockImplementation(async input => { await writeFile(join(input.cwd, 'src/contract.json'), '{"ready":false}'); return { output: 'done', costUsd: null }; });
    const result = await execute(); expect(result.status).toBe('failed'); expect(result.error).toContain('schema validation'); expect(store.handoffs('r')).toEqual([]);
  });
  it('does not treat role-bearing demo output as verified success', async () => {
    const node = run.graph.nodes[0]; if (node.kind === 'agent') node.config.provider = 'demo';
    const result = await execute(); expect(result.status).toBe('failed'); expect(result.error).toContain('Demo agents'); expect(runProvider).not.toHaveBeenCalled(); expect(store.handoffs('r')).toEqual([]);
  });
  it('rejects missing required handoffs and preserves work without publication', async () => {
    runProvider.mockImplementation(async input => { await writeFile(join(input.cwd, 'src/base.ts'), 'edited'); return { output: 'done', costUsd: null }; });
    const result = await execute(); expect(result.status).toBe('failed'); expect(result.error).toContain('Handoff contract'); expect(store.handoffs('r')).toEqual([]); expect((result.output as any).head).toBeUndefined();
  });
});
