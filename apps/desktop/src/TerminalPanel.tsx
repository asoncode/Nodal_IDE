import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Eraser, Plus, TerminalSquare, Trash2 } from 'lucide-react';
import type { TerminalOwner, TerminalRead, TerminalSession } from '../../../packages/shared/src/terminal.js';
import type { Project } from './model.js';
import { api } from './api.js';
import '@xterm/xterm/css/xterm.css';
import './TerminalPanel.css';

export interface TerminalPanelHandle { closeAll(): Promise<void> }
interface Props { project: Project; visible: boolean; onActiveCount?: (count: number) => void }
interface Entry {
  session: TerminalSession; terminal: Terminal; fit: FitAddon; host?: HTMLDivElement;
  cursor: number; disposed: boolean; pollTimer?: ReturnType<typeof setTimeout>;
  inputTimer?: ReturnType<typeof setTimeout>; input: string; writing: boolean;
  inputListener: { dispose(): void }; observer?: ResizeObserver;
  outputDone?: () => void; resizing: boolean; size?: { cols: number; rows: number };
}
interface Owner { scope: TerminalOwner; closed: boolean; entries: Map<string, Entry>; pending: Set<Promise<void>> }
const newOwner = (projectId: string): Owner => ({ scope: { projectId, ownerId: crypto.randomUUID() }, closed: false, entries: new Map(), pending: new Set() });
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function dispose(entry: Entry) {
  entry.disposed = true; clearTimeout(entry.pollTimer); clearTimeout(entry.inputTimer); entry.input = '';
  entry.outputDone?.(); entry.outputDone = undefined;
  entry.observer?.disconnect(); entry.inputListener.dispose(); entry.terminal.dispose();
}
async function closeOwner(owner: Owner, keepalive = false) {
  owner.closed = true;
  for (const entry of owner.entries.values()) dispose(entry);
  owner.entries.clear();
  const closing = api('closeTerminals', owner.scope, { keepalive });
  // A pending create uses this same owner, so the runtime tombstone also covers late shells.
  const results = await Promise.allSettled([closing, ...owner.pending]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

const TerminalPanel = forwardRef<TerminalPanelHandle, Props>(function TerminalPanel({ project, visible, onActiveCount }, ref) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const ownerRef = useRef<Owner | undefined>(undefined);
  const ownersRef = useRef<Set<Owner>>(new Set());
  const current = useRef({ visible, activeId, onActiveCount });
  current.current = { visible, activeId, onActiveCount };
  const alive = (owner: Owner) => !owner.closed && ownerRef.current === owner;
  const publish = (owner: Owner) => {
    if (!alive(owner)) return;
    const items = [...owner.entries.values()].map(entry => entry.session);
    setSessions(items); current.current.onActiveCount?.(items.filter(item => item.status === 'running').length);
  };
  const closeAll = async () => {
    const owner = ownerRef.current;
    if (!owner) return;
    setSessions([]); setActiveId(undefined); current.current.onActiveCount?.(0);
    await closeOwner(owner);
  };
  useImperativeHandle(ref, () => ({ closeAll }));
  useEffect(() => {
    // Each effect lifetime needs its own owner, including React StrictMode's replay.
    const owner = newOwner(project.id);
    const owners = new Set([owner]); ownersRef.current = owners;
    ownerRef.current = owner; setSessions([]); setActiveId(undefined); setError(''); setCreating(false); current.current.onActiveCount?.(0);
    const unload = () => { for (const item of owners) void closeOwner(item, true).catch(() => {}); };
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('beforeunload', unload); for (const item of owners) void closeOwner(item).catch(() => {}); };
  }, [project.id]);

  const fitEntry = (owner: Owner, entry: Entry) => {
    if (!alive(owner) || entry.disposed || !current.current.visible || current.current.activeId !== entry.session.id || !entry.host?.clientWidth || !entry.host.clientHeight) return;
    entry.fit.fit();
    const { cols, rows } = entry.terminal;
    if (entry.session.status !== 'running' || cols === entry.session.cols && rows === entry.session.rows) return;
    entry.size = { cols, rows };
    if (entry.resizing) return;
    entry.resizing = true;
    void (async () => {
      try {
        while (entry.size && alive(owner) && !entry.disposed) {
          const size = entry.size; entry.size = undefined;
          await api('resizeTerminal', { ...owner.scope, terminalId: entry.session.id, ...size });
          Object.assign(entry.session, size);
        }
      } catch (cause) { if (alive(owner) && !entry.disposed) setError(message(cause)); }
      finally { entry.resizing = false; }
    })();
  };
  useEffect(() => {
    const owner = ownerRef.current; const entry = activeId ? owner?.entries.get(activeId) : undefined;
    if (visible && owner && entry) { fitEntry(owner, entry); entry.terminal.focus(); }
  }, [visible, activeId]);

  const flushInput = async (owner: Owner, entry: Entry) => {
    if (entry.writing || entry.disposed || !alive(owner)) return;
    entry.writing = true;
    try {
      while (entry.input && alive(owner) && !entry.disposed && entry.session.status === 'running') {
        let end = 0; let bytes = 0;
        // The runtime limits UTF-8 bytes, so pasted multibyte characters count individually.
        for (const character of entry.input) {
          const point = character.codePointAt(0)!;
          const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
          if (bytes + size > 64 * 1024) break;
          bytes += size; end += character.length;
        }
        const data = entry.input.slice(0, end); entry.input = entry.input.slice(end);
        await api('writeTerminal', { ...owner.scope, terminalId: entry.session.id, data });
      }
    } catch (cause) { entry.input = ''; if (alive(owner) && !entry.disposed) setError(message(cause)); }
    finally { entry.writing = false; }
  };
  const poll = async (owner: Owner, entry: Entry) => {
    try {
      const result = await api<TerminalRead>('readTerminal', { ...owner.scope, terminalId: entry.session.id, after: entry.cursor });
      if (!alive(owner) || entry.disposed) return;
      if (result.truncated) entry.terminal.reset();
      const output = (result.truncated ? '[Earlier terminal output was discarded]\r\n' : '') + result.data;
      if (output) await new Promise<void>(resolve => {
        entry.outputDone = resolve;
        entry.terminal.write(output, () => { entry.outputDone = undefined; resolve(); });
      });
      if (!alive(owner) || entry.disposed) return;
      entry.cursor = result.next;
      if (entry.session.status !== result.status) {
        Object.assign(entry.session, { status: result.status, exitCode: result.exitCode, signal: result.signal });
        entry.terminal.options.disableStdin = result.status === 'exited';
        publish(owner);
      }
    } catch (cause) { if (alive(owner) && !entry.disposed) setError(message(cause)); }
    finally {
      if (alive(owner) && !entry.disposed) {
        // Retained exited tabs also renew the owner lease so another shell can be opened later.
        const delay = entry.session.status === 'exited' ? 5000 : !current.current.visible ? 1000 : current.current.activeId === entry.session.id ? 80 : 200;
        entry.pollTimer = setTimeout(() => void poll(owner, entry), delay);
      }
    }
  };
  const create = () => {
    const owner = ownerRef.current;
    if (!owner || owner.closed || creating) return;
    setCreating(true); setError('');
    const pending = (async () => {
      try {
        const session = await api<TerminalSession>('createTerminal', { ...owner.scope, cols: 80, rows: 24 });
        if (!alive(owner)) { await api('closeTerminal', { ...owner.scope, terminalId: session.id }); return; }
        const terminal = new Terminal({ cols: session.cols, rows: session.rows, fontFamily: "'SF Mono', Menlo, Consolas, monospace", fontSize: 12, scrollback: 5000, cursorBlink: true, theme: { background: '#181818', foreground: '#cccccc', cursor: '#e7e7e7', selectionBackground: '#264f78' } });
        const fit = new FitAddon(); terminal.loadAddon(fit);
        const entry: Entry = { session, terminal, fit, cursor: 0, disposed: false, input: '', writing: false, resizing: false, inputListener: { dispose() {} } };
        entry.inputListener = terminal.onData(data => {
          if (entry.disposed || session.status !== 'running') return;
          entry.input += data;
          if (!entry.inputTimer) entry.inputTimer = setTimeout(() => { entry.inputTimer = undefined; void flushInput(owner, entry); }, 16);
        });
        owner.entries.set(session.id, entry); publish(owner); setActiveId(session.id); void poll(owner, entry);
      } catch (cause) {
        if (alive(owner) && message(cause) === 'Terminal owner is closed. Open a new terminal panel.') {
          owner.closed = true;
          for (const entry of owner.entries.values()) dispose(entry);
          owner.entries.clear();
          const replacement = newOwner(owner.scope.projectId);
          ownersRef.current.add(replacement); ownerRef.current = replacement;
          setSessions([]); setActiveId(undefined); setCreating(false); current.current.onActiveCount?.(0);
          setError('Previous terminal sessions expired. Open a new terminal.');
        } else if (alive(owner)) setError(`Could not open terminal: ${message(cause)}`);
      }
      finally { if (alive(owner)) setCreating(false); }
    })();
    owner.pending.add(pending); void pending.finally(() => owner.pending.delete(pending));
  };
  const kill = async () => {
    const owner = ownerRef.current; const entry = activeId ? owner?.entries.get(activeId) : undefined;
    if (!owner || !entry) return;
    try {
      await api('closeTerminal', { ...owner.scope, terminalId: entry.session.id });
      if (!alive(owner) || entry.disposed) return;
      dispose(entry); owner.entries.delete(entry.session.id); publish(owner); setActiveId([...owner.entries.keys()].at(-1));
    } catch (cause) { if (alive(owner)) setError(message(cause)); }
  };
  const mountTerminal = (id: string, host: HTMLDivElement | null) => {
    const owner = ownerRef.current; const entry = owner?.entries.get(id);
    if (!owner || !entry || !host || entry.host) return;
    entry.host = host; entry.terminal.open(host);
    entry.observer = new ResizeObserver(() => fitEntry(owner, entry)); entry.observer.observe(host);
    fitEntry(owner, entry);
  };
  const active = sessions.find(item => item.id === activeId);
  return <section className="terminal-panel" aria-label="Terminal" style={{ display: visible ? 'flex' : 'none' }}>
    <div className="terminal-toolbar">
      <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs">{sessions.map(session => <button key={session.id} role="tab" id={`terminal-tab-${session.id}`} aria-controls={`terminal-view-${session.id}`} aria-selected={activeId === session.id} onClick={() => setActiveId(session.id)} title={session.cwd}><TerminalSquare size={12}/><span>{session.title}</span><small className={session.status}>{session.status === 'running' ? 'Running' : `Exited${session.exitCode === undefined ? '' : ` (${session.exitCode})`}`}</small></button>)}</div>
      <div className="terminal-actions"><button className="icon-button" aria-label="New terminal" title="New terminal" disabled={creating} onClick={create}><Plus size={15}/></button><button className="icon-button" aria-label="Clear terminal" title="Clear terminal" disabled={!active} onClick={() => { const terminal = activeId && ownerRef.current?.entries.get(activeId)?.terminal; if (terminal) { terminal.clear(); terminal.focus(); } }}><Eraser size={15}/></button><button className="icon-button" aria-label="Kill terminal" title={active?.status === 'exited' ? 'Close terminal' : 'Kill terminal'} disabled={!active} onClick={() => void kill()}><Trash2 size={14}/></button></div>
    </div>
    {error && <p className="terminal-error" role="alert">{error}</p>}
    {!sessions.length && <div className="terminal-empty"><div><TerminalSquare size={17}/><strong>Terminal</strong><button className="secondary" disabled={creating} onClick={create}>{creating ? 'Opening…' : 'New terminal'}</button></div><p title={project.root}>{project.root}</p><small>Run commands in your project folder using your local shell.</small></div>}
    <div className="terminal-views">{sessions.map(session => <div key={session.id} id={`terminal-view-${session.id}`} role="tabpanel" aria-labelledby={`terminal-tab-${session.id}`} className="terminal-view" style={{ display: session.id === activeId ? 'block' : 'none' }} ref={host => mountTerminal(session.id, host)}/>)}</div>
  </section>;
});
export default TerminalPanel;
