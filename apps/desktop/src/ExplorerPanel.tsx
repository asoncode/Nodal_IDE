import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, Copy, FileCode2, FilePlus2, Folder, FolderOpen, FolderPlus, MoreHorizontal, RefreshCw, Trash2, Undo2, X } from 'lucide-react';
import { api } from './api.js';
import type { FileBuffer, Project } from './model.js';
import './ExplorerPanel.css';

type Entry = { path: string; kind: 'file' | 'directory'; size?: number };
type ReadFile = { path: string; content: string; hash: string };
type DeletedFile = { trashId: string; path: string; deletedAt: string };
type Draft = { kind: 'file' | 'directory' | 'rename' | 'duplicate'; path: string; source?: string };
export interface ExplorerPanelProps {
  project?: Project; files: string[]; buffers: FileBuffer[]; activeFile?: string; busy?: boolean;
  actionRequest?: { action: 'newFile' | 'newFolder' | 'refresh' | 'collapse' | 'reveal'; version: number; path?: string };
  onOpenFolder: () => void; onOpenFile: (path: string) => void; onFilesChange: (files: string[]) => void;
  onCreated: (file: ReadFile) => void; onRenamed: (oldPath: string, file: ReadFile) => void; onDeleted: (path: string) => void;
  onPendingChange?: (pending: boolean) => void;
}
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const parent = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

