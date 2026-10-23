import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, MiniMap, applyNodeChanges, applyEdgeChanges, type Node as FlowNode, type Edge as FlowEdge, type Connection, type ReactFlowInstance } from '@xyflow/react';
import { DiffEditor } from '@monaco-editor/react';
import { Play, Pause, Square, Save, Check, Plus, Workflow, GitCompare, History, FolderOpen, ChevronRight, ChevronDown, FileCode2, GitBranch, Sparkles, Undo2, Redo2, Copy, Trash2, X, Search, ShieldCheck, Download, Upload, Files, Plug, RefreshCw, PanelLeft, PanelBottom, PanelRight, Bot, CircleX, CircleCheck, Users, Gauge, Library } from 'lucide-react';
import { api } from './api.js';
import ChatPanel from './ChatPanel.js';
import GenerationPanel from './GenerationPanel.js';
import RoleEditor, { RoleLibrary, RoleRunDetails } from './RoleEditor.js';
import { nodeIcons, nodeTypes } from './WorkflowNode.js';
import ToolEditor from './ToolEditor.js';
import PlaybookEditor from './PlaybookEditor.js';
import OrchestratorPanel from './OrchestratorPanel.js';
import LibraryPanel from './LibraryPanel.js';
import ExplorerPanel from './ExplorerPanel.js';
import SearchPanel from './SearchPanel.js';
import QuickPick from './QuickPick.js';
import CodeEditor, { readEditorSettings, type CodeEditorHandle, type EditorLocation, type Problem } from './CodeEditor.js';
import TerminalPanel, { type TerminalPanelHandle } from './TerminalPanel.js';
import { MessageSquare } from 'lucide-react';
import { isDesktop, pickFolder, restoreLastProject, listenDesktopActions } from './desktop.js';
import { createNode, emptyGraph, NODE_LABELS, language, type Graph, type GraphNode, type NodeKind, type Project, type Provider, type Run, type Event, type Inspection, type FileBuffer } from './model.js';
import { GraphSchema, roleOwnsPath } from '../../../packages/shared/src/index.js';
import { validateGraph } from '../../../packages/core/src/index.js';

type Tab = 'graph' | 'code' | 'diff' | 'replay' | 'playbook';
type View = 'explorer' | 'search' | 'workflows' | 'team' | 'runs' | 'orchestrator' | 'library' | 'providers';
type Diff = { diff: string; branch: string; worktrees: { nodeId: string; path: string; branch: string; diff: string; head: string; sourceHead: string; dirty: boolean }[] };
const kinds = Object.keys(NODE_LABELS) as NodeKind[];
const stringify = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const activeStates = ['queued', 'running', 'paused', 'waiting_approval'];
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });


