import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../persistence/src/index.js';
import { NodalService } from '../src/service.js';
import { createCommandGraph } from '../../core/src/templates.js';
import { planningContext, assertApprovedTeam } from '../src/planning.js';
import { RoleSchema } from '../../shared/src/roles.js';
import { TeamPlanSchema } from '../../shared/src/team.js';
import { createNode } from '../../shared/src/index.js';
import type { GenerationSnapshot } from '../../shared/src/generation.js';
const { runProvider, checkAvailability } = vi.hoisted(() => ({ runProvider: vi.fn(), checkAvailability: vi.fn() }));
vi.mock('../../providers/src/index.js', () => ({ runProvider, checkAvailability }));
const role = RoleSchema.parse({ id: 'api', title: 'API engineer', expertise: 'Build and test the API against contracts.', owns: ['api/**'], knowledge: ['brief.md'] });
const reviewer = RoleSchema.parse({ id: 'review', title: 'Reviewer', expertise: 'Independently review correctness.', knowledge: ['brief.md'] });
const team = TeamPlanSchema.parse({ name: 'API team', summary: 'API specialist and independent reviewer.', members: [{ role, provider: 'codex', permission: 'scoped-edit' }, { role: reviewer, provider: 'claude', permission: 'read-only' }], areas: [{ path: 'api/**', roleId: 'api' }] });
let root: string, data: string, service: NodalService, store: Store, projectId: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-team-')); data = await mkdtemp(join(tmpdir(), 'nodal-team-data-'));
  await writeFile(join(root, 'brief.md'), 'Build a causal simulator with explicit interventions.');
  store = new Store(':memory:'); projectId = store.addProject(root, 'Team').id; service = new NodalService(store, data);
  runProvider.mockReset(); checkAvailability.mockReset().mockResolvedValue({ available: true, authentication: 'authenticated' });
});
afterEach(async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }); });
describe('reviewed team planning', () => {
  it('reads only selected brief text and supplies manifest and saved roles without executing or saving a graph', async () => {
    await writeFile(join(root, 'private-not-selected.md'), 'Do not transmit this content.');
    store.saveRole(projectId, role); runProvider.mockResolvedValue({ output: JSON.stringify(team) });
    const job = await service.dispatch('startGeneration', { projectId, graph: createCommandGraph(), prompt: 'Build the application', provider: 'claude', planning: { stage: 'team', briefPaths: ['brief.md'] } }) as GenerationSnapshot;
    let completed!: GenerationSnapshot;
    await vi.waitFor(async () => { completed = await service.dispatch('inspectGeneration', { projectId, generationId: job.id }) as GenerationSnapshot; expect(completed.status).toBe('succeeded'); });
    expect(completed.result?.team).toEqual(team);
    const input = runProvider.mock.calls[0][0];
    expect(input).toMatchObject({ noTools: true, permissionMode: 'read-only' });
    expect(input.prompt).toContain('explicit interventions'); expect(input.prompt).toContain('API engineer');
    expect(input.prompt).not.toContain('Do not transmit this content.');
    expect(store.graphs(projectId)).toEqual([]); expect(store.runs(projectId)).toEqual([]);
  });
  it('rejects traversal, symlink, secret and oversized briefs before any paid request', async () => {
    await writeFile(join(root, 'large.md'), 'x'.repeat(33 * 1024));
    await writeFile(join(root, '.env'), 'SECRET=never-send');
    await symlink(join(root, 'brief.md'), join(root, 'linked.md'));
    for (const path of ['../outside.md', '.env', 'linked.md', 'large.md']) {
      await expect(service.dispatch('generateGraph', { projectId, graph: createCommandGraph(), prompt: 'Staff team', provider: 'claude', planning: { stage: 'team', briefPaths: [path] } })).rejects.toThrow();
    }
    expect(runProvider).not.toHaveBeenCalled();
  });
  it('bounds total brief context, excludes secret filenames, and does not expose unselected file contents', async () => {
    await mkdir(join(root, 'docs')); await writeFile(join(root, '.env'), 'secret');
    for (let i = 0; i < 4; i++) await writeFile(join(root, `docs/${i}.md`), 'a'.repeat(30 * 1024));
    await expect(planningContext(root, ['docs/0.md', 'docs/1.md', 'docs/2.md', 'docs/3.md'], [])).rejects.toThrow('planning budget');
    const context = await planningContext(root, [], []);
    expect(context.briefs).toEqual([]); expect(context.manifest.some(file => file.path === '.env')).toBe(false);
  });
  it('rejects a graph that silently changes an approved role, model, provider or permission', () => {
    const graph = createCommandGraph();
    const agent = { id: 'api', label: 'API', kind: 'agent' as const, position: { x: 0, y: 0 }, retry: { maxAttempts: 1, delayMs: 0 }, timeoutMs: 1000, disabled: false, ports: [], config: { role, provider: 'codex' as const, instructions: 'Implement API', permission: 'scoped-edit' as const, allowedTools: [] } };
    graph.nodes.push(agent, { ...agent, id: 'reviewer', config: { ...agent.config, role: reviewer, provider: 'claude', permission: 'read-only' } });
    expect(() => assertApprovedTeam(graph, team)).not.toThrow();
    agent.config.role = { ...role, owns: ['**'] }; expect(() => assertApprovedTeam(graph, team)).toThrow('unchanged role');
    agent.config.role = role;
    Object.assign(agent.config, { model: 'unapproved-model' }); expect(() => assertApprovedTeam(graph, team)).toThrow('provider, model and permissions');
  });
  it('checks role nodes: unchanged role, approved provider and model for inner agents, no edits for read-only members', () => {
    const graph = createCommandGraph();
    const api = createNode('role', 'api'); const review = createNode('role', 'review');
    if (api.kind !== 'role' || review.kind !== 'role') throw new Error('role node expected');
    api.config.role = role; review.config.role = reviewer;
    for (const step of api.config.playbook.nodes) if (step.kind === 'agent') step.config.provider = 'codex';
    for (const step of review.config.playbook.nodes) if (step.kind === 'agent') Object.assign(step.config, { provider: 'claude', permission: 'read-only' });
    graph.nodes.push(api, review);
    expect(() => assertApprovedTeam(graph, team)).not.toThrow();
    const plan = api.config.playbook.nodes.find(step => step.id === 'plan');
    if (plan?.kind === 'agent') plan.config.provider = 'claude';
    expect(() => assertApprovedTeam(graph, team)).toThrow('approved provider and model');
    if (plan?.kind === 'agent') plan.config.provider = 'codex';
    const reviewStep = review.config.playbook.nodes.find(step => step.id === 'implement');
    if (reviewStep?.kind === 'agent') reviewStep.config.permission = 'scoped-edit';
    expect(() => assertApprovedTeam(graph, team)).toThrow('read-only role');
  });
});
