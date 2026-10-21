import { z } from 'zod';

const IdSchema = z.string().min(1).max(200);
export const NodeKindSchema = z.enum([
  'start', 'agent', 'command', 'condition', 'parallel', 'join',
  'quality_gate', 'approval', 'merge', 'end',
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

export const NodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...baseNode, kind: z.literal('start'), config: emptyConfig }).strict(),
  z.object({ ...baseNode, kind: z.literal('agent'), config: AgentConfigSchema.default({ provider: 'codex', instructions: '', permission: 'read-only', allowedTools: [] }) }).strict(),
  z.object({ ...baseNode, kind: z.literal('command'), config: CommandConfigSchema.default({ command: 'node', args: ['--version'], successExitCodes: [0], requireApproval: true }) }).strict(),
  z.object({ ...baseNode, kind: z.literal('condition'), config: ConditionConfigSchema.default({ predicate: { sourceNodeId: '', field: 'exitCode', operator: 'eq', value: 0 } }) }).strict(),
  z.object({ ...baseNode, kind: z.literal('parallel'), config: z.object({ maxConcurrency: z.number().int().min(1).max(16).default(3) }).strict().default({ maxConcurrency: 3 }) }).strict(),
  z.object({ ...baseNode, kind: z.literal('join'), config: z.object({ mode: z.enum(['all_success', 'all_settled', 'first_success']).default('all_success') }).strict().default({ mode: 'all_success' }) }).strict(),
  z.object({ ...baseNode, kind: z.literal('quality_gate'), config: QualityGateConfigSchema.default({ predicate: { sourceNodeId: '', field: 'exitCode', operator: 'eq', value: 0 }, maxIterations: 4, inconclusive: 'fail' }) }).strict(),
  z.object({ ...baseNode, kind: z.literal('approval'), config: z.object({ message: z.string().default('Review the results before continuing.') }).strict().default({ message: 'Review the results before continuing.' }) }).strict(),
  z.object({ ...baseNode, kind: z.literal('merge'), config: z.object({ sourceNodeIds: z.array(z.string()).default([]), requireApproval: z.boolean().default(true) }).strict().default({ sourceNodeIds: [], requireApproval: true }) }).strict(),
  z.object({ ...baseNode, kind: z.literal('end'), config: emptyConfig }).strict(),
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
    approval: 'Human approval', merge: 'Merge', end: 'End',
  };
  return NodeSchema.parse({ id, kind, label: labels[kind], position });
}

export type { ChatProvider, ChatPermission, ChatContext, ChatSession, ChatTurn, ChatEvent, ChatSnapshot, CreateChatInput, ChatDiff } from './chat.js';
