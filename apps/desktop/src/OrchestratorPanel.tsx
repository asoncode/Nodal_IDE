import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { api } from './api.js';
import type { Graph } from './model.js';

type Step = { nodeId: string; label: string; runs: number; attempts: number; failures: number; loopExhausted: number; timeouts: number; ownershipViolations: number; flaky: number; medianDurationMs: number | null; costUsd: number | null };
type Side = { runs: number; successRate: number | null; attemptsPerRun: number | null };
type Proposal = { id: string; title: string; rationale: string; status: 'open' | 'applied' | 'dismissed' | 'reverted'; widensScope: boolean; evidence: { count: number; detail?: string[] }; changes: { nodeId: string; field: string; from: unknown; to: unknown }[]; comparison?: { before: Side; after: Side; recommendation: 'keep' | 'revert' | 'insufficient data' } };
type Insights = { metrics: { runs: number; succeeded: number; failed: number; steps: Step[] }; proposals: Proposal[]; revision: number };
type Lesson = { id: string; text: string; source: 'user' | 'proposal' };
const percent = (value: number | null) => value === null ? '—' : `${Math.round(value * 100)}%`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Between-run view of the workflow's orchestrator: measurements, reviewable proposals, and project memory. */
export default function OrchestratorPanel({ projectId, graph, saved, onGraphSaved }: { projectId: string; graph: Graph; saved: boolean; onGraphSaved: (graph: Graph) => void }) {
  const [insights, setInsights] = useState<Insights>();
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const scope = useRef({ alive: true });
  const refresh = useCallback(async () => {
    const current = scope.current;
    try {
      const [nextLessons, nextInsights] = await Promise.all([api<Lesson[]>('lessons', { projectId }), saved ? api<Insights>('workflowInsights', { projectId, graphId: graph.id }) : Promise.resolve(undefined)]);
      if (current.alive) { setLessons(nextLessons); setInsights(nextInsights); setError(''); }
    } catch (cause) { if (current.alive) setError(message(cause)); }
  }, [projectId, graph.id, saved]);
  useEffect(() => { const current = { alive: true }; scope.current = current; void refresh(); return () => { current.alive = false; }; }, [refresh]);
  const act = async (task: () => Promise<void>) => {
    if (pending) return;
    setPending(true); setError('');
    try { await task(); await refresh(); } catch (cause) { if (scope.current.alive) setError(message(cause)); } finally { if (scope.current.alive) setPending(false); }
  };
  const open = insights?.proposals.filter(item => item.status === 'open') ?? [];
  const applied = insights?.proposals.filter(item => item.status === 'applied') ?? [];
  return <section className="orchestrator-panel" aria-label="Workflow orchestrator">
    <div className="view-title"><span>Workflow orchestrator</span><button className="icon-button" title="Refresh" aria-label="Refresh orchestrator" disabled={pending} onClick={() => void refresh()}><RefreshCw size={14}/></button></div>
    <div className="sidebar-scroll orchestrator-body">
      <p className="field-help">During runs it pauses on repeated identical failures or a nearly spent attempt budget, and summarizes each run. Between runs it proposes changes from recorded evidence. It never changes a workflow by itself.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {!saved ? <p className="sidebar-hint">Save this workflow to measure it across runs.</p> : insights && <>
        <div className="section-header"><span>{graph.name} · revision {insights.revision}</span></div>
        <p className="field-help">{insights.metrics.runs} finished runs · {insights.metrics.succeeded} succeeded · {insights.metrics.failed} failed</p>
        {insights.metrics.steps.length > 0 && <table className="metrics-table"><thead><tr><th>Step</th><th title="Attempts / failures">Tries</th><th title="Loops that used every iteration">Loops out</th><th title="Timeouts, ownership violations, flaky test runs">Issues</th><th>Cost</th></tr></thead><tbody>
          {insights.metrics.steps.map(step => <tr key={step.nodeId}><td title={step.label}>{step.label}</td><td>{step.attempts} / {step.failures}</td><td>{step.loopExhausted}</td><td>{[step.timeouts && `${step.timeouts} timeout`, step.ownershipViolations && `${step.ownershipViolations} ownership`, step.flaky && `${step.flaky} flaky`].filter(Boolean).join(', ') || '—'}</td><td>{step.costUsd === null ? 'unknown' : `$${step.costUsd.toFixed(2)}`}</td></tr>)}
        </tbody></table>}
        <div className="inspector-group">Proposals</div>
        {!open.length && !applied.length && <p className="sidebar-hint">No proposals. They appear when the same problem shows up in at least two runs of this revision.</p>}
        {open.map(proposal => <article className="proposal" key={proposal.id} aria-label={proposal.title}>
          <strong>{proposal.title}</strong><p>{proposal.rationale}</p>
          <ul>{proposal.changes.map((change, index) => <li key={index}><code>{change.nodeId}.{change.field}</code>: {JSON.stringify(change.from)} → {JSON.stringify(change.to)}</li>)}</ul>
          <small>Evidence: {proposal.evidence.count} runs{proposal.evidence.detail?.length ? ` · ${proposal.evidence.detail.join(', ')}` : ''}</small>
          {proposal.widensScope && <p className="proposal-warning">Widens what a role may change.</p>}
          <div className="role-actions"><button className="secondary" disabled={pending} onClick={() => void act(async () => { await api('dismissProposal', { projectId, proposalId: proposal.id }); })}>Dismiss</button><button className="primary" disabled={pending} onClick={() => void act(async () => {
            if (proposal.widensScope && !window.confirm(`${proposal.title}? This lets the role change more of the repository.`)) return;
            onGraphSaved(await api<Graph>('applyProposal', { projectId, proposalId: proposal.id }));
          })}>Apply as new revision</button></div>
        </article>)}
        {applied.map(proposal => <article className="proposal applied" key={proposal.id} aria-label={`Applied: ${proposal.title}`}>
          <strong>Applied: {proposal.title}</strong>
          {proposal.comparison && <p>Before: {percent(proposal.comparison.before.successRate)} success over {proposal.comparison.before.runs} runs · After: {percent(proposal.comparison.after.successRate)} over {proposal.comparison.after.runs} runs. <b>{proposal.comparison.recommendation === 'insufficient data' ? 'Run it at least twice more to compare.' : proposal.comparison.recommendation === 'keep' ? 'Recommendation: keep.' : 'Recommendation: revert.'}</b></p>}
          <div className="role-actions"><button className="secondary" disabled={pending} onClick={() => void act(async () => { onGraphSaved(await api<Graph>('revertProposal', { projectId, proposalId: proposal.id })); })}>Revert</button></div>
        </article>)}
      </>}
      <div className="inspector-group">Project memory</div>
      <p className="field-help">Lessons reach the planner and every role. Applied proposals add one automatically.</p>
      {lessons.map(lesson => <div className="lesson" key={lesson.id}><span>{lesson.text}</span><button className="icon-button" aria-label={`Delete lesson: ${lesson.text}`} disabled={pending} onClick={() => void act(async () => { await api('deleteLesson', { projectId, lessonId: lesson.id }); })}><Trash2 size={13}/></button></div>)}
      <textarea aria-label="New lesson" rows={2} value={draft} placeholder="For example: seeds must be passed explicitly to every simulator call." onChange={event => setDraft(event.target.value)}/>
      <button className="secondary" disabled={pending || !draft.trim()} onClick={() => void act(async () => { await api('saveLesson', { projectId, text: draft.trim() }); setDraft(''); })}>Add lesson</button>
    </div>
  </section>;
}
