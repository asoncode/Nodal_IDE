import { GraphSchema, type Graph, type WorkflowEdge } from '../../shared/src/index.js';
import { validateTeamGraph } from './team.js';
import { playbookGraph } from './playbook.js';

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}
export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  graph?: Graph;
}

export function descendants(start: string, edges: WorkflowEdge[]): Set<string> {
  const found = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const id = pending.pop()!;
    if (found.has(id)) continue;
    found.add(id);
    for (const edge of edges) if (edge.source === id) pending.push(edge.target);
  }
  return found;
}

export function loopRegion(graph: Graph, edge: WorkflowEdge): Set<string> {
  const ordinary = graph.edges.filter((item) => item.kind !== 'loop');
  const forward = descendants(edge.target, ordinary);
  const backward = descendants(edge.source, ordinary.map((item) => ({ ...item, source: item.target, target: item.source })));
  return new Set([...forward].filter((id) => backward.has(id)));
}

export function validateGraph(input: unknown): ValidationResult {
  const parsed = GraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => ({
        code: 'schema',
        message: `${issue.path.join('.') || 'graph'}: ${issue.message}`,
      })),
    };
  }
  const graph = parsed.data;
  const errors: ValidationIssue[] = [];
  const issue = (code: string, message: string, nodeId?: string, edgeId?: string) => {
    errors.push({ code, message, ...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) });
  };
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (nodes.size !== graph.nodes.length) issue('duplicate_node', 'Node IDs must be unique.');
  if (new Set(graph.edges.map((edge) => edge.id)).size !== graph.edges.length) issue('duplicate_edge', 'Edge IDs must be unique.');
  const starts = graph.nodes.filter((node) => node.kind === 'start');
  const ends = graph.nodes.filter((node) => node.kind === 'end');
  if (starts.length !== 1) issue('start_count', 'A graph must have exactly one Start node.');
  if (!ends.length) issue('missing_end', 'Add an End node.');

  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) {
      issue('dangling_edge', 'Edge references a missing node.', undefined, edge.id);
      continue;
    }
    if (source.id === target.id) issue('self_edge', 'A node cannot connect to itself.', source.id, edge.id);
    if (target.kind === 'start') issue('start_input', 'Start cannot have incoming edges.', target.id, edge.id);
    if (source.kind === 'end') issue('end_output', 'End cannot have outgoing edges.', source.id, edge.id);
    if (edge.kind === 'loop' && (source.kind !== 'quality_gate' || edge.sourcePort !== 'fail')) {
      issue('invalid_loop', 'Loop edges must leave the fail port of a Quality Gate.', source.id, edge.id);
    }
    if (edge.kind !== 'artifact') {
      if (source.kind === 'condition' && !['true', 'false'].includes(edge.sourcePort ?? '')) {
        issue('condition_port', 'Condition edges must use the true or false source port.', source.id, edge.id);
      }
      if (source.kind === 'quality_gate' && !['pass', 'fail', 'inconclusive'].includes(edge.sourcePort ?? '')) {
        issue('quality_port', 'Quality Gate edges must use pass, fail, or inconclusive.', source.id, edge.id);
      }
    }
    if (edge.kind === 'artifact') {
      const output = source.ports.find((port) => port.id === edge.sourcePort && port.direction === 'output' && port.kind === 'artifact');
      const inputPort = target.ports.find((port) => port.id === edge.targetPort && port.direction === 'input' && port.kind === 'artifact');
      if (!output || !inputPort) issue('artifact_port', 'Artifact edges require existing artifact input and output ports.', undefined, edge.id);
      else if (output.dataType !== 'any' && inputPort.dataType !== 'any' && output.dataType !== inputPort.dataType) {
        issue('port_type', `Artifact types ${output.dataType} and ${inputPort.dataType} are incompatible.`, undefined, edge.id);
      }
    }
  }
  const ordinary = graph.edges.filter((edge) => edge.kind !== 'loop' && nodes.has(edge.source) && nodes.has(edge.target));
  const control = ordinary.filter((edge) => edge.kind === 'control');
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of ordinary) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const edge of ordinary.filter((item) => item.source === id)) {
      const count = indegree.get(edge.target)! - 1;
      indegree.set(edge.target, count);
      if (count === 0) queue.push(edge.target);
    }
  }
  if (visited !== nodes.size) issue('cycle', 'Ordinary edges must form a DAG. Use a bounded Quality Gate loop edge for feedback.');

  const reachable = starts.length === 1 ? descendants(starts[0]!.id, control) : new Set<string>();
  const reverse = control.map((edge) => ({ ...edge, source: edge.target, target: edge.source }));
  const reachesEnd = new Set(ends.flatMap((end) => [...descendants(end.id, reverse)]));
  for (const node of graph.nodes) {
    if (starts.length === 1 && !reachable.has(node.id)) issue('unreachable', `${node.label} is not reachable from Start through control edges.`, node.id);
    if (!reachesEnd.has(node.id)) issue('no_end_path', `${node.label} has no ordinary control path to End.`, node.id);
    if (node.kind !== 'start' && !control.some((edge) => edge.target === node.id)) issue('missing_input', `${node.label} needs a control input.`, node.id);
    for (const port of node.ports.filter((port) => port.required && port.direction === 'input')) {
      if (!graph.edges.some((edge) => edge.target === node.id && edge.targetPort === port.id && edge.kind === port.kind)) {
        issue('required_port', `${node.label}: required input ${port.id} is not connected.`, node.id);
      }
    }
    if (node.kind === 'condition') {
      for (const port of ['true', 'false']) if (!control.some((edge) => edge.source === node.id && edge.sourcePort === port)) {
        issue('missing_branch', `${node.label} needs a ${port} branch.`, node.id);
      }
    }
    if (node.kind === 'quality_gate' && !control.some((edge) => edge.source === node.id && edge.sourcePort === 'pass')) {
      issue('missing_pass', `${node.label} needs a pass path.`, node.id);
    }
    if (node.kind === 'condition' || node.kind === 'quality_gate') {
      const sourceId = node.config.predicate.sourceNodeId;
      if (!sourceId && new Set(ordinary.filter((edge) => edge.target === node.id).map((edge) => edge.source)).size > 1) {
        issue('predicate_source', `${node.label}: select an explicit predicate source when several nodes feed the gate.`, node.id);
      }
      if (sourceId && (!nodes.has(sourceId) || sourceId === node.id || !descendants(sourceId, ordinary).has(node.id))) {
        issue('predicate_source', `${node.label}: predicate source must be an upstream node.`, node.id);
      }
    }
  }
  const regions: Set<string>[] = [];
  // An owner-routed gate may loop to several roles; together its loops form one region.
  const loopGroups = new Map<string, WorkflowEdge[]>();
  for (const edge of graph.edges.filter((item) => item.kind === 'loop' && nodes.has(item.source) && nodes.has(item.target))) loopGroups.set(edge.source, [...(loopGroups.get(edge.source) ?? []), edge]);
  for (const [gateId, loops] of loopGroups) {
    const gate = nodes.get(gateId)!;
    const routed = gate.kind === 'quality_gate' && gate.config.routing === 'owner';
    if (loops.length > 1 && !routed) issue('multiple_loops', 'Each Quality Gate supports one loop target. Use owner routing to loop to several roles.', gateId);
    if (gate.kind === 'quality_gate' && gate.config.fallbackTargetId && !loops.some((edge) => edge.target === gate.config.fallbackTargetId)) {
      issue('routing_fallback', `${gate.label}: the fallback must be one of this gate's loop targets.`, gateId);
    }
    if (routed) for (const edge of loops) {
      const target = nodes.get(edge.target)!;
      if (!((target.kind === 'agent' || target.kind === 'role') && target.config.role)) issue('routing_target', `${gate.label}: owner routing can only loop back to steps with a specialist role.`, gateId, edge.id);
    }
    if (ordinary.some((item) => item.source === gateId && item.sourcePort === 'fail')) {
      issue('ambiguous_loop_exit', 'A looping Quality Gate must use its loop edge as the only fail path.', gateId);
    }
    for (const edge of loops) if (!descendants(edge.target, ordinary).has(gateId)) issue('loop_target', 'A loop must return to an ancestor of its Quality Gate.', gateId, edge.id);
    const edge = loops[0]!;
    const region = new Set(loops.flatMap((item) => [...loopRegion(graph, item)]));
    // Publishing out of a loop is safe only when every control path to the consumer crosses this gate's pass edge.
    const withoutPass = control.filter(item => item.source !== edge.source || item.sourcePort !== 'pass');
    const bypassesPass = new Set(starts.flatMap(start => [...descendants(start.id, withoutPass)]));
    if (regions.some((previous) => [...region].some((id) => previous.has(id)))) {
      issue('overlapping_loops', 'Overlapping quality loops are not supported. Use independent bounded loops.', edge.source, edge.id);
    }
    for (const id of region) {
      const node = nodes.get(id)!;
      if (node.kind === 'join' && node.config.mode === 'first_success') {
        issue('loop_early_join', 'A quality loop cannot contain a first_success join because other attempts may still be running.', id);
      }
      if (ordinary.some((item) => item.source === id && !region.has(item.target) && id !== edge.source &&
        !(item.kind === 'artifact' && descendants(edge.source, control).has(item.target) && !bypassesPass.has(item.target)))) {
        issue('loop_escape', 'Nodes inside a quality loop must exit through its Quality Gate.', id);
      }
    }
    regions.push(region);
  }
  // Role nodes: each playbook must be a valid workflow on its own; its role's team rules are checked at team level.
  const playbooks = new Map<string, Graph>();
  for (const node of graph.nodes) {
    if (node.kind === 'tool') {
      const config = node.config;
      if (config.tool === 'step-output' && (!nodes.has(config.nodeId) || !descendants(config.nodeId, ordinary).has(node.id) || config.nodeId === node.id)) {
        issue('tool_source', `${node.label}: step-output must name an earlier step in this workflow.`, node.id);
      }
      if (config.tool === 'git' && config.mode === 'blame' && (config.paths.length !== 1 || /[*?]/.test(config.paths[0]!))) {
        issue('tool_config', `${node.label}: blame needs exactly one literal file path.`, node.id);
      }
    }
    if (node.kind !== 'role') continue;
    for (const step of node.config.playbook.nodes) if (step.kind === 'agent' && step.config.role) {
      issue('playbook_role', `${node.label} playbook: ${step.label} works as the role ${node.config.role.title}; remove its separate role.`, node.id);
    }
    let playbook: Graph;
    try { playbook = playbookGraph(node, { interface: 'validation' }); }
    catch (error) { issue('playbook', `${node.label} playbook: ${error instanceof Error ? error.message : String(error)}`, node.id); continue; }
    playbooks.set(node.id, playbook);
    const own = new Set(node.config.playbook.nodes.map(step => step.id));
    const inner = validateGraph(playbook);
    for (const problem of inner.errors) {
      // Inner tool steps may read earlier team-level steps, which a standalone playbook cannot see.
      if (problem.code === 'role_test_gate' || (problem.code === 'tool_source' && problem.nodeId && !playbookReadsOwnStep(node, problem.nodeId, own))) continue;
      issue(problem.code, `${node.label} playbook: ${problem.message}`, node.id);
    }
  }
  errors.push(...validateTeamGraph(graph, playbooks));
  return { valid: errors.length === 0, errors, graph };
}

function playbookReadsOwnStep(node: Extract<Graph['nodes'][number], { kind: 'role' }>, stepId: string, own: Set<string>): boolean {
  const step = node.config.playbook.nodes.find(item => `${node.id}/${item.id}` === stepId);
  return step?.kind === 'tool' && step.config.tool === 'step-output' && own.has(step.config.nodeId);
}
