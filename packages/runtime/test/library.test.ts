import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphSchema, type Graph } from '../../shared/src/index.js';
import { Store } from '../../persistence/src/index.js';
import { git } from '../../workspace/src/index.js';
import { NodalService } from '../src/service.js';
import { instantiate, parameterCandidates } from '../src/library.js';
vi.mock('../../providers/src/index.js', () => ({ runProvider: vi.fn(), checkAvailability: vi.fn() }));

let library: string, nodeRepo: string, pythonRepo: string, data: string, store: Store, service: NodalService, nodeProject: string, pythonProject: string;
async function repo(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'nodal-library-repo-'));
  await git(root, ['init']);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  for (const args of [['add', '-A'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']]) { const result = await git(root, args); if (result.exitCode !== 0) throw new Error(result.stderr); }
  return root;
}
beforeEach(async () => {
  library = await mkdtemp(join(tmpdir(), 'nodal-library-')); data = await mkdtemp(join(tmpdir(), 'nodal-library-data-'));
  nodeRepo = await repo({ 'package.json': '{"scripts":{"test":"vitest"}}', 'backend/index.ts': 'export {};' });
  pythonRepo = await repo({ 'pyproject.toml': '[project]\nname="x"', 'server/app.py': 'pass' });
  store = new Store(':memory:'); nodeProject = store.addProject(nodeRepo, 'node-app').id; pythonProject = store.addProject(pythonRepo, 'python-app').id;
  service = new NodalService(store, data);
  await service.dispatch('setLibraryLocation', { path: library });
});
afterEach(async () => { await service.close(); store.close(); for (const dir of [library, nodeRepo, pythonRepo, data]) await rm(dir, { recursive: true, force: true }); });

const workflow = (): Graph => GraphSchema.parse({ id: 'build', name: 'Backend build', nodes: [
  { id: 'start', kind: 'start', label: 'Start' },
  { id: 'api', kind: 'agent', label: 'API', config: { provider: 'codex', permission: 'scoped-edit', instructions: 'Build the API in backend/.', role: { id: 'api', title: 'API engineer', expertise: 'Builds APIs.', owns: ['backend/**'], knowledge: ['backend/index.ts'] } } },
  { id: 'tests', kind: 'command', label: 'Tests', config: { command: 'npm', args: ['test'] } },
  { id: 'gate', kind: 'quality_gate', label: 'Gate', config: { predicate: { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 2 } },
  { id: 'end', kind: 'end', label: 'End' },
], edges: [{ id: '1', source: 'start', target: 'api' }, { id: '2', source: 'api', target: 'tests' }, { id: '3', source: 'tests', target: 'gate' }, { id: '4', source: 'gate', target: 'end', sourcePort: 'pass' }, { id: '5', source: 'gate', target: 'api', kind: 'loop', sourcePort: 'fail' }] });
const parameters = [{ name: 'backendDir', kind: 'path', value: 'backend', description: 'Where the API lives' }, { name: 'testCommand', kind: 'command', value: 'npm test', description: 'Runs the tests' }];

describe('workflow library', () => {
  it('suggests project-specific values as parameters', () => {
    expect(parameterCandidates(workflow())).toEqual([{ kind: 'path', value: 'backend', suggestedName: 'backendDir' }, { kind: 'command', value: 'npm test', suggestedName: 'testCommand' }]);
  });
  it('exports with placeholders and imports into a different project with detected and bound values', async () => {
    const saved = await service.dispatch('exportToLibrary', { projectId: nodeProject, kind: 'workflow', name: 'Backend build', changelog: 'First version', graph: workflow(), parameters }) as { slug: string; version: number };
    expect(saved).toMatchObject({ slug: 'backend-build', version: 1 });
    const file = await readFile(join(library, 'workflows/backend-build/1.json'), 'utf8');
    expect(file).toContain('{{backendDir}}/**'); expect(file).toContain('"command": "{{testCommand}}"'); expect(file).not.toMatch(/"backend\//);

    const preview = await service.dispatch('previewImport', { projectId: pythonProject, kind: 'workflow', slug: 'backend-build', version: 1 }) as { bindings: Record<string, string>; missing: string[] };
    expect(preview.bindings).toEqual({ backendDir: 'backend', testCommand: 'python3 -m pytest' });
    const bound = await service.dispatch('previewImport', { projectId: pythonProject, kind: 'workflow', slug: 'backend-build', version: 1, bindings: { backendDir: 'server' } }) as { result: { graph: Graph; problems: string[] } };
    const graph = bound.result.graph;
    expect(bound.result.problems).toEqual([]);
    const api = graph.nodes.find(node => node.id === 'api');
    expect(api?.kind === 'agent' && api.config.role).toMatchObject({ owns: ['server/**'], knowledge: ['server/index.ts'] });
    expect(api?.kind === 'agent' && api.config.instructions).toBe('Build the API in backend/.');
    expect(graph.nodes.find(node => node.id === 'tests')).toMatchObject({ config: { command: 'python3', args: ['-m', 'pytest'] } });
    expect(graph.origin).toEqual({ library: 'backend-build', version: 1, bindings: { backendDir: 'server', testCommand: 'python3 -m pytest' } });
    expect(graph.id).not.toBe('build');

    // Publishing an imported workflow back keeps its library identity and adds a version; version 1 is untouched.
    const next = await service.dispatch('exportToLibrary', { projectId: pythonProject, kind: 'workflow', name: 'Backend build', changelog: 'One more iteration', graph, parameters: [{ name: 'backendDir', kind: 'path', value: 'server', description: '' }, { name: 'testCommand', kind: 'command', value: 'python3 -m pytest', description: '' }] }) as { version: number };
    expect(next.version).toBe(2);
    expect(await readFile(join(library, 'workflows/backend-build/1.json'), 'utf8')).toBe(file);
    const info = await service.dispatch('libraryInfo', {}) as { items: { slug: string; version: number }[]; errors: string[] };
    expect(info.items.map(item => `${item.slug}@${item.version}`)).toEqual(['backend-build@1', 'backend-build@2']);
  });
  it('imports roles and lessons into a project and requires every parameter', async () => {
    const role = { id: 'api', title: 'API engineer', expertise: 'Builds APIs.', owns: ['backend/**'], knowledge: [], produces: [], consumes: [], skills: ['Validate inputs.'] };
    store.saveRole(nodeProject, role);
    await service.dispatch('exportToLibrary', { projectId: nodeProject, kind: 'role', name: 'API engineer', roleId: 'api', parameters: [{ name: 'apiDir', kind: 'path', value: 'backend' }] });
    await expect(service.dispatch('importToProject', { projectId: pythonProject, kind: 'role', slug: 'api-engineer', version: 1, bindings: { apiDir: ' ' } })).rejects.toThrow('apiDir');
    await service.dispatch('importToProject', { projectId: pythonProject, kind: 'role', slug: 'api-engineer', version: 1, bindings: { apiDir: 'server' } });
    expect(store.roles(pythonProject)).toEqual([expect.objectContaining({ title: 'API engineer', owns: ['server/**'], skills: ['Validate inputs.'] })]);
    const lesson = store.saveLesson({ id: 'l', projectId: nodeProject, text: 'Pass seeds explicitly.', source: 'user', createdAt: 'now', updatedAt: 'now' });
    await service.dispatch('exportToLibrary', { projectId: nodeProject, kind: 'lesson', name: 'Seeds', lessonId: lesson.id });
    await service.dispatch('importToProject', { projectId: pythonProject, kind: 'lesson', slug: 'seeds', version: 1 });
    expect(store.lessons(pythonProject).map(item => item.text)).toEqual(['Pass seeds explicitly.']);
  });
  it('treats library files as untrusted: reports invalid files, rejects credentials and undeclared placeholders', async () => {
    await mkdir(join(library, 'workflows/broken'), { recursive: true }); await writeFile(join(library, 'workflows/broken/1.json'), '{"nodalLibrary": 1}');
    await mkdir(join(library, 'lessons/leak'), { recursive: true });
    await writeFile(join(library, 'lessons/leak/1.json'), JSON.stringify({ nodalLibrary: 1, kind: 'lesson', slug: 'leak', name: 'Leak', version: 1, origin: { project: 'x', exportedAt: 'now' }, content: { text: 'Use API_KEY=sk-ant-abcdefghijklmnopqrstu' } }));
    const info = await service.dispatch('libraryInfo', {}) as { errors: string[] };
    expect(info.errors).toEqual([expect.stringContaining('workflows/broken/1.json')]);
    await expect(service.dispatch('previewImport', { projectId: pythonProject, kind: 'lesson', slug: 'leak', version: 1 })).rejects.toThrow('credentials');
    expect(() => instantiate({ owns: ['{{missing}}/**'] }, [], {})).toThrow('{{missing}}');
  });
});
