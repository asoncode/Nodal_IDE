import { z } from 'zod';
import { RoleSchema, RolePathSchema, RoleScopeSchema } from './roles.js';
export { RoleSchema, RolePathSchema, RoleScopeSchema, roleOwnsPath, type Role, type VerifiedHandoff } from './roles.js';

const IdSchema = z.string().min(1).max(200);
export const NodeKindSchema = z.enum([
  'start', 'agent', 'command', 'condition', 'parallel', 'join',
  'quality_gate', 'approval', 'merge', 'end', 'tool', 'role',
]);
export type NodeKind = z.infer<typeof NodeKindSchema>;
export const NodeStateSchema = z.enum([
  'pending', 'ready', 'running', 'waiting_approval', 'succeeded',
  'failed', 'skipped', 'cancelled', 'interrupted',
]);
export type NodeState = z.infer<typeof NodeStateSchema>;
export const RunStateSchema = z.enum([
  'queued', 'running', 'paused', 'waiting_approval',
  'succeeded', 'failed', 'cancelled', 'interrupted',
]);
export type RunState = z.infer<typeof RunStateSchema>;
export const ComparisonOperatorSchema = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains']);
export const PredicateSchema = z.object({
  sourceNodeId: z.string().default(''),
  field: z.string().max(500).default('exitCode'),
  operator: ComparisonOperatorSchema.default('eq'),
  value: z.unknown().optional().default(0),
}).strict();
export type Predicate = z.infer<typeof PredicateSchema>;
export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(1),
  delayMs: z.number().int().min(0).max(60_000).default(0),
}).strict();
export const PortSchema = z.object({
  id: IdSchema,
  direction: z.enum(['input', 'output']),
  kind: z.enum(['control', 'artifact']),
  required: z.boolean().default(false),
  dataType: z.enum(['any', 'json', 'text', 'file', 'diff', 'test_result']).default('any'),
}).strict();
export type Port = z.infer<typeof PortSchema>;

const baseNode = {
  id: IdSchema,
  label: z.string().min(1).max(200),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  retry: RetryPolicySchema.default({ maxAttempts: 1, delayMs: 0 }),
  timeoutMs: z.number().int().min(10).max(86_400_000).default(300_000),
  disabled: z.boolean().default(false),
  ports: z.array(PortSchema).default([]),
};
const emptyConfig = z.object({}).strict().default({});
const AgentConfigSchema = z.object({
  provider: z.enum(['codex', 'claude', 'demo']).default('codex'),
  model: z.string().optional(),
  instructions: z.string().default(''),
  role: RoleSchema.optional(),
  permission: z.enum(['read-only', 'scoped-edit']).default('read-only'),
  allowedTools: z.array(z.string()).default([]),
}).strict();
const CommandConfigSchema = z.object({
  command: z.string().min(1).default('node'),
  args: z.array(z.string()).default(['--version']),
  cwd: z.string().optional(),
  successExitCodes: z.array(z.number().int()).min(1).default([0]),
  requireApproval: z.boolean().default(true),
}).strict();
const ConditionConfigSchema = z.object({ predicate: PredicateSchema.default({ sourceNodeId: '', field: 'exitCode', operator: 'eq', value: 0 }) }).strict();
const QualityGateConfigSchema = z.object({
  predicate: PredicateSchema.default({ sourceNodeId: '', field: 'exitCode', operator: 'eq', value: 0 }),
  maxIterations: z.number().int().min(1).max(20).default(4),
  inconclusive: z.enum(['fail', 'approval']).default('fail'),
}).strict();

