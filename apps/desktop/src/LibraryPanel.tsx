import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from './api.js';
import type { Graph } from './model.js';
import type { Role } from '../../../packages/shared/src/index.js';

type Kind = 'workflow' | 'role' | 'lesson';
type Parameter = { name: string; kind: 'path' | 'command'; description: string; default?: string };
type Item = { kind: Kind; slug: string; name: string; version: number; changelog: string; parameters: Parameter[]; origin: { project: string; exportedAt: string } };
type Preview = { item: Item; bindings: Record<string, string>; missing: string[]; result?: { kind: 'workflow'; graph: Graph; problems: string[] } | { kind: 'role'; role: Role } | { kind: 'lesson'; text: string } };
type Candidate = { kind: 'path' | 'command'; value: string; suggestedName: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Saves workflows, roles, and lessons to a folder and applies them to other projects with parameters bound. */
export default function LibraryPanel({ projectId, graph, onApplyWorkflow }: { projectId: string; graph: Graph; onApplyWorkflow: (graph: Graph) => void }) {
  const [location, setLocation] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [selected, setSelected] = useState<{ kind: Kind; slug: string; version: number }>();
  const [preview, setPreview] = useState<Preview>();
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [candidates, setCandidates] = useState<(Candidate & { use: boolean; name: string })[]>([]);
  const [name, setName] = useState(graph.name);
  const [changelog, setChangelog] = useState('');
  const [roles, setRoles] = useState<Role[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const scope = useRef({ alive: true });
  const refresh = useCallback(async () => {
    const current = scope.current;
    try {
      const [info, projectRoles] = await Promise.all([api<{ location: string; items: Item[]; errors: string[] }>('libraryInfo'), api<Role[]>('listRoles', { projectId })]);
      if (current.alive) { setLocation(info.location); setItems(info.items); setErrors(info.errors); setRoles(projectRoles); }
    } catch (cause) { if (current.alive) setError(message(cause)); }
  }, [projectId]);
  useEffect(() => { const current = { alive: true }; scope.current = current; void refresh(); return () => { current.alive = false; }; }, [refresh]);
  useEffect(() => {
    setName(graph.name);
    void api<Candidate[]>('libraryCandidates', { projectId, graph }).then(found => {
      // A workflow imported from the library publishes back with its existing parameters.
      const bound = Object.entries(graph.origin?.bindings ?? {});
      setCandidates(found.map(candidate => { const known = bound.find(([, value]) => value === candidate.value); return { ...candidate, use: !!known || candidate.kind === 'command', name: known?.[0] ?? candidate.suggestedName }; }));
    }).catch(() => setCandidates([]));
  }, [projectId, graph]);
  const act = async (task: () => Promise<void>) => {
    if (pending) return;
    setPending(true); setError(''); setNotice('');
    try { await task(); } catch (cause) { if (scope.current.alive) setError(message(cause)); } finally { if (scope.current.alive) setPending(false); }
  };
  const load = (target: { kind: Kind; slug: string; version: number }, given?: Record<string, string>) => act(async () => {
    setSelected(target);
    const next = await api<Preview>('previewImport', { projectId, ...target, ...(given ? { bindings: given } : {}) });
    setPreview(next); setBindings(next.bindings);
  });
  const latest = (kind: Kind, slug: string) => Math.max(...items.filter(item => item.kind === kind && item.slug === slug).map(item => item.version));
  const slugs = [...new Map(items.map(item => [`${item.kind}:${item.slug}`, item])).values()];
  const update = graph.origin && items.some(item => item.kind === 'workflow' && item.slug === graph.origin!.library && item.version > graph.origin!.version) ? latest('workflow', graph.origin.library) : undefined;
  return <section className="library-panel" aria-label="Library">
    <div className="view-title"><span>Library</span><button className="icon-button" title="Refresh library" aria-label="Refresh library" disabled={pending} onClick={() => void refresh()}><RefreshCw size={14}/></button></div>
    <div className="sidebar-scroll orchestrator-body">
      <label className="field"><span>Library folder</span><input aria-label="Library folder" value={location} onChange={event => setLocation(event.target.value)}/></label>
      <button className="secondary" disabled={pending || !location.trim()} onClick={() => void act(async () => { await api('setLibraryLocation', { path: location.trim() }); await refresh(); setNotice('Library folder saved.'); })}>Use this folder</button>
      <p className="field-help">Items are plain JSON files. Make the folder a Git repository to share it. Imported items are validated and never run on import; their commands still ask for approval.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {notice && <p className="field-help" role="status">{notice}</p>}
      {update && <div className="proposal"><strong>Version {update} of {graph.origin!.library} is available</strong><p>This workflow came from version {graph.origin!.version}. Preview the update with your current parameter values.</p><button className="secondary" disabled={pending} onClick={() => void load({ kind: 'workflow', slug: graph.origin!.library, version: update }, graph.origin!.bindings)}>Preview update</button></div>}

      <div className="inspector-group">Items</div>
      {!slugs.length && <p className="sidebar-hint">The library is empty. Save a workflow, role, or lesson below.</p>}
      {slugs.map(item => <button key={`${item.kind}:${item.slug}`} className={`sidebar-item ${selected?.slug === item.slug && selected.kind === item.kind ? 'active' : ''}`} onClick={() => void load({ kind: item.kind, slug: item.slug, version: latest(item.kind, item.slug) })}><span>{item.name}</span><small>{item.kind} · v{latest(item.kind, item.slug)}</small></button>)}
      {errors.length > 0 && <details><summary>{errors.length} unreadable files</summary><ul className="validation-list">{errors.map(item => <li key={item}>{item}</li>)}</ul></details>}

      {preview && selected && <article className="proposal" aria-label={`Import ${preview.item.name}`}>
        <strong>{preview.item.name} · {preview.item.kind}</strong>
        <label className="field"><span>Version</span><select aria-label="Item version" value={selected.version} onChange={event => void load({ ...selected, version: Number(event.target.value) }, bindings)}>{items.filter(item => item.kind === selected.kind && item.slug === selected.slug).map(item => <option key={item.version} value={item.version}>v{item.version}{item.changelog ? ` — ${item.changelog.slice(0, 40)}` : ''}</option>)}</select></label>
        <small>From {preview.item.origin.project}</small>
        {preview.item.parameters.map(parameter => <label className="field" key={parameter.name}><span>{parameter.name}{parameter.description ? ` — ${parameter.description}` : ''}</span><input aria-label={`Parameter ${parameter.name}`} value={bindings[parameter.name] ?? ''} placeholder={parameter.kind === 'command' ? 'For example: npm test' : 'A folder in this project'} onChange={event => setBindings(old => ({ ...old, [parameter.name]: event.target.value }))}/></label>)}
        {preview.item.parameters.length > 0 && <button className="secondary" disabled={pending} onClick={() => void load(selected, bindings)}>Preview with these values</button>}
        {preview.missing.length > 0 && <p className="inline-error">Set values for: {preview.missing.join(', ')}.</p>}
        {preview.result?.kind === 'workflow' && <>
          <p>{preview.result.graph.nodes.length} steps. {preview.result.problems.length ? `${preview.result.problems.length} validation problems:` : 'Valid.'}</p>
          {preview.result.problems.length > 0 && <ul className="validation-list">{preview.result.problems.slice(0, 5).map(problem => <li key={problem}>{problem}</li>)}</ul>}
          <button className="primary" disabled={pending || preview.result.problems.length > 0} onClick={() => { if (preview.result?.kind === 'workflow') { onApplyWorkflow(preview.result.graph); setNotice('Applied to the canvas as a draft. Save it to keep it.'); } }}>Apply to canvas</button>
        </>}
        {preview.result?.kind === 'role' && <><p>{preview.result.role.title} · owns {preview.result.role.owns.join(', ') || 'nothing'}</p><button className="primary" disabled={pending} onClick={() => void act(async () => { await api('importToProject', { projectId, kind: 'role', slug: selected.slug, version: selected.version, bindings }); await refresh(); setNotice('Added to the project role library.'); })}>Add to project roles</button></>}
        {preview.result?.kind === 'lesson' && <><p>{preview.result.text}</p><button className="primary" disabled={pending} onClick={() => void act(async () => { await api('importToProject', { projectId, kind: 'lesson', slug: selected.slug, version: selected.version, bindings }); setNotice('Added to project memory.'); })}>Add to project memory</button></>}
      </article>}

      <div className="inspector-group">Save this workflow</div>
      <label className="field"><span>Name</span><input aria-label="Library item name" value={name} onChange={event => setName(event.target.value)}/></label>
      <label className="field"><span>What changed (optional)</span><input aria-label="Changelog" value={changelog} onChange={event => setChangelog(event.target.value)}/></label>
      {candidates.length > 0 && <p className="field-help">Parameters replace project-specific values so the workflow fits other projects.</p>}
      {candidates.map((candidate, index) => <div className="library-parameter" key={`${candidate.kind}:${candidate.value}`}>
        <label className="check-field"><input type="checkbox" checked={candidate.use} onChange={event => setCandidates(old => old.map((item, i) => i === index ? { ...item, use: event.target.checked } : item))}/><code>{candidate.value}</code></label>
        <input aria-label={`Parameter name for ${candidate.value}`} value={candidate.name} disabled={!candidate.use} onChange={event => setCandidates(old => old.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}/>
      </div>)}
      <button className="secondary" disabled={pending || !name.trim()} onClick={() => void act(async () => {
        const saved = await api<Item>('exportToLibrary', { projectId, kind: 'workflow', name: name.trim(), changelog, graph, parameters: candidates.filter(item => item.use).map(item => ({ name: item.name, kind: item.kind, value: item.value, description: '' })) });
        await refresh(); setNotice(`Saved ${saved.name} as version ${saved.version}.`);
      })}>Save workflow to library</button>
      {roles.length > 0 && <>
        <div className="inspector-group">Save a project role</div>
        {roles.map(role => <button key={role.id} className="sidebar-item" disabled={pending} onClick={() => void act(async () => { const saved = await api<Item>('exportToLibrary', { projectId, kind: 'role', name: role.title, roleId: role.id }); await refresh(); setNotice(`Saved ${saved.name} as version ${saved.version}.`); })}><span>{role.title}</span><small>save</small></button>)}
      </>}
    </div>
  </section>;
}
