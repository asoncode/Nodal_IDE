import { describe, expect, it } from 'vitest';
import { createNode, GraphSchema, type Graph, type WorkflowNode } from '../../shared/src/index.js';
import { validateGraph } from '../src/validation.js';
import { playbookGraph, type RoleNode } from '../src/playbook.js';
import { specialistPlaybookTeam } from '../src/templates.js';

function role(id: string, owns: string[]): RoleNode {
  const node = createNode('role', id) as RoleNode;
  node.config.role = { ...node.config.role, id, title: `${id} role`, owns };
  return node;
}
function team(...middle: WorkflowNode[]): Graph {
  const start = createNode('start', 'start'), end = createNode('end', 'end');
  const edges = middle.length ? [{ id: 's', source: 'start', target: middle[0]!.id, kind: 'control' as const }, ...middle.slice(1).map((node, i) => ({ id: `m${i}`, source: middle[i]!.id, target: node.id, kind: 'control' as const })), { id: 'e', source: middle.at(-1)!.id, target: 'end', kind: 'control' as const }] : [];
  return GraphSchema.parse({ id: 'g', name: 'team', nodes: [start, ...middle, end], edges });
}
const codes = (graph: Graph) => validateGraph(graph).errors.map(error => error.code);

describe('role nodes', () => {
  it('accepts the default playbook once the role owns paths, because its inner test gate covers the coding step', () => {
    expect(validateGraph(team(role('sim', ['src/sim']))).errors).toEqual([]);
    expect(validateGraph(team(role('sim', []))).errors.map(error => error.message)).toContain('sim role: a coding role must own at least one path.');
  });
  it('prefixes playbook steps so they never collide with team-level steps', () => {
    const graph = playbookGraph(role('sim', ['src']));
    expect(graph.nodes.map(node => node.id)).toContain('sim/implement');
    const gate = graph.nodes.find(node => node.id === 'sim/gate');
    expect(gate?.kind === 'quality_gate' && gate.config.predicate.sourceNodeId).toBe('sim/tests');
    const implement = graph.nodes.find(node => node.id === 'sim/implement');
    expect(implement?.kind === 'agent' && implement.config.role?.title).toBe('sim role');
  });
  it('reports an invalid playbook against the role', () => {
    const node = role('sim', ['src']);
    node.config.playbook.nodes = node.config.playbook.nodes.filter(step => step.kind !== 'end');
    node.config.playbook.edges = node.config.playbook.edges.filter(edge => edge.target !== 'end');
    expect(validateGraph(team(node)).errors.map(error => error.message)).toContain('Specialist playbook: Add an End node.');
  });
  it('requires a test gate inside the playbook or after the role at team level', () => {
    const ungated = role('sim', ['src']);
    ungated.config.playbook.nodes = ungated.config.playbook.nodes.filter(step => !['tests', 'gate', 'review'].includes(step.id));
    ungated.config.playbook.edges = [...ungated.config.playbook.edges.filter(edge => ['p1', 'p2', 'p3'].includes(edge.id)), { id: 'done', source: 'implement', target: 'end', kind: 'control' }];
    expect(codes(team(ungated))).toContain('role_test_gate');
    const tests = createNode('command', 'tests'), gate = createNode('quality_gate', 'gate');
    if (gate.kind === 'quality_gate') gate.config.predicate = { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 0 };
    const graph = team(ungated, tests, gate);
    graph.edges = graph.edges.map(edge => edge.source === 'gate' ? { ...edge, sourcePort: 'pass' } : edge);
    expect(codes(graph)).not.toContain('role_test_gate');
  });
  it('rejects overlapping ownership between parallel roles and a separate role on an inner agent', () => {
    const split = createNode('parallel', 'split'), join = createNode('join', 'join');
    const a = role('a', ['src']), b = role('b', ['src/ui']);
    const graph = GraphSchema.parse({ id: 'g', name: 'parallel', nodes: [createNode('start', 'start'), split, a, b, join, createNode('end', 'end')], edges: [
      { id: '1', source: 'start', target: 'split' }, { id: '2', source: 'split', target: 'a' }, { id: '3', source: 'split', target: 'b' },
      { id: '4', source: 'a', target: 'join' }, { id: '5', source: 'b', target: 'join' }, { id: '6', source: 'join', target: 'end' }] });
    expect(codes(graph)).toContain('parallel_ownership');
    const inner = role('c', ['lib']);
    const step = inner.config.playbook.nodes.find(item => item.id === 'implement');
    if (step?.kind === 'agent') step.config.role = { ...inner.config.role, id: 'other' };
    expect(codes(team(inner))).toContain('playbook_role');
  });
  it('requires step-output tools to read an earlier step', () => {
    const tool = createNode('tool', 'read');
    if (tool.kind === 'tool') tool.config = { tool: 'step-output', nodeId: 'end' };
    expect(codes(team(tool))).toContain('tool_source');
  });
  it('ships a valid playbook team template with owner-routed integration failures', () => {
    expect(validateGraph(specialistPlaybookTeam).errors).toEqual([]);
    expect(specialistPlaybookTeam.nodes.filter(node => node.kind === 'role').map(node => node.label)).toEqual(['Spatial intelligence engineer', 'Simulation engineer', 'UI engineer']);
    const gate = specialistPlaybookTeam.nodes.find(node => node.id === 'integration-gate');
    expect(gate?.kind === 'quality_gate' && gate.config).toMatchObject({ routing: 'owner', fallbackTargetId: 'integration' });
    expect(specialistPlaybookTeam.edges.filter(edge => edge.source === 'integration-gate' && edge.kind === 'loop').map(edge => edge.target).sort()).toEqual(['integration', 'simulation', 'spatial', 'ui']);
    expect(specialistPlaybookTeam.edges.some(edge => edge.kind === 'artifact' && edge.target === 'simulation')).toBe(true);
  });
});