function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function IconButton({ title, children, onClick, disabled, active, className }: { title: string; children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean; className?: string }) { return <button className={`icon-button ${active ? 'active' : ''} ${className ?? ''}`} title={title} aria-label={title} aria-pressed={active} onClick={onClick} disabled={disabled}>{children}</button>; }
function DiffText({ text }: { text: string }) { return <pre className="unified-diff">{text.split('\n').map((line, index) => <span key={index} className={line.startsWith('@@') ? 'hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : undefined}>{line}{'\n'}</span>)}</pre>; }

export default function App() {
  const [project, setProject] = useState<Project>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [templates, setTemplates] = useState<Graph[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [graph, setGraph] = useState<Graph>(emptyGraph);
  const [savedGraph, setSavedGraph] = useState('');
  const [graphs, setGraphs] = useState<Graph[]>([]);
  const [undo, setUndo] = useState<Graph[]>([]);
  const [redo, setRedo] = useState<Graph[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [nodeDimensions, setNodeDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const dragSnapshot = useRef<Graph | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [tab, setTab] = useState<Tab>('graph');
  const [playbookNodeId, setPlaybookNodeId] = useState<string>();
  const [view, setView] = useState<View>('explorer');
  const [layout, setLayout] = useState({ sidebar: true, panel: true, inspector: true });
  const [chatOpen, setChatOpen] = useState(false);
  const [chatContextRequest, setChatContextRequest] = useState<{ nodeId: string; version: number }>();
  const [sizes, setSizes] = useState({ sidebar: 260, panel: 220, inspector: 300 });
  const [files, setFiles] = useState<string[]>([]);
  const [explorerRequest, setExplorerRequest] = useState<{ action: 'newFile' | 'newFolder' | 'refresh' | 'collapse' | 'reveal'; path?: string; version: number }>();
  const [buffers, setBuffers] = useState<FileBuffer[]>([]);
  const [activeFile, setActiveFile] = useState<string>();
  const [location, setLocation] = useState<EditorLocation>();
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [problems, setProblems] = useState<Record<string, Problem[]>>({});
  const reportProblems = useCallback((path: string, markers: Problem[]) => setProblems(old => JSON.stringify(old[path]) === JSON.stringify(markers) ? old : { ...old, [path]: markers }), []);
  const [editorSettings, setEditorSettings] = useState(readEditorSettings);
  const editorController = useRef<CodeEditorHandle>(null);
  const shortcutActions = useRef({ saveAll: () => {}, closeActive: () => {}, reopen: () => {} });
  const nativeCommand = useRef<(id: string) => void>(() => {});
  const closedFiles = useRef<string[]>([]);
  const projectGeneration = useRef(0);
  const fileWrites = useRef(new Map<string, Promise<void>>());
  const [searchFocus, setSearchFocus] = useState(0);
  useEffect(() => { try { localStorage.setItem('nodal.editor.settings.v1', JSON.stringify(editorSettings)); } catch { /* Preferences remain usable when storage is unavailable. */ } }, [editorSettings]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<string>();
  const [inspection, setInspection] = useState<Inspection>();
  const [events, setEvents] = useState<Event[]>([]);
  const [diff, setDiff] = useState<Diff>();
  const [busy, setBusy] = useState(false);
  const [fileOperationPending, setFileOperationPending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState('Connecting to local runtime…');
  const [error, setError] = useState('');
  const [dock, setDock] = useState<'events' | 'console' | 'approvals' | 'terminal' | 'problems'>('events');
  const terminalController = useRef<TerminalPanelHandle>(null);
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const terminalCount = useRef(0);
  const terminalCountChanged = useCallback((count: number) => { terminalCount.current = count; }, []);
  const [modal, setModal] = useState<'project' | 'generate' | 'palette' | null>(null);
  const [projectPath, setProjectPath] = useState('');
  const [prompt, setPrompt] = useState('');
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteMode, setPaletteMode] = useState<'nodes' | 'files' | 'commands'>('nodes');
  const [configText, setConfigText] = useState('');
  const [configError, setConfigError] = useState('');
  const [replayIndex, setReplayIndex] = useState(0);
  const clipboard = useRef<GraphNode[]>([]);
  const importInput = useRef<HTMLInputElement>(null);
  const flowInstance = useRef<ReactFlowInstance | null>(null);
  useEffect(() => { const timer = window.setTimeout(() => { if (tab === 'graph') void flowInstance.current?.fitView({ padding: .25 }); }, 100); return () => window.clearTimeout(timer); }, [graph.id, tab]);
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const graphBaseline = useRef(JSON.stringify(graph));
  const projectRef = useRef(project);
  projectRef.current = project;
  const explicitFolderChoice = useRef(false);
  const folderPickerOpen = useRef(false);
  const selected = graph.nodes.find(node => node.id === selectedId);
  const edge = graph.edges.find(item => item.id === selectedEdge);
  const currentBuffer = buffers.find(buffer => buffer.path === activeFile);
  const dirty = JSON.stringify(graph) !== savedGraph;
  const escalation = events.findLast(event => event.kind === 'orchestrator.escalation');
  useEffect(() => { if (escalation) setMessage(`Orchestrator paused the run: ${(escalation.payload as { message?: string }).message ?? ''} Resume when ready.`); }, [escalation?.eventId]);
  const selectedRun = inspection?.run ?? runs.find(run => run.id === runId);
  const running = !!selectedRun && activeStates.includes(selectedRun.status);
  const approvals = inspection?.approvals.filter(item => !item.decision || item.decision === 'pending') ?? [];

  const act = useCallback(async (task: () => Promise<void>) => { setBusy(true); setError(''); try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }, []);
  const edit = useCallback((update: Graph | ((old: Graph) => Graph)) => {
    const old = graphRef.current;
    const next = typeof update === 'function' ? update(old) : update;
    setUndo(items => [...items.slice(-49), old]);
    setRedo([]);
    graphRef.current = next;
    setGraph(next);
  }, []);
  const undoGraph = useCallback(() => { if (!undo.length) return; setRedo(items => [...items, graph]); setGraph(undo.at(-1)!); setUndo(items => items.slice(0, -1)); }, [undo, graph]);
  const redoGraph = useCallback(() => { if (!redo.length) return; setUndo(items => [...items, graph]); setGraph(redo.at(-1)!); setRedo(items => items.slice(0, -1)); }, [redo, graph]);
  const changeNode = (patch: Partial<GraphNode>) => edit(old => ({ ...old, nodes: old.nodes.map(node => node.id === selectedId ? { ...node, ...patch } as GraphNode : node) }));
  const changeConfig = (patch: Record<string, unknown>) => selected && changeNode({ config: { ...selected.config, ...patch } } as Partial<GraphNode>);
  const addNode = (kind: NodeKind, position?: { x: number; y: number }) => { const node = createNode(kind, graph.nodes.length); node.position = position ?? { x: 100, y: Math.max(0, ...graph.nodes.map(item => item.position.y)) + 180 }; edit(old => ({ ...old, nodes: [...old.nodes, node] })); setSelectedId(node.id); setSelectedIds([node.id]); setSelectedEdge(undefined); setTab('graph'); setModal(null); };
  const deleteSelection = useCallback(() => {
    if (selectedEdge) { edit(old => ({ ...old, edges: old.edges.filter(item => item.id !== selectedEdge) })); setSelectedEdge(undefined); }
    else if (selectedId || selectedIds.length) { const ids = selectedIds.length ? selectedIds : [selectedId!]; edit(old => ({ ...old, nodes: old.nodes.filter(node => !ids.includes(node.id)), edges: old.edges.filter(item => !ids.includes(item.source) && !ids.includes(item.target)) })); setSelectedId(undefined); setSelectedIds([]); }
  }, [selectedId, selectedIds, selectedEdge, edit]);
  const duplicate = useCallback(() => {
    const source = clipboard.current.length ? clipboard.current : graph.nodes.filter(node => selectedIds.length ? selectedIds.includes(node.id) : node.id === selectedId);
    const copied = source.map(node => ({ ...structuredClone(node), id: crypto.randomUUID(), label: `${node.label} copy`, position: { x: node.position.x + 40, y: node.position.y + 40 } }));
    if (copied.length) { const mapping = new Map(source.map((node, index) => [node.id, copied[index].id])); const edges = graph.edges.filter(edge => mapping.has(edge.source) && mapping.has(edge.target)).map(edge => ({ ...edge, id: crypto.randomUUID(), source: mapping.get(edge.source)!, target: mapping.get(edge.target)! })); edit(old => ({ ...old, nodes: [...old.nodes, ...copied], edges: [...old.edges, ...edges] })); setSelectedId(copied[0].id); setSelectedIds(copied.map(node => node.id)); }
  }, [graph.nodes, graph.edges, selectedId, selectedIds, edit]);
  const resize = (key: keyof typeof sizes, axis: 'x' | 'y', direction: 1 | -1) => (event: React.PointerEvent) => {
    event.preventDefault();
    const origin = axis === 'x' ? event.clientX : event.clientY, initial = sizes[key];
    const move = (next: PointerEvent) => setSizes(old => ({ ...old, [key]: Math.min(640, Math.max(120, initial + direction * ((axis === 'x' ? next.clientX : next.clientY) - origin))) }));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const confirmFolderSwitch = useCallback(() => {
    const unsaved = buffersRef.current.some(buffer => buffer.content !== buffer.savedContent) || JSON.stringify(graphRef.current) !== graphBaseline.current;
    if (terminalCount.current) return window.confirm(`Stop this window's ${terminalCount.current} terminal${terminalCount.current === 1 ? '' : 's'}${unsaved ? ', discard unsaved edits,' : ''} and open another folder?`);
    return !unsaved || window.confirm('Discard unsaved edits and open another folder?');
  }, []);
  const loadProject = useCallback(async (selectedProject: Project, discardConfirmed = false) => {
    if (!discardConfirmed && !confirmFolderSwitch()) return false;
    const generation = ++projectGeneration.current; setExplorerRequest(undefined); setLocation(undefined); setProblems({}); setFileOperationPending(false); closedFiles.current = [];
    const [nextFiles, nextGraphs, nextRuns] = await Promise.all([api<string[]>('files', { projectId: selectedProject.id }), api<Graph[]>('listGraphs', { projectId: selectedProject.id }), api<Run[]>('runs', { projectId: selectedProject.id })]);
    if (generation !== projectGeneration.current) return false;
    const nextGraph = nextGraphs[0] ?? emptyGraph();
    graphRef.current = nextGraph; graphBaseline.current = JSON.stringify(nextGraph);
    projectRef.current = selectedProject; buffersRef.current = [];
    setProject(selectedProject); setBuffers([]); setActiveFile(undefined); setRunId(undefined); setInspection(undefined); setEvents([]); setDiff(undefined); setChatContextRequest(undefined);
    setTerminalGeneration(old => old + 1);
    setFiles(nextFiles); setGraphs(nextGraphs); setRuns(nextRuns); setGraph(nextGraph); setSavedGraph(nextGraphs.length ? JSON.stringify(nextGraph) : ''); setUndo([]); setRedo([]); setSelectedId(undefined); setSelectedIds([]); setSelectedEdge(undefined);
    setTab(selectedProject.isGitRepository === false ? 'code' : 'graph');
    setMessage(`Opened ${selectedProject.name}`);
    return true;
  }, [confirmFolderSwitch]);

  useEffect(() => {
    let disposed = false;
    void act(async () => { const restore = await restoreLastProject(); const bootstrap = await api<{ projects: Project[]; templates: Graph[]; providers: Provider[] }>('bootstrap'); if (disposed) return; setProjects(bootstrap.projects); setTemplates(bootstrap.templates); setProviders(bootstrap.providers); setConnected(true); setMessage('Local runtime connected'); if (!restore) setTab('code'); if (restore && !explicitFolderChoice.current && !projectRef.current && bootstrap.projects[0]) await loadProject(bootstrap.projects[0]); });
    return () => { disposed = true; };
  }, [act, loadProject]);

  useEffect(() => { setConfigText(selected ? JSON.stringify(selected.config, null, 2) : ''); setConfigError(''); }, [selected]);
  useEffect(() => {
    if (!runId) return;
    let disposed = false, polling = false, last = 0;
    setEvents([]); setReplayIndex(0);
    const poll = async () => {
      if (polling) return; polling = true;
      try {
        const [snapshot, incoming] = await Promise.all([api<Inspection>('inspectRun', { runId }), api<Event[]>('events', { runId, after: last })]);
        if (!disposed) { setConnected(true); setInspection(snapshot); setRuns(items => items.map(run => run.id === runId ? snapshot.run : run)); if (incoming.length) { last = Math.max(...incoming.map(event => event.sequence)); setEvents(items => [...items, ...incoming].slice(-2000)); setReplayIndex(index => index + incoming.length); } }
      } catch (cause) { if (!disposed) { setConnected(false); setError(`Runtime connection interrupted: ${String(cause)}`); } }
      finally { polling = false; }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 850);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [runId]);

  useEffect(() => {
    if (!project) return;
    let disposed = false;
    const timer = window.setInterval(async () => {
      const open = buffersRef.current;
      try {
        const updates = await Promise.all(open.map(async buffer => ({ path: buffer.path, value: await api<{ content: string; hash: string }>('readFile', { projectId: project.id, path: buffer.path }) })));
        if (!disposed) setBuffers(items => items.map(buffer => {
          const next = updates.find(item => item.path === buffer.path)?.value;
          if (!next || next.hash === buffer.hash) return buffer;
          return buffer.content === buffer.savedContent ? { ...buffer, content: next.content, savedContent: next.content, hash: next.hash, external: undefined } : { ...buffer, external: next };
        }));
      } catch { /* File write operations surface errors; a poll may overlap rename/removal. */ }
    }, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [project]);

  const saveBuffer = useCallback(async (buffer: FileBuffer) => {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    const generation = projectGeneration.current, key = `${generation}:${buffer.path}`;
    const pending = fileWrites.current.get(key);
    if (pending) { await pending; return; }
    const task = (async () => {
      const result = await api<{ hash: string }>('writeFile', { projectId: currentProject.id, path: buffer.path, content: buffer.content, expectedHash: buffer.hash });
      if (generation !== projectGeneration.current || projectRef.current?.id !== currentProject.id) return;
      setBuffers(items => items.map(item => item.path === buffer.path ? { ...item, hash: result.hash, savedContent: buffer.content, external: undefined } : item));
      setMessage(`Saved ${buffer.path}`);
    })();
    fileWrites.current.set(key, task);
    try { await task; } finally { fileWrites.current.delete(key); }
  }, []);
  const saveAll = useCallback(async () => {
    if (fileOperationPending) return;
    const generation = projectGeneration.current, projectId = projectRef.current?.id;
    for (const buffer of buffersRef.current.filter(item => item.content !== item.savedContent)) {
      if (generation !== projectGeneration.current || projectId !== projectRef.current?.id) return;
      await saveBuffer(buffer);
    }
  }, [saveBuffer, fileOperationPending]);
  const save = useCallback(async () => {
    if (fileOperationPending) return;
    if (tab === 'code' && !currentBuffer) return;
    if (!project) { setModal('project'); return; }
    if (tab === 'code' && currentBuffer) await saveBuffer(currentBuffer);
    else {
      const generation = projectGeneration.current;
      const saved = await api<Graph>('saveGraph', { projectId: project.id, graph });
      if (generation !== projectGeneration.current) return;
      graphBaseline.current = JSON.stringify(saved); setGraph(saved); setSavedGraph(JSON.stringify(saved)); setGraphs(await api<Graph[]>('listGraphs', { projectId: project.id })); setMessage(`Saved revision ${saved.revision}`);
    }
  }, [project, tab, currentBuffer, graph, saveBuffer, fileOperationPending]);

  const openFolderPath = useCallback(async (path: string) => {
    if (!confirmFolderSwitch()) return;
    const next = await api<Project>('openProject', { path });
    if (!await loadProject(next, true)) return;
    setProjects(items => [...items.filter(item => item.id !== next.id), next]);
    setView('explorer'); setLayout(old => ({ ...old, sidebar: true })); setTab('code'); setModal(null);
  }, [loadProject, confirmFolderSwitch]);
  const openFolder = useCallback(() => {
    explicitFolderChoice.current = true;
    if (!isDesktop()) { setModal('project'); return; }
    if (folderPickerOpen.current) return;
    folderPickerOpen.current = true;
    void act(async () => {
      try { const path = await pickFolder(); if (path) await openFolderPath(path); }
      finally { folderPickerOpen.current = false; }
    });
  }, [act, openFolderPath]);
  const desktopActions = useRef({ openFolder, save: () => void act(save) });
  desktopActions.current = { openFolder, save: () => void act(save) };
  useEffect(() => {
    let disposed = false; let stop: (() => void) | undefined;
    void listenDesktopActions({
      openFolder: () => { if (!disposed) desktopActions.current.openFolder(); },
      save: () => { if (!disposed) desktopActions.current.save(); },
      command: id => { if (!disposed) nativeCommand.current(id); },
      canClose: () => {
        const unsaved = buffersRef.current.some(buffer => buffer.content !== buffer.savedContent) || JSON.stringify(graphRef.current) !== graphBaseline.current;
        if (terminalCount.current) return window.confirm(`${unsaved ? 'Discard unsaved edits and close' : 'Close'} this window and stop its ${terminalCount.current} running terminal${terminalCount.current === 1 ? '' : 's'}?`);
        return !unsaved || window.confirm('Discard unsaved edits and close this window?');
      },
      beforeClose: async () => { await terminalController.current?.closeAll(); },
      onError: cause => { if (!disposed) setError(`Could not close this window: ${String(cause)}`); },
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }).catch(cause => { if (!disposed) setError(`Desktop menu connection failed: ${String(cause)}`); });
    return () => { disposed = true; stop?.(); };
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const element = event.target;
      if (event.ctrlKey && (event.code === 'Backquote' || event.key === '`')) { event.preventDefault(); event.stopPropagation(); setLayout(old => ({ ...old, panel: !(old.panel && dock === 'terminal') })); setDock('terminal'); return; }
      if (element instanceof HTMLElement && element.closest('.xterm')) return;
      const editing = element instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.closest('.monaco-editor'));
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 's') { if (!isDesktop()) { event.preventDefault(); shortcutActions.current.saveAll(); } return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { if (!isDesktop()) { event.preventDefault(); void act(save); } return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o' && !isDesktop()) { event.preventDefault(); openFolder(); return; }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'n' && !isDesktop()) { event.preventDefault(); nativeCommand.current('new-file'); return; }
      if ((event.metaKey || event.ctrlKey) && ['k', 'p'].includes(event.key.toLowerCase())) {
        if (element instanceof HTMLElement && element.closest('.monaco-editor') && event.key.toLowerCase() === 'k') return;
        event.preventDefault(); setPaletteQuery(''); setPaletteMode(event.shiftKey ? 'commands' : event.key.toLowerCase() === 'p' ? 'files' : 'nodes'); setModal('palette'); return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setView('search'); setLayout(old => ({ ...old, sidebar: true })); setSearchFocus(old => old + 1); return; }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); shortcutActions.current.reopen(); return; }
      if (event.altKey && event.key.toLowerCase() === 'z') { event.preventDefault(); setEditorSettings(old => ({ ...old, wordWrap: !old.wordWrap })); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); setLayout(old => ({ ...old, sidebar: !old.sidebar })); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') { event.preventDefault(); setLayout(old => ({ ...old, panel: !old.panel })); return; }
      if (event.key === 'Escape') { setModal(null); setSelectedId(undefined); setSelectedEdge(undefined); }
      if (editing || tab !== 'graph' || element instanceof HTMLElement && element.closest('.explorer-panel')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redoGraph(); else undoGraph(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') clipboard.current = graph.nodes.filter(node => selectedIds.length ? selectedIds.includes(node.id) : node.id === selectedId);
      if ((event.metaKey || event.ctrlKey) && ['v', 'd'].includes(event.key.toLowerCase())) { event.preventDefault(); duplicate(); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelection(); }
    };
    window.addEventListener('keydown', handler, true); return () => window.removeEventListener('keydown', handler, true);
  }, [save, act, tab, graph.nodes, selectedId, selectedIds, duplicate, deleteSelection, undoGraph, redoGraph, openFolder, dock]);

  const openFile = (path: string, line = 1, column = 1) => void act(async () => {
    const scope = projectRef.current, generation = projectGeneration.current;
    if (!scope) return;
    if (!buffersRef.current.some(buffer => buffer.path === path)) {
      const file = await api<{ content: string; hash: string }>('readFile', { projectId: scope.id, path });
      if (projectGeneration.current !== generation || projectRef.current?.id !== scope.id) return;
      setBuffers(items => items.some(item => item.path === path) ? items : [...items, { path, ...file, savedContent: file.content }]);
    }
    if (projectGeneration.current !== generation || projectRef.current?.id !== scope.id) return;
    setActiveFile(path); setTab('code'); setModal(null); setLocation(old => ({ path, line, column, version: (old?.version ?? 0) + 1 }));
  });
  const closeEditors = (paths: string[]) => {
    const closing = buffersRef.current.filter(buffer => paths.includes(buffer.path));
    if (closing.some(buffer => buffer.content !== buffer.savedContent) && !window.confirm(`Discard unsaved edits in ${closing.length === 1 ? closing[0].path : `${closing.length} files`}?`)) return;
    closedFiles.current.push(...closing.map(buffer => buffer.path)); closedFiles.current = closedFiles.current.slice(-20);
    const remaining = buffersRef.current.filter(buffer => !paths.includes(buffer.path)); setBuffers(remaining);
    if (activeFile && paths.includes(activeFile)) { setActiveFile(remaining.at(-1)?.path); setCursor({ line: 1, column: 1 }); }
  };
  const closeFile = (buffer: FileBuffer) => closeEditors([buffer.path]);
  shortcutActions.current = { saveAll: () => void act(saveAll), closeActive: () => { if (currentBuffer) closeFile(currentBuffer); }, reopen: () => { const path = closedFiles.current.pop(); if (path) openFile(path); } };
  const explorerAction = (action: 'newFile' | 'newFolder' | 'refresh' | 'collapse' | 'reveal') => {
    if (!project) { openFolder(); return; }
    setView('explorer'); setLayout(old => ({ ...old, sidebar: true }));
    setExplorerRequest(old => ({ action, path: activeFile, version: (old?.version ?? 0) + 1 }));
  };
  const createdFile = (file: { path: string; content: string; hash: string }) => {
    setBuffers(items => items.some(item => item.path === file.path) ? items : [...items, { ...file, savedContent: file.content }]);
    setActiveFile(file.path); setTab('code'); setLocation(undefined); setMessage(`Opened ${file.path}`);
  };
  const selectRun = (run: Run) => { setRunId(run.id); setInspection(undefined); setTab('replay'); setMessage(`Recorded run · ${run.id.slice(0, 8)}`); };
  const validation = useMemo(() => validateGraph(graph), [graph]);
  const ownershipCoverage = useMemo(() => {
    const roles = graph.nodes.flatMap(node => node.kind === 'agent' && !node.disabled && node.config.permission === 'scoped-edit' && node.config.role ? [{ nodeId: node.id, role: node.config.role }] : []);
    return files.map(path => ({ path, owners: roles.filter(item => roleOwnsPath(item.role.owns, path)) }));
  }, [graph, files]);
  const startRun = () => void act(async () => {
    if (!project) { setModal('project'); return; }
    if (project.isGitRepository === false) throw new Error('Workflows require a Git repository with an initial commit. You can still browse and edit this folder.');
    if (!validation.valid) throw new Error(validation.errors.map(issue => issue.message).join(' · '));
    const run = await api<Run>('run', { projectId: project.id, graph }); setRunId(run.id); setInspection(undefined); setRuns(items => [run, ...items]); setDock('events'); setLayout(old => ({ ...old, panel: true })); setMessage('Run started. Workflow snapshot is pinned; edits create a draft.');
  });
  const nodeStatus = (nodeId: string) => inspection?.attempts.filter(attempt => attempt.nodeId === nodeId).at(-1)?.state ?? 'pending';
  // Steps inside a role run under IDs like "role/step"; their latest states give the role's live progress.
  const innerStates = (roleId: string) => Object.fromEntries((inspection?.attempts ?? []).filter(attempt => attempt.nodeId.startsWith(`${roleId}/`)).map(attempt => [attempt.nodeId.slice(roleId.length + 1), attempt.state]));
  const roleProgress = (node: GraphNode) => {
    if (node.kind !== 'role' || !inspection) return undefined;
    const states = innerStates(node.id); const steps = node.config.playbook.nodes.filter(step => step.kind !== 'start' && step.kind !== 'end');
    const done = steps.filter(step => states[step.id] === 'succeeded').length; const active = steps.find(step => states[step.id] === 'running' || states[step.id] === 'waiting_approval');
    return Object.keys(states).length ? `${done}/${steps.length} steps${active ? ` · ${active.label}` : ''}` : undefined;
  };
  const playbookNode = graph.nodes.find(node => node.id === playbookNodeId && node.kind === 'role') as Extract<GraphNode, { kind: 'role' }> | undefined;
  const openPlaybook = (nodeId: string) => { setPlaybookNodeId(nodeId); setTab('playbook'); };
  const flowNodes: FlowNode[] = graph.nodes.map(node => ({ id: node.id, type: 'workflow', position: node.position, measured: nodeDimensions[node.id], selected: selectedIds.includes(node.id), data: { node, status: nodeStatus(node.id), progress: roleProgress(node) } }));
  const flowEdges: FlowEdge[] = graph.edges.map(item => ({ ...item, sourceHandle: item.sourcePort ?? (graph.nodes.find(node => node.id === item.source)?.kind === 'quality_gate' ? 'pass' : graph.nodes.find(node => node.id === item.source)?.kind === 'condition' ? 'true' : 'out'), targetHandle: 'in', selected: item.id === selectedEdge, type: 'smoothstep', animated: nodeStatus(item.target) === 'running', className: nodeStatus(item.target) === 'running' ? 'live' : undefined, label: item.kind === 'loop' ? 'loop' : item.sourcePort && !['out', 'in'].includes(item.sourcePort) ? item.sourcePort : item.kind === 'artifact' ? 'artifact' : undefined, style: { stroke: item.id === selectedEdge ? 'var(--accent)' : item.kind === 'loop' ? 'var(--loop)' : item.kind === 'artifact' ? 'var(--artifact)' : 'var(--edge)', strokeWidth: 1.25, strokeDasharray: item.kind === 'artifact' ? '5 4' : undefined } }));
  const connectNodes = (connection: Connection) => { if (!connection.source || !connection.target) return; edit(old => ({ ...old, edges: [...old.edges, { id: crypto.randomUUID(), source: connection.source!, target: connection.target!, sourcePort: connection.sourceHandle ?? undefined, kind: 'control' }] })); };
  const refreshDiff = () => void act(async () => { if (project) { setDiff(await api<Diff>('diff', { projectId: project.id, runId })); setTab('diff'); } });
  const applyTemplate = (template: Graph) => { if (dirty && savedGraph && !window.confirm('Replace the current draft with this template?')) return; edit({ ...structuredClone(template), id: crypto.randomUUID(), revision: 1 }); setSelectedId(undefined); setTab('graph'); };
  const exportGraph = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `${graph.name.replace(/[^a-z0-9]/gi, '-')}.json`; link.click(); URL.revokeObjectURL(url); };
  const openProjectPath = () => { explicitFolderChoice.current = true; void act(() => openFolderPath(projectPath)); };
  const showView = (next: View) => setLayout(old => { const toggle = old.sidebar && view === next; setView(next); return { ...old, sidebar: !toggle }; });
  const displayedEvents = tab === 'replay' ? events.slice(0, replayIndex) : events;
  const editorCommands = [
    { id: 'open', label: 'File: Open Folder', run: openFolder },
    { id: 'new-file', label: 'File: New File', run: () => explorerAction('newFile') },
    { id: 'new-folder', label: 'File: New Folder', run: () => explorerAction('newFolder') },
    { id: 'save-all', label: 'File: Save All', shortcut: 'Cmd/Ctrl+Shift+S', run: () => void act(saveAll) },
    { id: 'close-others', label: 'File: Close Other Editors', run: () => closeEditors(buffers.filter(buffer => buffer.path !== activeFile).map(buffer => buffer.path)) },
    { id: 'close-all', label: 'File: Close All Editors', run: () => closeEditors(buffers.map(buffer => buffer.path)) },
    { id: 'reopen', label: 'File: Reopen Closed Editor', shortcut: 'Cmd/Ctrl+Shift+T', run: shortcutActions.current.reopen },
    { id: 'search', label: 'Search: Find in Files', shortcut: 'Cmd/Ctrl+Shift+F', run: () => { setView('search'); setLayout(old => ({ ...old, sidebar: true })); setSearchFocus(old => old + 1); } },
    { id: 'refresh', label: 'Explorer: Refresh', run: () => explorerAction('refresh') },
    { id: 'collapse', label: 'Explorer: Collapse All', run: () => explorerAction('collapse') },
    { id: 'reveal', label: 'Explorer: Reveal Active File', run: () => explorerAction('reveal') },
    { id: 'wrap', label: 'Editor: Toggle Word Wrap', shortcut: 'Alt+Z', run: () => setEditorSettings(old => ({ ...old, wordWrap: !old.wordWrap })) },
    { id: 'format', label: 'Editor: Format Document', run: () => editorController.current?.run('editor.action.formatDocument') },
    { id: 'find', label: 'Editor: Find', run: () => editorController.current?.run('actions.find') },
    { id: 'replace', label: 'Editor: Replace', run: () => editorController.current?.run('editor.action.startFindReplaceAction') },
    { id: 'goto', label: 'Editor: Go to Line', run: () => editorController.current?.run('editor.action.gotoLine') },
    { id: 'comment', label: 'Editor: Toggle Line Comment', run: () => editorController.current?.run('editor.action.commentLine') },
    { id: 'fold', label: 'Editor: Fold All', run: () => editorController.current?.run('editor.foldAll') },
    { id: 'unfold', label: 'Editor: Unfold All', run: () => editorController.current?.run('editor.unfoldAll') },
    { id: 'terminal', label: 'View: Toggle Terminal', shortcut: 'Ctrl+`', run: () => { setDock('terminal'); setLayout(old => ({ ...old, panel: !(old.panel && dock === 'terminal') })); } },
    { id: 'problems', label: 'View: Problems', run: () => { setDock('problems'); setLayout(old => ({ ...old, panel: true })); } },
  ].filter(command => !['format', 'find', 'replace', 'goto', 'comment', 'fold', 'unfold'].includes(command.id) || tab === 'code' && !!currentBuffer);
  const paletteItems = paletteMode === 'commands' ? editorCommands.filter(command => command.label.toLowerCase().includes(paletteQuery.toLowerCase())) : paletteMode === 'files' ? files.filter(path => path.toLowerCase().includes(paletteQuery.toLowerCase())).slice(0, 100).map(path => ({ id: path, label: path.split('/').at(-1)!, detail: path })) : kinds.filter(kind => NODE_LABELS[kind].toLowerCase().includes(paletteQuery.toLowerCase())).map(kind => ({ id: kind, label: NODE_LABELS[kind] }));
  nativeCommand.current = id => {
    if (id === 'quick-open' || id === 'commands') { setPaletteQuery(''); setPaletteMode(id === 'quick-open' ? 'files' : 'commands'); setModal('palette'); }
    else editorCommands.find(command => command.id === id)?.run();
  };
  const problemItems = buffers.flatMap(buffer => (problems[buffer.path] ?? []).map(problem => ({ ...problem, path: buffer.path })));

  return <div className="app-shell">
    <header className="title-bar">
      <div className="title-left"><span className="brand-mark" aria-hidden="true"><img src="/nodal.svg" alt="" width="20" height="20"/></span><span className="brand-name">Nodal</span></div>
      <button className="command-center" onClick={() => { setPaletteQuery(''); setPaletteMode('commands'); setModal('palette'); }}><Search size={13}/><span>{project?.name ?? 'Nodal'}</span><kbd>⌘⇧P</kbd></button>
      <div className="command-actions">
        <IconButton title="Validate" onClick={() => { setMessage(validation.valid ? 'Graph is valid. All paths and execution bounds checked.' : ''); setError(validation.valid ? '' : validation.errors.map(issue => issue.message).join(' · ')); }}><ShieldCheck size={15}/></IconButton>
        <IconButton title="Save" disabled={busy || fileOperationPending} onClick={() => void act(save)}><Save size={15}/></IconButton>
        <IconButton title="Generate" onClick={() => { setError(''); setModal('generate'); }}><Sparkles size={15}/></IconButton>
        <span className="divider"/>
        <IconButton title={inspection?.run.status === 'paused' ? 'Resume run' : 'Pause run'} disabled={!running || busy} onClick={() => void act(async () => { await api(inspection?.run.status === 'paused' ? 'resume' : 'pause', { runId }); })}><Pause size={15}/></IconButton>
        <IconButton title="Stop run" disabled={!running || busy} onClick={() => void act(async () => { await api('cancel', { runId }); })}><Square size={13}/></IconButton>
        <button className="run-button" aria-label="Run workflow" title="Run workflow" disabled={busy || running} onClick={startRun}><Play size={12} fill="currentColor"/>Run</button>
        <span className="divider"/>
        <IconButton title="Toggle sidebar" active={layout.sidebar} onClick={() => setLayout(old => ({ ...old, sidebar: !old.sidebar }))}><PanelLeft size={15}/></IconButton>
        <IconButton title="Toggle panel" active={layout.panel} onClick={() => setLayout(old => ({ ...old, panel: !old.panel }))}><PanelBottom size={15}/></IconButton>
        <IconButton title="Toggle inspector" active={layout.inspector && !chatOpen} onClick={() => { setChatOpen(false); setLayout(old => ({ ...old, inspector: !old.inspector || chatOpen })); }}><PanelRight size={15}/></IconButton>
        <IconButton title="Toggle agent chat" active={chatOpen} onClick={() => setChatOpen(old => !old)}><MessageSquare size={15}/></IconButton>
      </div>
    </header>

    <div className="workbench">
      <nav className="activity-bar" aria-label="Views">
        {([{ id: 'explorer', label: 'Explorer', icon: Files }, { id: 'workflows', label: 'Workflows', icon: Workflow }, { id: 'team', label: 'Team', icon: Bot }, { id: 'runs', label: 'Runs', icon: History }, { id: 'orchestrator', label: 'Workflow orchestrator', icon: Gauge }, { id: 'library', label: 'Library', icon: Library }, { id: 'providers', label: 'Providers', icon: Plug }] as const).map(item => <button key={item.id} className={layout.sidebar && view === item.id ? 'active' : ''} title={item.label} aria-label={item.label} onClick={() => showView(item.id)}><item.icon size={22} strokeWidth={1.5}/></button>)}
        <button className={tab === 'diff' ? 'active' : ''} title="Source control" aria-label="Source control" onClick={refreshDiff}><GitCompare size={22} strokeWidth={1.5}/></button>
        <button className={chatOpen ? 'active' : ''} title="Agent chat" aria-label="Agent chat" onClick={() => setChatOpen(old => !old)}><MessageSquare size={22} strokeWidth={1.5}/></button>
      </nav>

      {<>
        <aside className="sidebar" style={{ width: sizes.sidebar, display: layout.sidebar ? 'flex' : 'none' }}>
          <div style={{ display: view === 'explorer' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
            <ExplorerPanel key={`${project?.id}:${terminalGeneration}`} project={project} files={files} buffers={buffers} activeFile={activeFile} busy={busy} actionRequest={explorerRequest} onPendingChange={setFileOperationPending} onOpenFolder={openFolder} onOpenFile={openFile} onFilesChange={setFiles} onCreated={createdFile}
              onRenamed={(oldPath, file) => {
                setBuffers(items => items.map(buffer => buffer.path === oldPath ? { ...buffer, path: file.path } : buffer));
                setActiveFile(old => old === oldPath ? file.path : old); setProblems(old => { const next = { ...old }; delete next[oldPath]; return next; });
                setMessage(`Renamed ${oldPath} to ${file.path}`);
              }} onDeleted={path => {
                setBuffers(items => items.filter(buffer => buffer.path !== path));
                setActiveFile(old => old === path ? buffersRef.current.filter(buffer => buffer.path !== path).at(-1)?.path : old); setProblems(old => { const next = { ...old }; delete next[path]; return next; }); setMessage(`Moved ${path} to Nodal Trash`);
              }}/>
          </div>
          <div style={{ display: view === 'search' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}><SearchPanel project={project} onOpen={openFile} focusVersion={searchFocus}/></div>
          {view === 'workflows' && <>
            <div className="view-title"><span>Workflows</span><IconButton title="New workflow" onClick={() => { edit(emptyGraph()); setSelectedId(undefined); setTab('graph'); }}><Plus size={15}/></IconButton></div>
            <div className="sidebar-scroll">
              <div className="section-header"><ChevronDown size={14}/><span>Saved</span></div>
              {graphs.map(item => <button key={item.id} className={`sidebar-item ${item.id === graph.id ? 'active' : ''}`} onClick={() => { if (dirty && !window.confirm('Discard unsaved graph changes?')) return; graphRef.current = item; graphBaseline.current = JSON.stringify(item); setGraph(item); setSavedGraph(JSON.stringify(item)); setUndo([]); setRedo([]); setSelectedId(undefined); setTab('graph'); }}><Workflow size={14}/><span>{item.name}</span><small>r{item.revision}</small></button>)}
              {!graphs.length && <p className="sidebar-hint">Saved workflows appear here.</p>}
              <div className="section-header"><ChevronDown size={14}/><span>Templates</span></div>
              {templates.map(template => <button key={template.id} className="sidebar-item" title="Open as a new draft" onClick={() => applyTemplate(template)}><Workflow size={14}/><span>{template.name}</span></button>)}
            </div>
          </>}
          {view === 'team' && <>
            <div className="view-title"><span>Team ownership</span></div>
            <div className="sidebar-scroll team-overview">
              <p className="field-help">Roles and ownership in the current workflow draft. Select a step to edit its role.</p>
              {graph.nodes.filter(node => node.kind === 'agent' && !node.disabled).map(node => node.kind === 'agent' && <button key={node.id} className="team-role" aria-label={`Edit role for ${node.label}`} onClick={() => { setSelectedId(node.id); setSelectedEdge(undefined); setChatOpen(false); setLayout(old => ({ ...old, inspector: true })); setTab('graph'); }}><strong>{node.config.role?.title ?? 'Role missing'}</strong><span>{node.label}</span><code>{node.config.role?.owns.join('\n') || (node.config.permission === 'scoped-edit' ? 'Coverage gap: no owned paths' : 'Read only')}</code></button>)}
              {!graph.nodes.some(node => node.kind === 'agent' && !node.disabled) && <p className="field-help">Add an agent step to assign a role.</p>}
              <div className="inspector-group">Repository coverage</div>
              <p className="field-help">{ownershipCoverage.filter(item => !item.owners.length).length} listed files without an editing owner · {ownershipCoverage.filter(item => item.owners.length > 1).length} with multiple editing steps. Sequential steps may share ownership.</p>
              <details><summary>Unassigned files</summary>{ownershipCoverage.filter(item => !item.owners.length).slice(0, 30).map(item => <code className="ownership-file" key={item.path}>{item.path}</code>)}{ownershipCoverage.filter(item => !item.owners.length).length > 30 && <p className="field-help">Showing the first 30 files.</p>}</details>
              <p className="field-help">Coverage uses the current file listing, not planned files.</p>
              {project && <RoleLibrary key={project.id} projectId={project.id}/>}
            </div>
          </>}
          {view === 'orchestrator' && (project ? <OrchestratorPanel key={`${project.id}:${graph.id}`} projectId={project.id} graph={graph} saved={graphs.some(item => item.id === graph.id)} onGraphSaved={saved => { graphBaseline.current = JSON.stringify(saved); setGraph(saved); setSavedGraph(JSON.stringify(saved)); setUndo([]); setRedo([]); void api<Graph[]>('listGraphs', { projectId: project.id }).then(setGraphs); setMessage(`Saved revision ${saved.revision} from the orchestrator`); }}/> : <p className="sidebar-hint">Open a folder to use the orchestrator.</p>)}
          {view === 'library' && (project ? <LibraryPanel key={project.id} projectId={project.id} graph={graph} onApplyWorkflow={next => { edit(next); setSelectedId(undefined); setTab('graph'); setMessage('Applied a library workflow as a draft. Review commands and permissions before running.'); }}/> : <p className="sidebar-hint">Open a folder to use the library.</p>)}
          {view === 'runs' && <>
            <div className="view-title"><span>Runs</span><small>{runs.length}</small></div>
            <div className="sidebar-scroll">
              {runs.map(run => <button key={run.id} className={`sidebar-item ${runId === run.id ? 'active' : ''}`} title={run.status.replaceAll('_', ' ')} onClick={() => selectRun(run)}><span className={`state-dot ${run.status}`}/><span>{run.graph?.name ?? run.id.slice(0, 8)}</span><small>{new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></button>)}
              {!runs.length && <p className="sidebar-hint">Executed workflows appear here.</p>}
            </div>
          </>}
          {view === 'providers' && <>
            <div className="view-title"><span>Providers</span><IconButton title="Refresh provider status" onClick={() => void act(async () => setProviders(await api<Provider[]>('providerStatus')))}><RefreshCw size={14}/></IconButton></div>
            <div className="sidebar-scroll">
              {providers.map(provider => <div className="provider-row" key={provider.id}><span className={`state-dot ${provider.available && provider.authenticated ? 'succeeded' : 'pending'}`}/><div><strong>{provider.id}</strong><small>{provider.authenticated ? 'Ready' : provider.available ? 'Authentication required' : 'Not configured'}</small>{provider.message && <p>{provider.message}</p>}</div></div>)}
              <p className="sidebar-hint">Provider requests run from the local runtime. Permissions are enforced per run.</p>
            </div>
          </>}
        </aside>
        <div className="sash vertical" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" style={{ display: layout.sidebar ? undefined : 'none' }} onPointerDown={resize('sidebar', 'x', 1)}/>
      </>}

      <main className="main-column">
        <div className="editor-group">
          <div className="tab-bar">
            <div className="tabs" role="tablist" aria-label="Open editors">
              <div className={`editor-tab ${tab === 'graph' ? 'active' : ''}`} data-tab="graph"><button role="tab" aria-selected={tab === 'graph'} onClick={() => setTab('graph')}><Workflow size={14}/>{graph.name}{dirty && savedGraph && <span className="dirty-dot"/>}</button></div>
              {buffers.map(buffer => <div key={buffer.path} className={`editor-tab ${tab === 'code' && activeFile === buffer.path ? 'active' : ''}`} data-tab="file"><button role="tab" aria-selected={tab === 'code' && activeFile === buffer.path} title={buffer.path} onClick={() => { setActiveFile(buffer.path); setTab('code'); }}><FileCode2 size={14}/>{buffer.path.split('/').at(-1)}</button><button className={`tab-close ${buffer.content !== buffer.savedContent ? 'dirty' : ''}`} aria-label={`Close ${buffer.path}`} onClick={() => closeFile(buffer)}><X size={13}/></button></div>)}
              {(diff || tab === 'diff') && <div className={`editor-tab ${tab === 'diff' ? 'active' : ''}`} data-tab="diff"><button role="tab" aria-selected={tab === 'diff'} onClick={() => setTab('diff')}><GitCompare size={14}/>Changes</button><button className="tab-close" aria-label="Close changes" onClick={() => { setDiff(undefined); if (tab === 'diff') setTab('graph'); }}><X size={13}/></button></div>}
              {runId && <div className={`editor-tab ${tab === 'replay' ? 'active' : ''}`} data-tab="replay"><button role="tab" aria-selected={tab === 'replay'} onClick={() => setTab('replay')}><History size={14}/>Run {runId.slice(0, 8)}</button></div>}
              {playbookNode && <div className={`editor-tab ${tab === 'playbook' ? 'active' : ''}`} data-tab="playbook"><button role="tab" aria-selected={tab === 'playbook'} onClick={() => setTab('playbook')}><Users size={14}/>{playbookNode.label} playbook</button><button className="tab-close" aria-label="Close playbook" onClick={() => { setPlaybookNodeId(undefined); if (tab === 'playbook') setTab('graph'); }}><X size={13}/></button></div>}
            </div>
            <div className="editor-actions">
              {tab === 'graph' && <>
                <IconButton title="Undo" disabled={!undo.length} onClick={undoGraph}><Undo2 size={15}/></IconButton>
                <IconButton title="Redo" disabled={!redo.length} onClick={redoGraph}><Redo2 size={15}/></IconButton>
                <IconButton title="Import graph JSON" onClick={() => importInput.current?.click()}><Upload size={15}/></IconButton>
                <IconButton title="Export graph JSON" onClick={exportGraph}><Download size={15}/></IconButton>
                <IconButton title="Add node" onClick={() => { setPaletteQuery(''); setPaletteMode('nodes'); setModal('palette'); }}><Plus size={16}/></IconButton>
              </>}
              {tab === 'code' && currentBuffer && <><IconButton title="Save All" disabled={busy || fileOperationPending} onClick={() => void act(saveAll)}><Save size={14}/></IconButton><IconButton title="Close other editors" onClick={() => closeEditors(buffers.filter(buffer => buffer.path !== activeFile).map(buffer => buffer.path))}><Files size={14}/></IconButton><IconButton title="Close all editors" onClick={() => closeEditors(buffers.map(buffer => buffer.path))}><X size={14}/></IconButton></>}
              {tab === 'diff' && <IconButton title="Refresh changes" onClick={refreshDiff}><RefreshCw size={14}/></IconButton>}
              {tab === 'replay' && runId && <button className="text-action" disabled={busy || running} onClick={() => void act(async () => { const next = await api<Run>('rerun', { runId, confirmed: true }); setRuns(items => [next, ...items]); setRunId(next.id); setMessage('Created a new run from the recorded workflow.'); })}><Play size={12}/>Re-run as new run</button>}
            </div>
          </div>

          <div className="breadcrumbs">
            {tab === 'graph' && <><span>{project?.name ?? 'workspace'}</span><ChevronRight size={12}/><span className="crumb-current">{graph.name}</span><span className="crumb-meta">r{graph.revision}{dirty ? ' · draft' : ''} · {graph.nodes.length} nodes · {graph.edges.length} connections</span>{running && <span className="crumb-live">Run pinned to r{inspection?.run.graph?.revision ?? graph.revision}</span>}</>}
            {tab === 'code' && currentBuffer && <>{currentBuffer.path.split('/').map((part, index, parts) => <span key={index} className={index === parts.length - 1 ? 'crumb-current' : undefined}>{part}{index < parts.length - 1 && <ChevronRight size={12}/>}</span>)}<span className="crumb-meta"><GitBranch size={11}/>{project?.branch ?? (project ? 'Folder' : 'working tree')}</span></>}
            {tab === 'playbook' && playbookNode && <><button className="crumb-link" onClick={() => setTab('graph')}>{graph.name}</button><ChevronRight size={12}/><span className="crumb-current">{playbookNode.label}</span><span className="crumb-meta">{playbookNode.config.role.title} · owns {playbookNode.config.role.owns.join(', ') || 'nothing yet'}</span></>}
            {tab === 'diff' && <><span>Changes</span><span className="crumb-meta"><GitBranch size={11}/>{diff?.branch ?? project?.branch ?? (project ? 'Folder' : 'working tree')}</span></>}
            {tab === 'replay' && <><span>Run</span><ChevronRight size={12}/><span className="crumb-current">{runId?.slice(0, 8) ?? '—'}</span><span className="crumb-meta"><span className={`state-dot ${inspection?.run.status ?? 'pending'}`}/>{inspection?.run.status.replaceAll('_', ' ') ?? 'loading'} · r{inspection?.run.graph?.revision ?? '—'} · {inspection?.checkpoints.length ?? 0} checkpoints · spending unavailable</span></>}
          </div>

          <div className="editor-body">
            {tab === 'graph' && <div className="canvas" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const kind = event.dataTransfer.getData('application/nodal-node') as NodeKind; if (kinds.includes(kind)) addNode(kind, flowInstance.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}>
              <ReactFlow onInit={instance => { flowInstance.current = instance; }} nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} onNodeDoubleClick={(_event, node) => { if (graph.nodes.find(item => item.id === node.id)?.kind === 'role') openPlaybook(node.id); }} onNodeClick={(_event, node) => { setSelectedId(node.id); setSelectedEdge(undefined); }} onEdgeClick={(_event, item) => { setSelectedEdge(item.id); setSelectedId(undefined); }} onPaneClick={() => { setSelectedId(undefined); setSelectedIds([]); setSelectedEdge(undefined); }} onNodeDragStart={() => { dragSnapshot.current = structuredClone(graphRef.current); }} onNodeDragStop={() => { if (dragSnapshot.current) { const before = dragSnapshot.current; if (JSON.stringify(before.nodes.map(node => node.position)) !== JSON.stringify(graphRef.current.nodes.map(node => node.position))) { setUndo(items => [...items.slice(-49), before]); setRedo([]); } dragSnapshot.current = null; } }} onNodesChange={changes => { const changed = applyNodeChanges(changes, flowNodes); const dimensions = changes.filter(change => change.type === 'dimensions' && change.dimensions); if (dimensions.length) setNodeDimensions(old => ({ ...old, ...Object.fromEntries(dimensions.flatMap(change => change.type === 'dimensions' && change.dimensions ? [[change.id, change.dimensions]] : [])) })); if (changes.some(change => change.type === 'select')) setSelectedIds(changed.filter(node => node.selected).map(node => node.id)); if (changes.some(change => change.type === 'position')) setGraph(old => ({ ...old, nodes: old.nodes.map(node => ({ ...node, position: changed.find(item => item.id === node.id)?.position ?? node.position })) })); }} onEdgesChange={changes => { if (changes.some(change => change.type === 'remove')) { const remaining = applyEdgeChanges(changes, flowEdges); edit(old => ({ ...old, edges: old.edges.filter(item => remaining.some(next => next.id === item.id)) })); } }} onConnect={connectNodes} isValidConnection={connection => connection.source !== connection.target && graph.nodes.find(node => node.id === connection.source)?.kind !== 'end' && graph.nodes.find(node => node.id === connection.target)?.kind !== 'start'} deleteKeyCode={null} fitView fitViewOptions={{ padding: .25 }} minZoom={.25} maxZoom={1.6} colorMode="dark">
                <Background variant={BackgroundVariant.Cross} color="#1f1f25" gap={28} size={6}/>
                <Controls showInteractive={false}/>
                <MiniMap nodeColor="#1f1f24" nodeStrokeColor="#3a3a41" nodeBorderRadius={6} maskColor="#101012cc" pannable zoomable/>
              </ReactFlow>
            </div>}
            {tab === 'code' && !currentBuffer && <div className="folder-welcome"><FolderOpen size={32}/><h2>{project?.name ?? 'Open a folder'}</h2><p>{project ? 'Select a file in Explorer to start editing.' : 'Open a folder to browse and edit its files.'}</p>{!project && <button className="primary" onClick={openFolder}>Open Folder</button>}</div>}
            {currentBuffer && <div className="code-pane" style={{ display: tab === 'code' ? 'flex' : 'none' }}>
              {currentBuffer.external && <div className="info-bar">File changed on disk. Your edits are preserved.<button onClick={() => setTab('diff')}>Compare</button><button onClick={() => setBuffers(items => items.map(buffer => buffer.path === currentBuffer.path && buffer.external ? { ...buffer, content: buffer.external.content, savedContent: buffer.external.content, hash: buffer.external.hash, external: undefined } : buffer))}>Reload from disk</button></div>}
              <CodeEditor key={project?.id} ref={editorController} projectId={project?.id ?? ''} buffer={currentBuffer} openPaths={buffers.map(buffer => buffer.path)} location={location} settings={editorSettings} readOnly={fileOperationPending} visible={tab === 'code'} onSettings={setEditorSettings}
                onChange={content => setBuffers(items => items.map(buffer => buffer.path === currentBuffer.path ? { ...buffer, content } : buffer))}
                onCursor={(line, column) => setCursor({ line, column })} onProblems={reportProblems} onError={setError}/>

            </div>}
            {tab === 'diff' && <div className="scroll-pane">
              {currentBuffer?.external ? <><div className="info-bar">Disk version → your unsaved buffer. Reload from the editor to discard your edits.</div><DiffEditor original={currentBuffer.external.content} modified={currentBuffer.content} language={language(currentBuffer.path)} theme="nodal" options={{ readOnly: true, minimap: { enabled: false }, automaticLayout: true }}/></> : <>
                <section className="diff-section"><h3>Working tree</h3>{diff?.diff ? <DiffText text={diff.diff}/> : <p className="muted-line">{project?.isGitRepository === false ? 'Git diffs require a Git repository. File editing is available in Explorer.' : 'No changes in the main working tree.'}</p>}</section>
                {diff?.worktrees?.map(tree => <section className="diff-section" key={tree.path}>
                  <h3><GitBranch size={13}/>{tree.branch}<span>{tree.path}</span><button className="primary" disabled={busy || running || !tree.diff} onClick={() => void act(async () => { if (!window.confirm(`Apply the reviewed changes from ${tree.branch} to your repository? Your working tree must be clean. This creates a local integration commit.`)) return; await api('applyChanges', { runId, nodeId: tree.nodeId, expectedHead: tree.head, expectedSourceHead: tree.sourceHead, approved: true }); setDiff(await api<Diff>('diff', { projectId: project?.id, runId })); setMessage('Integrated approved changes into the repository.'); })}><Check size={13}/>Apply reviewed changes</button></h3>
                  {tree.diff ? <DiffText text={tree.diff}/> : <p className="muted-line">No changes in this worktree.</p>}
                </section>)}
              </>}
            </div>}
            {tab === 'playbook' && playbookNode && <PlaybookEditor key={playbookNode.id} title={playbookNode.label} playbook={playbookNode.config.playbook} states={innerStates(playbookNode.id)}
              problems={validation.errors.filter(issue => issue.nodeId === playbookNode.id && issue.message.startsWith(`${playbookNode.label} playbook:`)).map(issue => issue.message.slice(playbookNode.label.length + 11))}
              onChange={playbook => edit(old => ({ ...old, nodes: old.nodes.map(node => node.id === playbookNode.id && node.kind === 'role' ? { ...node, config: { ...node.config, playbook } } : node) }))}/>}
            {tab === 'replay' && <div className="replay-pane">
              <label className="replay-scrubber"><span>Recorded events</span><input type="range" min="0" max={events.length} value={Math.min(replayIndex, events.length)} onChange={event => setReplayIndex(Number(event.target.value))}/><span>{Math.min(replayIndex, events.length)} / {events.length}</span></label>
              <div className="replay-events">{displayedEvents.map(event => <div className="replay-event" key={event.eventId}><time>{time(event.timestamp)}</time><span className={`state-dot ${event.kind.includes('failed') ? 'failed' : 'succeeded'}`}/><div><strong>{event.kind.replaceAll('_', ' ').replaceAll('.', ' › ')}</strong><small>{event.nodeId && inspection?.run.graph?.nodes.find(node => node.id === event.nodeId)?.label}</small><pre>{stringify(event.payload)}</pre></div></div>)}{!displayedEvents.length && <p className="muted-line">No events recorded yet.</p>}</div>
            </div>}
          </div>
        </div>

        <>
          <div className="sash horizontal" role="separator" aria-orientation="horizontal" aria-label="Resize panel" style={{ display: layout.panel ? undefined : 'none' }} onPointerDown={resize('panel', 'y', -1)}/>
          <section className="panel" style={{ height: sizes.panel, display: layout.panel ? 'flex' : 'none' }}>
            <nav className="panel-tabs">
              <button className={dock === 'events' ? 'selected' : ''} onClick={() => setDock('events')}>Timeline{events.length > 0 && <span className="badge">{events.length}</span>}</button>
              <button className={dock === 'console' ? 'selected' : ''} onClick={() => setDock('console')}>Console</button>
              <button className={dock === 'problems' ? 'selected' : ''} onClick={() => setDock('problems')}>Problems{problemItems.length > 0 && <span className="badge">{problemItems.length}</span>}</button>
              <button className={dock === 'terminal' ? 'selected' : ''} title="Terminal (Ctrl+`)" onClick={() => setDock('terminal')}>Terminal</button>
              <button className={dock === 'approvals' ? 'selected' : ''} onClick={() => setDock('approvals')}>Approvals{approvals.length > 0 && <span className="badge attention">{approvals.length}</span>}</button>
              <span className="panel-status"><span className={`state-dot ${inspection?.run.status ?? 'pending'}`}/>{inspection?.run.status.replaceAll('_', ' ') ?? 'No active run'}</span>
              <IconButton title="Close panel" onClick={() => setLayout(old => ({ ...old, panel: false }))}><X size={14}/></IconButton>
            </nav>
            <div className="panel-content" hidden={dock === 'terminal'}>
              {dock === 'problems' ? problemItems.length ? problemItems.map((problem, index) => <button key={`${problem.path}:${index}`} className="problem-row" onClick={() => openFile(problem.path, problem.startLineNumber, problem.startColumn)}><CircleX size={13}/><span>{problem.message}</span><small>{problem.path}:{problem.startLineNumber}:{problem.startColumn}</small></button>) : <p className="panel-empty">No diagnostics reported for open editors. Language checks depend on Monaco support; external language servers are not connected.</p>
                : dock === 'approvals' ? approvals.length ? approvals.map(approval => <div key={approval.id} className="approval-item"><ShieldCheck size={16}/><div><strong>{graph.nodes.find(node => node.id === approval.nodeId)?.label ?? approval.nodeId}</strong><p>{approval.message ?? 'Review this node before continuing.'}</p><code>{stringify(approval.scope ?? {})}</code></div><button className="secondary" disabled={busy} onClick={() => void act(async () => { await api('approve', { runId, nodeId: approval.nodeId, approved: false }); })}>Reject</button><button className="primary" disabled={busy} onClick={() => void act(async () => { await api('approve', { runId, nodeId: approval.nodeId, approved: true }); })}>Approve</button></div>) : <p className="panel-empty">No pending approvals. Requests appear here when a run needs your decision.</p>
                : dock === 'console' ? <pre className="console-output">{events.filter(event => (!selectedId || event.nodeId === selectedId) && /output|stream|log|tool|error|failed/.test(event.kind)).map(event => `${time(event.timestamp)}  ${event.kind}\n${stringify(event.payload)}`).join('\n\n') || (selectedId ? 'No output recorded for the selected node.' : 'Command output and provider events appear here. Select a node to filter.')}</pre>
                : events.length ? [...events].reverse().slice(0, 150).map(event => <div className="timeline-row" key={event.eventId}><time>{time(event.timestamp)}</time><span className={`state-dot ${event.kind.includes('fail') ? 'failed' : event.kind.includes('approval') ? 'waiting_approval' : 'succeeded'}`}/><strong>{event.kind}</strong><span>{event.nodeId ? graph.nodes.find(node => node.id === event.nodeId)?.label ?? event.nodeId : 'Workflow'}</span><code>{stringify(event.payload)}</code></div>) : <p className="panel-empty">Run a workflow to see live events. Commands and provider actions are recorded as they happen.</p>}
            </div>
            {project ? <TerminalPanel key={`${project.id}:${terminalGeneration}`} ref={terminalController} project={project} visible={layout.panel && dock === 'terminal'} onActiveCount={terminalCountChanged}/> : dock === 'terminal' && <div className="panel-empty">Open a folder to start a terminal.</div>}
          </section>
        </>
      </main>

      {layout.inspector && !chatOpen && <>
        <div className="sash vertical" role="separator" aria-orientation="vertical" aria-label="Resize inspector" onPointerDown={resize('inspector', 'x', -1)}/>
        <aside className="inspector" style={{ width: sizes.inspector }}>
          <div className="view-title"><span>{selected ? 'Node' : edge ? 'Connection' : 'Workflow'}</span>{(selected || edge) && <IconButton title="Close inspector selection" onClick={() => { setSelectedId(undefined); setSelectedEdge(undefined); }}><X size={14}/></IconButton>}</div>
          <div className="inspector-scroll">{selected ? <>
            <div className="inspector-kind">{(() => { const Icon = nodeIcons[selected.kind]; return <Icon size={14}/>; })()}{NODE_LABELS[selected.kind]}</div>
            {selected.kind === 'agent' && selected.config.provider !== 'demo' && <button className="secondary block" onClick={() => { setChatContextRequest(old => ({ nodeId: selected.id, version: (old?.version ?? 0) + 1 })); setChatOpen(true); }}><MessageSquare size={13}/>Chat with this agent</button>}
            <Field label="Name"><input value={selected.label} onChange={event => changeNode({ label: event.target.value })}/></Field>
            {selected.kind === 'agent' && <><Field label="Provider"><select value={selected.config.provider} onChange={event => changeConfig({ provider: event.target.value })}><option value="codex">OpenAI Codex</option><option value="claude">Claude</option><option value="demo">Demo — deterministic test fixture</option></select></Field><Field label="Model (optional)"><input value={selected.config.model ?? ''} placeholder="Provider default" onChange={event => changeConfig({ model: event.target.value || undefined })}/></Field><Field label="Instructions"><textarea rows={7} placeholder="Describe the task and acceptance criteria…" value={selected.config.instructions} onChange={event => changeConfig({ instructions: event.target.value })}/></Field><Field label="Workspace permission"><select value={selected.config.permission} onChange={event => changeConfig({ permission: event.target.value })}><option value="read-only">Read only</option><option value="scoped-edit">Scoped edit in isolated worktree</option></select></Field></>}
            {selected.kind === 'agent' && <><div className="inspector-group">Functional role · step override</div><RoleEditor key={selected.id} value={selected.config.role} onChange={role => changeConfig({ role })}/>{project && <RoleLibrary key={`${project.id}:${selected.id}`} projectId={project.id} role={selected.config.role} onApply={role => changeConfig({ role })}/>}</>}
            {selected.kind === 'command' && <><Field label="Executable"><input value={selected.config.command} onChange={event => changeConfig({ command: event.target.value })}/></Field><Field label="Arguments (one per line)"><textarea rows={4} value={selected.config.args.join('\n')} onChange={event => changeConfig({ args: event.target.value.split('\n').filter(Boolean) })}/></Field><p className="field-help">Arguments are passed directly. Shell syntax is not expanded. Command execution requires approval.</p></>}
            {selected.kind === 'tool' && <ToolEditor key={selected.id} value={selected.config} earlier={graph.nodes.filter(node => node.id !== selected.id && graph.edges.some(item => item.target === selected.id)).map(node => ({ id: node.id, label: node.label }))} onChange={config => changeConfig(config)}/>}
            {selected.kind === 'role' && <><button className="secondary block" onClick={() => openPlaybook(selected.id)}><Users size={13}/>Open playbook ({selected.config.playbook.nodes.length - 2} steps)</button><p className="field-help">The playbook is this role's own workflow. Its agents work as this role, and everything it changes must stay within the role's owned paths.</p><div className="inspector-group">Role</div><RoleEditor key={selected.id} value={selected.config.role} allowRemove={false} onChange={role => { if (role) changeConfig({ role }); }}/>{project && <RoleLibrary key={`${project.id}:${selected.id}`} projectId={project.id} role={selected.config.role} onApply={role => changeConfig({ role })}/>}</>}
            {selected.kind === 'approval' && <Field label="Review instructions"><textarea rows={5} value={selected.config.message} onChange={event => changeConfig({ message: event.target.value })}/></Field>}
            {selected.kind === 'join' && <Field label="Wait for"><select value={selected.config.mode} onChange={event => changeConfig({ mode: event.target.value })}><option value="all_success">All branches succeed</option><option value="all_settled">All branches settle</option><option value="first_success">First successful branch</option></select></Field>}
            {(selected.kind === 'condition' || selected.kind === 'quality_gate') && <><Field label="Read output from"><select value={selected.config.predicate.sourceNodeId} onChange={event => changeConfig({ predicate: { ...selected.config.predicate, sourceNodeId: event.target.value } })}><option value="">Choose source node</option>{graph.nodes.filter(node => node.id !== selected.id).map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</select></Field><Field label="Output field"><input value={selected.config.predicate.field} onChange={event => changeConfig({ predicate: { ...selected.config.predicate, field: event.target.value } })}/></Field><Field label="Comparison"><select value={selected.config.predicate.operator} onChange={event => changeConfig({ predicate: { ...selected.config.predicate, operator: event.target.value } })}>{['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'contains'].map(operator => <option key={operator}>{operator}</option>)}</select></Field><Field label="Expected value"><input value={String(selected.config.predicate.value ?? '')} onChange={event => { let value: unknown = event.target.value; try { value = JSON.parse(event.target.value); } catch { /* A plain string is a valid comparison value. */ } changeConfig({ predicate: { ...selected.config.predicate, value } }); }}/></Field></>}
            {selected.kind === 'quality_gate' && <><Field label="Maximum iterations"><input type="number" min="1" max="20" value={selected.config.maxIterations} onChange={event => changeConfig({ maxIterations: Number(event.target.value) })}/></Field>
              {(() => { const targets = graph.edges.filter(item => item.source === selected.id && item.kind === 'loop').map(item => graph.nodes.find(node => node.id === item.target)).filter((node): node is GraphNode => !!node); return targets.length > 1 || selected.config.routing === 'owner' ? <>
                <Field label="When this gate fails"><select aria-label="Failure routing" value={selected.config.routing ?? 'single'} onChange={event => changeConfig({ routing: event.target.value === 'owner' ? 'owner' : undefined })}><option value="single">Loop back to one step</option><option value="owner">Send to the roles that own the failing files</option></select></Field>
                {selected.config.routing === 'owner' && <Field label="When ownership is unclear, send to"><select aria-label="Routing fallback" value={selected.config.fallbackTargetId ?? ''} onChange={event => changeConfig({ fallbackTargetId: event.target.value || undefined })}><option value="">First loop target</option>{targets.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</select></Field>}
                <p className="field-help">Owner routing matches file paths in the failing test output or review findings against each role's owned paths, then re-runs only those roles.</p>
              </> : null; })()}</>}
            <div className="inspector-group">Execution</div>
            <div className="field-row"><Field label="Timeout (seconds)"><input type="number" min="1" value={selected.timeoutMs / 1000} onChange={event => changeNode({ timeoutMs: Number(event.target.value) * 1000 })}/></Field><Field label="Maximum attempts"><input type="number" min="1" max="10" value={selected.retry.maxAttempts} onChange={event => changeNode({ retry: { ...selected.retry, maxAttempts: Number(event.target.value) } })}/></Field></div>
            <label className="check-field"><input type="checkbox" checked={selected.disabled} onChange={event => changeNode({ disabled: event.target.checked })}/>Disable this node</label>
            <details><summary>Advanced configuration JSON</summary><textarea className="config-json" rows={10} value={configText} onChange={event => setConfigText(event.target.value)}/>{configError && <p className="inline-error">{configError}</p>}<button className="secondary" onClick={() => { try { const parsed = GraphSchema.parse({ ...graph, nodes: graph.nodes.map(node => node.id === selected.id ? { ...node, config: JSON.parse(configText) } : node) }); edit(parsed); setConfigError(''); } catch (cause) { setConfigError(String(cause)); } }}>Apply configuration</button></details>
            <div className="node-actions"><button className="secondary" onClick={() => { clipboard.current = []; duplicate(); }}><Copy size={13}/>Duplicate</button><button className="secondary danger" onClick={deleteSelection}><Trash2 size={13}/>Delete</button></div>
            <RoleRunDetails events={events.filter(event => event.nodeId === selected.id)}/>
            {inspection?.attempts.some(attempt => attempt.nodeId === selected.id) && <div className="inspector-group">Attempts</div>}
            {inspection?.attempts.filter(attempt => attempt.nodeId === selected.id).map(attempt => <div key={attempt.id} className="attempt-card"><div><span className={`state-dot ${attempt.state}`}/>Attempt {attempt.attemptIndex ?? 1} · {attempt.state.replaceAll('_', ' ')}</div><pre>{stringify(attempt.output ?? attempt.error ?? 'No output recorded')}</pre>{attempt.worktreePath && <small>{attempt.worktreePath}</small>}</div>)}
          </> : edge ? <>
            <Field label="Connection type"><select value={edge.kind} onChange={event => edit(old => ({ ...old, edges: old.edges.map(item => item.id === edge.id ? { ...item, kind: event.target.value as 'control' | 'artifact' | 'loop' } : item) }))}><option value="control">Control flow</option><option value="artifact">Artifact dependency</option><option value="loop">Bounded quality loop</option></select></Field>
            <p className="field-help">Loop edges must leave a quality gate. The gate enforces its iteration limit.</p>
            <Field label="Source port"><input value={edge.sourcePort ?? ''} onChange={event => edit(old => ({ ...old, edges: old.edges.map(item => item.id === edge.id ? { ...item, sourcePort: event.target.value || undefined } : item) }))}/></Field>
            <div className="node-actions"><button className="secondary danger" onClick={deleteSelection}><Trash2 size={13}/>Delete connection</button></div>
          </> : <>
            <Field label="Workflow name"><input value={graph.name} onChange={event => edit(old => ({ ...old, name: event.target.value }))}/></Field>
            <div className="field-row"><Field label="Concurrent nodes"><input type="number" min="1" max="16" value={graph.settings.maxConcurrency} onChange={event => edit(old => ({ ...old, settings: { ...old.settings, maxConcurrency: Number(event.target.value) } }))}/></Field><Field label="Total attempt limit"><input type="number" min="1" max="2000" value={graph.settings.maxTotalAttempts} onChange={event => edit(old => ({ ...old, settings: { ...old.settings, maxTotalAttempts: Number(event.target.value) } }))}/></Field></div>
            <Field label="Workflow timeout (minutes)"><input type="number" min="1" value={graph.settings.timeoutMs / 60000} onChange={event => edit(old => ({ ...old, settings: { ...old.settings, timeoutMs: Number(event.target.value) * 60000 } }))}/></Field>
            <div className="inspector-group">Context</div>
            <label className="check-field"><input type="checkbox" checked={graph.settings.contextEconomy !== false} onChange={event => edit(old => ({ ...old, settings: { ...old.settings, contextEconomy: event.target.checked ? undefined : false } }))}/>Layered prompts, verified-facts ledger, and digests</label>
            <label className="check-field"><input type="checkbox" checked={graph.settings.resumeOnRetry === true} onChange={event => edit(old => ({ ...old, settings: { ...old.settings, resumeOnRetry: event.target.checked ? true : undefined } }))}/>Resume agent sessions on retries</label>
            <p className="field-help">Neither setting changes which tests, gates, or approvals run. Session resume is off by default; turn it on only after comparison runs show no drop in pass rates.</p>
            <div className="inspector-group">Validation</div>
            <div className="validation-summary">{validation.valid ? <><CircleCheck size={14} className="ok"/>Workflow is valid</> : <><CircleX size={14} className="err"/>{validation.errors.length} validation issues</>}</div>
            {!validation.valid && <ul className="validation-list">{validation.errors.slice(0, 6).map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>}
            <p className="trust-note">Local-first does not mean sandboxed. Review command and integration approvals before granting access.</p>
            <p className="field-help">Select a node on the canvas to configure it.</p>
          </>}</div>
        </aside>
      </>}
      {project && <ChatPanel key={project.id} project={project} graph={graph} visible={chatOpen} contextRequest={chatContextRequest} runId={selectedRun?.graph.id === graph.id && selectedRun.graph.nodes.some(node => node.id === chatContextRequest?.nodeId) ? runId : undefined} onClose={() => setChatOpen(false)} onApplyWorkflow={next => { edit(next); setSelectedId(undefined); setTab('graph'); setMessage('Applied the workflow from chat as a draft. Review permissions before running.'); }}/>}
      {!project && chatOpen && <aside className="chat-panel"><div className="chat-heading">Agent chat<IconButton title="Close chat" onClick={() => setChatOpen(false)}><X size={15}/></IconButton></div><div className="chat-empty"><h3>Open a folder to start chatting</h3><p>Choose a folder so your conversation has a project to work with.</p><button className="primary" onClick={openFolder}>Open Folder</button></div></aside>}
    </div>

    <footer className="status-bar">
      <div>
        <span className="status-item"><span className={`state-dot ${connected ? 'succeeded' : 'pending'}`}/>{project?.name ?? 'No project'}</span>
        <span className="status-item"><GitBranch size={12}/>{project?.branch ?? (project ? 'Folder' : '—')}</span>
        <button className="status-item" title="Show validation" onClick={() => { setSelectedId(undefined); setSelectedEdge(undefined); setLayout(old => ({ ...old, inspector: true })); }}><CircleX size={12}/>{validation.valid ? 0 : validation.errors.length}</button>
        {approvals.length > 0 && <button className="status-item" onClick={() => { setDock('approvals'); setLayout(old => ({ ...old, panel: true })); }}><ShieldCheck size={12}/>{approvals.length} awaiting approval</button>}
        <span className="status-item status-message">{busy ? 'Working…' : message}</span>
      </div>
      <div>{tab === 'code' && currentBuffer && <><span className="status-item">Ln {cursor.line}, Col {cursor.column}</span><span className="status-item">{language(currentBuffer.path)} · UTF-8</span></>}<span className="status-item">Usage: unavailable</span><span className="status-item">Local workspace</span></div>
    </footer>

    {error && !modal && <div className="notification" role="alert"><CircleX size={15}/><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={14}/></button></div>}
    <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void act(async () => { const imported = GraphSchema.parse(JSON.parse(await file.text())); edit(imported); setTab('graph'); setMessage('Imported workflow as a draft.'); }); event.target.value = ''; }}/>
    {modal && <div className={`modal-backdrop ${modal === 'palette' ? 'top' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget) setModal(null); }}><section className={`modal ${modal === 'palette' ? 'quick-input' : ''}`} role="dialog" aria-modal="true" aria-label={modal === 'project' ? 'Open Folder' : modal === 'generate' ? 'Generate workflow' : paletteMode === 'files' ? 'Quick Open' : paletteMode === 'commands' ? 'Command Palette' : 'Add a node'}>
      {modal !== 'palette' && <div className="modal-header"><h2>{modal === 'project' ? 'Open Folder' : 'Generate workflow'}</h2><IconButton title="Close dialog" onClick={() => setModal(null)}><X size={15}/></IconButton></div>}
      {modal === 'project' && <div className="modal-body">
        <p>Choose any folder to browse and edit. Agent workflows require a Git repository with an initial commit.</p>
        <Field label="Folder path"><input autoFocus placeholder="/Users/you/projects/my-app" value={projectPath} onChange={event => setProjectPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') openProjectPath(); }}/></Field>
        <div className="dialog-actions">{isDesktop() && <button className="secondary" onClick={openFolder}>Browse…</button>}<button className="primary" disabled={!projectPath || busy} onClick={openProjectPath}>Open</button></div>
        {projects.length > 0 && <div className="recent-projects"><div className="inspector-group">Recent</div>{projects.map(item => <button key={item.id} onClick={() => void act(async () => { if (await loadProject(item)) { explicitFolderChoice.current = true; setModal(null); setView('explorer'); setTab('code'); } })}><FolderOpen size={14}/><strong>{item.name}</strong><small>{item.root}</small></button>)}</div>}
      </div>}
      {modal === 'generate' && (project ? <GenerationPanel key={project.id} projectId={project.id} graph={graph} prompt={prompt} onPromptChange={setPrompt} onApply={next => {
        edit(next); setSelectedId(undefined); setTab('graph'); setModal(null); setMessage('Applied generated workflow as a draft. Review permissions before running.');
      }}/> : <div className="modal-body"><p className="inline-error">Open a repository before generating a graph.</p></div>)}
      {modal === 'palette' && <QuickPick key={paletteMode} label={paletteMode === 'files' ? 'Quick Open' : paletteMode === 'commands' ? 'Command Palette' : 'Search nodes and files'} placeholder={paletteMode === 'files' ? 'Search files by name or path' : paletteMode === 'commands' ? 'Type a command' : 'Add a workflow node'} query={paletteQuery} onQueryChange={setPaletteQuery} items={paletteItems} onClose={() => setModal(null)} onChoose={id => {
        setModal(null);
        if (paletteMode === 'files') openFile(id);
        else if (paletteMode === 'nodes') addNode(id as NodeKind);
        else editorCommands.find(command => command.id === id)?.run();
      }}/>}
      {error && <div className="inline-error" role="alert">{error}</div>}
    </section></div>}
  </div>;
}
