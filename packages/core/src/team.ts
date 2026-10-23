import { roleOwnsPath, type Graph, type Role, type WorkflowNode } from '../../shared/src/index.js';
import type { TeamPlan } from '../../shared/src/team.js';
import type { ValidationIssue } from './validation.js';

/** Ambiguous wildcard intersections count as overlap. Use separate directory scopes to prove independence. */
export function ownershipMayOverlap(left: string, right: string): boolean {
  const prefix = (scope: string) => scope.split(/[*?]/, 1)[0]!;
  const a = prefix(left); const b = prefix(right);
  if (!/[*?]/.test(left) && !/[*?]/.test(right)) return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  if (!/[*?]/.test(left)) return b === left || b.startsWith(`${left}/`) || left.startsWith(b);
  if (!/[*?]/.test(right)) return a === right || a.startsWith(`${right}/`) || right.startsWith(a);
  return a.startsWith(b) || b.startsWith(a);
}

function reachable(start: string, edges: Graph['edges']): Set<string> {
  const found = new Set<string>(); const pending = [start];
  while (pending.length) {
    const id = pending.pop()!;
    if (found.has(id)) continue;
    found.add(id);
    pending.push(...edges.filter(edge => edge.source === id).map(edge => edge.target));
  }
  return found;
}

/** Materialize declared handoffs without inventing producers or changing control flow. */
export function withHandoffEdges(input: Graph): Graph {
  const graph = structuredClone(input);
  const control = graph.edges.filter(edge => edge.kind === 'control');
  const agents = graph.nodes.filter((node): node is Extract<WorkflowNode, { kind: 'agent' }> => node.kind === 'agent' && !!node.config.role);
  const downstream = new Map(agents.map(node => [node.id, reachable(node.id, control)]));
  const stableId = (parts: string[]) => {
    let hash = 2166136261;
    for (const char of JSON.stringify(parts)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `handoff-${(hash >>> 0).toString(16)}`;
  };
  for (const consumer of agents) for (const handoff of consumer.config.role!.consumes) {
    const candidates = agents.filter(producer => producer.id !== consumer.id && !producer.disabled && downstream.get(producer.id)!.has(consumer.id) &&
      producer.config.role!.produces.some(output => output.name === handoff.name && output.path === handoff.path && (!handoff.required || output.required)));
    const latest = candidates.filter(producer => !candidates.some(other => other.id !== producer.id && downstream.get(producer.id)!.has(other.id)));
    if (latest.length !== 1) continue;
    const producer = latest[0]!;
    const outputId = stableId(['output', handoff.name, handoff.path]);
    const inputId = stableId(['input', handoff.name, handoff.path]);
    if (!producer.ports.some(port => port.id === outputId)) producer.ports.push({ id: outputId, direction: 'output', kind: 'artifact', dataType: 'file', required: false });
    if (!consumer.ports.some(port => port.id === inputId)) consumer.ports.push({ id: inputId, direction: 'input', kind: 'artifact', dataType: 'file', required: handoff.required });
    if (!graph.edges.some(edge => edge.kind === 'artifact' && edge.source === producer.id && edge.target === consumer.id && edge.sourcePort === outputId && edge.targetPort === inputId)) {
      graph.edges.push({ id: stableId([producer.id, consumer.id, handoff.name, handoff.path]), kind: 'artifact', source: producer.id, target: consumer.id, sourcePort: outputId, targetPort: inputId });
    }
  }
  return graph;
}

function coveredArea(role: Role, area: string): boolean {
  if (!/[*?]/.test(area)) return roleOwnsPath(role.owns, area);
  return role.owns.some(scope => scope === '**' || scope === area || (!/[*?]/.test(scope) && area.startsWith(`${scope}/`)) ||
    (scope.endsWith('/**') && !/[*?]/.test(scope.slice(0, -3)) && area.startsWith(scope.slice(0, -2))));
}

export function validateTeamPlan(plan: TeamPlan): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const roles = new Map(plan.members.map(member => [member.role.id, member.role]));
  if (roles.size !== plan.members.length) errors.push({ code: 'duplicate_role', message: 'Team role IDs must be unique.' });
  for (const member of plan.members) {
    if (member.permission === 'scoped-edit' && !member.role.owns.length) errors.push({ code: 'role_ownership', message: `${member.role.title}: a coding role must own at least one path.` });
    for (const output of member.role.produces) {
      if (member.permission !== 'scoped-edit' || !roleOwnsPath(member.role.owns, output.path)) errors.push({ code: 'handoff_ownership', message: `${member.role.title}: producing ${output.path} requires edit ownership of that path.` });
    }
    for (const input of member.role.consumes) {
      const producers = plan.members.filter(other => other.role.id !== member.role.id && other.role.produces.some(output =>
        output.name === input.name && output.path === input.path && (!input.required || output.required)));
      if (!producers.length) errors.push({ code: 'missing_handoff', message: `${member.role.title}: no team role produces ${input.name} at ${input.path}.` });
    }
  }
  for (const area of plan.areas) {
    const role = roles.get(area.roleId);
    if (!role || !plan.members.some(member => member.role.id === role.id && member.permission === 'scoped-edit') || !coveredArea(role, area.path)) errors.push({ code: 'unowned_area', message: `Planned area ${area.path} is not covered by coding role ${area.roleId}'s ownership.` });
  }
  return errors;
}

