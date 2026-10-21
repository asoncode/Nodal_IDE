import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalRuntime } from '../src/terminals.js';
import { Store } from '../../persistence/src/index.js';
import { NodalService } from '../src/service.js';
import type { TerminalRead, TerminalScope, TerminalSession } from '../../shared/src/terminal.js';

let directory: string, runtime: TerminalRuntime;
const owner = { projectId: 'project', ownerId: 'panel' };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await pause(); }
  throw new Error('Terminal did not settle');
}
const scope = (session: TerminalSession): TerminalScope => ({ projectId: session.projectId, ownerId: session.ownerId, terminalId: session.id });
const output = (session: TerminalSession, after = 0) => runtime.read({ ...scope(session), after });
const write = (session: TerminalSession, data: string) => runtime.write({ ...scope(session), data });
async function create(ownerId = owner.ownerId) {
  const session = runtime.create({ ...owner, ownerId, cols: 80, rows: 24 });
  write(session, "set +H; stty -echo; printf '\\nREADY\\n'\r");
  await waitFor(() => /\r?\nREADY\r?\n/.test(output(session).data));
  return session;
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'nodal-terminals-')));
  runtime = new TerminalRuntime(projectId => { if (projectId !== 'project' && projectId !== 'other') throw new Error('Unknown project'); return directory; }, { shell: '/bin/bash', args: ['--noprofile', '--norc', '-i'] });
});
afterEach(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('real host PTY terminals', () => {
  it('runs in the project directory with a TTY, raw ANSI and the local Node on PATH', async () => {
    const session = await create();
    write(session, "pwd; test -t 0 && printf 'IS_TTY\\n'; printf '\\033[31mRED\\033[0m\\n'; node -e 'console.log(\"NODE_WORKS\")'\r");
    await waitFor(() => output(session).data.includes('NODE_WORKS'));
    expect(output(session).data).toContain(directory);
    expect(output(session).data).toContain('IS_TTY');
    expect(output(session).data).toContain('\x1b[31mRED\x1b[0m');
    expect(session).toMatchObject({ cwd: directory, cols: 80, rows: 24, status: 'running' });
  });
  it('resizes the PTY and interrupts a foreground program with Ctrl-C', async () => {
    const session = await create();
    runtime.resize({ ...scope(session), cols: 103, rows: 37 });
    write(session, "stty size; sleep 30\r");
    await waitFor(() => output(session).data.includes('37 103'));
    write(session, '\x03');
    write(session, "printf 'AFTER_INTERRUPT\\n'\r");
    await waitFor(() => output(session).data.includes('AFTER_INTERRUPT'));
    expect(output(session).status).toBe('running');
  });
  it('enforces ownership, input limits, dimensions, offsets and session quotas', async () => {
    const session = await create();
    for (const wrong of [{ ...scope(session), ownerId: 'other' }, { ...scope(session), projectId: 'other' }]) {
      expect(() => runtime.read({ ...wrong, after: 0 })).toThrow('does not belong');
      expect(() => runtime.write({ ...wrong, data: 'echo nope\r' })).toThrow('does not belong');
      expect(() => runtime.resize({ ...wrong, cols: 80, rows: 24 })).toThrow('does not belong');
      await expect(runtime.closeTerminal(wrong)).rejects.toThrow('does not belong');
    }
    expect(() => write(session, 'é'.repeat(40_000))).toThrow('64 KiB');
    expect(() => runtime.resize({ ...scope(session), cols: 501, rows: 24 })).toThrow('dimensions');
    expect(() => output(session, Number.MAX_SAFE_INTEGER)).toThrow('offset');
    for (let index = 1; index < 6; index++) runtime.create({ ...owner, cols: 80, rows: 24 });
    expect(() => runtime.create({ ...owner, cols: 80, rows: 24 })).toThrow('limit');
    for (let index = 0; index < 10; index++) runtime.create({ ...owner, ownerId: `owner-${index}`, cols: 80, rows: 24 });
    expect(() => runtime.create({ ...owner, ownerId: 'extra', cols: 80, rows: 24 })).toThrow('limit');
  });
  it('retains at most 512 KiB with absolute cursors and complete Unicode', async () => {
    const session = await create();
    const previous = output(session).next;
    write(session, `${quote(process.execPath)} -e 'process.stdout.write(String.fromCodePoint(128512).repeat(180000)+"OVERFLOW_DONE")'\r`);
    await waitFor(() => output(session).data.includes('OVERFLOW_DONE'));
    const snapshot = output(session);
    expect(Buffer.byteLength(snapshot.data)).toBeLessThanOrEqual(512 * 1024);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.start).toBeGreaterThan(previous);
    expect(snapshot.next - snapshot.start).toBe(snapshot.data.length);
    expect(snapshot.data).not.toContain('\ufffd');
    expect(snapshot.data.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
    const tail = output(session, snapshot.next);
    expect(tail).toMatchObject({ data: '', start: snapshot.next, next: snapshot.next, truncated: false });
    write(session, "printf 'CURSOR_DONE\\n'\r");
    await waitFor(() => output(session, snapshot.next).data.includes('CURSOR_DONE'));
    expect(output(session, snapshot.next).data).not.toContain('OVERFLOW_DONE');
  });
  it('retains natural exit output until its tab closes', async () => {
    const session = await create();
    write(session, "printf 'FINAL_OUTPUT\\n'; exit 7\r");
    await waitFor(() => output(session).status === 'exited');
    expect(output(session)).toMatchObject({ status: 'exited', exitCode: 7 });
    expect(output(session).data).toContain('FINAL_OUTPUT');
    expect(() => write(session, 'x')).toThrow('exited');
    await runtime.closeTerminal(scope(session));
    expect(() => output(session)).toThrow('does not belong');
  });
  it('closes foreground and background process groups without touching another owner', async () => {
    const session = await create(), other = await create('other-panel');
    write(session, "sleep 30 & printf 'BACKGROUND:%s\\n' $!; /bin/sh -c 'printf \"FOREGROUND:%s\\n\" $$; exec sleep 30'\r");
    await waitFor(() => /FOREGROUND:\d+/.test(output(session).data));
    const data = output(session).data;
    const background = Number(data.match(/BACKGROUND:(\d+)/)![1]);
    const foreground = Number(data.match(/FOREGROUND:(\d+)/)![1]);
    expect(alive(background)).toBe(true); expect(alive(foreground)).toBe(true);
    await runtime.closeTerminals(owner);
    await waitFor(() => !alive(session.pid) && !alive(background) && !alive(foreground));
    write(other, "printf 'OTHER_STILL_WORKS\\n'\r");
    await waitFor(() => output(other).data.includes('OTHER_STILL_WORKS'));
    await runtime.closeTerminals(owner);
    expect(() => runtime.create({ ...owner, cols: 80, rows: 24 })).toThrow('closed');
  });
  it('tombstones cleanup before creation and shuts down every owner', async () => {
    await runtime.closeTerminals(owner);
    expect(() => runtime.create({ ...owner, cols: 80, rows: 24 })).toThrow('closed');
    const a = await create('fresh'), b = await create('another');
    await Promise.all([runtime.close(), runtime.close()]);
    await waitFor(() => !alive(a.pid) && !alive(b.pid));
    expect(() => runtime.create({ ...owner, ownerId: 'after-shutdown', cols: 80, rows: 24 })).toThrow('closed');
  });
  it('expires abandoned owners while polling keeps all owner sessions alive', async () => {
    await runtime.close();
    runtime = new TerminalRuntime(() => directory, { shell: '/bin/bash', args: ['--noprofile', '--norc', '-i'], leaseMs: 100 });
    const abandoned = await create('abandoned'), active = await create('active'), sibling = await create('active');
    for (let index = 0; index < 40; index++) { output(active); await pause(20); }
    await waitFor(() => !alive(abandoned.pid));
    expect(() => output(abandoned)).toThrow('does not belong');
    expect(output(sibling).status).toBe('running');
  });
  it('renews every owner lease after the runtime resumes from machine sleep', async () => {
    const first = await create('first'), second = await create('second');
    const resumedAt = Date.now() + 300_000;
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(resumedAt);
      (runtime as unknown as { sweep(): void }).sweep();
      // The next regular sweep must also preserve shells before any renderer heartbeat arrives.
      clock.mockReturnValue(resumedAt + 5000);
      (runtime as unknown as { sweep(): void }).sweep();
      expect(() => write(first, "printf 'FIRST_AWAKE\\n'\r")).not.toThrow();
      expect(() => write(second, "printf 'SECOND_AWAKE\\n'\r")).not.toThrow();
    } finally { clock.mockRestore(); }
    await waitFor(() => output(first).data.includes('FIRST_AWAKE') && output(second).data.includes('SECOND_AWAKE'));
  });
  it('validates public RPC inputs, resolves project roots and cleans up on service shutdown', async () => {
    const store = new Store(join(directory, 'state.sqlite'));
    const service = new NodalService(store, directory);
    try {
      const project = store.addProject(directory, 'Terminal project');
      const params = { projectId: project.id, ownerId: 'rpc', cols: 80, rows: 24 };
      await expect(service.dispatch('createTerminal', { ...params, shell: '/bin/other' })).rejects.toThrow();
      await expect(service.dispatch('createTerminal', { ...params, cols: 0 })).rejects.toThrow();
      const terminal = await service.dispatch('createTerminal', params) as TerminalSession;
      expect(terminal.cwd).toBe(directory);
      const target = { ...scope(terminal), after: 0 };
      const read = await service.dispatch('readTerminal', target) as TerminalRead;
      expect(read.status).toBe('running');
      await service.close();
      await waitFor(() => !alive(terminal.pid));
    } finally { await service.close(); store.close(); }
  });
});
