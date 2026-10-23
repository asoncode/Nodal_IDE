// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ChatPanel from './ChatPanel.js';
import { api } from './api.js';
import { createNode, emptyGraph, type Graph } from './model.js';
vi.mock('./api.js', () => ({ api: vi.fn() }));

const project = { id: 'p', name: 'causal-xi', root: '/tmp/causal-xi' };
let graph: Graph, proposed: Graph, calls: { method: string; params: Record<string, unknown> }[];
beforeEach(() => {
  graph = emptyGraph();
  proposed = structuredClone(graph); const review = createNode('agent', 2); review.label = 'Security review'; proposed.nodes.push(review);
  proposed.edges = [{ id: 'a', source: proposed.nodes[0].id, target: review.id, kind: 'control' }, { id: 'b', source: review.id, target: proposed.nodes[1].id, kind: 'control' }];
  calls = [];
  vi.mocked(api).mockImplementation(async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ method, params });
    if (method === 'chats') return [] as T;
    if (method === 'startGeneration') return { id: 'gen', projectId: 'p', provider: 'claude', status: 'running', createdAt: 'now' } as T;
    if (method === 'inspectGeneration') return { id: 'gen', projectId: 'p', provider: 'claude', status: 'succeeded', createdAt: 'now', result: { graph: proposed, summary: '3 nodes.', attempts: 1 } } as T;
    if (method === 'createChat') return { id: 'chat', projectId: 'p', provider: 'claude', permission: 'read-only', title: 'Chat', createdAt: 'now', updatedAt: 'now' } as T;
    if (method === 'sendChat') return { id: 'turn', chatId: 'chat', message: params.message, output: '', status: 'running', createdAt: 'now' } as T;
    if (method === 'inspectChat') return { session: { id: 'chat' }, turns: [], events: [] } as T;
    throw new Error(`Unexpected ${method}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const type = (text: string) => fireEvent.change(screen.getByLabelText('Message agent'), { target: { value: text } });

describe('editing the workflow from chat', () => {
  it('drafts a requested change with the generator and applies it only on confirmation', async () => {
    const onApply = vi.fn();
    render(<ChatPanel project={project} graph={graph} onClose={() => {}} onApplyWorkflow={onApply}/>);
    type('Add a security review step before the end');
    expect(screen.getByText('Drafts a workflow change for you to review.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Draft workflow change' }));
    const card = await screen.findByRole('article', { name: 'Workflow proposal' });
    await within(card).findByText('Security review');
    expect(calls.find(call => call.method === 'startGeneration')?.params).toMatchObject({ projectId: 'p', graph, provider: 'claude', prompt: 'Add a security review step before the end' });
    expect(calls.some(call => call.method === 'sendChat' || call.method === 'createChat')).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Apply to canvas' }));
    expect(onApply).toHaveBeenCalledWith(proposed);
    expect(within(card).getByText('Applied')).toBeInTheDocument();
  });

  it('sends a detected request as a normal chat message when asked', async () => {
    render(<ChatPanel project={project} graph={graph} onClose={() => {}} onApplyWorkflow={vi.fn()}/>);
    type('Add a security review step before the end');
    fireEvent.click(screen.getByRole('button', { name: 'Send as chat instead' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send & approve' }));
    await waitFor(() => expect(calls.some(call => call.method === 'sendChat')).toBe(true));
    expect(calls.some(call => call.method === 'startGeneration')).toBe(false);
  });

  it('routes an undetected request when the workflow toggle is on', async () => {
    render(<ChatPanel project={project} graph={graph} onClose={() => {}} onApplyWorkflow={vi.fn()}/>);
    type('Add a security review before merge');
    expect(screen.getByRole('button', { name: 'Send & approve' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit workflow' }));
    expect(screen.getByRole('button', { name: 'Edit workflow' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Draft workflow change' }));
    await waitFor(() => expect(calls.some(call => call.method === 'startGeneration')).toBe(true));
  });

  it('asks before replacing a canvas that changed after the proposal was drafted', async () => {
    const onApply = vi.fn(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const view = render(<ChatPanel project={project} graph={graph} onClose={() => {}} onApplyWorkflow={onApply}/>);
    type('Add a security review step before the end'); fireEvent.click(screen.getByRole('button', { name: 'Draft workflow change' }));
    const card = await screen.findByRole('article', { name: 'Workflow proposal' }); await within(card).findByText('Security review');
    view.rerender(<ChatPanel project={project} graph={{ ...graph, name: 'Edited meanwhile' }} onClose={() => {}} onApplyWorkflow={onApply}/>);
    fireEvent.click(within(card).getByRole('button', { name: 'Apply to canvas' }));
    expect(confirm).toHaveBeenCalled(); expect(onApply).not.toHaveBeenCalled();
  });
});