const ToolScopes = z.array(RoleScopeSchema).max(50).default([]);
const MaxResults = (limit: number, fallback: number) => z.number().int().min(1).max(limit).default(fallback);
/** Built-in read-only steps. They read a pinned commit, never a working directory, and make no provider call. */
export const ToolConfigSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('search'), query: z.string().trim().min(1).max(200).refine(value => !/[\r\n]/.test(value), 'Use a single-line query.'), regex: z.boolean().default(false), caseSensitive: z.boolean().default(false), paths: ToolScopes, maxResults: MaxResults(500, 100) }).strict(),
  z.object({ tool: z.literal('symbols'), name: z.string().trim().min(1).max(200).regex(/^[A-Za-z_$][\w$]*$/, 'Use an identifier.').optional(), paths: ToolScopes, maxResults: MaxResults(500, 100) }).strict(),
  z.object({ tool: z.literal('read'), paths: z.array(RoleScopeSchema).min(1).max(50), maxBytes: z.number().int().min(1).max(256 * 1024).default(64 * 1024) }).strict(),
  z.object({ tool: z.literal('list'), paths: ToolScopes, maxResults: MaxResults(5000, 500) }).strict(),
  z.object({ tool: z.literal('git'), mode: z.enum(['log', 'diff', 'blame']), ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/, 'Use a branch, tag, or commit name.').optional(), paths: ToolScopes, maxResults: MaxResults(500, 50) }).strict(),
  z.object({ tool: z.literal('test-impact'), paths: ToolScopes, maxResults: MaxResults(500, 100) }).strict(),
  z.object({ tool: z.literal('validate'), path: RolePathSchema.refine(value => !/[*?]/.test(value), 'Validate a literal file path.'), schema: z.record(z.string(), z.unknown()).optional(), required: z.boolean().default(true) }).strict(),
  z.object({ tool: z.literal('step-output'), nodeId: IdSchema }).strict(),
]);
export type ToolConfig = z.infer<typeof ToolConfigSchema>;

