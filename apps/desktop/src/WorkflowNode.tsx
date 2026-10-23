import { Handle, Position } from '@xyflow/react';
import { CirclePlay, Bot, SquareTerminal, GitFork, Split, Merge, Repeat, UserCheck, GitMerge, Flag, SearchCode, Users, type LucideIcon } from 'lucide-react';
import { NODE_LABELS, type GraphNode, type NodeKind } from './model.js';

export const nodeIcons: Record<NodeKind, LucideIcon> = { start: CirclePlay, agent: Bot, command: SquareTerminal, condition: GitFork, parallel: Split, join: Merge, quality_gate: Repeat, approval: UserCheck, merge: GitMerge, end: Flag, tool: SearchCode, role: Users };

function toolDetail(node: Extract<GraphNode, { kind: 'tool' }>): string {
  const config = node.config;
  switch (config.tool) {
    case 'search': return `search "${config.query}"${config.paths.length ? ` in ${config.paths.join(', ')}` : ''}`;
    case 'symbols': return `symbols${config.name ? ` ${config.name}` : ''}`;
    case 'git': return `git ${config.mode}`;
    case 'validate': return `validate ${config.path}`;
    case 'step-output': return `output of ${config.nodeId}`;
    default: return `${config.tool}${'paths' in config && config.paths.length ? ` ${config.paths.join(', ')}` : ''}`;
  }
}
export function nodeDetail(node: GraphNode): string | undefined {
  switch (node.kind) {
    case 'agent': return `${node.config.provider} · ${node.config.permission}`;
    case 'command': return `${node.config.command} ${node.config.args.join(' ')}`;
    case 'approval': return 'Review before continuing';
    case 'quality_gate': return `max ${node.config.maxIterations} iterations`;
    case 'join': return node.config.mode.replaceAll('_', ' ');
    case 'tool': return toolDetail(node);
    case 'role': return `${node.config.playbook.nodes.filter(step => step.kind !== 'start' && step.kind !== 'end').length} playbook steps · open to edit`;
    default: return undefined;
  }
}

export type WorkflowNodeData = { node: GraphNode; status: string; progress?: string };
export function WorkflowNodeView({ data, selected }: { data: WorkflowNodeData; selected?: boolean }) {
  const { node, status, progress } = data;
  const Icon = nodeIcons[node.kind];
  const ports = node.kind === 'condition' ? ['true', 'false'] : node.kind === 'quality_gate' ? ['pass', 'fail', 'inconclusive'] : ['out'];
  const role = node.kind === 'agent' || node.kind === 'role' ? node.config.role : undefined;
  const detail = nodeDetail(node);
  return <div className={`wf-node ${node.kind === 'role' ? 'wf-role' : ''} ${selected ? 'selected' : ''} ${node.disabled ? 'disabled' : ''}`} data-state={status}>
    {node.kind !== 'start' && <Handle type="target" position={Position.Left} id="in"/>}
    <div className="wf-node-kind"><Icon size={12}/><span>{NODE_LABELS[node.kind]}</span><span className={`state-dot ${status}`} role="img" aria-label={status.replaceAll('_', ' ')} title={status.replaceAll('_', ' ')}/></div>
    <div className="wf-node-label">{node.label}</div>
    {role && <div className="role-badge" title={role.expertise}>{role.title}</div>}
    {detail && <div className="wf-node-detail">{detail}</div>}
    {progress && <div className="wf-node-detail wf-node-progress">{progress}</div>}
    {node.kind !== 'end' && ports.map((port, index) => <Handle key={port} type="source" position={Position.Right} id={port} title={port} style={{ top: `${(index + 1) * 100 / (ports.length + 1)}%` }}>{ports.length > 1 && <span className="port-label">{port}</span>}</Handle>)}
  </div>;
}
export const nodeTypes = { workflow: WorkflowNodeView };