export default function ExplorerPanel(props: ExplorerPanelProps) {
  const { project, files, buffers, activeFile, busy, onOpenFolder, onOpenFile } = props;
  const [listing, setListing] = useState<{ projectId: string; entries: Entry[]; truncated: boolean }>();
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [menu, setMenu] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [trash, setTrash] = useState<DeletedFile[]>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(props); latest.current = props;
  const lifetime = useRef({ projectId: project?.id, mounted: true });
  if (lifetime.current.projectId !== project?.id) lifetime.current = { projectId: project?.id, mounted: true };
  const mutation = useRef<object | undefined>(undefined);
  const scan = useRef<object | undefined>(undefined);
  const entries = useMemo(() => listing && listing.projectId === project?.id ? listing.entries : files.map(path => ({ path, kind: 'file' as const })), [listing, project?.id, files]);
  const refresh = useCallback(async () => {
    const scope = lifetime.current;
    if (!scope.projectId || scan.current) return;
    const request = {}; scan.current = request; setRefreshing(true);
    try {
      const result = await api<{ entries: Entry[]; truncated: boolean }>('workspaceEntries', { projectId: scope.projectId });
      if (!scope.mounted || lifetime.current !== scope || scan.current !== request) return;
      setListing({ projectId: scope.projectId, ...result });
      latest.current.onFilesChange(result.entries.filter(entry => entry.kind === 'file').map(entry => entry.path));
    } catch (cause) { if (scope.mounted && lifetime.current === scope && scan.current === request) setError(message(cause)); }
    finally { if (scan.current === request) { scan.current = undefined; if (scope.mounted && lifetime.current === scope) setRefreshing(false); } }
  }, []);
  // Passive-effect cleanup can run after the next folder is already on screen; end this
  // panel's lifetime synchronously so late file-operation results are always discarded.
  useLayoutEffect(() => { const scope = lifetime.current; scope.mounted = true; return () => { scope.mounted = false; }; }, [project?.id]);
  useEffect(() => {
    const scope = lifetime.current; scope.mounted = true;
    mutation.current = undefined; scan.current = undefined;
    setDraft(undefined); setMenu(undefined); setDeleting(undefined); setTrash(undefined); setError(''); setPending(false); setRefreshing(false); setFolder(''); setQuery(''); setOpenFolders({});
    void refresh();
    const focus = () => { if (!mutation.current) void refresh(); };
    window.addEventListener('focus', focus);
    return () => { scope.mounted = false; latest.current.onPendingChange?.(false); window.removeEventListener('focus', focus); };
  }, [project?.id, refresh]);

  const run = async (work: (valid: () => boolean, projectId: string) => Promise<void>) => {
    if (mutation.current || busy || !project) return;
    const scope = lifetime.current, request = {}; mutation.current = request; scan.current = undefined; setRefreshing(false); setPending(true); latest.current.onPendingChange?.(true); setError('');
    const valid = () => scope.mounted && lifetime.current === scope;
    try { await work(valid, project.id); }
    catch (cause) { if (valid()) setError(message(cause)); }
    finally { if (mutation.current === request) { mutation.current = undefined; if (valid()) { setPending(false); latest.current.onPendingChange?.(false); } } }
  };
  const assertTarget = (path: string) => {
    if (!path.trim() || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Enter a relative path without empty, . or .. segments.');
    if (latest.current.buffers.some(buffer => buffer.path === path) || entries.some(entry => entry.path === path)) throw new Error('That path already exists or is open in the editor. Choose another path.');
  };
  const expectedHash = async (path: string, projectId: string) => {
    const disk = await api<ReadFile>('readFile', { projectId, path });
    const buffer = latest.current.buffers.find(item => item.path === path);
    if (buffer && buffer.hash !== disk.hash) throw new Error('This file changed on disk. Reload or resolve its changes before continuing.');
    return buffer?.hash ?? disk.hash;
  };
  const updateEntries = (next: Entry[]) => {
    setListing({ projectId: project!.id, entries: next, truncated: listing?.truncated ?? false });
    latest.current.onFilesChange(next.filter(entry => entry.kind === 'file').map(entry => entry.path));
  };
  const submit = () => draft && void run(async (valid, projectId) => {
    const { kind, path, source } = draft;
    if (kind === 'rename' && source === path) { setDraft(undefined); return; }
    assertTarget(path);
    if (kind === 'directory') {
      await api('createFolder', { projectId, path });
      if (!valid()) return;
      updateEntries([...entries, { path, kind: 'directory' }]);
      setOpenFolders(old => ({ ...old, [path]: true })); setFolder(path);
    } else {
      let file: ReadFile;
      if (source) {
        const hash = await expectedHash(source, projectId);
        if (!valid()) return;
        file = await api<ReadFile>(kind === 'rename' ? 'renameFile' : 'duplicateFile', { projectId, path: source, newPath: path, expectedHash: hash });
      } else file = await api<ReadFile>('createFile', { projectId, path });
      if (!valid()) return;
      updateEntries([...entries.filter(entry => kind !== 'rename' || entry.path !== source), { path: file.path, kind: 'file' }]);
      if (kind === 'rename') latest.current.onRenamed(source!, file); else latest.current.onCreated(file);
    }
    setOpenFolders(old => {
      const next = { ...old }; let directory = parent(path);
      while (directory) { next[directory] = true; directory = parent(directory); }
      return next;
    });
    setQuery(''); setDraft(undefined);
  });
  const deleteFile = () => deleting && void run(async (valid, projectId) => {
    const path = deleting, hash = await expectedHash(path, projectId);
    if (!valid()) return;
    await api('trashFile', { projectId, path, expectedHash: hash });
    if (!valid()) return;
    updateEntries(entries.filter(entry => entry.path !== path)); latest.current.onDeleted(path); setDeleting(undefined);
  });
  const showTrash = () => void run(async (valid, projectId) => {
    const result = await api<DeletedFile[]>('listTrash', { projectId });
    if (valid()) { setTrash(result); setMenu(undefined); }
  });
  const restore = (item: DeletedFile) => void run(async (valid, projectId) => {
    assertTarget(item.path);
    const file = await api<ReadFile>('restoreTrash', { projectId, trashId: item.trashId });
    if (!valid()) return;
    updateEntries([...entries, { path: file.path, kind: 'file' }]); latest.current.onCreated(file); setTrash(old => old?.filter(entry => entry.trashId !== item.trashId));
    setQuery('');
    setOpenFolders(old => {
      const next = { ...old }; let directory = parent(file.path);
      while (directory) { next[directory] = true; directory = parent(directory); }
      return next;
    });
  });
  const copyPath = async (path: string, absolute: boolean) => {
    const scope = lifetime.current; setMenu(undefined);
    try { await navigator.clipboard.writeText(absolute ? `${project!.root.replace(/[/\\]$/, '')}/${path}` : path); }
    catch (cause) { if (scope.mounted && lifetime.current === scope) setError(`Could not copy path: ${message(cause)}`); }
  };
  const startDraft = (kind: Draft['kind'], source?: string) => {
    setMenu(undefined); setError('');
    setDraft({ kind, source, path: source ?? (folder ? `${folder}/` : '') });
  };
  const tree = useMemo(() => {
    const all = new Map<string, Entry>();
    for (const entry of entries) {
      all.set(entry.path, entry);
      let directory = parent(entry.path);
      while (directory) { if (!all.has(directory)) all.set(directory, { path: directory, kind: 'directory' }); directory = parent(directory); }
    }
    return [...all.values()].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.path.localeCompare(b.path));
  }, [entries]);
  const handledAction = useRef<number | undefined>(undefined);
  useEffect(() => {
    const request = props.actionRequest;
    if (!request || handledAction.current === request.version || !project) return;
    handledAction.current = request.version;
    if (request.action === 'reveal') {
      const path = request.path ?? activeFile;
      if (!path) return;
      setQuery(''); setFolder(parent(path));
      setOpenFolders(old => {
        const next = { ...old }; let directory = parent(path);
        while (directory) { next[directory] = true; directory = parent(directory); }
        return next;
      });
    } else if (request.action === 'collapse') setOpenFolders(Object.fromEntries(tree.filter(entry => entry.kind === 'directory').map(entry => [entry.path, false])));
    else if (!busy && !mutation.current) {
      if (request.action === 'refresh') { setError(''); void refresh(); }
      else { setMenu(undefined); setError(''); setDraft({ kind: request.action === 'newFile' ? 'file' : 'directory', path: folder ? `${folder}/` : '' }); }
    }
  }, [props.actionRequest, project, activeFile, tree, busy, folder, refresh]);
  const disabled = busy || pending;
  const rows = (directory: string, depth: number, filtered = false): React.ReactNode[] => (filtered ? entries.filter(entry => entry.kind === 'file' && entry.path.toLowerCase().includes(query.toLowerCase())) : tree.filter(entry => parent(entry.path) === directory)).flatMap(entry => {
    const isFolder = entry.kind === 'directory', open = openFolders[entry.path] ?? depth === 0;
    return [<div key={entry.path} className={`explorer-row ${activeFile === entry.path || folder === entry.path ? 'selected' : ''}`}>
      <button className="explorer-entry" style={{ paddingLeft: 8 + depth * 12 }} aria-label={entry.path} aria-expanded={isFolder ? open : undefined} title={entry.path} onClick={() => { setMenu(undefined); if (isFolder) { setFolder(entry.path); setOpenFolders(old => ({ ...old, [entry.path]: !open })); } else { setFolder(parent(entry.path)); onOpenFile(entry.path); } }} onKeyDown={event => {
        if (isFolder || event.nativeEvent.isComposing) return;
        if (event.key === 'F2' || event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); if (!disabled) { if (event.key === 'F2') startDraft('rename', entry.path); else { setDeleting(entry.path); setError(''); } } }
      }}>{isFolder ? <>{open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<Folder size={14}/></> : <FileCode2 size={14}/>}<span>{filtered ? entry.path : entry.path.split('/').at(-1)}</span>{buffers.some(buffer => buffer.path === entry.path && buffer.content !== buffer.savedContent) && <span className="dirty-dot" aria-label="Unsaved changes"/>}</button>
      <button className="icon-button explorer-more" aria-label={`Actions for ${entry.path}`} aria-expanded={menu === entry.path} onClick={() => setMenu(menu === entry.path ? undefined : entry.path)}><MoreHorizontal size={14}/></button>
      {menu === entry.path && <div className="explorer-menu" onKeyDown={event => { if (event.key === 'Escape') setMenu(undefined); }}>
        {!isFolder && <><button disabled={disabled} onClick={() => startDraft('rename', entry.path)}>Rename file</button><button disabled={disabled} onClick={() => startDraft('duplicate', entry.path)}>Duplicate saved file</button><button disabled={disabled} onClick={() => { setDeleting(entry.path); setMenu(undefined); setError(''); }}><Trash2 size={13}/>Delete file</button></>}
        <button onClick={() => void copyPath(entry.path, false)}><Copy size={13}/>Copy relative path</button><button onClick={() => void copyPath(entry.path, true)}>Copy absolute path</button>
      </div>}
    </div>, ...(!filtered && isFolder && open ? rows(entry.path, depth + 1) : [])];
  });
  return <section className="explorer-panel" aria-label="File explorer">
    <div className="view-title"><span>Explorer</span><div className="explorer-actions">
      <button className="icon-button" title="New File" aria-label="New File" disabled={!project || disabled} onClick={() => startDraft('file')}><FilePlus2 size={15}/></button>
      <button className="icon-button" title="New Folder" aria-label="New Folder" disabled={!project || disabled} onClick={() => startDraft('directory')}><FolderPlus size={15}/></button>
      <button className="icon-button" title="Refresh Explorer" aria-label="Refresh Explorer" disabled={!project || disabled || refreshing} onClick={() => { setError(''); void refresh(); }}><RefreshCw size={14}/></button>
      <button className="icon-button" title="Collapse All" aria-label="Collapse All" disabled={!project} onClick={() => setOpenFolders(Object.fromEntries(tree.filter(entry => entry.kind === 'directory').map(entry => [entry.path, false])))}><ChevronsDownUp size={14}/></button>
      <button className="icon-button" title="Open Folder" aria-label="Open Folder" onClick={onOpenFolder}><FolderOpen size={15}/></button>
    </div></div>
    {!project ? <div className="empty-state"><p>Open a folder to start editing.</p><button className="primary" onClick={onOpenFolder}>Open Folder</button></div> : <>
      <button className="explorer-root" title={project.root} onClick={() => { setFolder(''); setMenu(undefined); }}><FolderOpen size={14}/><strong>{project.name}</strong></button>
      <div className="explorer-filter"><input aria-label="Filter files" placeholder="Filter files…" value={query} onChange={event => setQuery(event.target.value)}/><button className="icon-button" aria-label="Deleted files" title="Deleted files" disabled={disabled} onClick={showTrash}><Trash2 size={14}/></button></div>
      {draft && <form className="new-file-form" onSubmit={event => { event.preventDefault(); submit(); }}>
        <label className="explorer-draft-label">{({ file: 'New file', directory: 'New folder', rename: 'Rename file', duplicate: 'Duplicate saved file' })[draft.kind]}</label>
        <div className="new-file-input"><input autoFocus key={`${draft.kind}:${draft.source ?? ''}`} aria-label={draft.kind === 'file' ? 'New file path' : draft.kind === 'directory' ? 'New folder path' : draft.kind === 'rename' ? 'Rename file path' : 'Duplicate file path'} value={draft.path} disabled={disabled} onChange={event => { setDraft({ ...draft, path: event.target.value }); setError(''); }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return; } if (event.key === 'Escape') { event.preventDefault(); setDraft(undefined); setError(''); } }}/><button type="submit" disabled={disabled}>OK</button><button type="button" className="icon-button" aria-label="Cancel file action" disabled={pending} onClick={() => { setDraft(undefined); setError(''); }}><X size={13}/></button></div>
        {draft.kind === 'duplicate' && <p className="explorer-hint">Copies the saved file on disk. Unsaved edits stay in the original.</p>}
      </form>}
      {deleting && <div className="explorer-confirm" role="dialog" aria-label="Delete file" aria-modal="false"><p>Delete <strong>{deleting}</strong>?</p><p>Recover it later from Nodal Trash.{buffers.some(buffer => buffer.path === deleting && buffer.content !== buffer.savedContent) ? ' Unsaved editor changes will be discarded.' : ''}</p><button disabled={disabled} onClick={deleteFile}>Delete file</button><button disabled={pending} onClick={() => { setDeleting(undefined); setError(''); }}>Cancel</button></div>}
      {error && <p className="inline-error explorer-error" role="alert">{error}</p>}
      {listing?.projectId === project.id && listing.truncated && <p className="explorer-hint">Showing the first workspace entries. Use a smaller folder to see all files.</p>}
      {trash ? <div className="explorer-trash"><div className="explorer-trash-heading"><strong>Deleted files</strong><button className="icon-button" aria-label="Close deleted files" onClick={() => setTrash(undefined)}><X size={14}/></button></div>{!trash.length && <p className="explorer-hint">Nodal Trash is empty.</p>}{trash.map(item => <div className="explorer-trash-row" key={item.trashId}><span title={`${item.path} · ${item.deletedAt}`}>{item.path}</span><button className="icon-button" aria-label={`Restore ${item.path}`} disabled={disabled} onClick={() => restore(item)}><Undo2 size={14}/></button></div>)}</div> : <div className="file-tree">{query ? rows('', 0, true) : rows('', 0)}{!entries.length && <p className="explorer-hint">This folder is empty. Create a file or folder to begin.</p>}</div>}
    </>}
  </section>;
}
