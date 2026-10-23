import { describe, expect, it } from 'vitest';
import { createNode, GraphSchema, RoleSchema, type Graph, type WorkflowNode } from '../../shared/src/index.js';
import { TeamPlanSchema } from '../../shared/src/team.js';
import { ownershipMayOverlap, validateTeamGraph, validateTeamPlan, withHandoffEdges } from '../src/team.js';
import { WorkflowEngine } from '../src/engine.js';
import { featureBuilder, specialistTeam } from '../src/templates.js';
import { validateGraph } from '../src/validation.js';

const role = () => RoleSchema.parse({ id: 'coder', title: 'API engineer', expertise: 'Implement and test API contracts.', owns: ['api/**'] });
const reviewer = () => RoleSchema.parse({ id: 'reviewer', title: 'Reviewer', expertise: 'Review the implementation and test evidence.' });
const codes = (graph: Graph) => validateTeamGraph(graph).map(issue => issue.code);
function agent(graph: Graph, id: string): Extract<WorkflowNode, { kind: 'agent' }> {
  const node = graph.nodes.find(item => item.id === id);
  if (node?.kind !== 'agent') throw new Error(`Missing agent ${id}`);
  return node;
}
function linear(): Graph {
  const build = createNode('agent', 'build');
  if (build.kind === 'agent') build.config = { ...build.config, permission: 'scoped-edit', role: role() };
  const gate = createNode('quality_gate', 'gate');
  if (gate.kind === 'quality_gate') gate.config.predicate.sourceNodeId = 'tests';
  return GraphSchema.parse({ id: 'team-test', name: 'Team test', nodes: [createNode('start', 'start'), build, createNode('command', 'tests'), gate, createNode('end', 'end')], edges: [
    { id: 'start-build', source: 'start', target: 'build' }, { id: 'build-tests', source: 'build', target: 'tests' },
    { id: 'tests-gate', source: 'tests', target: 'gate' }, { id: 'gate-end', source: 'gate', target: 'end', sourcePort: 'pass' },
  ] });
}

describe('specialist ownership', () => {
  it.each([
    ['src/ui/**', 'src/api/**', false], ['src', 'src-ui/**', false],
    ['src/**', 'src/ui/**', true], ['src', 'src/ui', true],
    ['**/*.ts', 'src/ui/**', true], ['src/**/*.ts', 'src/**/*.tsx', true],
  ])('compares %s with %s conservatively', (left, right, overlaps) => {
    expect(ownershipMayOverlap(left, right)).toBe(overlaps);
    expect(ownershipMayOverlap(right, left)).toBe(overlaps);
  });
  it('rejects concurrent overlapping roles but permits ordered contract ownership', () => {
    const graph = structuredClone(specialistTeam);
    agent(graph, 'simulation').config.role!.owns.push('src/spatial/**');
    expect(codes(graph)).toContain('parallel_ownership');
    agent(graph, 'simulation').config.role!.owns.pop();
    agent(graph, 'integration').config.role!.owns.push('src/spatial/**');
    expect(codes(graph)).not.toContain('parallel_ownership');
  });
  it('requires ownership and specialist assignment for coding steps in a team', () => {
    const graph = structuredClone(specialistTeam);
    agent(graph, 'spatial').config.role!.owns = [];
    expect(codes(graph)).toContain('role_ownership');
    delete agent(graph, 'spatial').config.role;
    expect(codes(graph)).toContain('generic_implementation');
  });
});

describe('specialist verification', () => {
  it('accepts the full lifecycle template and leaves existing flat workflows valid', () => {
    expect(validateGraph(specialistTeam).errors).toEqual([]);
    expect(validateGraph(featureBuilder).errors).toEqual([]);
    expect(validateGraph(linear()).errors).toEqual([]);
  });
  it('rejects a path that bypasses required tests or exits through a failed gate', () => {
    const graph = linear();
    graph.edges.push({ id: 'bypass', source: 'build', target: 'end', kind: 'control' });
    expect(codes(graph)).toContain('role_test_gate');
    graph.edges.pop();
    graph.edges.push({ id: 'failed-end', source: 'gate', target: 'end', kind: 'control', sourcePort: 'fail' });
    expect(codes(graph)).toContain('role_test_gate');
  });
  it('rejects disabled tests, a reviewer-only gate, and inverted exit-code predicates', () => {
    const graph = linear();
    const tests = graph.nodes.find(node => node.id === 'tests')!;
    tests.disabled = true;
    expect(codes(graph)).toContain('role_test_gate');
    tests.disabled = false;
    const gate = graph.nodes.find(node => node.id === 'gate')!;
    if (gate.kind !== 'quality_gate' || tests.kind !== 'command') throw new Error('Invalid fixture');
    gate.config.predicate = { sourceNodeId: 'build', field: 'output', operator: 'contains', value: 'PASS' };
    expect(codes(graph)).toContain('role_test_gate');
    gate.config.predicate = { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 1 };
    tests.config.successExitCodes = [1];
    expect(codes(graph)).toContain('role_test_gate');
    gate.config.predicate.value = 0;
    tests.config.successExitCodes = [0, 1];
    expect(codes(graph)).toContain('role_test_gate');
  });
  it('requires the test command to execute downstream of the coding role', () => {
    const graph = linear();
    graph.edges = [
      { id: 'a', source: 'start', target: 'tests', kind: 'control' }, { id: 'b', source: 'tests', target: 'build', kind: 'control' },
      { id: 'c', source: 'build', target: 'gate', kind: 'control' }, { id: 'd', source: 'gate', target: 'end', kind: 'control', sourcePort: 'pass' },
    ];
    expect(codes(graph)).toContain('role_test_gate');
  });
});

