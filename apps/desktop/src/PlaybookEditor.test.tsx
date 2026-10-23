// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { defaultRoleNodeConfig, type Playbook, type ToolConfig } from '../../../packages/shared/src/index.js';
import PlaybookEditor from './PlaybookEditor.js';
import ToolEditor from './ToolEditor.js';

type FlowProps = { nodes: { id: string; data: { node: { label: string }; status: string } }[]; onNodeClick: (event: unknown, node: { id: string }) => void; onConnect: (connection: { source: string; target: string; sourceHandle?: string }) => void; children?: React.ReactNode };
let lastFlow: FlowProps;
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: FlowProps) => { lastFlow = props; return <div aria-label="Playbook graph">{props.nodes.map(node => <button key={node.id} data-status={node.data.status} onClick={() => props.onNodeClick({}, node)}>{node.data.node.label}</button>)}{props.children}</div>; },
  Background: () => null, Controls: () => null, Handle: () => null, BackgroundVariant: { Cross: 'cross' }, Position: { Left: 'left', Right: 'right' }, applyNodeChanges: vi.fn((_, nodes) => nodes),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function editor(states: Record<string, string> = {}) {
  let playbook: Playbook = defaultRoleNodeConfig().playbook;
  const onChange = vi.fn((next: Playbook) => { playbook = next; view.rerender(<PlaybookEditor title="Simulation" playbook={playbook} states={states} onChange={onChange}/>); });
  const view = render(<PlaybookEditor title="Simulation" playbook={playbook} states={states} onChange={onChange}/>);
  return { onChange, current: () => playbook };
}

describe('playbook editor', () => {
  it('adds a step and edits it through the step inspector', () => {
    const { current } = editor();
    fireEvent.change(screen.getByLabelText('Step type'), { target: { value: 'tool' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    expect(current().nodes.at(-1)).toMatchObject({ kind: 'tool', label: 'Search code' });
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'simulate(' } });
    expect(current().nodes.at(-1)).toMatchObject({ config: { tool: 'search', query: 'simulate(' } });
    fireEvent.click(screen.getByRole('button', { name: 'Implement' }));
    fireEvent.change(screen.getByLabelText('Step task'), { target: { value: 'Build the seeded simulator.' } });
    expect(current().nodes.find(node => node.id === 'implement')).toMatchObject({ config: { instructions: 'Build the seeded simulator.' } });
  });
  it('turns a gate fail connection to an earlier step into a bounded loop, and other connections into control edges', () => {
    const { current } = editor();
    lastFlow.onConnect({ source: 'gate', target: 'plan', sourceHandle: 'fail' });
    expect(current().edges.at(-1)).toMatchObject({ source: 'gate', target: 'plan', kind: 'loop', sourcePort: 'fail' });
    lastFlow.onConnect({ source: 'orient', target: 'review', sourceHandle: 'out' });
    expect(current().edges.at(-1)).toMatchObject({ kind: 'control' }); expect(current().edges.at(-1)).not.toHaveProperty('sourcePort');
  });
  it('protects start and end, deletes other steps with their connections, and shows inner run states', () => {
    const { current } = editor({ implement: 'running' });
    expect(screen.getByRole('button', { name: 'Implement' })).toHaveAttribute('data-status', 'running');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Self-review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(current().nodes.some(node => node.id === 'review')).toBe(false);
    expect(current().edges.some(edge => edge.source === 'review' || edge.target === 'review')).toBe(false);
  });
});

describe('tool editor', () => {
  it('publishes only valid configurations', () => {
    const onChange = vi.fn();
    const value: ToolConfig = { tool: 'validate', path: 'contracts/api.json', required: true };
    render(<ToolEditor value={value} onChange={onChange}/>);
    fireEvent.change(screen.getByLabelText('File to validate'), { target: { value: '../escape.json' } });
    expect(onChange).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('path');
    fireEvent.change(screen.getByLabelText('File to validate'), { target: { value: 'contracts/match.json' } });
    expect(onChange).toHaveBeenLastCalledWith({ tool: 'validate', path: 'contracts/match.json', required: true });
    fireEvent.change(screen.getByLabelText('JSON schema (optional)'), { target: { value: '{"type":' } });
    expect(screen.getByRole('alert')).toHaveTextContent('valid JSON');
    fireEvent.change(screen.getByLabelText('Tool'), { target: { value: 'git' } });
    expect(onChange).toHaveBeenLastCalledWith({ tool: 'git', mode: 'log', paths: [], maxResults: 50 });
  });
});
