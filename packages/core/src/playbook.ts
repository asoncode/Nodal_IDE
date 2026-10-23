import { GraphSchema, type Graph, type Role, type WorkflowNode } from '../../shared/src/index.js';

export type RoleNode = Extract<WorkflowNode, { kind: 'role' }>;
export const PLAYBOOK_SEPARATOR = '/';
export const playbookStepId = (roleNodeId: string, stepId: string) => `${roleNodeId}${PLAYBOOK_SEPARATOR}${stepId}`;

/**
 * Expands a role node's playbook into a standalone graph whose step IDs are prefixed with the
 * role node's ID, so events, approvals, and attempts never collide with team-level steps.
 * Inner agents work as the role. Produced handoffs are verified once, for the whole role.
 */
export function playbookGraph(node: RoleNode, options: { interface?: 'runtime' | 'validation'; maxTotalAttempts?: number; timeoutMs?: number } = {}): Graph {
  const own = new Set(node.config.playbook.nodes.map(step => step.id));
  const id = (step: string) => own.has(step) ? playbookStepId(node.id, step) : step;
  const role: Role = { ...node.config.role, produces: [], ...(options.interface === 'validation' ? { consumes: [] } : {}) };
  const nodes = node.config.playbook.nodes.map(step => {
    const copy = structuredClone(step) as WorkflowNode;
    copy.id = playbookStepId(node.id, step.id);
    if (copy.kind === 'agent') copy.config.role = role;
    if ((copy.kind === 'quality_gate' || copy.kind === 'condition') && copy.config.predicate.sourceNodeId) copy.config.predicate.sourceNodeId = id(copy.config.predicate.sourceNodeId);
    // step-output may name a playbook step or an earlier team-level step.
    if (copy.kind === 'tool' && copy.config.tool === 'step-output') copy.config.nodeId = id(copy.config.nodeId);
    return copy;
  });
  const edges = node.config.playbook.edges.map(edge => ({ ...edge, id: playbookStepId(node.id, edge.id), source: playbookStepId(node.id, edge.source), target: playbookStepId(node.id, edge.target) }));
  return GraphSchema.parse({
    schemaVersion: 1, id: playbookStepId(node.id, 'playbook'), name: `${node.config.role.title} playbook`, revision: 1, nodes, edges,
    settings: { maxConcurrency: 1, maxTotalAttempts: Math.max(1, Math.min(options.maxTotalAttempts ?? 100, 2000)), timeoutMs: Math.max(100, options.timeoutMs ?? node.timeoutMs) },
  });
}