const StartNode = z.object({ ...baseNode, kind: z.literal('start'), config: emptyConfig }).strict();
const AgentNode = z.object({ ...baseNode, kind: z.literal('agent'), config: AgentConfigSchema.default({ provider: 'codex', instructions: '', permission: 'read-only', allowedTools: [] }) }).strict();
const CommandNode = z.object({ ...baseNode, kind: z.literal('command'), config: CommandConfigSchema.default({ command: 'node', args: ['--version'], successExitCodes: [0], requireApproval: true }) }).strict();
const ConditionNode = z.object({ ...baseNode, kind: z.literal('condition'), config: ConditionConfigSchema.default({ predicate: { sourceNodeId: '', field: 'exitCode', operator: 'eq', value: 0 } }) }).strict();
const QualityGateNode = z.object({ ...baseNode, kind: z.literal('quality_gate'), config: QualityGateConfigSchema.default({ predicate: { sourceNodeId: '', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 4, inconclusive: 'fail' }) }).strict();
const EndNode = z.object({ ...baseNode, kind: z.literal('end'), config: emptyConfig }).strict();
const ToolNode = z.object({ ...baseNode, kind: z.literal('tool'), config: ToolConfigSchema.default({ tool: 'search', query: 'TODO', regex: false, caseSensitive: false, paths: [], maxResults: 100 }) }).strict();
/** A role's internal workflow: one code lineage, no nested roles, no parallel branches or merges. */
export const PlaybookNodeSchema = z.discriminatedUnion('kind', [StartNode, AgentNode, CommandNode, ConditionNode, QualityGateNode, EndNode, ToolNode]);
export type PlaybookNode = z.infer<typeof PlaybookNodeSchema>;
export const PlaybookSchema = z.object({ nodes: z.array(PlaybookNodeSchema).min(2).max(60), edges: z.array(z.lazy(() => EdgeSchema)).max(200) }).strict();
export type Playbook = z.infer<typeof PlaybookSchema>;
export const RoleNodeConfigSchema = z.object({ role: RoleSchema, playbook: PlaybookSchema }).strict();

export const NodeSchema = z.discriminatedUnion('kind', [
  StartNode, AgentNode, CommandNode, ConditionNode,
  z.object({ ...baseNode, kind: z.literal('parallel'), config: z.object({ maxConcurrency: z.number().int().min(1).max(16).default(3) }).strict().default({ maxConcurrency: 3 }) }).strict(),
  z.object({ ...baseNode, kind: z.literal('join'), config: z.object({ mode: z.enum(['all_success', 'all_settled', 'first_success']).default('all_success') }).strict().default({ mode: 'all_success' }) }).strict(),
  QualityGateNode,
  z.object({ ...baseNode, kind: z.literal('approval'), config: z.object({ message: z.string().default('Review the results before continuing.') }).strict().default({ message: 'Review the results before continuing.' }) }).strict(),
  z.object({ ...baseNode, kind: z.literal('merge'), config: z.object({ sourceNodeIds: z.array(z.string()).default([]), requireApproval: z.boolean().default(true) }).strict().default({ sourceNodeIds: [], requireApproval: true }) }).strict(),
  EndNode, ToolNode,
  z.object({ ...baseNode, kind: z.literal('role'), config: z.lazy(() => RoleNodeConfigSchema).default(() => defaultRoleNodeConfig()) }).strict(),
]);
export type WorkflowNode = z.infer<typeof NodeSchema>;
export type Node = WorkflowNode;
export const EdgeSchema = z.object({
  id: IdSchema,
  source: IdSchema,
  target: IdSchema,
  kind: z.enum(['control', 'artifact', 'loop']).default('control'),
  sourcePort: z.string().optional(),
  targetPort: z.string().optional(),
}).strict();
export type WorkflowEdge = z.infer<typeof EdgeSchema>;
export type Edge = WorkflowEdge;
export const GraphSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: IdSchema,
  name: z.string().min(1).max(200),
  revision: z.number().int().min(1).default(1),
  nodes: z.array(NodeSchema).min(1).max(200),
  edges: z.array(EdgeSchema).max(1000),
  settings: z.object({
    maxConcurrency: z.number().int().min(1).max(16).default(3),
    maxTotalAttempts: z.number().int().min(1).max(2000).default(100),
    timeoutMs: z.number().int().min(100).max(86_400_000).default(3_600_000),
  }).strict().default({ maxConcurrency: 3, maxTotalAttempts: 100, timeoutMs: 3_600_000 }),
}).strict();
export type Graph = z.infer<typeof GraphSchema>;
export const ArtifactSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  attemptId: z.string().optional(),
  kind: z.enum(['text', 'file', 'diff', 'test_result', 'log', 'json']),
  path: z.string().optional(),
  contentHash: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
}).strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
export const NodeAttemptSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  nodeId: IdSchema,
  iteration: z.number().int().min(1),
  attemptIndex: z.number().int().min(1),
  state: NodeStateSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  worktreePath: z.string().optional(),
  sourceCommit: z.string().optional(),
  error: z.string().optional(),
  output: z.unknown().optional(),
  /** Set on steps that ran inside a role node's playbook. */
  parentAttemptId: z.string().optional(),
}).strict();
export type NodeAttempt = z.infer<typeof NodeAttemptSchema>;
export const ExecutionEventSchema = z.object({
  eventId: IdSchema,
  runId: IdSchema,
  nodeId: z.string().optional(),
  attemptId: z.string().optional(),
  sequence: z.number().int().min(1),
  timestamp: z.string(),
  kind: z.string().min(1),
  payload: z.unknown(),
}).strict();
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
export const ApprovalRequestSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  nodeId: IdSchema,
  message: z.string(),
  decision: z.enum(['pending', 'approved', 'rejected']),
  requestedAt: z.string(),
  resolvedAt: z.string().optional(),
  scope: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export const RunCheckpointSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  nodeId: z.string().optional(),
  graphRevision: z.number().int(),
  graphRevisionHash: z.string(),
  repositorySha: z.string().optional(),
  artifactIds: z.array(z.string()),
  outputs: z.record(z.string(), z.unknown()),
  worktreePaths: z.array(z.string()).default([]),
  createdAt: z.string(),
}).strict();
export type RunCheckpoint = z.infer<typeof RunCheckpointSchema>;
export const WorkflowRunSchema = z.object({
  id: IdSchema,
  graphId: IdSchema,
  graphRevision: z.number().int(),
  status: RunStateSchema,
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  nodeStates: z.record(z.string(), NodeStateSchema),
  attempts: z.array(NodeAttemptSchema),
}).strict();
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export const QualityVerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  checks: z.array(z.object({
    id: z.string(),
    status: z.enum(['pass', 'fail']),
    evidenceArtifactId: z.string().optional(),
  })),
  defects: z.array(z.object({
    severity: z.enum(['low', 'medium', 'high']),
    summary: z.string(),
    evidenceArtifactId: z.string().optional(),
  })),
  nextInstructions: z.string(),
  iteration: z.number().int().min(1),
  maxIterations: z.number().int().min(1),
});
export type QualityVerdict = z.infer<typeof QualityVerdictSchema>;

