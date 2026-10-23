// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import OrchestratorPanel from './OrchestratorPanel.js';
import { api } from './api.js';
import { emptyGraph } from './model.js';
vi.mock('./api.js', () => ({ api: vi.fn() }));

const graph = { ...emptyGraph(), id: 'flow', name: 'Simulator build', revision: 3 };
const proposal = (id: string, title: string, widensScope = false) => ({ id, title, rationale: 'Seen in 2 runs.', status: 'open', widensScope, evidence: { count: 2 }, changes: [{ nodeId: 'gate', field: 'config.maxIterations', from: 1, to: 2 }] });
let lessons: { id: string; text: string; source: string }[];
let calls: { method: string; params: Record<string, unknown> }[];
beforeEach(() => {
  lessons = []; calls = [];
  vi.mocked(api).mockImplementation(async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ method, params });
    if (method === 'lessons') return lessons as T;
    if (method === 'workflowInsights') return { revision: 3, metrics: { runs: 2, succeeded: 0, failed: 2, steps: [{ nodeId: 'gate', label: 'Test gate', runs: 2, attempts: 4, failures: 2, loopExhausted: 2, timeouts: 0, ownershipViolations: 0, flaky: 0, medianDurationMs: 10, costUsd: null }] }, proposals: [proposal('p1', 'Allow one more iteration for Test gate'), proposal('p2', 'Let Engineer own lib', true)] } as T;
    if (method === 'applyProposal') return { ...graph, revision: 4 } as T;
    if (method === 'saveLesson') { lessons = [...lessons, { id: 'l1', text: params.text as string, source: 'user' }]; return lessons[0] as T; }
    if (method === 'deleteLesson') { lessons = []; return { deleted: true } as T; }
    return {} as T;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('orchestrator panel', () => {
  it('shows measurements and applies a proposal as a new revision', async () => {
    const onGraphSaved = vi.fn();
    render(<OrchestratorPanel projectId="p" graph={graph} saved onGraphSaved={onGraphSaved}/>);
    expect(await screen.findByText('2 finished runs · 0 succeeded · 2 failed')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'unknown' })).toBeInTheDocument();
    const card = screen.getByRole('article', { name: 'Allow one more iteration for Test gate' });
    expect(within(card).getByText('gate.config.maxIterations')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Apply as new revision' }));
    await waitFor(() => expect(onGraphSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 })));
  });
  it('asks before applying a proposal that widens a role and does nothing if declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<OrchestratorPanel projectId="p" graph={graph} saved onGraphSaved={vi.fn()}/>);
    const card = await screen.findByRole('article', { name: 'Let Engineer own lib' });
    expect(within(card).getByText('Widens what a role may change.')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Apply as new revision' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(calls.some(call => call.method === 'applyProposal')).toBe(false);
  });
  it('adds and deletes project lessons, and explains unsaved workflows', async () => {
    render(<OrchestratorPanel projectId="p" graph={graph} saved={false} onGraphSaved={vi.fn()}/>);
    expect(await screen.findByText('Save this workflow to measure it across runs.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New lesson'), { target: { value: 'Pass seeds explicitly.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add lesson' }));
    expect(await screen.findByText('Pass seeds explicitly.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete lesson: Pass seeds explicitly.' }));
    await waitFor(() => expect(screen.queryByText('Pass seeds explicitly.')).not.toBeInTheDocument());
    expect(calls.some(call => call.method === 'workflowInsights')).toBe(false);
  });
});
