// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GenerationPanel from './GenerationPanel.js';
import { api } from './api.js';
import { emptyGraph } from './model.js';
import type { GenerationSnapshot } from '../../../packages/shared/src/generation.js';
vi.mock('./api.js', () => ({ api: vi.fn() }));
const graph = emptyGraph();
const ready = [{ id: 'claude', available: true, authenticated: true, status: 'authenticated' }, { id: 'codex', available: true, authenticated: true, status: 'authenticated' }];
const running: GenerationSnapshot = { id: 'generation-1', projectId: 'p', provider: 'claude', status: 'running', createdAt: 'now' };
const success: GenerationSnapshot = { ...running, status: 'succeeded', result: { graph: { ...graph, name: 'Generated workflow' }, summary: 'A reviewed plan', attempts: 1 } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function open() { const onApply = vi.fn(); const onPromptChange = vi.fn(); return { ...render(<GenerationPanel projectId="p" graph={graph} prompt="Keep this plan" onPromptChange={onPromptChange} onApply={onApply}/>), onApply, onPromptChange }; }
async function generate() { const button = await screen.findByRole('button', { name: 'Generate preview' }); await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); }
beforeEach(() => {
  vi.mocked(api).mockImplementation(async <T,>(method: string): Promise<T> => {
    if (method === 'providerStatus') return ready as T;
    if (method === 'startGeneration') return running as T;
    if (method === 'inspectGeneration') return success as T;
    if (method === 'cancelGeneration') return { accepted: true } as T;
    throw new Error(`Unexpected ${method}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('workflow generation panel', () => {
  it('waits for the job, polls running work, and applies only after explicit review', async () => {
    const start = deferred<GenerationSnapshot>();
    let inspections = 0;
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'startGeneration' ? start.promise as ReturnType<typeof api> : method === 'inspectGeneration' ? Promise.resolve(++inspections === 1 ? running : success) as ReturnType<typeof api> : implementation(method, params, options));
    const view = open(); await generate();
    expect(screen.getByRole('status')).toHaveTextContent('Starting generation');
    expect(api).not.toHaveBeenCalledWith('inspectGeneration', expect.anything(), expect.anything());
    await act(async () => { start.resolve(running); });
    expect(screen.getByRole('status')).toHaveTextContent('Generating workflow');
    await screen.findByText('A reviewed plan', {}, { timeout: 2500 });
    expect(view.onApply).not.toHaveBeenCalled();
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === 'startGeneration')).toHaveLength(1);
    expect(api).toHaveBeenCalledWith('startGeneration', { projectId: 'p', graph, prompt: 'Keep this plan', provider: 'claude' });
    expect(api).toHaveBeenCalledWith('inspectGeneration', { projectId: 'p', generationId: 'generation-1' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to canvas' }));
    expect(view.onApply).toHaveBeenCalledWith(success.result!.graph);
  });

  it('shows official CLI login commands and refreshes without a separate connection', async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    let checks = 0;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'providerStatus' ? Promise.resolve(++checks === 1 ? [{ ...ready[0], authenticated: false, status: 'missing', loginCommand: 'claude auth login' }, { ...ready[1], authenticated: false, status: 'missing', loginCommand: 'codex login' }] : ready) as ReturnType<typeof api> : implementation(method, params, options));
    open();
    await screen.findByText('claude auth login'); expect(screen.getByText('codex login')).toBeInTheDocument();
    expect(screen.getByText(/reuses your existing official Claude and Codex CLI logins/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate preview' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate preview' })).toBeEnabled());
  });

  it('allows unknown authentication and makes provider check errors refreshable', async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    let checks = 0;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'providerStatus' ? (++checks === 1 ? Promise.reject(new Error('Runtime disconnected')) : Promise.resolve([{ ...ready[0], authenticated: false, status: 'unknown' }])) as ReturnType<typeof api> : implementation(method, params, options));
    open(); await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Use Refresh');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Generate preview' })).toBeEnabled();
  });

  it('preserves the prompt after backend failure and permits an explicit retry', async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    let inspections = 0;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'inspectGeneration' ? Promise.resolve(++inspections === 1 ? { ...running, status: 'failed', error: 'Provider limit reached. Try again later.' } : success) as ReturnType<typeof api> : implementation(method, params, options));
    open(); await generate();
    await screen.findByText('Provider limit reached. Try again later.');
    expect(screen.getByLabelText('What should this workflow do?')).toHaveValue('Keep this plan');
    expect(api).toHaveBeenCalledWith('cancelGeneration', { projectId: 'p', generationId: 'generation-1' }, { keepalive: true });
    await generate(); await screen.findByText('A reviewed plan');
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === 'startGeneration')).toHaveLength(2);
  });

  it('cancels the same job and ignores a late successful poll', async () => {
    const inspected = deferred<GenerationSnapshot>();
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'inspectGeneration' ? inspected.promise as ReturnType<typeof api> : implementation(method, params, options));
    const view = open(); await generate();
    await waitFor(() => expect(api).toHaveBeenCalledWith('inspectGeneration', expect.anything(), expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel generation' }));
    await screen.findByText('Generation cancelled.');
    await act(async () => { inspected.resolve(success); });
    expect(screen.queryByText('A reviewed plan')).not.toBeInTheDocument(); expect(view.onApply).not.toHaveBeenCalled();
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === 'cancelGeneration')).toHaveLength(1);
  });

  it('cancels a late start response after unmount without aborting the start request', async () => {
    const start = deferred<GenerationSnapshot>();
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'startGeneration' ? start.promise as ReturnType<typeof api> : implementation(method, params, options));
    const view = open(); await generate(); view.unmount();
    await act(async () => { start.resolve(running); });
    expect(api).toHaveBeenCalledWith('cancelGeneration', { projectId: 'p', generationId: 'generation-1' }, { keepalive: true });
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === 'cancelGeneration')).toHaveLength(1);
    expect(vi.mocked(api).mock.calls.find(([method]) => method === 'startGeneration')?.[2]).toBeUndefined();
    expect(api).not.toHaveBeenCalledWith('inspectGeneration', expect.anything(), expect.anything());
  });

  it('reports a polling transport error, cleans up, and never automatically restarts generation', async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'inspectGeneration' ? Promise.reject(new Error('Local runtime response interrupted')) : implementation(method, params, options));
    open(); await generate(); await screen.findByText('Local runtime response interrupted');
    expect(screen.getByLabelText('What should this workflow do?')).toHaveValue('Keep this plan');
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === 'startGeneration')).toHaveLength(1);
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === 'cancelGeneration')).toHaveLength(1);
  });

  it('waits for the start identifier when cancellation is requested during startup', async () => {
    const start = deferred<GenerationSnapshot>();
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'startGeneration' ? start.promise as ReturnType<typeof api> : implementation(method, params, options));
    open(); await generate();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel generation' }));
    expect(screen.getByRole('status')).toHaveTextContent('Cancelling');
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === 'cancelGeneration')).toHaveLength(0);
    await act(async () => { start.resolve(running); });
    await screen.findByText('Generation cancelled.');
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === 'cancelGeneration')).toHaveLength(1);
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === 'inspectGeneration')).toHaveLength(0);
  });

  it('cancels the original project job and ignores its result when the project changes', async () => {
    const inspected = deferred<GenerationSnapshot>();
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'inspectGeneration' ? inspected.promise as ReturnType<typeof api> : implementation(method, params, options));
    const view = open(); await generate();
    await waitFor(() => expect(api).toHaveBeenCalledWith('inspectGeneration', expect.anything(), expect.anything()));
    view.rerender(<GenerationPanel projectId="new-project" graph={graph} prompt="A new plan" onPromptChange={view.onPromptChange} onApply={view.onApply}/>);
    await act(async () => { inspected.resolve(success); });
    expect(api).toHaveBeenCalledWith('cancelGeneration', { projectId: 'p', generationId: 'generation-1' }, { keepalive: true });
    expect(screen.queryByText('A reviewed plan')).not.toBeInTheDocument();
    expect(screen.getByLabelText('What should this workflow do?')).toHaveValue('A new plan');
    expect(view.onApply).not.toHaveBeenCalled();
  });

  it('reports cancellation failure honestly and rejects invalid generated graphs', async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'inspectGeneration' ? Promise.resolve({ ...success, result: { ...success.result!, graph: { ...graph, nodes: [] } } }) as ReturnType<typeof api> : method === 'cancelGeneration' ? Promise.reject(new Error('Runtime unavailable')) : implementation(method, params, options));
    const view = open(); await generate(); await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not confirm cancellation');
    expect(screen.getByRole('alert')).toHaveTextContent('may still be running');
    expect(screen.getByRole('button', { name: 'Apply to canvas' })).toBeDisabled(); expect(view.onApply).not.toHaveBeenCalled();
  });
});