export function createNode(kind: NodeKind, id: string, position = { x: 0, y: 0 }): WorkflowNode {
  const labels: Record<NodeKind, string> = {
    start: 'Start', agent: 'Agent', command: 'Run command', condition: 'Condition',
    parallel: 'Parallel', join: 'Join', quality_gate: 'Quality gate',
    approval: 'Human approval', merge: 'Merge', end: 'End', tool: 'Search code', role: 'Specialist',
  };
  return NodeSchema.parse({ id, kind, label: labels[kind], position });
}

/** Default playbook: orient with deterministic search, plan, implement, test in a bounded loop, then self-review. */
export function defaultRoleNodeConfig(): z.infer<typeof RoleNodeConfigSchema> {
  const node = (kind: PlaybookNode['kind'], id: string, label: string, x: number, config?: object) =>
    PlaybookNodeSchema.parse({ id, kind, label, position: { x, y: 120 }, ...(config ? { config } : {}) });
  return {
    role: { id: 'specialist', title: 'Specialist', expertise: 'Describe this role: its expertise, standards, and what it must not do.', knowledge: [], owns: [], produces: [], consumes: [], skills: [] },
    playbook: {
      nodes: [
        node('start', 'start', 'Start', 0),
        node('tool', 'orient', 'Search related code', 220, { tool: 'search', query: 'TODO', regex: false, caseSensitive: false, paths: [], maxResults: 100 }),
        node('agent', 'plan', 'Plan', 440, { provider: 'claude', instructions: 'Plan the change for this role. Do not edit files.', permission: 'read-only', allowedTools: [] }),
        node('agent', 'implement', 'Implement', 660, { provider: 'codex', instructions: 'Implement the plan within your owned paths. Use previous test evidence to fix failures.', permission: 'scoped-edit', allowedTools: [] }),
        node('command', 'tests', 'Unit tests', 880, { command: 'npm', args: ['test'], successExitCodes: [0], requireApproval: true }),
        node('quality_gate', 'gate', 'Test gate', 1100, { predicate: { sourceNodeId: 'tests', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 3, inconclusive: 'fail' }),
        node('agent', 'review', 'Self-review', 1320, { provider: 'claude', instructions: 'Review the change against the role contracts and list any open issues. Do not edit files.', permission: 'read-only', allowedTools: [] }),
        node('end', 'end', 'End', 1540),
      ],
      edges: [
        { id: 'p1', source: 'start', target: 'orient', kind: 'control' }, { id: 'p2', source: 'orient', target: 'plan', kind: 'control' },
        { id: 'p3', source: 'plan', target: 'implement', kind: 'control' }, { id: 'p4', source: 'implement', target: 'tests', kind: 'control' },
        { id: 'p5', source: 'tests', target: 'gate', kind: 'control' }, { id: 'p6', source: 'gate', target: 'implement', kind: 'loop', sourcePort: 'fail' },
        { id: 'p7', source: 'gate', target: 'review', kind: 'control', sourcePort: 'pass' }, { id: 'p8', source: 'review', target: 'end', kind: 'control' },
      ],
    },
  };
}

/** The role a node works as: an agent's step role or a composite role node's role. */
export function nodeRole(node: WorkflowNode) {
  return node.kind === 'agent' ? node.config.role : node.kind === 'role' ? node.config.role : undefined;
}
/** Whether a node can change code: a scoped-edit agent or a role whose playbook contains one. */
export function nodeEdits(node: WorkflowNode): boolean {
  if (node.kind === 'agent') return node.config.permission === 'scoped-edit';
  if (node.kind === 'role') return node.config.playbook.nodes.some(item => item.kind === 'agent' && !item.disabled && item.config.permission === 'scoped-edit');
  return false;
}

export type { ChatProvider, ChatPermission, ChatContext, ChatSession, ChatTurn, ChatEvent, ChatSnapshot, CreateChatInput, ChatDiff } from './chat.js';
