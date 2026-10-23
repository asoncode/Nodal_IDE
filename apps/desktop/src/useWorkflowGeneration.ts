import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import type { Graph } from './model.js';
import { GraphSchema } from '../../../packages/shared/src/index.js';
import { validateGraph } from '../../../packages/core/src/index.js';
import type { GenerationSnapshot } from '../../../packages/shared/src/generation.js';
import { TeamPlanSchema, type PlanningOptions } from '../../../packages/shared/src/team.js';

export type GeneratedWorkflow = NonNullable<GenerationSnapshot['result']>;
type Job = { projectId: string; id?: string; cancelled: boolean; controller: AbortController; timer?: ReturnType<typeof setTimeout>; cancelPromise?: Promise<unknown> };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function cancelRemote(job: Job) {
  if (!job.id) return Promise.resolve();
  return job.cancelPromise ??= api('cancelGeneration', { projectId: job.projectId, generationId: job.id }, { keepalive: true });
}

/** Runs one background workflow generation at a time for a project and validates the preview it returns. */
export function useWorkflowGeneration(projectId: string) {
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<GeneratedWorkflow>();
  const active = useRef<Job | undefined>(undefined);
  const scope = useRef({ alive: true });

  useEffect(() => {
    const current = { alive: true }; scope.current = current;
    setGenerated(undefined); setError(''); setProgress(''); setBusy(false);
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

  async function generate(graph: Graph, prompt: string, planning?: PlanningOptions) {
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
          if (planning?.stage === 'team') TeamPlanSchema.parse(snapshot.result.team);
          const parsed = GraphSchema.parse(snapshot.result.graph);
          const check = validateGraph(parsed);
          if (!check.valid) throw new Error(check.errors.map(issue => issue.message).join(' · '));
          setGenerated({ ...snapshot.result, graph: parsed }); setProgress(planning?.stage === 'team' ? 'Team ready. Review roles before generating the workflow.' : 'Preview ready. Review it before applying.');
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
      const snapshot = await api<GenerationSnapshot>('startGeneration', { projectId, graph, prompt, provider: 'claude', ...(planning ? { planning } : {}) });
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

  const clear = () => { if (!active.current) { setGenerated(undefined); setProgress(''); setError(''); } };
  return { busy, progress, error, generated, generate, cancel, clear };
}
