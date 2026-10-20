import { createNode, GraphSchema, type Graph, type NodeKind, type WorkflowEdge, type WorkflowNode } from '../../shared/src/index.js';

function node(id: string, kind: NodeKind, label: string, x: number, y = 180, config?: object): WorkflowNode {
  const result = createNode(kind, id, { x, y });
  return { ...result, label, config: { ...result.config, ...config } } as WorkflowNode;
}
function edge(source: string, target: string, sourcePort?: string, kind: WorkflowEdge['kind'] = 'control'): WorkflowEdge {
  return { id: `${source}-${target}-${sourcePort ?? 'out'}`, source, target, kind, ...(sourcePort ? { sourcePort } : {}) };
}
function graph(id: string, name: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): Graph {
  return GraphSchema.parse({ id, name, nodes, edges });
}

/** A real local command, suitable for first run without provider credentials. */
export function createCommandGraph(): Graph {
  return graph('local-command', 'Local command', [
    node('start', 'start', 'Start', 40),
    node('command', 'command', 'Node version', 300),
    node('end', 'end', 'End', 560),
  ], [edge('start', 'command'), edge('command', 'end')]);
}

export const featureBuilder = graph('feature-builder', 'Feature Builder', [
  node('start', 'start', 'Start', 40),
  node('architect', 'agent', 'Architect', 260, 180, { provider: 'claude', instructions: 'Inspect the repository and propose a focused implementation plan. Do not edit files.' }),
  node('implement', 'agent', 'Implement', 480, 180, { provider: 'codex', instructions: 'Implement the requested feature. Use previous test evidence to fix failures.', permission: 'scoped-edit' }),
  node('tests', 'command', 'Run tests', 700, 180, { command: 'npm', args: ['test'] }),
  node('quality', 'quality_gate', 'Quality gate', 920, 180, {
    predicate: { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 4,
  }),
  node('approval', 'approval', 'Review changes', 1140),
  node('merge', 'merge', 'Integrate approved work', 1360, 180, { sourceNodeIds: ['implement'] }),
  node('end', 'end', 'End', 1580),
], [
  edge('start', 'architect'), edge('architect', 'implement'), edge('implement', 'tests'),
  edge('tests', 'quality'), edge('quality', 'implement', 'fail', 'loop'),
  edge('quality', 'approval', 'pass'), edge('approval', 'merge'), edge('merge', 'end'),
]);

export const parallelFullstack = graph('parallel-fullstack', 'Parallel Fullstack', [
  node('start', 'start', 'Start', 40),
  node('plan', 'agent', 'Plan', 260, 180, { provider: 'claude', instructions: 'Plan independent frontend, backend, and test work. Do not edit files.' }),
  node('split', 'parallel', 'Parallel work', 480),
  node('frontend', 'agent', 'Frontend', 720, 20, { provider: 'codex', instructions: 'Implement the frontend portion of the plan.', permission: 'scoped-edit' }),
  node('backend', 'agent', 'Backend', 720, 180, { provider: 'codex', instructions: 'Implement the backend portion of the plan.', permission: 'scoped-edit' }),
  node('test-author', 'agent', 'Test author', 720, 340, { provider: 'claude', instructions: 'Write acceptance tests for the plan.', permission: 'scoped-edit' }),
  node('join', 'join', 'Join completed work', 960),
  node('merge', 'merge', 'Create integration branch', 1180, 180, { sourceNodeIds: ['frontend', 'backend', 'test-author'] }),
  node('tests', 'command', 'Integration tests', 1400, 180, { command: 'npm', args: ['test'] }),
  node('review', 'agent', 'Review', 1620, 180, { provider: 'claude', instructions: 'Review the integrated changes and test evidence. Do not edit files.' }),
  node('approval', 'approval', 'Human approval', 1840),
  node('end', 'end', 'End', 2060),
], [
  edge('start', 'plan'), edge('plan', 'split'), edge('split', 'frontend'), edge('split', 'backend'), edge('split', 'test-author'),
  edge('frontend', 'join'), edge('backend', 'join'), edge('test-author', 'join'), edge('join', 'merge'),
  edge('merge', 'tests'), edge('tests', 'review'), edge('review', 'approval'), edge('approval', 'end'),
]);

export const bugHunt = graph('bug-hunt', 'Bug Hunt', [
  node('start', 'start', 'Start', 40),
  node('diagnose', 'agent', 'Diagnose', 260, 180, { provider: 'claude', instructions: 'Investigate the reported defect. Propose a reproducible failure and focused fix.' }),
  node('reproduce', 'command', 'Reproduce failure', 480, 180, { command: 'npm', args: ['test'], successExitCodes: [0, 1] }),
  node('patch', 'agent', 'Patch', 700, 180, { provider: 'codex', instructions: 'Fix the diagnosed defect and any failing regression test.', permission: 'scoped-edit' }),
  node('tests', 'command', 'Regression tests', 920, 180, { command: 'npm', args: ['test'] }),
  node('quality', 'quality_gate', 'Regression gate', 1140, 180, { predicate: { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 3 }),
  node('approval', 'approval', 'Review fix', 1360),
  node('end', 'end', 'End', 1580),
], [
  edge('start', 'diagnose'), edge('diagnose', 'reproduce'), edge('reproduce', 'patch'),
  edge('patch', 'tests'), edge('tests', 'quality'), edge('quality', 'patch', 'fail', 'loop'),
  edge('quality', 'approval', 'pass'), edge('approval', 'end'),
]);

export const templates: Graph[] = [createCommandGraph(), featureBuilder, parallelFullstack, bugHunt];
