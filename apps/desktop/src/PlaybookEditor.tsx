import { useEffect, useState } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, applyNodeChanges, type Node as FlowNode, type Edge as FlowEdge, type Connection, type NodeChange } from '@xyflow/react';
import { Plus, Trash2 } from 'lucide-react';
import { PlaybookNodeSchema, type Playbook, type PlaybookNode } from '../../../packages/shared/src/index.js';
import { NODE_LABELS, type GraphNode } from './model.js';
import { nodeTypes, type WorkflowNodeData } from './WorkflowNode.js';
import ToolEditor from './ToolEditor.js';

const STEP_KINDS = ['agent', 'command', 'tool', 'quality_gate', 'condition'] as const;
type Props = { title: string; playbook: Playbook; states?: Record<string, string>; problems?: string[]; onChange: (playbook: Playbook) => void };

function ancestors(id: string, edges: Playbook['edges']): Set<string> {
  const found = new Set<string>(); const pending = [id];
  while (pending.length) { const next = pending.pop()!; for (const edge of edges) if (edge.kind !== 'loop' && edge.target === next && !found.has(edge.source)) { found.add(edge.source); pending.push(edge.source); } }
  return found;
}

/** Edits one role's internal workflow. Changes go straight into the role node of the draft workflow. */
export default function PlaybookEditor({ title, playbook, states = {}, problems = [], onChange }: Props) {
  const [selected, setSelected] = useState<string>();
  const [edgeId, setEdgeId] = useState<string>();
  const [positions, setPositions] = useState<FlowNode[]>([]);
  const [kind, setKind] = useState<typeof STEP_KINDS[number]>('agent');
  const step = playbook.nodes.find(node => node.id === selected);
  const flowNodes: FlowNode[] = playbook.nodes.map(node => ({ id: node.id, type: 'workflow', position: positions.find(item => item.id === node.id)?.position ?? node.position, selected: node.id === selected, data: { node: node as GraphNode, status: states[node.id] ?? 'pending' } satisfies WorkflowNodeData }));
  useEffect(() => { setPositions([]); }, [playbook]);
  const flowEdges: FlowEdge[] = playbook.edges.map(edge => ({ ...edge, sourceHandle: edge.sourcePort ?? (playbook.nodes.find(node => node.id === edge.source)?.kind === 'quality_gate' ? 'pass' : playbook.nodes.find(node => node.id === edge.source)?.kind === 'condition' ? 'true' : 'out'), targetHandle: 'in', selected: edge.id === edgeId, type: 'smoothstep', label: edge.kind === 'loop' ? 'loop' : edge.sourcePort, style: { stroke: edge.id === edgeId ? 'var(--accent)' : edge.kind === 'loop' ? 'var(--loop)' : 'var(--edge)', strokeWidth: 1.25 } }));
  const change = (patch: Partial<Playbook>) => onChange({ ...playbook, ...patch });
  const updateStep = (next: PlaybookNode) => change({ nodes: playbook.nodes.map(node => node.id === next.id ? next : node) });
  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const source = playbook.nodes.find(node => node.id === connection.source);
    // A gate's fail port wired back to an earlier step is the bounded retry loop.
    const loop = source?.kind === 'quality_gate' && connection.sourceHandle === 'fail' && ancestors(source.id, playbook.edges).has(connection.target);
    const port = connection.sourceHandle && connection.sourceHandle !== 'out' ? connection.sourceHandle : undefined;
    change({ edges: [...playbook.edges, { id: crypto.randomUUID(), source: connection.source, target: connection.target, kind: loop ? 'loop' : 'control', ...(port ? { sourcePort: port } : {}) }] });
  };
  const remove = () => {
    if (edgeId) { change({ edges: playbook.edges.filter(edge => edge.id !== edgeId) }); setEdgeId(undefined); return; }
    if (!step || step.kind === 'start' || step.kind === 'end') return;
    change({ nodes: playbook.nodes.filter(node => node.id !== step.id), edges: playbook.edges.filter(edge => edge.source !== step.id && edge.target !== step.id) });
    setSelected(undefined);
  };
  const add = () => {
    const id = `${kind.replace('_', '-')}-${crypto.randomUUID().slice(0, 6)}`;
    const x = Math.max(0, ...playbook.nodes.map(node => node.position.x)) + 220;
    const node = PlaybookNodeSchema.parse({ id, kind, label: kind === 'tool' ? 'Search code' : NODE_LABELS[kind], position: { x, y: 260 } });
    change({ nodes: [...playbook.nodes, node] }); setSelected(id); setEdgeId(undefined);
  };
  const earlier = step ? playbook.nodes.filter(node => ancestors(step.id, playbook.edges).has(node.id)).map(node => ({ id: node.id, label: node.label })) : [];
  return <div className="playbook-editor" aria-label={`${title} playbook`}>
    <div className="playbook-toolbar">
      <span>Steps inside <strong>{title}</strong>. Inner agents work as this role and stay within its owned paths.</span>
      <select aria-label="Step type" value={kind} onChange={event => setKind(event.target.value as typeof kind)}>{STEP_KINDS.map(item => <option key={item} value={item}>{NODE_LABELS[item]}</option>)}</select>
      <button className="secondary" onClick={add}><Plus size={13}/>Add step</button>
      <button className="secondary" disabled={!edgeId && (!step || step.kind === 'start' || step.kind === 'end')} onClick={remove}><Trash2 size={13}/>Delete</button>
    </div>
    {problems.length > 0 && <ul className="validation-list playbook-problems">{problems.slice(0, 6).map((problem, index) => <li key={index}>{problem}</li>)}</ul>}
    <div className="playbook-body">
      <div className="canvas">
        <ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: .25 }} colorMode="dark" deleteKeyCode={null}
          onNodeClick={(_event, node) => { setSelected(node.id); setEdgeId(undefined); }} onEdgeClick={(_event, edge) => { setEdgeId(edge.id); setSelected(undefined); }} onPaneClick={() => { setSelected(undefined); setEdgeId(undefined); }}
          onNodesChange={(changes: NodeChange[]) => setPositions(applyNodeChanges(changes, flowNodes))}
          onNodeDragStop={(_event, node) => change({ nodes: playbook.nodes.map(item => item.id === node.id ? { ...item, position: node.position } : item) })}
          onConnect={connect}>
          <Background variant={BackgroundVariant.Cross} color="#1f1f25" gap={28} size={6}/><Controls showInteractive={false}/>
        </ReactFlow>
      </div>
      <aside className="playbook-step" aria-label="Playbook step">
        {!step ? <p className="field-help">Select a step to configure it. Connect a gate's fail port back to an earlier step to make a bounded retry loop.</p> : <>
          <div className="inspector-group">{NODE_LABELS[step.kind]}</div>
          <label className="field"><span>Name</span><input aria-label="Step name" value={step.label} onChange={event => updateStep({ ...step, label: event.target.value || step.label })}/></label>
          {step.kind === 'agent' && <>
            <label className="field"><span>Provider</span><select aria-label="Step provider" value={step.config.provider} onChange={event => updateStep({ ...step, config: { ...step.config, provider: event.target.value as 'codex' | 'claude' } })}><option value="codex">OpenAI Codex</option><option value="claude">Claude</option></select></label>
            <label className="field"><span>Model (optional)</span><input aria-label="Step model" value={step.config.model ?? ''} placeholder="Provider default" onChange={event => updateStep({ ...step, config: { ...step.config, model: event.target.value || undefined } })}/></label>
            <label className="field"><span>Permission</span><select aria-label="Step permission" value={step.config.permission} onChange={event => updateStep({ ...step, config: { ...step.config, permission: event.target.value as 'read-only' | 'scoped-edit' } })}><option value="read-only">Read only</option><option value="scoped-edit">Edit owned paths</option></select></label>
            <label className="field"><span>Task</span><textarea aria-label="Step task" rows={5} value={step.config.instructions} onChange={event => updateStep({ ...step, config: { ...step.config, instructions: event.target.value } })}/></label>
          </>}
          {step.kind === 'command' && <>
            <label className="field"><span>Executable</span><input aria-label="Step executable" value={step.config.command} onChange={event => event.target.value && updateStep({ ...step, config: { ...step.config, command: event.target.value } })}/></label>
            <label className="field"><span>Arguments (one per line)</span><textarea aria-label="Step arguments" rows={3} value={step.config.args.join('\n')} onChange={event => updateStep({ ...step, config: { ...step.config, args: event.target.value.split('\n').filter(Boolean) } })}/></label>
            <p className="field-help">Runs with approval, like any command.</p>
          </>}
          {step.kind === 'tool' && <ToolEditor value={step.config} earlier={earlier} onChange={config => updateStep({ ...step, config })}/>}
          {(step.kind === 'quality_gate' || step.kind === 'condition') && <>
            <label className="field"><span>Read result of</span><select aria-label="Gate source" value={step.config.predicate.sourceNodeId} onChange={event => updateStep({ ...step, config: { ...step.config, predicate: { ...step.config.predicate, sourceNodeId: event.target.value } } } as PlaybookNode)}><option value="">Choose a step</option>{earlier.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <label className="field"><span>Field</span><input aria-label="Gate field" value={step.config.predicate.field} onChange={event => updateStep({ ...step, config: { ...step.config, predicate: { ...step.config.predicate, field: event.target.value } } } as PlaybookNode)}/></label>
            <label className="field"><span>Comparison</span><select aria-label="Gate comparison" value={step.config.predicate.operator} onChange={event => updateStep({ ...step, config: { ...step.config, predicate: { ...step.config.predicate, operator: event.target.value as 'eq' } } } as PlaybookNode)}>{['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains'].map(operator => <option key={operator}>{operator}</option>)}</select></label>
            <label className="field"><span>Expected value</span><input aria-label="Gate value" value={JSON.stringify(step.config.predicate.value ?? '')} onChange={event => { let value: unknown = event.target.value; try { value = JSON.parse(event.target.value); } catch { /* plain text compares as a string */ } updateStep({ ...step, config: { ...step.config, predicate: { ...step.config.predicate, value } } } as PlaybookNode); }}/></label>
            {step.kind === 'quality_gate' && <label className="field"><span>Maximum iterations</span><input aria-label="Gate iterations" type="number" min={1} max={20} value={step.config.maxIterations} onChange={event => updateStep({ ...step, config: { ...step.config, maxIterations: Math.min(20, Math.max(1, Number(event.target.value) || 1)) } })}/></label>}
          </>}
          {step.kind !== 'start' && step.kind !== 'end' && <label className="check-field"><input type="checkbox" checked={step.disabled} onChange={event => updateStep({ ...step, disabled: event.target.checked })}/>Disable this step</label>}
        </>}
      </aside>
    </div>
  </div>;
}
