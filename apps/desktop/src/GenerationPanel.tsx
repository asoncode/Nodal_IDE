import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import type { Graph, Provider } from './model.js';
import { GraphSchema } from '../../../packages/shared/src/index.js';
import { validateGraph } from '../../../packages/core/src/index.js';
import type { GenerationSnapshot } from '../../../packages/shared/src/generation.js';

type Props = { projectId: string; graph: Graph; prompt: string; onPromptChange: (value: string) => void; onApply: (graph: Graph) => void };
type Job = { projectId: string; id?: string; cancelled: boolean; controller: AbortController; timer?: ReturnType<typeof setTimeout>; cancelPromise?: Promise<unknown> };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function cancelRemote(job: Job) {
  if (!job.id) return Promise.resolve();
  return job.cancelPromise ??= api('cancelGeneration', { projectId: job.projectId, generationId: job.id }, { keepalive: true });
}

export default function GenerationPanel({ projectId, graph, prompt, onPromptChange, onApply }: Props) {
  const [providers, setProviders] = useState<(Provider & { loginCommand?: string })[]>([]);
  const [checking, setChecking] = useState(true);
  const [providerError, setProviderError] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<NonNullable<GenerationSnapshot['result']>>();
  const active = useRef<Job | undefined>(undefined);
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
    setGenerated(undefined); setError(''); setProgress(''); setBusy(false); setProviders([]);
    void refreshProviders();
    return () => {
      current.alive = false;
      const job = active.current;
      active.current = undefined;
      if (job) {
        job.cancelled = true; job.controller.abort(); clearTimeout(job.timer);
        void cancelRemote(job).catch(() => {});
      }
    };
  }, [projectId]);

  async function generate() {
    if (active.current) return;
    const current = scope.current;
    const job: Job = { projectId, cancelled: false, controller: new AbortController() };
    active.current = job;
    const visible = () => current.alive && active.current === job;
    setBusy(true); setGenerated(undefined); setError(''); setProgress('Starting generation…');
    const finishCancellation = async () => {
      try {
        await cancelRemote(job);
        if (visible()) setProgress('Generation cancelled.');
      } catch (error) {
        if (visible()) { setProgress(''); setError(`Could not confirm cancellation. ${message(error)} The generation may still be running.`); }
      } finally {
        if (visible()) { active.current = undefined; setBusy(false); }
      }
    };
    const inspect = async () => {
      try {
        const snapshot = await api<GenerationSnapshot>('inspectGeneration', { projectId: job.projectId, generationId: job.id }, { signal: job.controller.signal });
        if (!visible() || job.cancelled) return;
        if (snapshot.status === 'running') {
          setProgress('Generating workflow… You can cancel while the provider is working.');
          job.timer = setTimeout(() => void inspect(), 750);
          return;
        }
        if (snapshot.status === 'failed') throw new Error(snapshot.error || 'Generation failed. Try again.');
        if (snapshot.status === 'cancelled') setProgress('Generation cancelled.');
        else {
          if (!snapshot.result) throw new Error('Generation completed without a workflow. Try again.');
          const parsed = GraphSchema.parse(snapshot.result.graph);
          const check = validateGraph(parsed);
          if (!check.valid) throw new Error(check.errors.map(issue => issue.message).join(' · '));
          setGenerated({ ...snapshot.result, graph: parsed }); setProgress('Preview ready. Review it before applying.');
        }
        active.current = undefined; setBusy(false);
      } catch (error) {
        if (!visible() || job.cancelled) return;
        job.cancelled = true;
        let detail = message(error);
        try { await cancelRemote(job); } catch (cancelError) { detail += ` Could not confirm cancellation: ${message(cancelError)} The generation may still be running.`; }
        if (visible()) { active.current = undefined; setBusy(false); setProgress(''); setError(detail); }
      }
    };
    try {
      const snapshot = await api<GenerationSnapshot>('startGeneration', { projectId, graph, prompt, provider: 'claude' });
      job.id = snapshot.id;
      if (!visible() || job.cancelled) { await finishCancellation(); return; }
      setProgress('Generating workflow… You can cancel while the provider is working.');
      await inspect();
    } catch (error) {
      if (visible()) { active.current = undefined; setBusy(false); setProgress(''); setError(message(error)); }
    }
  }

  async function cancel() {
    const job = active.current;
    if (!job || job.cancelled) return;
    job.cancelled = true; job.controller.abort(); clearTimeout(job.timer);
    setProgress('Cancelling generation…');
    if (!job.id) return;
    const current = scope.current;
    try {
      await cancelRemote(job);
      if (current.alive && active.current === job) setProgress('Generation cancelled.');
    } catch (error) {
      if (current.alive && active.current === job) { setProgress(''); setError(`Could not confirm cancellation. ${message(error)} The generation may still be running.`); }
    } finally {
      if (current.alive && active.current === job) { active.current = undefined; setBusy(false); }
    }
  }

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
    <div className="dialog-actions"><button className="secondary" disabled={busy || checking || blocked || !prompt.trim()} onClick={() => void generate()}>{busy ? 'Generating…' : generated ? 'Generate again' : 'Generate preview'}</button>{busy && <button className="secondary" onClick={() => void cancel()}>Cancel generation</button>}<button className="primary" disabled={!generated || busy} onClick={() => { if (generated) onApply(generated.graph); }}>Apply to canvas</button></div>
  </div>;
}
