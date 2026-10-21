import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { basename, delimiter, dirname } from 'node:path';
import { promisify } from 'node:util';
import { spawn, type IPty, type IDisposable } from 'node-pty';
import type { CreateTerminalInput, TerminalOwner, TerminalRead, TerminalScope, TerminalSession } from '../../shared/src/terminal.js';

const exec = promisify(execFile);
const BUFFER_BYTES = 512 * 1024;
const LEASE_MS = 120_000;
const TOMBSTONE_MS = 300_000;
type Session = { info: TerminalSession; pty: IPty; buffer: string; offset: number; listeners: IDisposable[]; closing?: Promise<void> };
type Owner = { touched: number; sessions: Set<string> };
const ownerKey = (scope: TerminalOwner) => JSON.stringify([scope.projectId, scope.ownerId]);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Ephemeral host shells: output stays in bounded memory and never enters event storage. */
export class TerminalRuntime {
  private sessions = new Map<string, Session>();
  private owners = new Map<string, Owner>();
  private closedOwners = new Map<string, number>();
  private blockedUntil = 0;
  private closed = false;
  private cleanup?: Promise<void>;
  private lastSweep = Date.now();
  private timer: ReturnType<typeof setInterval>;
  constructor(private projectRoot: (projectId: string) => string, private options: { shell?: string; args?: string[]; leaseMs?: number } = {}) {
    this.timer = setInterval(() => this.sweep(), Math.min(5000, options.leaseMs ?? LEASE_MS));
    this.timer.unref();
  }
  private sweep() {
    const now = Date.now(), elapsed = now - this.lastSweep;
    this.lastSweep = now;
    this.pruneTombstones(now);
    // Machine sleep pauses both runtime and renderer. Give the renderer a fresh lease on wake.
    if (elapsed > 15_000) {
      for (const owner of this.owners.values()) owner.touched = now;
      return;
    }
    for (const [key, owner] of this.owners) if (now - owner.touched > (this.options.leaseMs ?? LEASE_MS)) void this.closeOwner(key);
  }
  create(input: CreateTerminalInput): TerminalSession {
    const cwd = this.projectRoot(input.projectId);
    this.dimensions(input.cols, input.rows);
    const key = ownerKey(input);
    this.pruneTombstones(Date.now());
    if (this.closed || this.closedOwners.has(key) || Date.now() < this.blockedUntil) throw new Error('Terminal owner is closed. Open a new terminal panel.');
    const owner = this.owners.get(key) ?? { touched: Date.now(), sessions: new Set<string>() };
    if (owner.sessions.size >= 6 || this.sessions.size >= 16) throw new Error('Terminal session limit reached. Close a terminal first.');
    const shell = this.options.shell ?? (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH ?? ''}`;
    env.TERM = 'xterm-256color';
    const pty = spawn(shell, this.options.args ?? (process.platform === 'win32' ? [] : ['-l']), { name: 'xterm-256color', cwd, cols: input.cols, rows: input.rows, env });
    const info: TerminalSession = { ...input, id: randomUUID(), title: basename(shell), pid: pty.pid, cwd, status: 'running' };
    const session: Session = { info, pty, buffer: '', offset: 0, listeners: [] };
    session.listeners.push(pty.onData(data => this.append(session, data)), pty.onExit(event => { info.status = 'exited'; info.exitCode = event.exitCode; info.signal = event.signal; }));
    this.sessions.set(info.id, session); owner.sessions.add(info.id); owner.touched = Date.now(); this.owners.set(key, owner);
    return { ...info };
  }
  read(input: TerminalScope & { after: number }): TerminalRead {
    const session = this.get(input);
    const next = session.offset + session.buffer.length;
    if (!Number.isSafeInteger(input.after) || input.after < 0 || input.after > next) throw new Error('Invalid terminal output offset.');
    const start = Math.max(input.after, session.offset);
    return { data: session.buffer.slice(start - session.offset), start, next, truncated: input.after < session.offset, status: session.info.status, exitCode: session.info.exitCode, signal: session.info.signal };
  }
  write(input: TerminalScope & { data: string }) {
    const session = this.get(input);
    if (typeof input.data !== 'string' || Buffer.byteLength(input.data) > 64 * 1024) throw new Error('Terminal input exceeds 64 KiB.');
    if (session.info.status !== 'running' || session.closing) throw new Error('Terminal has exited.');
    session.pty.write(input.data);
    return { accepted: true };
  }
  resize(input: TerminalScope & { cols: number; rows: number }) {
    const session = this.get(input);
    this.dimensions(input.cols, input.rows);
    if (session.info.status === 'running' && !session.closing) session.pty.resize(input.cols, input.rows);
    session.info.cols = input.cols; session.info.rows = input.rows;
    return { accepted: true };
  }
  async closeTerminal(input: TerminalScope) {
    const session = this.get(input);
    await this.stop(session);
    return { closed: true };
  }
  async closeTerminals(input: TerminalOwner) {
    this.projectRoot(input.projectId);
    await this.closeOwner(ownerKey(input));
    return { closed: true };
  }
  close(): Promise<void> {
    if (!this.cleanup) {
      this.closed = true; clearInterval(this.timer);
      this.cleanup = Promise.all([...this.sessions.values()].map(session => this.stop(session))).then(() => { this.owners.clear(); this.closedOwners.clear(); });
    }
    return this.cleanup;
  }
  private get(input: TerminalScope): Session {
    this.projectRoot(input.projectId);
    const session = this.sessions.get(input.terminalId);
    if (!session || session.info.projectId !== input.projectId || session.info.ownerId !== input.ownerId) throw new Error('Terminal does not belong to this project and owner.');
    const owner = this.owners.get(ownerKey(input));
    if (owner) owner.touched = Date.now();
    return session;
  }
  private dimensions(cols: number, rows: number) {
    if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 300) throw new Error('Invalid terminal dimensions.');
  }
  private append(session: Session, data: string) {
    session.buffer += data;
    if (Buffer.byteLength(session.buffer) <= BUFFER_BYTES) return;
    let low = 0, high = session.buffer.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (Buffer.byteLength(session.buffer.slice(middle)) > BUFFER_BYTES) low = middle + 1; else high = middle;
    }
    // Never retain half of a UTF-16 surrogate pair at the buffer boundary.
    if (session.buffer.charCodeAt(low) >= 0xdc00 && session.buffer.charCodeAt(low) <= 0xdfff) low++;
    session.buffer = session.buffer.slice(low); session.offset += low;
  }
  private pruneTombstones(now: number) {
    for (const [key, expires] of this.closedOwners) if (expires <= now) this.closedOwners.delete(key);
  }
  private async closeOwner(key: string) {
    this.pruneTombstones(Date.now());
    if (this.closedOwners.size < 4096) this.closedOwners.set(key, Date.now() + TOMBSTONE_MS);
    else this.blockedUntil = Date.now() + TOMBSTONE_MS;
    const owner = this.owners.get(key);
    if (owner) await Promise.all([...owner.sessions].map(id => this.sessions.get(id)).filter((session): session is Session => !!session).map(session => this.stop(session)));
    this.owners.delete(key);
  }
  private stop(session: Session): Promise<void> {
    if (!session.closing) session.closing = this.terminate(session).finally(() => {
      for (const listener of session.listeners) listener.dispose();
      session.buffer = ''; this.sessions.delete(session.info.id);
      const key = ownerKey(session.info), owner = this.owners.get(key);
      owner?.sessions.delete(session.info.id);
      if (!owner?.sessions.size) this.owners.delete(key);
    });
    return session.closing;
  }
  private async terminate(session: Session) {
    if (session.info.status === 'exited') return;
    if (process.platform === 'win32') {
      await exec('taskkill', ['/pid', String(session.info.pid), '/T', '/F'], { timeout: 1000 }).catch(() => {});
      try { session.pty.kill(); } catch { /* Already exited. */ }
      return;
    }
    // Interactive jobs use separate process groups. Capture descendants before the shell exits.
    const descendants = new Set<number>();
    const rows = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { timeout: 500, maxBuffer: 4 * 1024 * 1024 }).then(result => result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))).catch(() => [] as number[][]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of rows) if ((parent === session.info.pid || descendants.has(parent)) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
    }
    const targets = [session.info.pid, ...descendants];
    const groups = new Set(rows.filter(([pid, , group]) => targets.includes(pid) && targets.includes(group)).map(([, , group]) => group));
    const signal = (kind: NodeJS.Signals) => {
      for (const group of groups) { try { process.kill(-group, kind); } catch { /* Already exited. */ } }
      for (const pid of targets) { try { process.kill(pid, kind); } catch { /* Already exited. */ } }
    };
    signal('SIGTERM');
    try { session.pty.kill('SIGTERM'); } catch { /* Already exited. */ }
    await delay(350);
    signal('SIGKILL');
  }
}
