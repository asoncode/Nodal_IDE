import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Plus, Send, Square, X, GitCompare, Check, ChevronDown, Paperclip, FileText, AtSign } from 'lucide-react';
import { api } from './api.js';
import type { Project, Graph } from './model.js';
import type { ChatSession, ChatSnapshot, ChatTurn, ChatEvent, ChatProvider, ChatPermission, ChatDiff, ChatFile } from '../../../packages/shared/src/chat.js';
import { mentionAt, checkAttachments, readChatUpload, type DraftAttachment } from './chatAttachments.js';
import './ChatPanel.css';

interface Props {
  project: Project; graph: Graph; selectedNodeId?: string; runId?: string; visible?: boolean;
  contextRequest?: { nodeId: string; version: number }; onClose: () => void;
}
export function streamedText(events: ChatEvent[], turnId: string): string {
  const chunks = new Map<string, string>();
  for (const event of events) if (event.turnId === turnId && event.type === 'message' && typeof event.data.text === 'string') {
    chunks.set(typeof event.data.id === 'string' ? event.data.id : event.id, event.data.text);
  }
  return [...chunks.values()].join('\n\n');
}
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
export default function ChatPanel({ project, graph, runId, visible = true, contextRequest, onClose }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [chatId, setChatId] = useState<string>();
  const [snapshot, setSnapshot] = useState<ChatSnapshot>();
  const [localTurn, setLocalTurn] = useState<ChatTurn>();
  const [provider, setProvider] = useState<ChatProvider>('claude');
  const [model, setModel] = useState('');
  const [permission, setPermission] = useState<ChatPermission>('read-only');
  const [nodeId, setNodeId] = useState('');
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [mention, setMention] = useState<ReturnType<typeof mentionAt>>();
  const [fileOptions, setFileOptions] = useState<ChatFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileIndex, setFileIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<ChatDiff>();
  const [notice, setNotice] = useState('');
  const epoch = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadPending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; }; }, []);
  const agents = graph.nodes.filter(node => node.kind === 'agent' && node.config.provider !== 'demo');
  const turns = snapshot?.turns ?? [];
  const shownTurns = localTurn && !turns.some(turn => turn.id === localTurn.id) ? [...turns, localTurn] : turns;
  const running = shownTurns.find(turn => turn.status === 'running');
  const session = snapshot?.session ?? sessions.find(session => session.id === chatId);
  const currentProvider = session?.provider ?? provider;
  const currentPermission = session?.permission ?? permission;
  const currentModel = session?.model ?? model;
  const newChat = (nextNodeId = '') => {
    epoch.current++; setChatId(undefined); setSnapshot(undefined); setLocalTurn(undefined); setMessage(''); setAttachments([]); setMention(undefined); setError(''); setReview(undefined); setNotice(''); setNodeId(nextNodeId);
    const node = graph.nodes.find(node => node.id === nextNodeId);
    if (node?.kind === 'agent' && node.config.provider !== 'demo') { setProvider(node.config.provider); setModel(node.config.model ?? ''); }
    composer.current?.focus();
  };
  useEffect(() => {
    if (contextRequest) newChat(contextRequest.nodeId);
    // Only an explicit request starts a node conversation; canvas selection never switches a chat.
  }, [contextRequest?.version]);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    void api<ChatSession[]>('chats', { projectId: project.id }).then(items => { if (!disposed) setSessions(items); }).catch(cause => { if (!disposed) setError(errorText(cause)); });
    return () => { disposed = true; };
  }, [project.id, visible, chatId]);
  const mentionOpen = !!mention;
  useEffect(() => {
    if (!mentionOpen || !visible) return;
    let disposed = false; setFilesLoading(true);
    void api<ChatFile[]>('chatFiles', { projectId: project.id }).then(files => { if (!disposed) setFileOptions(files); }).catch(cause => { if (!disposed) { setFileOptions([]); setError(errorText(cause)); } }).finally(() => { if (!disposed) setFilesLoading(false); });
    return () => { disposed = true; };
  }, [project.id, mentionOpen, visible]);
  const matchingFiles = fileOptions.filter(file => file.path.toLowerCase().includes(mention?.query.toLowerCase() ?? '') && !attachments.some(item => item.input.kind === 'reference' && item.input.path === file.path)).slice(0, 12);
  const updateMention = (text: string, caret: number) => { setMention(mentionAt(text, caret)); setFileIndex(0); };
  const focusComposer = (caret: number) => requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(caret, caret); });
  const referenceFile = (file: ChatFile) => {
    if (!mention || busy || uploading || running) return;
    try {
      const next = [...attachments, { id: crypto.randomUUID(), size: file.size, input: { kind: 'reference' as const, path: file.path } }];
      checkAttachments(next); setAttachments(next); setMessage(message.slice(0, mention.start) + message.slice(mention.caret)); setMention(undefined); setError(''); focusComposer(mention.start);
    } catch (cause) { setError(errorText(cause)); }
  };
  const startReference = () => {
    const caret = composer.current?.selectionStart ?? message.length;
    const token = caret && !/\s/.test(message[caret - 1]) ? ' @' : '@';
    const next = message.slice(0, caret) + token + message.slice(caret);
    setMessage(next); updateMention(next, caret + token.length); focusComposer(caret + token.length);
  };
  const uploadFiles = async (files: File[]) => {
    if (!files.length || uploadPending.current) return;
    const version = epoch.current; uploadPending.current = true; setUploading(true); setError('');
    try {
      if (files.length + attachments.length > 8) throw new Error('Attach at most 8 files per message.');
      const uploaded = await Promise.all(files.map(readChatUpload));
      if (!mounted.current || epoch.current !== version) return;
      const next = [...attachments, ...uploaded]; checkAttachments(next); setAttachments(next);
    } catch (cause) { if (mounted.current && epoch.current === version) setError(errorText(cause)); }
    finally { uploadPending.current = false; if (mounted.current) setUploading(false); }
  };
  useEffect(() => {
    if (!chatId || !visible) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 700;
      try {
        const next = await api<ChatSnapshot>('inspectChat', { projectId: project.id, chatId });
        if (!disposed) setSnapshot(next);
        if (!next.turns.some(turn => turn.status === 'running')) delay = 4000;
      } catch (cause) { if (!disposed) setError(errorText(cause)); }
      finally { if (!disposed) timer = setTimeout(() => void poll(), delay); }
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [project.id, chatId, visible, localTurn?.id]);
  const lastTurn = shownTurns.at(-1);
  const pendingText = running ? streamedText(snapshot?.events ?? [], running.id) : '';
  useEffect(() => { transcript.current?.scrollTo?.({ top: transcript.current.scrollHeight, behavior: 'instant' }); }, [lastTurn?.id, lastTurn?.status, pendingText]);
  const act = async (action: (valid: () => boolean) => Promise<void>) => {
    const version = epoch.current; setBusy(true); setError('');
    try { await action(() => mounted.current && version === epoch.current); } catch (cause) { if (mounted.current && version === epoch.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const send = () => {
    if (busy || uploading || running || !message.trim() && !attachments.length) return;
    const version = epoch.current; const text = message.trim() || 'Please review the attached files.';
    void act(async () => {
      let selected = session;
      if (!selected) {
        selected = await api<ChatSession>('createChat', { projectId: project.id, provider, model: model.trim() || undefined, permission,
          context: nodeId ? { graph, nodeId, runId } : undefined });
        if (!mounted.current || epoch.current !== version) return;
        setSessions(items => [selected!, ...items.filter(item => item.id !== selected!.id)]); setChatId(selected.id);
        setSnapshot({ session: selected, turns: [], events: [] });
      }
      const sent = await api<ChatTurn>('sendChat', { projectId: project.id, chatId: selected.id, message: text, attachments: attachments.map(item => item.input), confirmed: true });
      if (!mounted.current || epoch.current !== version) return;
      setLocalTurn(sent); setMessage(''); setAttachments([]); setMention(undefined); setReview(undefined); setNotice('');
    });
  };
  const selectSession = (id: string) => {
    epoch.current++; setChatId(id || undefined); setSnapshot(undefined); setLocalTurn(undefined); setReview(undefined); setError(''); setMessage(''); setAttachments([]); setMention(undefined); setNotice('');
  };
  const approval = running?.approval?.status === 'pending' ? running.approval : undefined;
  return <aside className="chat-panel" aria-label="Agent chat" style={{ display: visible ? 'flex' : 'none' }}>
    <div className="chat-heading"><span><MessageSquare size={15}/>Agent chat</span><div><button className="icon-button" title="New chat" aria-label="New chat" disabled={busy} onClick={() => newChat()}><Plus size={16}/></button><button className="icon-button" title="Close chat" aria-label="Close chat" onClick={onClose}><X size={16}/></button></div></div>
    <div className="chat-context">
      <label>Conversation<select aria-label="Chat history" value={chatId ?? ''} disabled={busy} onChange={event => event.target.value ? selectSession(event.target.value) : newChat()}><option value="">New conversation</option>{sessions.map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label>
      {!chatId ? <>
        <label>Context<select aria-label="Chat context" value={nodeId} disabled={busy} onChange={event => newChat(event.target.value)}><option value="">Repository · {project.name}</option>{agents.map(node => <option key={node.id} value={node.id}>Agent · {node.label}</option>)}</select></label>
        <div className="chat-field-row"><label>Provider<select aria-label="Chat provider" value={provider} disabled={busy || !!nodeId} onChange={event => setProvider(event.target.value as ChatProvider)}><option value="claude">Claude</option><option value="codex">Codex</option></select></label><label>Access<select aria-label="Chat access" value={permission} disabled={busy} onChange={event => setPermission(event.target.value as ChatPermission)}><option value="read-only">Read only</option><option value="scoped-edit" disabled={project.isGitRepository === false}>Isolated edits</option></select></label></div>
        <label><span>Model <small>(optional)</small></span><input aria-label="Chat model" value={model} disabled={busy || !!nodeId} placeholder="Provider default" onChange={event => setModel(event.target.value)}/></label>
      </> : <div className="chat-session-scope"><strong>{currentProvider === 'claude' ? 'Claude' : 'Codex'}</strong><span>{currentPermission === 'read-only' ? 'Read only' : 'Isolated edits'}</span><small>{currentModel || 'Provider default'}</small></div>}
      {(session?.context || !chatId && nodeId) && <p className="chat-context-note">{session?.context?.nodeLabel ?? agents.find(node => node.id === nodeId)?.label} · Separate context chat. Does not control the workflow or its running agent.</p>}
    </div>
    <div className="chat-transcript" role="log" aria-label="Chat messages" aria-live="polite" ref={transcript}>
      {!shownTurns.length && <div className="chat-empty"><MessageSquare size={26}/><h3>Talk through your project</h3><p>Ask about the code, plan a change, or give an agent a task. Choose an agent context to discuss its role in your workflow.</p><small>Uses your existing Claude or Codex login.</small></div>}
      {shownTurns.map(turn => <div className="chat-turn" key={turn.id}>
        <article className="chat-message user"><strong>You</strong><div>{turn.message}</div>{turn.attachments?.map((file, index) => <details className="chat-attached-file" key={index}><summary><FileText size={12}/>{file.path ?? file.name}<small>{file.kind === 'reference' ? 'Reference' : 'Upload'}</small></summary><pre>{file.content}</pre></details>)}</article>
        <article className="chat-message assistant"><strong>{currentProvider === 'claude' ? 'Claude' : 'Codex'}<span className={`state-dot ${turn.status}`}/><small>{turn.status === 'running' ? turn.approval?.status === 'pending' ? 'Awaiting approval' : 'Working…' : turn.status}</small></strong><div>{turn.status === 'running' ? streamedText(snapshot?.events ?? [], turn.id) || 'Reading your request…' : turn.output || (turn.status === 'cancelled' ? 'Stopped. Partial work is preserved.' : '')}</div>{turn.error && <p className="chat-turn-error">{turn.error}</p>}</article>
      </div>)}
      {!!snapshot?.events.filter(event => !['session', 'message', 'result'].includes(event.type)).length && <details className="chat-activity"><summary><ChevronDown size={12}/>Agent activity</summary>{snapshot.events.filter(event => !['session', 'message', 'result'].includes(event.type)).slice(-30).map(event => <pre key={event.id}>{event.type}{'\n'}{JSON.stringify(event.data, null, 2)}</pre>)}</details>}
    </div>
    {approval && <section className="chat-command-approval" aria-label="Command approval"><strong>Allow this command?</strong><pre>{approval.command}</pre><p>Runs in the chat worktree with your user privileges, including host files and network access. Approve only commands you trust.</p><div><button className="secondary" disabled={busy} onClick={() => void act(async () => { await api('approveChatCommand', { projectId: project.id, chatId, turnId: running!.id, approvalId: approval.id, approved: false }); })}>Reject command</button><button className="primary" disabled={busy} onClick={() => void act(async () => { await api('approveChatCommand', { projectId: project.id, chatId, turnId: running!.id, approvalId: approval.id, approved: true }); })}>Approve command</button></div></section>}
    {chatId && session?.worktreePath && <div className="chat-changes"><button className="secondary" disabled={busy || !!running} onClick={() => void act(async valid => { const preview = await api<ChatDiff>('chatDiff', { projectId: project.id, chatId }); if (valid()) setReview(preview); })}><GitCompare size={13}/>Review changes</button><small title={session.worktreePath}>Isolated chat worktree</small></div>}
    {review && <section className="chat-review" aria-label="Chat changes"><button className="icon-button" title="Close changes" aria-label="Close chat changes" onClick={() => setReview(undefined)}><X size={14}/></button><pre>{review.diff || 'No changes to apply.'}</pre><button className="primary" disabled={busy || !!running || !review.diff || review.dirty} onClick={() => void act(async valid => {
      if (!window.confirm('Apply these reviewed chat changes to your repository? This creates a local integration commit.')) return;
      const result = await api<{ merged: boolean; conflicts: string[]; message?: string }>('applyChatChanges', { projectId: project.id, chatId, expectedHead: review.head, expectedSourceHead: review.sourceHead, approved: true });
      if (!result.merged) throw new Error(`Changes were not applied: ${result.message ?? result.conflicts.join(', ')}`);
      if (valid()) { setReview(undefined); setNotice('Reviewed changes applied to your repository.'); }
    })}><Check size={13}/>Apply reviewed changes</button>{review.dirty && <p>Commit or stash changes in your main checkout before applying.</p>}</section>}
    <div className="chat-compose">
      {error && <p className="chat-error" role="alert">{error}</p>}{notice && <p className="chat-notice" role="status">{notice}</p>}
      {!!attachments.length && <ul className="chat-attachments" aria-label="Attached files">{attachments.map(file => <li key={file.id}><FileText size={12}/><span title={file.input.kind === 'reference' ? file.input.path : file.input.name}>{file.input.kind === 'reference' ? file.input.path : file.input.name}</span><small>{file.input.kind === 'reference' ? '@' : 'Upload'}</small><button className="icon-button" aria-label={`Remove ${file.input.kind === 'reference' ? file.input.path : file.input.name}`} disabled={busy || uploading} onClick={() => setAttachments(items => items.filter(item => item.id !== file.id))}><X size={12}/></button></li>)}</ul>}
      {mention && <div className="chat-file-picker"><div className="chat-file-picker-heading">Reference a saved project file <small>↑ ↓ · Enter · Esc</small></div><div role="listbox" id="chat-file-options" aria-label="Project file references">{filesLoading ? <p>Loading files…</p> : matchingFiles.length ? matchingFiles.map((file, index) => <button type="button" role="option" id={`chat-file-option-${index}`} aria-selected={index === Math.min(fileIndex, matchingFiles.length - 1)} key={file.path} disabled={busy || uploading || !!running} onMouseDown={event => event.preventDefault()} onClick={() => referenceFile(file)}><FileText size={12}/><span>{file.path}</span></button>) : <p>No matching text files. Press Esc to dismiss.</p>}</div></div>}
      <textarea ref={composer} aria-label="Message agent" aria-autocomplete="list" aria-controls={mention ? 'chat-file-options' : undefined} aria-activedescendant={mention && !filesLoading && matchingFiles.length ? `chat-file-option-${Math.min(fileIndex, matchingFiles.length - 1)}` : undefined} placeholder="Ask about this project… Type @ to reference a file" rows={3} maxLength={20000} value={message} disabled={busy || uploading} onChange={event => { setMessage(event.target.value); updateMention(event.target.value, event.target.selectionStart); }} onSelect={event => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (mention && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          if (event.key === 'Escape') setMention(undefined);
          else if (event.key === 'Enter') { const file = matchingFiles[Math.min(fileIndex, matchingFiles.length - 1)]; if (file && !filesLoading) referenceFile(file); }
          else setFileIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + matchingFiles.length) % Math.max(1, matchingFiles.length));
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
      }}/>
      <div className="chat-attachment-actions"><button type="button" className="icon-button" title="Reference project file (@)" aria-label="Reference project file" disabled={busy || uploading || !!running} onClick={startReference}><AtSign size={15}/></button><button type="button" className="icon-button" title="Upload text files" aria-label="Upload files" disabled={busy || uploading || !!running} onClick={() => uploadInput.current?.click()}><Paperclip size={15}/></button><small>{uploading ? 'Reading files…' : 'Text / code · 8 files · 64 KiB each'}</small></div>
      <input ref={uploadInput} type="file" multiple hidden aria-label="Upload chat files" accept="text/*,application/json,.md,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.swift,.json,.yaml,.yml,.toml,.xml,.sh,.sql,.vue,.svelte,.ipynb" disabled={busy || uploading || !!running} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void uploadFiles(files); }}/>
      <p className="chat-consent">Sending approves this turn and shares your message, files, and repository context with {currentProvider === 'claude' ? 'Claude' : 'Codex'}. {currentPermission === 'read-only' ? 'Read-only access.' : `Edits use a separate worktree from committed files. ${currentProvider === 'claude' ? 'Shell commands ask separately.' : 'Includes sandboxed commands; network disabled.'}`}</p>
      <div className="chat-compose-actions"><small>Enter to send · Shift+Enter for a new line</small>{running ? <button className="secondary" disabled={busy} onClick={() => void act(async () => { await api('cancelChat', { projectId: project.id, chatId, turnId: running.id }); })}><Square size={12}/>Stop</button> : <button className="primary" disabled={busy || uploading || !message.trim() && !attachments.length} onClick={send}><Send size={13}/>{busy ? 'Sending…' : 'Send & approve'}</button>}</div>
    </div>
  </aside>;
}