describe('declared handoffs and reviewed team plans', () => {
  it('materializes stable typed handoff edges without mutating the draft or duplicating edges', () => {
    const graph = structuredClone(specialistTeam);
    graph.edges = graph.edges.filter(edge => edge.kind !== 'artifact');
    const wired = withHandoffEdges(graph);
    expect(graph.edges.every(edge => edge.kind !== 'artifact')).toBe(true);
    expect(wired.edges.filter(edge => edge.kind === 'artifact')).toHaveLength(5);
    expect(withHandoffEdges(wired)).toEqual(wired);
    expect(validateGraph(wired).errors).toEqual([]);
  });
  it('holds a consumer until its producer passes the quality loop and supplies the latest output', async () => {
    const graph = linear();
    const handoff = { name: 'contract', path: 'api/contract.json', required: true };
    agent(graph, 'build').config.role!.produces.push(handoff);
    const review = createNode('agent', 'review');
    if (review.kind !== 'agent') throw new Error('Invalid fixture');
    review.config.role = { ...reviewer(), consumes: [handoff] };
    graph.nodes.splice(-1, 0, review);
    graph.edges.find(edge => edge.id === 'gate-end')!.target = 'review';
    graph.edges.push({ id: 'review-end', source: 'review', target: 'end', kind: 'control' }, { id: 'retry', source: 'gate', target: 'build', sourcePort: 'fail', kind: 'loop' });
    const wired = withHandoffEdges(graph);
    const iterations: number[] = [];
    const engine = new WorkflowEngine(wired, { execute: async ctx => {
      if (ctx.node.id === 'build') return { status: 'succeeded', output: { version: ctx.attempt.iteration } };
      if (ctx.node.id === 'tests') return { status: ctx.attempt.iteration === 1 ? 'failed' : 'succeeded', output: { exitCode: ctx.attempt.iteration === 1 ? 1 : 0 } };
      if (ctx.node.id === 'review') iterations.push((ctx.inputs.build!.output as { version: number }).version);
      return { status: 'succeeded' };
    } });
    expect((await engine.start()).status).toBe('succeeded');
    expect(iterations).toEqual([2]);
    wired.edges.push({ id: 'inconclusive-review', source: 'gate', target: 'review', sourcePort: 'inconclusive', kind: 'control' });
    expect(validateGraph(wired).errors.map(issue => issue.code)).toContain('loop_escape');
    wired.edges.pop();
    // An artifact cannot leave the loop when the consumer has an independent control path.
    wired.edges.find(edge => edge.id === 'gate-end')!.target = 'end';
    wired.edges.push({ id: 'ungated-review', source: 'start', target: 'review', kind: 'control' });
    expect(validateGraph(wired).errors.map(issue => issue.code)).toContain('loop_escape');
  });
  it('requires a matching enabled upstream producer and edit ownership for each output', () => {
    const graph = structuredClone(specialistTeam);
    agent(graph, 'architect').disabled = true;
    expect(codes(graph)).toContain('missing_handoff');
    agent(graph, 'architect').disabled = false;
    agent(graph, 'architect').config.role!.produces[0]!.path = 'contracts/wrong.json';
    expect(codes(graph)).toContain('missing_handoff');
    agent(graph, 'architect').config.role!.produces[0]!.path = 'outside/contract.json';
    expect(codes(graph)).toContain('handoff_ownership');
  });
  it('cannot satisfy a required handoff with an optional producer output', () => {
    const graph = structuredClone(specialistTeam);
    agent(graph, 'architect').config.role!.produces[0]!.required = false;
    expect(codes(graph)).toContain('missing_handoff');
  });
  it('checks planned area coverage and role IDs without requiring invented handoffs', () => {
    const plan = TeamPlanSchema.parse({ name: 'API team', summary: 'Build and review an API.', members: [
      { role: role(), provider: 'codex', permission: 'scoped-edit' }, { role: reviewer(), provider: 'claude', permission: 'read-only' },
    ], areas: [{ path: 'api/**', roleId: 'coder' }] });
    expect(validateTeamPlan(plan)).toEqual([]);
    plan.areas[0]!.path = 'ui/**';
    expect(validateTeamPlan(plan).map(issue => issue.code)).toContain('unowned_area');
    plan.members[1]!.role.id = 'coder';
    expect(validateTeamPlan(plan).map(issue => issue.code)).toContain('duplicate_role');
  });
  it('rejects missing planned handoffs and readonly roles that claim repository outputs', () => {
    const plan = TeamPlanSchema.parse({ name: 'API team', summary: 'Build and review an API.', members: [
      { role: { ...role(), consumes: [{ name: 'api-contract', path: 'contracts/api.json', required: true }] }, provider: 'codex', permission: 'scoped-edit' },
      { role: { ...reviewer(), produces: [{ name: 'review', path: 'review.json', required: true }] }, provider: 'claude', permission: 'read-only' },
    ], areas: [] });
    expect(validateTeamPlan(plan).map(issue => issue.code)).toEqual(expect.arrayContaining(['missing_handoff', 'handoff_ownership']));
  });
});
