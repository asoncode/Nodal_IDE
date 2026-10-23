import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoleSchema, roleOwnsPath, type VerifiedHandoff } from '../../shared/src/roles.js';
import { git, readFile } from '../../workspace/src/index.js';
import { enforceConsumedHandoffs, enforceOwnership, roleContext, roleUsage, validateRole, verifyProduced, verifyCommittedHandoffs } from '../src/roles.js';
import { Store } from '../../persistence/src/index.js';
import { GraphSchema } from '../../shared/src/index.js';

let root: string, source: string;
const role = RoleSchema.parse({ id: 'api', title: 'API engineer', expertise: 'Maintain contracts.', owns: ['src/**'], knowledge: ['guide.md'], skills: ['Test each change.'], produces: [{ name: 'contract', path: 'src/contract.json', required: true, schema: { type: 'object', required: ['version'], properties: { version: { type: 'integer' } }, additionalProperties: false } }] });
async function run(args: string[]) { const result = await git(root, args); if (result.exitCode !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-role-')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'guide.md'), 'Repository guidelines'); await writeFile(join(root, 'src/base.ts'), 'export const value = 1;'); await writeFile(join(root, 'outside.ts'), 'do not edit');
  await run(['init']); await run(['add', '.']); await run(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']); source = await run(['rev-parse', 'HEAD']);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('role scopes and knowledge', () => {
  it('accepts portable glob scopes and rejects external, traversal, sensitive and unsupported scopes', () => {
    expect(roleOwnsPath(['src/**/*.ts'], 'src/base.ts')).toBe(true);
    expect(roleOwnsPath(['src/**/*.ts'], 'src/nested/file.ts')).toBe(true);
    expect(roleOwnsPath(['src/api'], 'src/apitest/file.ts')).toBe(false);
    for (const path of ['/tmp/reference', '../secret', 'C:/secret', '.git/config', 'src/{a,b}']) expect(RoleSchema.safeParse({ ...role, knowledge: [path] }).success).toBe(false);
    expect(() => validateRole({ ...role, knowledge: ['.env'] })).toThrow('credentials');
    expect(() => validateRole({ ...role, produces: [{ name: 'bad', path: 'src/data.json', required: true, schema: { type: 'made-up' } }] })).toThrow();
  });
  it('bounds knowledge and orders stable layers before task and evidence', async () => {
    await writeFile(join(root, 'large.md'), 'x'.repeat(40_000));
    const context = await roleContext(root, { ...role, knowledge: ['*.md'] }, {}, 'TASK_UNIQUE', 'EVIDENCE_UNIQUE', source);
    expect(context.knowledgePaths).toEqual(['guide.md']);
    expect(context.repositoryPaths).toContain('src/base.ts');
    expect(context.layers.map(layer => layer.name)).toEqual(['platform', 'ledger', 'role', 'task', 'evidence']);
    expect(context.prompt.indexOf('Maintain contracts.')).toBeLessThan(context.prompt.indexOf('TASK_UNIQUE'));
    expect(context.prompt).toContain('Test each change.'); expect(context.prompt).toContain('Repository guidelines');
    expect(context.prompt).not.toContain('x'.repeat(100));
    await symlink(join(root, 'guide.md'), join(root, 'linked.md'));
    await expect(roleContext(root, { ...role, knowledge: ['linked.md'] }, {}, '', '', source)).rejects.toThrow('Linked');
  });
});

describe('ownership before publication', () => {
  it('allows owned edits and rejects untracked files outside ownership', async () => {
    await writeFile(join(root, 'src/base.ts'), 'export const value = 2;');
    expect(await enforceOwnership(root, source, role)).toEqual(['src/base.ts']);
    await writeFile(join(root, 'new.ts'), 'outside');
    await expect(enforceOwnership(root, source, role)).rejects.toThrow('new.ts');
  });
  it('rejects ignored files outside ownership', async () => {
    await writeFile(join(root, '.gitignore'), 'cache/'); await run(['add', '.gitignore']); await run(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'ignore']); source = await run(['rev-parse', 'HEAD']);
    await mkdir(join(root, 'cache')); await writeFile(join(root, 'cache/unowned.txt'), 'hidden');
    await expect(enforceOwnership(root, source, role)).rejects.toThrow('cache/unowned.txt');
  });
  it('checks both rename paths and deleted paths', async () => {
    await rename(join(root, 'outside.ts'), join(root, 'src/moved.ts'));
    await expect(enforceOwnership(root, source, role)).rejects.toThrow('outside.ts');
    await run(['reset', '--hard', source]); await unlink(join(root, 'outside.ts'));
    await expect(enforceOwnership(root, source, role)).rejects.toThrow('outside.ts');
  });
  it('rejects out-of-scope changes already committed by a provider', async () => {
    await writeFile(join(root, 'outside.ts'), 'provider change'); await run(['add', '.']); await run(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'provider self commit']);
    await expect(enforceOwnership(root, source, role)).rejects.toThrow('outside.ts');
  });
});

