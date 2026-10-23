import { createNode, GraphSchema, RoleSchema, type Graph, type NodeKind, type WorkflowEdge, type WorkflowNode } from '../../shared/src/index.js';
import { withHandoffEdges } from './team.js';

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

const contract = { name: 'system-contract', path: 'contracts/system-contract.json', required: true };
const specialistBranches = [
  { id: 'spatial', title: 'Spatial intelligence engineer', area: 'spatial', y: 20, expertise: 'Build spatial data structures and coordinate transforms. Preserve coordinate systems, units, and the published interfaces; test boundary cases.' },
  { id: 'simulation', title: 'Simulation engineer', area: 'simulation', y: 240, expertise: 'Build deterministic simulation and causal models. Make assumptions explicit, preserve reproducibility, and test numerical and state-transition boundaries.' },
  { id: 'ui', title: 'UI engineer', area: 'ui', y: 460, expertise: 'Build accessible UI components against published interfaces. Cover loading, empty, error, and interaction states with tests.' },
];

/** Flat specialist agents use the real scheduler and Node's test runner. Customize paths for the target project. */
export const specialistTeam = withHandoffEdges(graph('specialist-team', 'Specialist Team', [
  node('start', 'start', 'Start', 40),
  node('research', 'agent', 'Researcher', 260, 180, { provider: 'claude', instructions: 'Read the project brief and repository. Report relevant prior art, constraints, and open questions for the architect.', role: RoleSchema.parse({ id: 'researcher', title: 'Researcher', expertise: 'Investigate evidence and distinguish facts from assumptions. Report sources and uncertainties; do not edit the repository.', knowledge: ['README.md'] }) }),
  node('architect', 'agent', 'Architecture & contracts', 480, 180, { provider: 'claude', permission: 'scoped-edit', instructions: 'Use the research to write contracts/system-contract.json with interfaces and acceptance criteria. Write runnable Node test-runner tests at tests/contracts/*.test.js that validate the contract schema only; behavioral acceptance tests run after implementation. Specialists will implement against this contract. Do not edit their source areas.', role: RoleSchema.parse({ id: 'architect', title: 'Architect', expertise: 'Define coherent interface contracts and acceptance criteria before implementation. Own contract changes and document design assumptions in the contract.', knowledge: ['README.md'], owns: ['contracts/**', 'tests/contracts/**'], produces: [{ ...contract, schema: { type: 'object', required: ['interfaces', 'acceptance'], properties: { interfaces: { type: 'array', items: { type: 'string' } }, acceptance: { type: 'array', items: { type: 'string' } } }, additionalProperties: true } }], skills: ['Preserve published contract semantics when addressing failing tests.'] }) }),
  node('contract-tests', 'command', 'Contract schema tests', 700, 180, { command: 'node', args: ['--test', 'tests/contracts/*.test.js'] }),
  node('contract-gate', 'quality_gate', 'Contract gate', 920, 180, { predicate: { sourceNodeId: 'contract-tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 3 }),
  node('split', 'parallel', 'Parallel specialists', 1140),
  ...specialistBranches.flatMap(branch => [
    node(branch.id, 'agent', branch.title, 1360, branch.y, { provider: 'codex', permission: 'scoped-edit', instructions: `Implement the ${branch.area} portion against contracts/system-contract.json within your owned source and test directories. Write runnable Node test-runner unit tests at tests/${branch.area}/*.test.js that do not depend on unfinished specialist implementations. Read current files before editing. Use failed test evidence on retries; preserve the shared contract.`, role: RoleSchema.parse({ id: `${branch.id}-engineer`, title: branch.title, expertise: branch.expertise, knowledge: ['contracts/**'], owns: [`src/${branch.area}/**`, `tests/${branch.area}/**`], consumes: [contract], skills: ['Keep tests authoritative; never weaken acceptance criteria to make a failure disappear.'] }) }),
    node(`${branch.id}-tests`, 'command', `${branch.title} unit tests`, 1580, branch.y, { command: 'node', args: ['--test', `tests/${branch.area}/*.test.js`] }),
    node(`${branch.id}-gate`, 'quality_gate', `${branch.title} gate`, 1800, branch.y, { predicate: { sourceNodeId: `${branch.id}-tests`, field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 3 }),
  ]),
  node('join', 'join', 'Join tested specialists', 2020, 240),
  node('merge', 'merge', 'Merge specialist branches', 2240, 240, { sourceNodeIds: specialistBranches.map(branch => branch.id) }),
  node('integration', 'agent', 'Integration engineer', 2460, 240, { provider: 'claude', permission: 'scoped-edit', instructions: 'Inspect the merged implementation and add runnable Node test-runner integration and behavioral acceptance tests at tests/integration/*.test.js against the shared contract. Report defects in specialist-owned code with paths and evidence; do not edit their files or weaken the contract.', role: RoleSchema.parse({ id: 'integration-engineer', title: 'Integration engineer', expertise: 'Verify interactions between specialist components and provide reproducible failure evidence. Own integration tests, while implementation fixes remain with their owners.', knowledge: ['contracts/**'], owns: ['tests/integration/**'], consumes: [contract] }) }),
  node('integration-tests', 'command', 'Integration and acceptance tests', 2680, 240, { command: 'node', args: ['--test', 'tests/integration/*.test.js'] }),
  node('integration-gate', 'quality_gate', 'Integration gate', 2900, 240, { predicate: { sourceNodeId: 'integration-tests', field: 'exitCode', operator: 'eq', value: 0 } }),
  node('review', 'agent', 'Independent reviewer', 3120, 240, { provider: 'claude', instructions: 'Review the integrated changes, contract, and test evidence. Report concrete defects without editing. End with exactly VERDICT: PASS or VERDICT: FAIL.', role: RoleSchema.parse({ id: 'independent-reviewer', title: 'Independent reviewer', expertise: 'Independently review correctness, security, and acceptance criteria. A passing opinion never replaces passing tests.', knowledge: ['contracts/**'], consumes: [contract] }) }),
  node('review-gate', 'quality_gate', 'Independent review gate', 3340, 240, { predicate: { sourceNodeId: 'review', field: 'output', operator: 'contains', value: 'VERDICT: PASS' } }),
  node('approval', 'approval', 'Approve integrated changes', 3560, 240),
  node('end', 'end', 'End', 3780, 240),
], [
  edge('start', 'research'), edge('research', 'architect'), edge('architect', 'contract-tests'), edge('contract-tests', 'contract-gate'),
  edge('contract-gate', 'architect', 'fail', 'loop'), edge('contract-gate', 'split', 'pass'),
  ...specialistBranches.flatMap(branch => [edge('split', branch.id), edge(branch.id, `${branch.id}-tests`), edge(`${branch.id}-tests`, `${branch.id}-gate`), edge(`${branch.id}-gate`, branch.id, 'fail', 'loop'), edge(`${branch.id}-gate`, 'join', 'pass')]),
  edge('join', 'merge'), edge('merge', 'integration'), edge('integration', 'integration-tests'), edge('integration-tests', 'integration-gate'),
  edge('integration-gate', 'review', 'pass'), edge('review', 'review-gate'), edge('review-gate', 'approval', 'pass'), edge('approval', 'end'),
]));

const decisions = { name: 'decisions', path: 'contracts/decisions.json', required: true };
/** A specialist as a role node: orient with a deterministic listing, plan, implement, test in a bounded loop, self-review. */
function specialistRole(branch: typeof specialistBranches[number]): WorkflowNode {
  // Tool configs are a union keyed by tool, so they replace the default config instead of merging into it.
  const step = (id: string, kind: NodeKind, label: string, x: number, config?: object) => kind === 'tool' ? { ...node(id, kind, label, x, 120), config } as WorkflowNode : node(id, kind, label, x, 120, config);
  const area = `src/${branch.area}`;
  return node(branch.id, 'role', branch.title, 1360, branch.y, {
    role: RoleSchema.parse({ id: `${branch.id}-engineer`, title: branch.title, expertise: branch.expertise, knowledge: ['contracts/**'], owns: [`${area}/**`, `tests/${branch.area}/**`], consumes: [contract, decisions], skills: ['Keep tests authoritative; never weaken acceptance criteria to make a failure disappear.'] }),
    playbook: {
      nodes: [
        step('start', 'start', 'Start', 0),
        step('orient', 'tool', 'List my area', 220, { tool: 'list', paths: [area, `tests/${branch.area}`], maxResults: 500 }),
        step('plan', 'agent', 'Plan', 440, { provider: 'claude', permission: 'read-only', instructions: `Plan the ${branch.area} implementation against contracts/system-contract.json and the recorded decisions. Do not edit files. Consult the architect if the contract is ambiguous.` }),
        step('implement', 'agent', 'Implement', 660, { provider: 'codex', permission: 'scoped-edit', instructions: `Implement the plan in ${area} with Node test-runner unit tests at tests/${branch.area}/*.test.js. Read current files before editing. On retries, fix the failing tests without weakening them.` }),
        step('tests', 'command', 'Unit tests', 880, { command: 'node', args: ['--test', `tests/${branch.area}/*.test.js`] }),
        step('gate', 'quality_gate', 'Unit test gate', 1100, { predicate: { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 3 }),
        step('review', 'agent', 'Self-review', 1320, { provider: 'claude', permission: 'read-only', instructions: 'Check the change against the contract and decisions. List open issues for the integration engineer. Do not edit files.' }),
        step('end', 'end', 'End', 1540),
      ],
      edges: [edge('start', 'orient'), edge('orient', 'plan'), edge('plan', 'implement'), edge('implement', 'tests'), edge('tests', 'gate'), edge('gate', 'implement', 'fail', 'loop'), edge('gate', 'review', 'pass'), edge('review', 'end')],
    },
  });
}

/**
 * Specialists as role nodes with their own playbooks. Integration failures go back to the role that owns
 * the failing files, falling back to the integration engineer. Customize paths and commands for the project.
 */
export const specialistPlaybookTeam = withHandoffEdges(graph('specialist-playbook-team', 'Specialist Team with playbooks', [
  node('start', 'start', 'Start', 40),
  node('research', 'agent', 'Researcher', 260, 180, { provider: 'claude', instructions: 'Read the project brief and repository. Report relevant prior art, constraints, and open questions for the architect.', role: RoleSchema.parse({ id: 'researcher', title: 'Researcher', expertise: 'Investigate evidence and distinguish facts from assumptions. Report sources and uncertainties; do not edit the repository.', knowledge: ['README.md'] }) }),
  node('architect', 'agent', 'Architecture & contracts', 480, 180, { provider: 'claude', permission: 'scoped-edit', instructions: 'Use the research to write contracts/system-contract.json with interfaces and acceptance criteria, and contracts/decisions.json recording each design decision with its rationale. Write Node test-runner tests at tests/contracts/*.test.js that validate the contract schema. Do not edit specialist areas.', role: RoleSchema.parse({ id: 'architect', title: 'Architect', expertise: 'Define coherent interface contracts and acceptance criteria before implementation. Own contract changes and record design decisions.', knowledge: ['README.md'], owns: ['contracts/**', 'tests/contracts/**'], produces: [contract, decisions] }) }),
  node('contract-tests', 'command', 'Contract schema tests', 700, 180, { command: 'node', args: ['--test', 'tests/contracts/*.test.js'] }),
  node('contract-gate', 'quality_gate', 'Contract gate', 920, 180, { predicate: { sourceNodeId: 'contract-tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 3 }),
  node('split', 'parallel', 'Parallel specialists', 1140),
  ...specialistBranches.map(specialistRole),
  node('join', 'join', 'Join specialists', 1580, 240),
  node('merge', 'merge', 'Merge specialist branches', 1800, 240, { sourceNodeIds: specialistBranches.map(branch => branch.id) }),
  node('integration', 'agent', 'Integration engineer', 2020, 240, { provider: 'claude', permission: 'scoped-edit', instructions: 'Add Node test-runner integration and acceptance tests at tests/integration/*.test.js against the contract. When they fail, include the failing file paths so failures reach the owning specialist. Do not edit specialist files or weaken the contract.', role: RoleSchema.parse({ id: 'integration-engineer', title: 'Integration engineer', expertise: 'Verify interactions between specialist components and provide reproducible failure evidence with file paths.', knowledge: ['contracts/**'], owns: ['tests/integration/**'], consumes: [contract] }) }),
  node('integration-tests', 'command', 'Integration and acceptance tests', 2240, 240, { command: 'node', args: ['--test', 'tests/integration/*.test.js'] }),
  node('integration-gate', 'quality_gate', 'Integration gate (routes to owners)', 2460, 240, { predicate: { sourceNodeId: 'integration-tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 3, routing: 'owner', fallbackTargetId: 'integration' }),
  node('review', 'agent', 'Independent reviewer', 2680, 240, { provider: 'claude', instructions: 'Review the integrated changes, contract, decisions, and test evidence. Report concrete defects with file paths, without editing. End with exactly VERDICT: PASS or VERDICT: FAIL.', role: RoleSchema.parse({ id: 'independent-reviewer', title: 'Independent reviewer', expertise: 'Independently review correctness, security, and acceptance criteria. A passing opinion never replaces passing tests.', knowledge: ['contracts/**'], consumes: [contract] }) }),
  node('review-gate', 'quality_gate', 'Independent review gate', 2900, 240, { predicate: { sourceNodeId: 'review', field: 'output', operator: 'contains', value: 'VERDICT: PASS' } }),
  node('approval', 'approval', 'Approve integrated changes', 3120, 240),
  node('end', 'end', 'End', 3340, 240),
], [
  edge('start', 'research'), edge('research', 'architect'), edge('architect', 'contract-tests'), edge('contract-tests', 'contract-gate'),
  edge('contract-gate', 'architect', 'fail', 'loop'), edge('contract-gate', 'split', 'pass'),
  ...specialistBranches.flatMap(branch => [edge('split', branch.id), edge(branch.id, 'join'), edge('integration-gate', branch.id, 'fail', 'loop')]),
  edge('join', 'merge'), edge('merge', 'integration'), edge('integration', 'integration-tests'), edge('integration-tests', 'integration-gate'),
  { ...edge('integration-gate', 'integration', 'fail', 'loop'), id: 'integration-gate-integration-fallback' },
  edge('integration-gate', 'review', 'pass'), edge('review', 'review-gate'), edge('review-gate', 'approval', 'pass'), edge('approval', 'end'),
]));

export const templates: Graph[] = [createCommandGraph(), featureBuilder, parallelFullstack, bugHunt, specialistTeam, specialistPlaybookTeam];
