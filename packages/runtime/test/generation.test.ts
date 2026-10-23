import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../persistence/src/index.js';
import { NodalService } from '../src/service.js';
import { startServer } from '../src/server.js';
import { createCommandGraph } from '../../core/src/templates.js';
import type { GenerationSnapshot } from '../../shared/src/generation.js';
const { runProvider, checkAvailability } = vi.hoisted(() => ({ runProvider: vi.fn(), checkAvailability: vi.fn() }));
vi.mock('../../providers/src/index.js', () => ({ runProvider, checkAvailability }));
let store: Store, service: NodalService, data: string, projectId: string;
beforeEach(async () => { runProvider.mockReset(); checkAvailability.mockReset().mockResolvedValue({ id: 'claude', available: true, authentication: 'authenticated', message: 'Signed in.' }); data = await mkdtemp(join(tmpdir(), 'nodal-planning-test-')); store = new Store(':memory:'); projectId = store.addProject(data, 'Planning').id; service = new NodalService(store, data); });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const start = () => service.dispatch('startGeneration', { projectId, graph: createCommandGraph(), prompt: 'Add a gate', provider: 'claude' }) as Promise<GenerationSnapshot>;
const inspect = (id: string) => service.dispatch('inspectGeneration', { projectId, generationId: id }) as Promise<GenerationSnapshot>;
async function finished(id: string) {
  let snapshot!: GenerationSnapshot;
  await vi.waitFor(async () => { snapshot = await inspect(id); expect(snapshot.status).not.toBe('running'); });
  return snapshot;
}
describe('background graph generation', () => {
  it('returns a running job over authenticated desktop HTTP and polls through completion', async () => {
    const provider = deferred<{ output: string }>(); runProvider.mockReturnValue(provider.promise);
    const runtime = await startServer(service);
    const request = (method: string, params: Record<string, unknown>) => fetch(`${runtime.url}/api`, {
      method: 'POST', headers: { Origin: 'tauri://localhost', Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(2000),
    });
    try {
      const response = await request('startGeneration', { projectId, graph: createCommandGraph(), prompt: 'Add a gate', provider: 'claude' });
      expect(response.status).toBe(200); expect(response.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
      const { result: job } = await response.json() as { result: GenerationSnapshot };
      expect(job.status).toBe('running');
      await vi.waitFor(() => expect(runProvider).toHaveBeenCalledTimes(1));
      const running = await request('inspectGeneration', { projectId, generationId: job.id });
      expect((await running.json()).result.status).toBe('running');
      const other = store.addProject(join(data, 'http-other'), 'Other').id;
      const denied = await request('inspectGeneration', { projectId: other, generationId: job.id });
      expect(denied.status).toBe(400); expect((await denied.json()).error).toContain('not found for this project');
      provider.resolve({ output: JSON.stringify(createCommandGraph()) });
      await vi.waitFor(async () => {
        const completed = await request('inspectGeneration', { projectId, generationId: job.id });
        expect(completed.status).toBe(200);
        expect((await completed.json()).result).toMatchObject({ status: 'succeeded', result: { graph: createCommandGraph(), attempts: 1 } });
      });
      expect(store.graphs(projectId)).toEqual([]); expect(store.runs(projectId)).toEqual([]);
    } finally {
      provider.resolve({ output: JSON.stringify(createCommandGraph()) });
      await runtime.close();
    }
  });
  it('returns before preflight or the provider finishes, then exposes a validated isolated preview', async () => {
    const preflight = deferred<{ available: boolean; authentication: string }>();
    checkAvailability.mockReturnValue(preflight.promise);
    const provider = deferred<{ output: string }>(); runProvider.mockReturnValue(provider.promise);
    const job = await start();
    expect(job.status).toBe('running'); expect(runProvider).not.toHaveBeenCalled();
    preflight.resolve({ available: true, authentication: 'unknown' });
    await vi.waitFor(() => expect(runProvider).toHaveBeenCalledTimes(1));
    expect((await inspect(job.id)).status).toBe('running');
    provider.resolve({ output: JSON.stringify(createCommandGraph()) });
    const result = await finished(job.id);
    expect(result).toMatchObject({ status: 'succeeded', finishedAt: expect.any(String), result: { attempts: 1, summary: expect.stringContaining('Review every command') } });
    expect(result.result?.graph).toEqual(createCommandGraph());
    result.result!.graph.name = 'Changed by caller';
    expect((await inspect(job.id)).result?.graph.name).not.toBe('Changed by caller');
    expect(store.graphs(projectId)).toEqual([]); expect(store.runs(projectId)).toEqual([]);
  });
  it('rejects duplicate starts, unknown projects, cross-project access, unknown IDs, and extra parameters', async () => {
    const preflight = deferred<{ available: boolean; authentication: string }>(); checkAvailability.mockReturnValue(preflight.promise);
    const job = await start(); const other = store.addProject(join(data, 'other'), 'Other').id;
    await expect(start()).rejects.toThrow('already has a generation');
    for (const method of ['inspectGeneration', 'cancelGeneration']) {
      await expect(service.dispatch(method, { projectId: other, generationId: job.id })).rejects.toThrow('not found');
      await expect(service.dispatch(method, { projectId, generationId: 'unknown' })).rejects.toThrow('not found');
      await expect(service.dispatch(method, { projectId, generationId: job.id, extra: true })).rejects.toThrow();
    }
    await expect(service.dispatch('startGeneration', { projectId: 'unknown', graph: createCommandGraph(), prompt: 'Generate', provider: 'claude' })).rejects.toThrow();
    expect((await inspect(job.id)).status).toBe('running'); expect(checkAvailability).toHaveBeenCalledTimes(1);
    await service.dispatch('cancelGeneration', { projectId, generationId: job.id });
    preflight.resolve({ available: true, authentication: 'authenticated' });
    await new Promise(resolve => setImmediate(resolve));
    expect(runProvider).not.toHaveBeenCalled();
  });
  it('sanitizes and bounds provider errors without retrying a failed provider turn', async () => {
    runProvider.mockRejectedValue(new Error('API_KEY=secret-value sk-ant-1234567890123456 ' + 'x'.repeat(5000)));
    const result = await finished((await start()).id);
    expect(result.status).toBe('failed'); expect(result.error).toContain('[REDACTED]');
    expect(result.error).not.toContain('secret-value'); expect(result.error).not.toContain('1234567890123456');
    expect(result.error!.length).toBeLessThanOrEqual(4000); expect(result.result).toBeUndefined();
    expect(runProvider).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'unavailable'])('fails %s preflight without a model request', async reason => {
    checkAvailability.mockResolvedValue({ available: reason !== 'unavailable', authentication: reason === 'missing' ? 'missing' : 'unknown', message: 'Install or sign in to the official CLI.' });
    const result = await finished((await start()).id);
    expect(result.status).toBe('failed'); expect(result.error).toContain('No model request was made');
    expect(result.error).toContain(reason === 'missing' ? 'claude auth login' : 'unavailable');
    expect(runProvider).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'close'])('keeps cancellation final after %s even when a provider returns late', async action => {
    const provider = deferred<{ output: string }>(); runProvider.mockReturnValue(provider.promise);
    const job = await start(); await vi.waitFor(() => expect(runProvider).toHaveBeenCalledTimes(1));
    if (action === 'close') await service.close();
    else await service.dispatch('cancelGeneration', { projectId, generationId: job.id });
    expect(runProvider.mock.calls[0][0].signal.aborted).toBe(true);
    expect((await inspect(job.id)).status).toBe('cancelled');
    provider.resolve({ output: JSON.stringify(createCommandGraph()) });
    await new Promise(resolve => setImmediate(resolve));
    expect(await inspect(job.id)).toMatchObject({ status: 'cancelled', finishedAt: expect.any(String) });
    expect((await inspect(job.id)).result).toBeUndefined();
    expect(runProvider).toHaveBeenCalledTimes(1);
  });
  it('corrects an invalid background result once and reports exhausted validation as failure', async () => {
    runProvider.mockResolvedValueOnce({ output: 'not JSON' }).mockResolvedValueOnce({ output: JSON.stringify(createCommandGraph()) });
    const corrected = await finished((await start()).id);
    expect(corrected).toMatchObject({ status: 'succeeded', result: { attempts: 2 } });
    expect(runProvider.mock.calls[1][0]).toMatchObject({ noTools: true, permissionMode: 'read-only', maxTurns: 6 });
    runProvider.mockReset().mockResolvedValue({ output: 'not JSON' });
    const invalid = await finished((await start()).id);
    expect(invalid.status).toBe('failed'); expect(invalid.error).toContain('after two attempts');
    expect(runProvider).toHaveBeenCalledTimes(2); expect(store.graphs(projectId)).toEqual([]);
  });
  it('caps active operations across projects, including cancelled providers still unwinding', async () => {
    const preflight = deferred<{ available: boolean; authentication: string }>(); checkAvailability.mockReturnValue(preflight.promise);
    const job = await start();
    for (let i = 0; i < 3; i++) {
      const other = store.addProject(join(data, String(i)), String(i)).id;
      await service.dispatch('startGeneration', { projectId: other, graph: createCommandGraph(), prompt: 'Generate', provider: 'claude' });
    }
    await service.dispatch('cancelGeneration', { projectId, generationId: job.id });
    await expect(start()).rejects.toThrow('Too many active generations');
    await service.close(); preflight.resolve({ available: true, authentication: 'authenticated' });
    await new Promise(resolve => setImmediate(resolve));
    expect(runProvider).not.toHaveBeenCalled();
    await expect(start()).rejects.toThrow('Runtime is closing');
  });
  it('retains only 32 finished jobs and leaves the newest result inspectable', async () => {
    checkAvailability.mockResolvedValue({ available: false, authentication: 'unknown', message: 'Unavailable' });
    const jobs: string[] = [];
    for (let i = 0; i < 33; i++) {
      const job = await start(); jobs.push(job.id);
      await new Promise(resolve => setImmediate(resolve));
      expect((await inspect(job.id)).status).toBe('failed');
    }
    await expect(inspect(jobs[0])).rejects.toThrow('not found');
    expect((await inspect(jobs[1])).status).toBe('failed');
    expect((await inspect(jobs[32])).status).toBe('failed');
    expect(runProvider).not.toHaveBeenCalled();
  });
});
