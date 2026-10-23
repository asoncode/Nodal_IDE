import { createNode as makeNode } from '../../../packages/shared/src/index.js';
import type { Graph, NodeKind, WorkflowNode } from '../../../packages/shared/src/index.js';
export type { Graph, NodeKind };
export type GraphNode = WorkflowNode;
export interface Project { id: string; name: string; root: string; branch?: string; isGitRepository?: boolean }
export interface Provider { id: string; available: boolean; authenticated: boolean; status: string; message?: string }
export interface Run { id: string; projectId: string; graph: Graph; status: string; createdAt: string; finishedAt?: string }
export interface Event { eventId: string; runId: string; nodeId?: string; sequence: number; timestamp: string; kind: string; payload: unknown }
export interface Attempt { id: string; nodeId: string; state: string; status?: string; attemptIndex?: number; iteration?: number; output?: unknown; error?: unknown; worktreePath?: string; startedAt?: string; finishedAt?: string }
export interface Approval { id: string; message?: string; nodeId: string; decision?: string | null; scope?: unknown; requestedAt?: string }
export interface Inspection { run: Run; attempts: Attempt[]; approvals: Approval[]; checkpoints: unknown[] }
export interface FileBuffer { path: string; content: string; savedContent: string; hash: string; external?: { content: string; hash: string } }
export const NODE_LABELS: Record<NodeKind, string> = { start: 'Start', agent: 'Agent', command: 'Command / test', condition: 'Condition', parallel: 'Parallel split', join: 'Join', quality_gate: 'Quality loop', approval: 'Human approval', merge: 'Merge', end: 'End', tool: 'Tool', role: 'Role' };
export function createNode(kind: NodeKind, index: number): GraphNode {
  return makeNode(kind, crypto.randomUUID(), { x: 100 + (index % 3) * 270, y: 80 + Math.floor(index / 3) * 150 });
}
export function emptyGraph(): Graph {
  const start = createNode('start', 0), end = createNode('end', 1);
  return { schemaVersion: 1, id: crypto.randomUUID(), name: 'Untitled workflow', revision: 1, nodes: [start, end], edges: [{ id: crypto.randomUUID(), source: start.id, target: end.id, kind: 'control' }], settings: { maxConcurrency: 3, maxTotalAttempts: 30, timeoutMs: 600000 } };
}
export function language(path: string) {
  const filename = path.split('/').at(-1) ?? '';
  const extension = filename.includes('.') ? filename.split('.').at(-1)?.toLowerCase() : '';
  return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', md: 'markdown', css: 'css', html: 'html', py: 'python', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', c: 'c', h: 'c', rs: 'rust', yml: 'yaml', yaml: 'yaml', sh: 'shell', toml: 'ini' } as Record<string, string>)[extension ?? ''] ?? 'plaintext';
}
