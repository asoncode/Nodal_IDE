import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import type { Graph, Provider } from './model.js';
import { useWorkflowGeneration } from './useWorkflowGeneration.js';

type Props = { projectId: string; graph: Graph; prompt: string; onPromptChange: (value: string) => void; onApply: (graph: Graph) => void };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function GenerationPanel({ projectId, graph, prompt, onPromptChange, onApply }: Props) {
  const [providers, setProviders] = useState<(Provider & { loginCommand?: string })[]>([]);
  const [checking, setChecking] = useState(true);
  const [providerError, setProviderError] = useState('');
  const { busy, progress, error, generated, generate, cancel } = useWorkflowGeneration(projectId);
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

  const planner = providers.find(provider => provider.id === 'claude');
  const blocked = planner?.available === false || planner?.status === 'missing';
  return <div className="modal-body">
    <p>Describe the work. You review a validated graph before it is applied to the canvas.</p>
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
    <p className="field-help">Generating sends your prompt and current workflow configuration to the selected provider. It does not execute the generated workflow.</p>
    {progress && <p role="status">{progress}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {generated && <div className="generated-preview"><strong>{generated.graph.name}</strong><p>{generated.summary}</p><small>{generated.graph.nodes.length} nodes · up to {generated.graph.settings.maxConcurrency} concurrent · {generated.graph.settings.maxTotalAttempts} attempts maximum</small><div>{generated.graph.nodes.map(node => <span key={node.id} className="chip">{node.label}{node.kind === 'agent' ? ` · ${node.config.provider}` : ''}</span>)}</div><details><summary>Review generated graph JSON</summary><pre>{JSON.stringify(generated.graph, null, 2)}</pre></details></div>}
    <div className="dialog-actions"><button className="secondary" disabled={busy || checking || blocked || !prompt.trim()} onClick={() => void generate(graph, prompt)}>{busy ? 'Generating…' : generated ? 'Generate again' : 'Generate preview'}</button>{busy && <button className="secondary" onClick={() => void cancel()}>Cancel generation</button>}<button className="primary" disabled={!generated || busy} onClick={() => { if (generated) onApply(generated.graph); }}>Apply to canvas</button></div>
  </div>;
}
