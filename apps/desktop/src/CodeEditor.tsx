import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { Code2, ListOrdered, Replace, Search, SlidersHorizontal, WrapText } from 'lucide-react';
import { language, type FileBuffer } from './model.js';
import './CodeEditor.css';

export interface EditorSettings { fontSize: number; tabSize: number; wordWrap: boolean; minimap: boolean }
export interface Problem { message: string; severity: number; startLineNumber: number; startColumn: number }
export interface EditorLocation { path: string; line: number; column: number; version: number }
export interface CodeEditorHandle { run(action: string): void }
const defaults: EditorSettings = { fontSize: 13, tabSize: 2, wordWrap: false, minimap: false };
export function readEditorSettings(): EditorSettings {
  try {
    const value = JSON.parse(localStorage.getItem('nodal.editor.settings.v1') ?? '{}');
    return { fontSize: Number.isInteger(value.fontSize) && value.fontSize >= 10 && value.fontSize <= 24 ? value.fontSize : defaults.fontSize, tabSize: [2, 4, 8].includes(value.tabSize) ? value.tabSize : defaults.tabSize, wordWrap: value.wordWrap === true, minimap: value.minimap === true };
  } catch { return defaults; }
}
interface Props {
  projectId: string; buffer: FileBuffer; openPaths?: string[]; location?: EditorLocation; settings: EditorSettings; readOnly?: boolean; visible?: boolean;
  onSettings: (settings: EditorSettings) => void; onChange: (content: string) => void;
  onCursor: (line: number, column: number) => void; onProblems: (path: string, problems: Problem[]) => void; onError: (message: string) => void;
}

const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor({ projectId, buffer, openPaths, location, settings, readOnly = false, visible = true, onSettings, onChange, onCursor, onProblems, onError }, ref) {
  const instance = useRef<editor.IStandaloneCodeEditor | null>(null);
  const cursorListener = useRef<{ dispose(): void } | null>(null);
  const models = useRef(new Map<string, editor.ITextModel>());
  const syncing = useRef(false);
  const uri = (path: string) => `file:///nodal/${encodeURIComponent(projectId)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const current = useRef({ buffer, location, onCursor, uri: uri(buffer.path) }); current.current = { buffer, location, onCursor, uri: uri(buffer.path) };
  const [preferences, setPreferences] = useState(false);
  const navigate = () => {
    const target = current.current.location, model = instance.current?.getModel();
    if (!target || target.path !== current.current.buffer.path || !model || !instance.current) return;
    const position = model.validatePosition({ lineNumber: target.line, column: target.column });
    instance.current.setPosition(position); instance.current.revealPositionInCenter(position); instance.current.focus();
  };
  useEffect(navigate, [buffer.path, location]);
  useEffect(() => { if (visible) instance.current?.focus(); }, [buffer.path, visible]);
  const reconcile = () => {
    const model = instance.current?.getModel();
    if (!model || model.uri.toString() !== current.current.uri) return;
    models.current.set(model.uri.toString(), model);
    // The Monaco wrapper reuses models when paths change, even when the controlled text is unchanged.
    if (model.getValue() !== current.current.buffer.content) {
      syncing.current = true;
      try { model.setValue(current.current.buffer.content); } finally { syncing.current = false; }
    }
  };
  useEffect(() => {
    reconcile();
    const opened = new Set((openPaths ?? [buffer.path]).map(uri));
    for (const [path, model] of models.current) if (!opened.has(path) && model !== instance.current?.getModel()) {
      if (!model.isDisposed()) model.dispose(); models.current.delete(path);
    }
  }, [projectId, buffer.path, openPaths]);
  useEffect(() => () => {
    cursorListener.current?.dispose();
    for (const model of models.current.values()) if (model !== instance.current?.getModel() && !model.isDisposed()) model.dispose();
    models.current.clear(); instance.current = null;
  }, []);
  const run = (id: string) => {
    const action = instance.current?.getAction(id);
    if (!action?.isSupported()) { onError('This action is not available for the current file type.'); return; }
    instance.current?.focus();
    void action.run().catch(cause => onError(cause instanceof Error ? cause.message : String(cause)));
  };
  useImperativeHandle(ref, () => ({ run }));
  const update = (patch: Partial<EditorSettings>) => onSettings({ ...settings, ...patch });
  return <>
    <div className="code-tools" aria-label="Editor actions">
      <button title="Find (Cmd/Ctrl+F)" onClick={() => run('actions.find')}><Search size={13}/>Find</button>
      <button title="Replace" onClick={() => run('editor.action.startFindReplaceAction')}><Replace size={13}/>Replace</button>
      <button title="Format document" onClick={() => run('editor.action.formatDocument')}><Code2 size={13}/>Format</button>
      <button title="Go to line (Ctrl+G)" onClick={() => run('editor.action.gotoLine')}><ListOrdered size={13}/>Go to line</button>
      <span/>
      <button title="Toggle word wrap (Alt+Z)" aria-label="Word wrap" aria-pressed={settings.wordWrap} onClick={() => update({ wordWrap: !settings.wordWrap })}><WrapText size={14}/></button>
      <button title="Editor settings" aria-label="Editor settings" aria-expanded={preferences} onClick={() => setPreferences(old => !old)}><SlidersHorizontal size={14}/></button>
    </div>
    {preferences && <div className="editor-preferences" aria-label="Editor preferences" onKeyDown={event => { if (event.key === 'Escape') setPreferences(false); }}>
      <label>Font size<select aria-label="Editor font size" value={settings.fontSize} onChange={event => update({ fontSize: Number(event.target.value) })}>{Array.from({ length: 15 }, (_, index) => index + 10).map(size => <option key={size}>{size}</option>)}</select></label>
      <label>Indent size<select aria-label="Indent size" value={settings.tabSize} onChange={event => update({ tabSize: Number(event.target.value) })}>{[2, 4, 8].map(size => <option key={size} value={size}>{size} spaces</option>)}</select></label>
      <label><input type="checkbox" checked={settings.minimap} onChange={event => update({ minimap: event.target.checked })}/>Minimap</label>
      <button onClick={() => setPreferences(false)}>Done</button>
    </div>}
    <Editor path={uri(buffer.path)} language={language(buffer.path)} value={buffer.content} theme="vs-dark" onChange={(value: string | undefined) => { if (!syncing.current) onChange(value ?? ''); }}
      onMount={(editor: editor.IStandaloneCodeEditor) => {
        instance.current = editor; cursorListener.current?.dispose();
        cursorListener.current = editor.onDidChangeCursorPosition(event => current.current.onCursor(event.position.lineNumber, event.position.column));
        reconcile(); if (visible) editor.focus(); navigate();
      }} onValidate={(markers: editor.IMarker[]) => onProblems(buffer.path, markers.map(marker => ({ message: marker.message, severity: marker.severity, startLineNumber: marker.startLineNumber, startColumn: marker.startColumn })))}
      options={{ editContext: false, readOnly, fontSize: settings.fontSize, lineHeight: Math.round(settings.fontSize * 1.6), tabSize: settings.tabSize, insertSpaces: true, wordWrap: settings.wordWrap ? 'on' : 'off', fontFamily: "'SF Mono', Menlo, Consolas, monospace", minimap: { enabled: settings.minimap }, padding: { top: 8 }, scrollBeyondLastLine: false, automaticLayout: true, renderLineHighlight: 'line' }}/>
  </>;
});
export default CodeEditor;
