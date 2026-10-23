import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import type { Graph, Provider } from './model.js';
import { useWorkflowGeneration } from './useWorkflowGeneration.js';
import { TeamPlanSchema, type TeamPlan } from '../../../packages/shared/src/team.js';
import { validateTeamPlan } from '../../../packages/core/src/team.js';

type Props = { projectId: string; graph: Graph; prompt: string; onPromptChange: (value: string) => void; onApply: (graph: Graph) => void };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function GenerationPanel({ projectId, graph, prompt, onPromptChange, onApply }: Props) {
  const [providers, setProviders] = useState<(Provider & { loginCommand?: string })[]>([]);
  const [checking, setChecking] = useState(true);
  const [providerError, setProviderError] = useState('');
  const { busy, progress, error, generated, generate, cancel, clear } = useWorkflowGeneration(projectId);
  const [teamFirst, setTeamFirst] = useState(true);
  const [briefPaths, setBriefPaths] = useState<string[]>([]);
  const [briefFiles, setBriefFiles] = useState<{ path: string }[]>([]);
  const [briefError, setBriefError] = useState('');
  const [teamText, setTeamText] = useState('');
  const scope = useRef({ alive: true });
  const statusRequest = useRef(0);

  async function refreshProviders() {
    const current = scope.current, request = ++statusRequest.current;
    setChecking(true); setProviderError('');
    try {
      const result = await api<(Provider & { loginCommand?: string })[]>('providerStatus');
      if (current.alive && request === statusRequest.current) setProviders(result);
    } catch (error) {
      if (current.alive && request === statusRequest.current) setProviderError(`Could not check CLI accounts. ${message(error)} Use Refresh to check again.`);
    } finally {
      if (current.alive && request === statusRequest.current) setChecking(false);
    }
  }

  useEffect(() => {
    const current = { alive: true }; scope.current = current;
    setProviders([]);
    void refreshProviders();
    return () => { current.alive = false; };
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    setBriefPaths([]); setBriefFiles([]); setBriefError(''); setTeamText('');
    void api<{ path: string }[]>('chatFiles', { projectId }).then(files => { if (alive) setBriefFiles(files); }).catch(error => { if (alive) setBriefError(`Could not list brief files. ${message(error)}`); });
    return () => { alive = false; };
  }, [projectId]);
  useEffect(() => { if (generated?.team) setTeamText(JSON.stringify(generated.team, null, 2)); }, [generated]);

  let reviewedTeam: TeamPlan | undefined, teamError = '';
  if (teamText) {
    try {
      reviewedTeam = TeamPlanSchema.parse(JSON.parse(teamText));
      teamError = validateTeamPlan(reviewedTeam).map(issue => issue.message).join(' · ');
    } catch (error) { teamError = message(error); }
  }

  const planner = providers.find(provider => provider.id === 'claude');
  const blocked = planner?.available === false || planner?.status === 'missing';
  return <div className="modal-body">
    <p>Describe the work, review the specialist team, then review its workflow before applying.</p>
    <p className="field-help">Nodal reuses your existing official Claude and Codex CLI logins. No separate Nodal connection is needed. If sign-in is missing, run the command shown in Terminal, then Refresh.</p>
    <div aria-label="CLI accounts">
      {['claude', 'codex'].map(id => {
        const provider = providers.find(item => item.id === id);
        return <div className="provider-row" key={id}><span className={`state-dot ${provider?.authenticated ? 'succeeded' : 'pending'}`}/><div><strong>{id === 'claude' ? 'Claude' : 'Codex'}</strong><small>{checking ? 'Checking CLI account…' : !provider ? 'Account status unknown' : provider.available === false ? 'CLI unavailable' : provider.authenticated ? 'Connected' : provider.status === 'missing' ? 'Sign-in required' : 'Account status unknown'}</small>{provider?.message && <p>{provider.message}</p>}{!provider?.authenticated && provider?.loginCommand && <p>Run in Terminal: <code>{provider.loginCommand}</code></p>}</div></div>;
      })}
      <button className="secondary" disabled={checking} onClick={() => void refreshProviders()}>Refresh</button>
    </div>
    {providerError && <p className="inline-error" role="alert">{providerError}</p>}
    <label className="field"><span>Planning provider</span><select value="claude" disabled={busy} onChange={() => {}}><option value="claude">Claude</option><option value="codex" disabled>Codex — tool-free planning unavailable</option></select></label>
    <label className="field"><span>What should this workflow do?</span><textarea autoFocus rows={5} disabled={busy} value={prompt} onChange={event => onPromptChange(event.target.value)} placeholder="Plan a fix, implement it with Codex, run regression tests, and ask for approval before merging…"/></label>
    <label><input type="checkbox" checked={teamFirst} disabled={busy} onChange={event => { setTeamFirst(event.target.checked); clear(); setTeamText(''); }}/> Plan a specialist team first</label>
    {!teamFirst && <p className="field-help">Direct graph editing preserves the existing team. For a new project, propose and review a team first.</p>}
    <details><summary>Project brief files ({briefPaths.length} selected)</summary>
      <p className="field-help">Select repository files to send to the planner. Up to 8 files, 32 KiB each, 96 KiB total. Add external briefs to the repository first.</p>
      {briefError && <p className="inline-error">{briefError}</p>}
      <select multiple aria-label="Project brief files" disabled={busy} value={briefPaths} onChange={event => { setBriefPaths([...event.target.selectedOptions].map(option => option.value)); clear(); setTeamText(''); }}>{briefFiles.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select>
    </details>
    <p className="field-help">Generating sends your prompt, selected briefs, repository file manifest, saved roles and current workflow to the provider. It does not execute the workflow.</p>
    {progress && <p role="status">{progress}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {generated?.team && <div className="generated-preview"><strong>{generated.team.name}</strong><p>{generated.summary}</p>
      <p className="field-help">Edit the team JSON to adjust expertise, knowledge, ownership, handoffs, skills, provider and model before wiring. Omit model to use that provider’s default.</p>
      <label className="field"><span>Review and edit team</span><textarea rows={18} disabled={busy} value={teamText} onChange={event => setTeamText(event.target.value)}/></label>
      {teamError && <p className="inline-error" role="alert">{teamError}</p>}
      <button className="primary" disabled={busy || !reviewedTeam || !!teamError} onClick={() => { if (reviewedTeam) void generate(graph, prompt, { stage: 'workflow', briefPaths, team: reviewedTeam }); }}>Approve team and generate workflow</button>
    </div>}
    {generated && !generated.team && <div className="generated-preview"><strong>{generated.graph.name}</strong><p>{generated.summary}</p><small>{generated.graph.nodes.length} nodes · up to {generated.graph.settings.maxConcurrency} concurrent · {generated.graph.settings.maxTotalAttempts} attempts maximum</small><p>{generated.graph.nodes.filter(node => !graph.nodes.some(old => old.id === node.id)).length} added · {graph.nodes.filter(node => !generated.graph.nodes.some(next => next.id === node.id)).length} removed · {generated.graph.nodes.filter(node => graph.nodes.some(old => old.id === node.id && JSON.stringify(old) !== JSON.stringify(node))).length} changed nodes</p><div>{generated.graph.nodes.map(node => <span key={node.id} className="chip">{node.label}{node.kind === 'agent' ? ` · ${node.config.role?.title ?? 'Agent'} · ${node.config.provider} · ${node.config.model ?? 'default model'} · ${node.config.permission}` : ''}</span>)}</div><details><summary>Review generated graph JSON</summary><pre>{JSON.stringify(generated.graph, null, 2)}</pre></details></div>}
    <div className="dialog-actions"><button className="secondary" disabled={busy || checking || blocked || !prompt.trim() || briefPaths.length > 8} onClick={() => void generate(graph, prompt, teamFirst ? { stage: 'team', briefPaths } : briefPaths.length ? { stage: 'workflow', briefPaths } : undefined)}>{busy ? 'Generating…' : generated ? 'Generate again' : 'Generate preview'}</button>{busy && <button className="secondary" onClick={() => void cancel()}>Cancel generation</button>}<button className="primary" disabled={!generated || !!generated.team || busy} onClick={() => { if (generated && !generated.team) onApply(generated.graph); }}>Apply to canvas</button></div>
  </div>;
}
