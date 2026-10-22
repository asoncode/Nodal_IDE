// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import type { EditorProps, OnMount } from '@monaco-editor/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import CodeEditor, { readEditorSettings, type CodeEditorHandle } from './CodeEditor.js';

interface FakeModel {
  uri: { toString: () => string };
  getValue: () => string;
  setValue: ReturnType<typeof vi.fn<(value: string) => void>>;
  isDisposed: () => boolean;
  dispose: ReturnType<typeof vi.fn>;
  validatePosition: ReturnType<typeof vi.fn<(position: { lineNumber: number; column: number }) => { lineNumber: number; column: number }>>;
}
const monaco = vi.hoisted(() => ({ props: undefined as EditorProps | undefined, models: new Map<string, FakeModel>(), active: undefined as FakeModel | undefined, previousValue: undefined as string | undefined }));
function createModel(value: string, path: string): FakeModel {
  let text = value, disposed = false;
  return { uri: { toString: () => path }, getValue: () => text, setValue: vi.fn((next: string) => { text = next; }), isDisposed: () => disposed,
    dispose: vi.fn(() => { disposed = true; }),
    validatePosition: vi.fn(({ lineNumber, column }: { lineNumber: number; column: number }) => ({ lineNumber: Math.max(1, Math.min(3, lineNumber)), column: Math.max(1, Math.min(8, column)) })) };
}
vi.mock('@monaco-editor/react', () => ({ default: (props: EditorProps) => {
  monaco.props = props;
  const path = props.path!;
  let model = monaco.models.get(path);
  if (!model || model.isDisposed()) { model = createModel(props.value ?? '', path); monaco.models.set(path, model); }
  monaco.active = model;
  // The wrapper changes models with the path, but its value effect runs only when value changes.
  if (monaco.previousValue !== props.value) model.setValue(props.value ?? '');
  monaco.previousValue = props.value;
  return <div aria-label="Monaco editor"/>;
} }));
const defaults = { fontSize: 13, tabSize: 2, wordWrap: false, minimap: false };
const buffer = { path: 'src/file.ts', content: 'const x = 1;', savedContent: 'const x = 1;', hash: 'hash' };
const props = () => ({ projectId: 'project', buffer, settings: defaults, onSettings: vi.fn(), onChange: vi.fn(), onCursor: vi.fn(), onProblems: vi.fn(), onError: vi.fn() });
function fakeMonaco() {
  let cursor = (_event: { position: { lineNumber: number; column: number } }) => {};
  const dispose = vi.fn();
  const action = { isSupported: vi.fn(() => true), run: vi.fn(() => Promise.resolve()) };
  const validatePosition = monaco.active!.validatePosition;
  const editor = { getAction: vi.fn(() => action), focus: vi.fn(), getModel: vi.fn(() => monaco.active),
    setPosition: vi.fn(), revealPositionInCenter: vi.fn(), onDidChangeCursorPosition: vi.fn((callback: typeof cursor) => { cursor = callback; return { dispose }; }) };
  act(() => monaco.props!.onMount!(editor as unknown as Parameters<OnMount>[0], {} as Parameters<OnMount>[1]));
  return { editor, action, validatePosition, dispose, move: (lineNumber: number, column: number) => cursor({ position: { lineNumber, column } }) };
}
beforeEach(() => { localStorage.clear(); monaco.props = undefined; monaco.models.clear(); monaco.active = undefined; monaco.previousValue = undefined; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('code editor', () => {
  it('reconciles cached model text on path changes and disposes a closed inactive model before reopening', () => {
    const handlers = props(), a = { ...buffer, path: 'a.ts', content: 'saved', savedContent: 'saved' }, b = { ...a, path: 'b.ts' };
    const openPaths = ['a.ts', 'b.ts'];
    const { rerender } = render(<CodeEditor {...handlers} buffer={a} openPaths={openPaths}/>);
    fakeMonaco();
    const oldA = monaco.active!;
    act(() => oldA.setValue('dirty'));
    rerender(<CodeEditor {...handlers} buffer={{ ...a, content: 'dirty' }} openPaths={openPaths}/>);
    rerender(<CodeEditor {...handlers} buffer={b} openPaths={openPaths}/>);
    expect(oldA.getValue()).toBe('dirty'); expect(oldA.dispose).not.toHaveBeenCalled();
    // Both successive buffers have the same controlled value. Only a path reconciliation fixes A.
    rerender(<CodeEditor {...handlers} buffer={a} openPaths={openPaths}/>);
    expect(monaco.active).toBe(oldA); expect(monaco.active!.getValue()).toBe('saved');
    act(() => oldA.setValue('dirty again'));
    rerender(<CodeEditor {...handlers} buffer={{ ...a, content: 'dirty again' }} openPaths={openPaths}/>);
    rerender(<CodeEditor {...handlers} buffer={b} openPaths={openPaths}/>);
    const modelB = monaco.active!;
    rerender(<CodeEditor {...handlers} buffer={b} openPaths={['b.ts']}/>);
    expect(oldA.dispose).toHaveBeenCalledOnce(); expect(modelB.dispose).not.toHaveBeenCalled();
    rerender(<CodeEditor {...handlers} buffer={a} openPaths={openPaths}/>);
    expect(monaco.active).not.toBe(oldA); expect(monaco.active!.getValue()).toBe('saved');
  });
  it('routes toolbar and imperative commands to supported Monaco actions and reports unsupported or failed actions', async () => {
    const handlers = props(), ref = createRef<CodeEditorHandle>();
    render(<CodeEditor {...handlers} ref={ref}/>);
    const { editor, action } = fakeMonaco();
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(editor.getAction).toHaveBeenLastCalledWith('actions.find');
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(editor.getAction).toHaveBeenLastCalledWith('editor.action.startFindReplaceAction');
    fireEvent.click(screen.getByRole('button', { name: 'Go to line' }));
    expect(editor.getAction).toHaveBeenLastCalledWith('editor.action.gotoLine');
    act(() => ref.current!.run('editor.action.commentLine'));
    expect(editor.getAction).toHaveBeenLastCalledWith('editor.action.commentLine');
    expect(action.run).toHaveBeenCalledTimes(4);
    action.isSupported.mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Format' }));
    expect(action.run).toHaveBeenCalledTimes(4);
    expect(handlers.onError).toHaveBeenLastCalledWith('This action is not available for the current file type.');
    action.isSupported.mockReturnValue(true); action.run.mockRejectedValueOnce(new Error('Formatter failed'));
    await act(async () => { ref.current!.run('editor.action.formatDocument'); });
    expect(handlers.onError).toHaveBeenLastCalledWith('Formatter failed');
  });
  it('validates and reveals requested locations on mount and subsequent navigation, ignoring other files', () => {
    const handlers = props();
    const { rerender } = render(<CodeEditor {...handlers} location={{ path: buffer.path, line: 99, column: 99, version: 1 }}/>);
    const { editor, validatePosition } = fakeMonaco();
    expect(validatePosition).toHaveBeenCalledWith({ lineNumber: 99, column: 99 });
    expect(editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 3, column: 8 });
    expect(editor.revealPositionInCenter).toHaveBeenLastCalledWith({ lineNumber: 3, column: 8 });
    rerender(<CodeEditor {...handlers} location={{ path: buffer.path, line: -1, column: 0, version: 2 }}/>);
    expect(editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 1, column: 1 });
    rerender(<CodeEditor {...handlers} location={{ path: 'other.ts', line: 2, column: 1, version: 3 }}/>);
    expect(editor.setPosition).toHaveBeenCalledTimes(2);
  });
  it('forwards current cursor, content and diagnostic callbacks and disposes its cursor listener', () => {
    const handlers = props(); const { rerender, unmount } = render(<CodeEditor {...handlers}/>);
    const { move, dispose } = fakeMonaco();
    act(() => move(4, 7)); expect(handlers.onCursor).toHaveBeenCalledWith(4, 7);
    const nextCursor = vi.fn(); rerender(<CodeEditor {...handlers} onCursor={nextCursor}/>);
    act(() => move(5, 2)); expect(nextCursor).toHaveBeenCalledWith(5, 2);
    act(() => monaco.props!.onChange!(undefined, {} as Parameters<NonNullable<EditorProps['onChange']>>[1]));
    expect(handlers.onChange).toHaveBeenCalledWith('');
    const marker = { message: 'Unexpected token', severity: 8, startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 4,
      owner: 'typescript', resource: {} as Parameters<NonNullable<EditorProps['onValidate']>>[0][number]['resource'] };
    act(() => monaco.props!.onValidate!([marker]));
    expect(handlers.onProblems).toHaveBeenCalledWith(buffer.path, [{ message: marker.message, severity: 8, startLineNumber: 2, startColumn: 3 }]);
    act(() => monaco.props!.onValidate!([])); expect(handlers.onProblems).toHaveBeenLastCalledWith(buffer.path, []);
    unmount(); expect(dispose).toHaveBeenCalledOnce();
  });
  it('updates controlled preferences and passes changed settings to Monaco', () => {
    const handlers = props(); const { rerender } = render(<CodeEditor {...handlers}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Word wrap' }));
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ ...defaults, wordWrap: true });
    fireEvent.click(screen.getByRole('button', { name: 'Editor settings' }));
    fireEvent.change(screen.getByLabelText('Editor font size'), { target: { value: '18' } });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ ...defaults, fontSize: 18 });
    fireEvent.change(screen.getByLabelText('Indent size'), { target: { value: '4' } });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ ...defaults, tabSize: 4 });
    fireEvent.click(screen.getByLabelText('Minimap'));
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ ...defaults, minimap: true });
    rerender(<CodeEditor {...handlers} readOnly settings={{ fontSize: 18, tabSize: 4, minimap: true, wordWrap: true }}/>);
    expect(monaco.props!.options).toMatchObject({ readOnly: true, fontSize: 18, tabSize: 4, wordWrap: 'on', minimap: { enabled: true } });
    fireEvent.keyDown(screen.getByLabelText('Editor font size'), { key: 'Escape' });
    expect(screen.queryByLabelText('Editor font size')).not.toBeInTheDocument();
  });
  it('reads saved preferences with defaults for malformed and out-of-bounds values', () => {
    expect(readEditorSettings()).toEqual(defaults);
    localStorage.setItem('nodal.editor.settings.v1', '{broken'); expect(readEditorSettings()).toEqual(defaults);
    localStorage.setItem('nodal.editor.settings.v1', 'null'); expect(readEditorSettings()).toEqual(defaults);
    localStorage.setItem('nodal.editor.settings.v1', JSON.stringify({ fontSize: 25, tabSize: 3, wordWrap: 'true', minimap: 1 }));
    expect(readEditorSettings()).toEqual(defaults);
    localStorage.setItem('nodal.editor.settings.v1', JSON.stringify({ fontSize: 10, tabSize: 8, wordWrap: true, minimap: true }));
    expect(readEditorSettings()).toEqual({ fontSize: 10, tabSize: 8, wordWrap: true, minimap: true });
    localStorage.setItem('nodal.editor.settings.v1', JSON.stringify({ fontSize: 24, tabSize: 4 }));
    expect(readEditorSettings()).toEqual({ fontSize: 24, tabSize: 4, wordWrap: false, minimap: false });
  });
});
