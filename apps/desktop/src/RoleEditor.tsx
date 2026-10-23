import { useEffect, useRef, useState } from 'react';
import { RoleSchema, type Role } from '../../../packages/shared/src/index.js';
import { api } from './api.js';

const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
const emptyRole = (): Role => ({ id: crypto.randomUUID(), title: '', expertise: '', knowledge: [], owns: [], produces: [], consumes: [], skills: [] });

/** Edits a snapshot; library changes never mutate a workflow or a recorded run. */
export default function RoleEditor({ value, onChange, actionLabel = 'Apply role to step', allowRemove = true }: { value?: Role; onChange: (role: Role | undefined) => void; actionLabel?: string; allowRemove?: boolean }) {
  const [draft, setDraft] = useState<Role>(() => structuredClone(value ?? emptyRole()));
  const [produces, setProduces] = useState(JSON.stringify(value?.produces ?? [], null, 2));
  const [consumes, setConsumes] = useState(JSON.stringify(value?.consumes ?? [], null, 2));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(structuredClone(value ?? emptyRole())); setProduces(JSON.stringify(value?.produces ?? [], null, 2)); setConsumes(JSON.stringify(value?.consumes ?? [], null, 2)); setError(''); }, [value]);
  const patch = (key: 'title' | 'expertise', text: string) => setDraft(old => ({ ...old, [key]: text }));
  return <div className="role-editor">
    <label className="field"><span>Role title</span><input value={draft.title} onChange={event => patch('title', event.target.value)}/></label>
    <label className="field"><span>Expertise and standards</span><textarea rows={4} value={draft.expertise} onChange={event => patch('expertise', event.target.value)}/></label>
    {([{ key: 'knowledge', label: 'Knowledge paths (one per line)' }, { key: 'owns', label: 'Owned paths (one per line)' }, { key: 'skills', label: 'Skill instructions (one per line)' }] as const).map(field => <label className="field" key={field.key}><span>{field.label}</span><textarea rows={3} value={draft[field.key].join('\n')} onChange={event => setDraft(old => ({ ...old, [field.key]: event.target.value.split('\n') }))}/></label>)}
    <p className="field-help">Knowledge and ownership use repository-relative paths or globs. External knowledge sources are not supported.</p>
    <details><summary>Handoffs</summary><p className="field-help">JSON arrays of named repository files: name, path, required. Produced files may also declare a JSON schema.</p>
      <label className="field"><span>Produces JSON</span><textarea className="config-json" rows={5} value={produces} onChange={event => setProduces(event.target.value)}/></label>
      <label className="field"><span>Consumes JSON</span><textarea className="config-json" rows={5} value={consumes} onChange={event => setConsumes(event.target.value)}/></label>
    </details>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="role-actions"><button className="secondary" onClick={() => { try { const parsed = RoleSchema.parse({ ...draft, knowledge: lines(draft.knowledge.join('\n')), owns: lines(draft.owns.join('\n')), skills: lines(draft.skills.join('\n')), produces: JSON.parse(produces), consumes: JSON.parse(consumes) }); onChange(parsed); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>{actionLabel}</button>{value && allowRemove && <button className="secondary" onClick={() => onChange(undefined)}>Remove role</button>}</div>
  </div>;
}

export function RoleLibrary({ projectId, role, onApply }: { projectId: string; role?: Role; onApply?: (role: Role) => void }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Role>();
  const [creating, setCreating] = useState(false);
  const scope = useRef({ alive: true });
  useEffect(() => {
    const current = { alive: true }; scope.current = current;
    setRoles([]); setLoaded(false); setPending(false); setError(''); setEditing(undefined); setCreating(false);
    return () => { current.alive = false; };
  }, [projectId]);
  const perform = async (task: () => Promise<() => void>) => {
    if (pending) return;
    const current = scope.current;
    setPending(true); setError('');
    try { const commit = await task(); if (current.alive) commit(); }
    catch (cause) { if (current.alive) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current.alive) setPending(false); }
  };
  const save = async (next: Role) => {
    await api<Role>('saveRole', { projectId, role: structuredClone(next) });
    const saved = await api<Role[]>('listRoles', { projectId });
    return () => { setRoles(saved); setLoaded(true); setEditing(undefined); setCreating(false); };
  };
  return <section className="role-library" aria-label="Project role library">
    <div className="inspector-group">Project role library</div>
    <div className="role-actions"><button className="secondary" disabled={pending} onClick={() => void perform(async () => { const saved = await api<Role[]>('listRoles', { projectId }); return () => { setRoles(saved); setLoaded(true); }; })}>{loaded ? 'Refresh roles' : 'Load roles'}</button><button className="secondary" disabled={pending} onClick={() => { setCreating(true); setEditing(undefined); }}>New role</button>{role && <button className="secondary" disabled={pending} onClick={() => void perform(() => save(role))}>Save step role to library</button>}</div>
    <p className="field-help">Applying a role copies it into the draft. Library edits do not change existing steps or runs.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loaded && !roles.length && <p className="field-help">No saved roles. Create a role or save one from an agent step.</p>}
    {roles.map(item => <div className="role-library-item" key={item.id}><strong>{item.title}</strong><small>{item.owns.join(', ') || 'No edit ownership'}</small><div className="role-actions">{onApply && <button className="secondary" disabled={pending} onClick={() => onApply(structuredClone(item))}>Apply {item.title}</button>}<button className="secondary" disabled={pending} aria-label={`Edit ${item.title}`} onClick={() => { setEditing(item); setCreating(false); }}>Edit</button><button className="secondary danger" disabled={pending} aria-label={`Delete ${item.title}`} onClick={() => void perform(async () => { await api('deleteRole', { projectId, roleId: item.id }); return () => { setRoles(old => old.filter(saved => saved.id !== item.id)); if (editing?.id === item.id) setEditing(undefined); }; })}>Delete</button></div></div>)}
    {(creating || editing) && <><RoleEditor key={editing?.id ?? 'new'} value={editing} allowRemove={false} actionLabel="Save library role" onChange={next => { if (next) void perform(() => save(next)); else { setEditing(undefined); setCreating(false); } }}/><button className="secondary" disabled={pending} onClick={() => { setEditing(undefined); setCreating(false); }}>Cancel library edit</button></>}
  </section>;
}

export function RoleRunDetails({ events }: { events: { eventId: string; kind: string; payload: unknown }[] }) {
  const recorded = events.filter(event => /^(role\.(context|usage|policy_violation)|handoff\.verified)$/.test(event.kind));
  if (!recorded.length) return null;
  return <section className="role-run-details" aria-label="Recorded role context"><div className="inspector-group">Recorded role context and usage</div>{recorded.map(event => {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
    return <details key={event.eventId}><summary>{event.kind === 'role.context' ? 'Context supplied' : event.kind === 'role.usage' ? 'Attempt usage' : event.kind === 'handoff.verified' ? 'Verified handoff' : 'Ownership policy violation'}</summary>{event.kind === 'role.usage' && <p className="field-help">Input tokens: {typeof payload.inputTokens === 'number' ? payload.inputTokens : 'unavailable'} · Output tokens: {typeof payload.outputTokens === 'number' ? payload.outputTokens : 'unavailable'} · Cost: {typeof payload.costUsd === 'number' ? `$${payload.costUsd}` : 'unavailable'}</p>}<pre>{JSON.stringify(event.payload, null, 2)}</pre></details>;
  })}</section>;
}