describe('verified handoffs', () => {
  it('rejects missing, invalid JSON and invalid schema outputs', async () => {
    await expect(verifyProduced(root, role)).rejects.toThrow('Handoff contract');
    await writeFile(join(root, 'src/contract.json'), 'plain text'); await expect(verifyProduced(root, role)).rejects.toThrow('valid JSON');
    await writeFile(join(root, 'src/contract.json'), '{"version":"wrong"}'); await expect(verifyProduced(root, role)).rejects.toThrow('schema validation');
    await writeFile(join(root, 'src/contract.json'), '{"version":1}'); expect(await verifyProduced(root, role)).toHaveLength(1);
  });
  it('validates repeated snapshots with the same schema id without sharing a schema registry', async () => {
    const identified = { ...role, produces: role.produces.map(handoff => ({ ...handoff, schema: { ...handoff.schema, $id: 'urn:nodal:contract' } })) };
    await writeFile(join(root, 'src/contract.json'), '{"version":1}');
    for (let index = 0; index < 3; index++) { validateRole(identified); await expect(verifyProduced(root, validateRole(identified))).resolves.toHaveLength(1); }
  });
  it('consumes only successful upstream verified content and detects modification', async () => {
    const consumer = { ...role, consumes: [{ name: 'contract', path: 'src/contract.json', required: true }] };
    await writeFile(join(root, 'src/contract.json'), '{"version":1}');
    const handoff: VerifiedHandoff = { ...(await verifyProduced(root, role))[0], producerNodeId: 'architect', attemptId: 'attempt-volatile', commit: source };
    await expect(roleContext(root, consumer, {}, '', '', source)).rejects.toThrow('no verified upstream');
    await expect(roleContext(root, consumer, { architect: { status: 'failed', output: { handoffs: [handoff] } } }, '', '', source)).rejects.toThrow('no verified upstream');
    const inputs = { architect: { status: 'succeeded' as const, output: { handoffs: [handoff] } } };
    const context = await roleContext(root, consumer, inputs, 'task', 'evidence', source);
    expect(context.prompt).toContain('"version":1'); expect(context.prompt).not.toContain('attempt-volatile');
    await writeFile(join(root, 'src/contract.json'), '{"version":2}');
    await expect(enforceConsumedHandoffs(root, [handoff])).rejects.toThrow('was modified');
    await expect(roleContext(root, consumer, inputs, '', '', source)).rejects.toThrow('changed since upstream');
  });
  it('rejects a handoff missing from its claimed commit', async () => {
    await writeFile(join(root, 'src/contract.json'), '{"version":1}');
    const produced = await verifyProduced(root, role);
    await expect(verifyCommittedHandoffs(root, source, produced)).rejects.toThrow('committed snapshot');
    await run(['add', '.']); await run(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'handoff']);
    await expect(verifyCommittedHandoffs(root, await run(['rev-parse', 'HEAD']), produced)).resolves.toBeUndefined();
  });
  it('keeps unknown usage unknown', () => {
    expect(roleUsage('api', 20)).toEqual({ roleId: 'api', durationMs: 20, inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null });
    expect(roleUsage('api', 20, { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 }, 0)).toMatchObject({ inputTokens: 10, cachedInputTokens: 5, costUsd: 0 });
  });
  it('persists project-isolated roles and verified handoffs without changing pinned graph roles', async () => {
    const dbPath = join(root, 'roles.sqlite'); let store = new Store(dbPath);
    const first = store.addProject(root, 'First'), second = store.addProject(root + '/other', 'Second');
    store.saveRole(first.id, role); store.saveRole(second.id, { ...role, title: 'Other' });
    const graph = GraphSchema.parse({ id: 'g', name: 'Pinned', nodes: [{ id: 'agent', kind: 'agent', label: 'Agent', config: { role } }], edges: [] });
    store.saveGraph(first.id, graph); store.saveRole(first.id, { ...role, title: 'Updated' });
    store.createRun({ id: 'r', projectId: first.id, graph, status: 'succeeded', createdAt: 'now' });
    const handoff = { name: 'guide', path: 'guide.md', contentHash: (await readFile(root, 'guide.md')).hash, producerNodeId: 'agent', attemptId: 'a', commit: source };
    store.saveHandoff('r', handoff); store.close(); store = new Store(dbPath);
    expect(store.roles(first.id)[0].title).toBe('Updated'); expect(store.roles(second.id)[0].title).toBe('Other');
    expect((store.graphs(first.id)[0].nodes[0] as any).config.role.title).toBe('API engineer');
    expect(store.handoffs('r')).toEqual([handoff]); store.deleteRole(first.id, role.id); expect(store.roles(first.id)).toEqual([]); expect(store.roles(second.id)).toHaveLength(1); store.close();
  });
});