function hasUngatedCompletion(graph: Graph, roleNode: WorkflowNode): boolean {
  const control = graph.edges.filter(edge => edge.kind === 'control');
  const afterRole = reachable(roleNode.id, control);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const gates = new Set(graph.nodes.filter(node => {
    if (node.kind !== 'quality_gate' || node.disabled || node.config.inconclusive !== 'fail') return false;
    const predicate = node.config.predicate;
    const sourceId = predicate.sourceNodeId || graph.edges.find(edge => edge.target === node.id && edge.kind !== 'loop')?.source;
    const test = sourceId ? nodes.get(sourceId) : undefined;
    return test?.kind === 'command' && !test.disabled && afterRole.has(test.id) && reachable(test.id, control).has(node.id) &&
      predicate.field === 'exitCode' && predicate.operator === 'eq' && predicate.value === 0 && test.config.successExitCodes.length === 1 && test.config.successExitCodes[0] === 0;
  }).map(node => node.id));
  // Only a gate's pass edge proves verification; fail/inconclusive exits cannot complete untested work.
  const pending = [roleNode.id]; const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (nodes.get(id)?.kind === 'end') return true;
    for (const edge of control.filter(item => item.source === id)) {
      if (!gates.has(id) || edge.sourcePort !== 'pass') pending.push(edge.target);
    }
  }
  return false;
}

/** Additional policy checks for workflows that opt into specialist roles. Existing flat workflows remain valid. */
export function validateTeamGraph(graph: Graph): ValidationIssue[] {
  const agents = graph.nodes.filter((node): node is Extract<WorkflowNode, { kind: 'agent' }> => node.kind === 'agent');
  const specialists = agents.filter(node => node.config.role);
  if (!specialists.length) return [];
  const errors: ValidationIssue[] = [];
  const issue = (code: string, message: string, nodeId: string) => errors.push({ code, message, nodeId });
  const ordinary = graph.edges.filter(edge => edge.kind !== 'loop');
  const downstream = new Map(agents.map(node => [node.id, reachable(node.id, ordinary)]));
  const coding = agents.filter(node => !node.disabled && node.config.permission === 'scoped-edit');
  const roleCount = new Set(specialists.map(node => node.config.role!.id)).size;
  for (const node of agents) {
    const role = node.config.role;
    if (!role) {
      if (roleCount > 1 && node.config.permission === 'scoped-edit' && !node.disabled) issue('generic_implementation', `${node.label}: assign a specialist role to every coding step in a team workflow.`, node.id);
      continue;
    }
    if (node.disabled) continue;
    if (node.config.permission === 'scoped-edit') {
      if (!role.owns.length) issue('role_ownership', `${role.title}: a coding role must own at least one path.`, node.id);
      if (hasUngatedCompletion(graph, node)) issue('role_test_gate', `${role.title}: every control path to End must pass an enabled command/test quality gate after this role.`, node.id);
    }
    for (const output of role.produces) {
      if (node.config.permission !== 'scoped-edit' || !roleOwnsPath(role.owns, output.path)) issue('handoff_ownership', `${role.title}: producing ${output.path} requires edit ownership of that path.`, node.id);
    }
    for (const input of role.consumes) {
      const producer = specialists.some(other => other.id !== node.id && !other.disabled && downstream.get(other.id)?.has(node.id) &&
        other.config.role!.produces.some(output => output.name === input.name && output.path === input.path && (!input.required || output.required)));
      if (!producer) issue('missing_handoff', `${role.title}: ${input.name} at ${input.path} must be produced by an enabled upstream role.`, node.id);
    }
  }
  for (let i = 0; i < coding.length; i++) for (let j = i + 1; j < coding.length; j++) {
    const a = coding[i]!; const b = coding[j]!;
    if (!a.config.role || !b.config.role || downstream.get(a.id)?.has(b.id) || downstream.get(b.id)?.has(a.id)) continue;
    if (a.config.role.owns.some(left => b.config.role!.owns.some(right => ownershipMayOverlap(left, right)))) {
      issue('parallel_ownership', `${a.config.role.title} and ${b.config.role.title} may run concurrently with overlapping ownership. Use disjoint directory scopes or order these roles; ambiguous wildcard overlaps are rejected.`, b.id);
    }
  }
  return errors;
}
