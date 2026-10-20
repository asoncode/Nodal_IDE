import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../persistence/src/index.js';
import { NodalService } from '../src/service.js';
import { createCommandGraph } from '../../core/src/templates.js';
const { runProvider } = vi.hoisted(() => ({ runProvider: vi.fn() }));
vi.mock('../../providers/src/index.js', () => ({ runProvider, checkAvailability: vi.fn() }));
let store: Store, service: NodalService, data: string, projectId: string;
beforeEach(async () => { runProvider.mockReset(); data = await mkdtemp(join(tmpdir(), 'nodal-planning-test-')); store = new Store(':memory:'); projectId = store.addProject(data, 'Planning').id; service = new NodalService(store, data); });
afterEach(async () => { await service.close(); store.close(); await rm(data, { recursive: true, force: true }); });
describe('untrusted graph planning boundary', () => {
  it('uses the SDK-supported schema dialect, disables tools, corrects once, and never applies or runs the preview', async () => {
    runProvider.mockResolvedValueOnce({ output: '{"invalid":"shape"}' }).mockResolvedValueOnce({ output: JSON.stringify(createCommandGraph()) });
    const preview = await service.dispatch('generateGraph', { projectId, graph: createCommandGraph(), prompt: 'Add a gate', provider: 'claude' }) as { attempts: number };
    expect(preview.attempts).toBe(2); expect(runProvider).toHaveBeenCalledTimes(2);
    expect(runProvider.mock.calls[0][0]).toMatchObject({ noTools: true, maxTurns: 6, permissionMode: 'read-only', outputSchema: { $schema: 'http://json-schema.org/draft-07/schema#' } });
    expect(runProvider.mock.calls[1][0].prompt).toContain('Correct this invalid graph');
    expect(store.graphs(projectId)).toEqual([]); expect(store.runs(projectId)).toEqual([]);
  });
  it('stops after two invalid responses and preserves the existing saved draft', async () => {
    const saved = store.saveGraph(projectId, createCommandGraph()); runProvider.mockResolvedValue({ output: 'not JSON' });
    await expect(service.dispatch('generateGraph', { projectId, graph: saved, prompt: 'Modify this graph', provider: 'claude' })).rejects.toThrow('after two attempts');
    expect(runProvider).toHaveBeenCalledTimes(2); expect(store.graphs(projectId)).toEqual([saved]); expect(store.runs(projectId)).toEqual([]);
  });
});
