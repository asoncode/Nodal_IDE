// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createRef, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TerminalPanel, { type TerminalPanelHandle } from './TerminalPanel.js';
import { api } from './api.js';
import type { TerminalSession } from '../../../packages/shared/src/terminal.js';

const mocks = vi.hoisted(() => ({ terminals: [] as Array<{ input: (data: string) => void; write: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; options: { disableStdin?: boolean } }> }));
vi.mock('./api.js', () => ({ api: vi.fn() }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; input = (_data: string) => {};
  write = vi.fn((_data: string, callback?: () => void) => callback?.()); reset = vi.fn(); dispose = vi.fn(); clear = vi.fn(); focus = vi.fn();
  constructor() { mocks.terminals.push(this); }
  open = vi.fn(); loadAddon = vi.fn(); onData(callback: (data: string) => void) { this.input = callback; return { dispose: vi.fn() }; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));
const project = { id: 'p', name: 'Project', root: '/tmp/project' };
let serial = 0;
const makeSession = (params: Record<string, unknown>): TerminalSession => ({ id: `terminal-${++serial}`, title: `Shell ${serial}`, projectId: String(params.projectId), ownerId: String(params.ownerId), pid: serial, cwd: project.root, cols: 80, rows: 24, status: 'running' });
const calls = (method: string) => vi.mocked(api).mock.calls.filter(call => call[0] === method);
const newTerminal = async () => { fireEvent.click(screen.getByRole('button', { name: 'New terminal' })); await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(serial)); };
beforeEach(() => {
  serial = 0; mocks.terminals.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.mocked(api).mockImplementation(async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (method === 'createTerminal') return makeSession(params) as T;
    if (method === 'readTerminal') return { data: '', next: params.after, start: 0, truncated: false, status: 'running' } as T;
    return {} as T;
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('project terminal panel', () => {
  it('opens a shell only through an explicit action and clears its active screen', async () => {
    render(<TerminalPanel project={project} visible/>);
    expect(calls('createTerminal')).toHaveLength(0); expect(screen.getByText(project.root)).toBeInTheDocument();
    // The empty state and toolbar offer the same action.
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' })[0]);
    await screen.findByRole('tab', { name: /Shell 1.*Running/ });
    expect(calls('createTerminal')[0][1]).toMatchObject({ projectId: 'p', cols: 80, rows: 24, ownerId: expect.any(String) });
    fireEvent.click(screen.getByRole('button', { name: 'Clear terminal' })); expect(mocks.terminals[0].clear).toHaveBeenCalled();
  });
  it('serializes input and preserves pasted text across request chunk boundaries', async () => {
    render(<TerminalPanel project={project} visible/>);
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' })[0]); await screen.findByRole('tab');
    let finish!: () => void;
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'writeTerminal' && calls('writeTerminal').length === 1 ? new Promise(resolve => { finish = () => resolve({}); }) : implementation(method, params, options));
    act(() => { mocks.terminals[0].input('first'); mocks.terminals[0].input('\r'); });
    await waitFor(() => expect(calls('writeTerminal')).toHaveLength(1));
    const pasted = 'x'.repeat(65535) + '😀é漢'.repeat(10000) + 'last\r';
    act(() => mocks.terminals[0].input(pasted));
    await new Promise(resolve => setTimeout(resolve, 30)); expect(calls('writeTerminal')).toHaveLength(1);
    await act(async () => finish());
    await waitFor(() => expect(calls('writeTerminal')).toHaveLength(4));
    const chunks = calls('writeTerminal').map(call => String(call[1]!.data));
    expect(chunks.join('')).toBe('first\r' + pasted);
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(65536);
      expect(new TextDecoder().decode(new TextEncoder().encode(chunk))).toBe(chunk);
    }
  });
  it('advances the output cursor, resets after a gap, and renews the lease for retained exited output', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    let reads = 0;
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (method, params, options) => method === 'readTerminal' ? ++reads === 1 ? { data: 'hello', start: 0, next: 5, truncated: false, status: 'running' } : { data: 'retained', start: 20, next: 28, truncated: true, status: 'exited', exitCode: 0 } : implementation(method, params, options));
    const count = vi.fn(); render(<TerminalPanel project={project} visible onActiveCount={count}/>);
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' })[0]);
    await screen.findByRole('tab', { name: /Exited \(0\)/ });
    expect(calls('readTerminal')[1][1]).toMatchObject({ after: 5 });
    expect(mocks.terminals[0].reset).toHaveBeenCalledOnce(); expect(mocks.terminals[0].write).toHaveBeenLastCalledWith('[Earlier terminal output was discarded]\r\nretained', expect.any(Function));
    expect(mocks.terminals[0].options.disableStdin).toBe(true); expect(mocks.terminals[0].dispose).not.toHaveBeenCalled(); expect(count).toHaveBeenLastCalledWith(0);
    expect(timers).toHaveBeenCalledWith(expect.any(Function), 5000);
    fireEvent.click(screen.getByRole('button', { name: 'Kill terminal' })); await waitFor(() => expect(screen.queryByRole('tab')).not.toBeInTheDocument());
  });
  it('waits for the renderer before polling again and releases pending output on close', async () => {
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'readTerminal' ? Promise.resolve({ data: 'output', start: 0, next: 6, truncated: false, status: 'running' }) : implementation(method, params, options));
    const ref = createRef<TerminalPanelHandle>();
    render(<TerminalPanel ref={ref} project={project} visible/>);
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' })[0]); await screen.findByRole('tab');
    // Hold the next write callback to simulate a busy xterm renderer.
    let finish!: () => void;
    mocks.terminals[0].write.mockImplementation((_data: string, callback: () => void) => { finish = callback; });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    const reads = calls('readTerminal').length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(calls('readTerminal')).toHaveLength(reads);
    await act(async () => finish());
    await waitFor(() => expect(calls('readTerminal')).toHaveLength(reads + 1));
    await act(async () => ref.current!.closeAll());
    expect(mocks.terminals[0].dispose).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(calls('readTerminal')).toHaveLength(reads + 1);
  });
  it('preserves both emulators and the selected tab while hidden', async () => {
    const view = render(<TerminalPanel project={project} visible/>);
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' })[0]); await screen.findByRole('tab'); await newTerminal();
    fireEvent.click(screen.getByRole('tab', { name: /Shell 1/ }));
    view.rerender(<TerminalPanel project={project} visible={false}/>);
    expect(mocks.terminals.every(terminal => !terminal.dispose.mock.calls.length)).toBe(true);
    view.rerender(<TerminalPanel project={project} visible/>);
    expect(screen.getByRole('tab', { name: /Shell 1/ })).toHaveAttribute('aria-selected', 'true'); expect(mocks.terminals).toHaveLength(2);
  });
  it('keeps an existing terminal when opening another shell fails', async () => {
    render(<TerminalPanel project={project} visible/>); fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' })[0]); await screen.findByRole('tab');
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'createTerminal' ? Promise.reject(new Error('Session limit reached')) : implementation(method, params, options));
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' })); await screen.findByRole('alert');
    expect(screen.getByRole('tab')).toHaveAttribute('aria-selected', 'true'); expect(mocks.terminals[0].dispose).not.toHaveBeenCalled();
  });
  it('replaces an expired owner only after a conclusive create failure', async () => {
    const view = render(<TerminalPanel project={project} visible/>);
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' })[0]); await screen.findByRole('tab');
    const originalScope = calls('createTerminal')[0][1]!;
    const implementation = vi.mocked(api).getMockImplementation()!;
    let expired = true;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'createTerminal' && expired ? Promise.reject(new Error('Terminal owner is closed. Open a new terminal panel.')) : implementation(method, params, options));
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await screen.findByText('Previous terminal sessions expired. Open a new terminal.');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument(); expect(mocks.terminals[0].dispose).toHaveBeenCalledOnce();
    expired = false;
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' })[0]); await screen.findByRole('tab');
    const freshScope = calls('createTerminal').at(-1)![1]!;
    expect(freshScope.ownerId).not.toBe(originalScope.ownerId);
    expect(freshScope.projectId).toBe(originalScope.projectId);
    view.unmount();
    expect(calls('closeTerminals').some(call => call[1]!.ownerId === freshScope.ownerId)).toBe(true);
    expect(mocks.terminals[1].dispose).toHaveBeenCalledOnce();
  });
  it('closes a late create after unmount using the captured owner', async () => {
    let finish!: (value: TerminalSession) => void;
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'createTerminal' ? new Promise(resolve => { finish = resolve; }) : implementation(method, params, options));
    const view = render(<TerminalPanel project={project} visible/>); fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' })[0]);
    const scope = calls('createTerminal')[0][1]!; view.unmount();
    await act(async () => finish(makeSession(scope)));
    expect(calls('closeTerminal')[0][1]).toMatchObject({ projectId: 'p', ownerId: scope.ownerId, terminalId: 'terminal-1' }); expect(mocks.terminals).toHaveLength(0);
  });
  it('awaits pending creates in closeAll and gives StrictMode lifetimes distinct owners', async () => {
    const ref = createRef<TerminalPanelHandle>();
    let finish!: (value: TerminalSession) => void;
    const implementation = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((method, params, options) => method === 'createTerminal' ? new Promise(resolve => { finish = resolve; }) : implementation(method, params, options));
    render(<StrictMode><TerminalPanel ref={ref} project={project} visible/></StrictMode>);
    fireEvent.click(screen.getAllByRole('button', { name: 'New terminal' })[0]);
    const scope = calls('createTerminal')[0][1]!;
    expect(calls('closeTerminals')[0][1]!.ownerId).not.toBe(scope.ownerId);
    let done = false; let closing!: Promise<void>;
    act(() => { closing = ref.current!.closeAll().then(() => { done = true; }); });
    await act(async () => { await Promise.resolve(); }); expect(done).toBe(false);
    expect(calls('closeTerminals').at(-1)![1]).toMatchObject({ ownerId: scope.ownerId });
    await act(async () => { finish(makeSession(scope)); await closing; });
    expect(done).toBe(true); expect(calls('closeTerminal')).toHaveLength(1); expect(mocks.terminals).toHaveLength(0);
  });
});
