import { RoleSchema, type Role, type VerifiedHandoff } from '../../shared/src/roles.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Graph, ExecutionEvent, NodeAttempt, ApprovalRequest, RunCheckpoint, WorkflowRun, Artifact } from '../../shared/src/index.js';
import type { ChatSession, ChatTurn, ChatEvent } from '../../shared/src/chat.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function redact<T>(value: T): T {
  const secretKeys = /^(?:password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|cookie)$/i;
  const scrub = (item: unknown): unknown => {
    if (typeof item === 'string') return item.replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, '[REDACTED]').replace(/((?:API_KEY|PASSWORD|SECRET|ACCESS_TOKEN|AUTHORIZATION)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, secretKeys.test(key) ? '[REDACTED]' : scrub(child)]));
    return item;
  };
  return scrub(value) as T;
}
const json = (value: unknown) => JSON.stringify(redact(value));
const now = () => new Date().toISOString();
export interface Project { id: string; name: string; root: string; createdAt: string; branch?: string; isGitRepository?: boolean }
export interface Consult { id: string; runId: string; attemptId: string; fromRoleId: string; toRoleId: string; question: string; answer: string; provider: string; createdAt: string }
export interface LedgerSnapshot { id: string; runId: string; attemptId: string; repoSha: string; contentHash: string; text: string; createdAt: string }
export type StoredRun = Partial<WorkflowRun> & { id: string; projectId: string; graph: Graph; status: string; createdAt: string; repositorySha?: string; parentRunId?: string };

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }
  private migrate() {
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, repository_root TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS roles(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(project_id,id));
      CREATE TABLE IF NOT EXISTS handoffs(run_id TEXT NOT NULL REFERENCES runs(id), attempt_id TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(run_id,attempt_id,name));
      CREATE TABLE IF NOT EXISTS graphs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS graph_revisions(id TEXT PRIMARY KEY, graph_id TEXT NOT NULL, content_hash TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), graph_revision_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS node_attempts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt_id TEXT, monotonic_sequence INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(run_id,monotonic_sequence));
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt_id TEXT, kind TEXT NOT NULL, content_hash TEXT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT NOT NULL, decision TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), node_id TEXT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_config(id TEXT PRIMARY KEY, provider TEXT NOT NULL, nonsecret_settings_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_turns(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_events(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), sequence INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE(chat_id,sequence));
      CREATE INDEX IF NOT EXISTS chats_project ON chats(project_id);
      CREATE INDEX IF NOT EXISTS chat_turns_chat ON chat_turns(chat_id);
      CREATE INDEX IF NOT EXISTS events_run_sequence ON events(run_id,monotonic_sequence);
      CREATE INDEX IF NOT EXISTS attempts_run ON node_attempts(run_id,node_id);
      CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id,decision);
      CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id);
      INSERT OR IGNORE INTO migrations VALUES(1,datetime('now'));
      INSERT OR IGNORE INTO migrations VALUES(2,datetime('now'));
      CREATE TABLE IF NOT EXISTS tool_cache(key TEXT PRIMARY KEY, tool TEXT NOT NULL, repo_sha TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repo_index(blob TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(3,datetime('now'));
      CREATE TABLE IF NOT EXISTS consults(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt_id TEXT NOT NULL, from_role_id TEXT NOT NULL, to_role_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger_snapshots(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt_id TEXT NOT NULL, repo_sha TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS consults_run ON consults(run_id);
      INSERT OR IGNORE INTO migrations VALUES(4,datetime('now'));
    `));
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private one<T>(sql: string, ...args: (string | number)[]): T | undefined {
    const row = this.db.prepare(sql).get(...args) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  private many<T>(sql: string, ...args: (string | number)[]): T[] {
    return (this.db.prepare(sql).all(...args) as { json: string }[]).map(row => JSON.parse(row.json) as T);
  }
  projects(): Project[] { return this.many('SELECT json FROM projects ORDER BY rowid DESC'); }
  saveChat<T extends ChatSession>(session: T): T {
    this.db.prepare('INSERT INTO chats VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(session.id, session.projectId, json(session)); return session;
  }
  chat<T extends ChatSession = ChatSession>(id: string): T { const chat = this.one<T>('SELECT json FROM chats WHERE id=?', id); if (!chat) throw new Error('Chat not found'); return chat; }
  chats(projectId: string): ChatSession[] { return this.many('SELECT json FROM chats WHERE project_id=? ORDER BY rowid DESC LIMIT 100', projectId); }
  saveChatTurn(turn: ChatTurn): void { this.db.prepare('INSERT INTO chat_turns VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(turn.id, turn.chatId, json(turn)); }
  chatTurns(chatId: string): ChatTurn[] { return this.many('SELECT json FROM chat_turns WHERE chat_id=? ORDER BY rowid', chatId); }
  chatEvents(chatId: string): ChatEvent[] { return this.many('SELECT json FROM (SELECT rowid,json FROM chat_events WHERE chat_id=? ORDER BY rowid DESC LIMIT 200) ORDER BY rowid', chatId); }
  appendChatEvent(event: Omit<ChatEvent, 'sequence'>): void {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM chat_events WHERE chat_id=?').get(event.chatId) as { sequence: number };
    const stored = { ...event, sequence: row.sequence + 1 };
    this.db.prepare('INSERT INTO chat_events VALUES(?,?,?,?)').run(stored.id, stored.chatId, stored.sequence, json(stored));
    this.db.prepare('DELETE FROM chat_events WHERE chat_id=? AND sequence<=?').run(stored.chatId, stored.sequence - 200);
  }
  recoverChats(): void {
    for (const turn of this.many<ChatTurn>('SELECT json FROM chat_turns')) if (turn.status === 'running') {
      this.saveChatTurn({ ...turn, status: 'interrupted', error: 'Nodal restarted. This message was not repeated. Start a new chat to continue with fresh provider context.', finishedAt: now(), approval: undefined });
      const chat = this.chat<ChatSession & { providerSessionId?: string }>(turn.chatId);
      this.saveChat({ ...chat, providerSessionId: undefined });
    }
  }
  project(id: string): Project { const p = this.one<Project>('SELECT json FROM projects WHERE id=?', id); if (!p) throw new Error('Project not found'); return p; }
  addProject(root: string, name: string, branch?: string, isGitRepository = true): Project {
    const existing = this.one<Project>('SELECT json FROM projects WHERE repository_root=?', root);
    const p: Project = existing ? { ...existing, branch, isGitRepository } : { id: randomUUID(), root, name, branch, isGitRepository, createdAt: now() };
    this.db.prepare('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(p.id, root, json(p)); return p;
  }
  roles(projectId: string): Role[] { this.project(projectId); return this.many('SELECT json FROM roles WHERE project_id=? ORDER BY rowid', projectId); }
  saveRole(projectId: string, input: Role): Role {
    this.project(projectId); const role = RoleSchema.parse(input);
    this.db.prepare('INSERT INTO roles VALUES(?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET json=excluded.json').run(projectId, role.id, json(role)); return role;
  }
  deleteRole(projectId: string, roleId: string): void { this.project(projectId); this.db.prepare('DELETE FROM roles WHERE project_id=? AND id=?').run(projectId, roleId); }
  /** Deterministic tool results, keyed by tool, configuration and commit. */
  toolResult<T>(key: string): T | undefined { return this.one<T>('SELECT json FROM tool_cache WHERE key=?', key); }
  saveToolResult(key: string, tool: string, repoSha: string, output: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO tool_cache VALUES(?,?,?,?,?)').run(key, tool, repoSha, json(output), now());
  }
  /** Content-addressed file index: a Git blob SHA identifies exact file contents. */
  fileIndex<T>(blob: string): T | undefined { return this.one<T>('SELECT json FROM repo_index WHERE blob=?', blob); }
  saveFileIndex(blob: string, index: unknown): void { this.db.prepare('INSERT OR REPLACE INTO repo_index VALUES(?,?,?)').run(blob, json(index), now()); }
  saveConsult(consult: Consult): void { this.db.prepare('INSERT INTO consults VALUES(?,?,?,?,?,?)').run(consult.id, consult.runId, consult.attemptId, consult.fromRoleId, consult.toRoleId, json(consult)); }
  consults(runId: string): Consult[] { this.run(runId); return this.many('SELECT json FROM consults WHERE run_id=? ORDER BY rowid', runId); }
  saveLedger(snapshot: LedgerSnapshot): void { this.db.prepare('INSERT INTO ledger_snapshots VALUES(?,?,?,?,?)').run(snapshot.id, snapshot.runId, snapshot.attemptId, snapshot.repoSha, json(snapshot)); }
  ledgers(runId: string): LedgerSnapshot[] { this.run(runId); return this.many('SELECT json FROM ledger_snapshots WHERE run_id=? ORDER BY rowid', runId); }
  saveHandoff(runId: string, handoff: VerifiedHandoff): void { this.db.prepare('INSERT INTO handoffs VALUES(?,?,?,?) ON CONFLICT(run_id,attempt_id,name) DO UPDATE SET json=excluded.json').run(runId, handoff.attemptId, handoff.name, json(handoff)); }
  handoffs(runId: string): VerifiedHandoff[] { this.run(runId); return this.many('SELECT json FROM handoffs WHERE run_id=? ORDER BY rowid', runId); }
  saveGraph(projectId: string, graph: Graph): Graph {
    const existing = this.one<Graph>('SELECT json FROM graphs WHERE id=? AND project_id=?', graph.id, projectId);
    const owner = this.db.prepare('SELECT project_id FROM graphs WHERE id=?').get(graph.id) as { project_id: string } | undefined;
    if (owner && owner.project_id !== projectId) graph = { ...graph, id: randomUUID() };
    const saved = { ...graph, revision: existing ? existing.revision + 1 : graph.revision };
    this.db.prepare('INSERT INTO graphs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(saved.id, projectId, json(saved));
    this.revision(saved); return saved;
  }
  graphs(projectId: string): Graph[] { return this.many('SELECT json FROM graphs WHERE project_id=? ORDER BY rowid DESC', projectId); }
  revision(graph: Graph): string {
    const content = json(graph); const hash = digest(content);
    this.db.prepare('INSERT OR IGNORE INTO graph_revisions VALUES(?,?,?,?,?)').run(hash, graph.id, hash, content, now()); return hash;
  }
  createRun(run: StoredRun): void {
    this.transaction(() => { const revision = this.revision(run.graph); this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(run.id, run.projectId, revision, run.status, json(run)); });
  }
  run(id: string): StoredRun { const r = this.one<StoredRun>('SELECT json FROM runs WHERE id=?', id); if (!r) throw new Error('Run not found'); return r; }
  runs(projectId: string): StoredRun[] { return this.many('SELECT json FROM runs WHERE project_id=? ORDER BY rowid DESC LIMIT 100', projectId); }
  updateRun(id: string, patch: Partial<StoredRun>): void { const r = { ...this.run(id), ...patch }; this.db.prepare('UPDATE runs SET status=?,json=? WHERE id=?').run(r.status, json(r), id); }
  attempts(runId: string): NodeAttempt[] { return this.many('SELECT json FROM node_attempts WHERE run_id=? ORDER BY rowid', runId); }
  upsertAttempt(attempt: NodeAttempt): void {
    const existing = this.one<NodeAttempt>('SELECT json FROM node_attempts WHERE id=?', attempt.id);
    const merged = { ...existing, ...attempt };
    this.db.prepare('INSERT INTO node_attempts VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,json=excluded.json').run(merged.id, merged.runId, merged.nodeId, merged.state, json(merged));
  }
  approvals(runId: string): ApprovalRequest[] { return this.many('SELECT json FROM approvals WHERE run_id=? ORDER BY rowid', runId); }
  approval(request: ApprovalRequest): void { this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET decision=excluded.decision,json=excluded.json').run(request.id, request.runId, request.nodeId, request.decision, json(request)); }
  checkpoint(checkpoint: RunCheckpoint): void { this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?)').run(checkpoint.id, checkpoint.runId, checkpoint.nodeId ?? null, json(checkpoint)); }
  artifacts(runId: string): Artifact[] { return this.many('SELECT json FROM artifacts WHERE run_id=? ORDER BY rowid', runId); }
  checkpoints(runId: string): RunCheckpoint[] { return this.many('SELECT json FROM checkpoints WHERE run_id=? ORDER BY rowid', runId); }
  events(runId: string, after = 0): ExecutionEvent[] { return this.many('SELECT json FROM events WHERE run_id=? AND monotonic_sequence>? ORDER BY monotonic_sequence LIMIT 1000', runId, after); }
  appendEvent(event: ExecutionEvent): ExecutionEvent {
    return this.transaction(() => {
      // The database owns sequence assignment: runtime permission and engine events share one journal.
      const last = this.db.prepare('SELECT COALESCE(MAX(monotonic_sequence),0) AS sequence FROM events WHERE run_id=?').get(event.runId) as { sequence: number };
      const stored = redact({ ...event, sequence: last.sequence + 1 });
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(stored.eventId, stored.runId, stored.attemptId ?? null, stored.sequence, stored.kind, json(stored.payload), stored.timestamp, json(stored));
      const payload = stored.payload as Record<string, unknown>;
      if (stored.kind === 'node.started' || stored.kind === 'node.completed') {
        if (payload.attempt) this.upsertAttempt(payload.attempt as NodeAttempt);
      }
      if (stored.kind === 'node.completed') {
        const result = payload.result as { artifacts?: Array<{ id: string; kind: string; contentHash?: string }> } | undefined;
        for (const artifact of result?.artifacts ?? []) this.db.prepare('INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?,?)').run(artifact.id, stored.runId, stored.attemptId ?? null, artifact.kind, artifact.contentHash ?? null, json(artifact));
      }
      if (stored.kind === 'node.state' && stored.nodeId) {
        const run = this.run(stored.runId); this.updateRun(run.id, { nodeStates: { ...run.nodeStates, [stored.nodeId]: payload.state as NodeAttempt['state'] } });
      }
      if (stored.kind === 'approval.requested' || stored.kind === 'approval.resolved') this.approval(payload as unknown as ApprovalRequest);
      if (stored.kind === 'run.completed' && payload.run) this.updateRun(stored.runId, payload.run as Partial<StoredRun>);
      if (stored.kind === 'run.status') this.updateRun(stored.runId, { status: payload.status as StoredRun['status'] });
      if (stored.kind === 'run.started') this.updateRun(stored.runId, { status: 'running' });
      return stored;
    });
  }
  recover(): number {
    const unfinished = this.many<StoredRun>("SELECT json FROM runs WHERE status IN ('queued','running','paused','waiting_approval')");
    for (const run of unfinished) {
      this.transaction(() => {
        this.updateRun(run.id, { status: 'interrupted', error: 'Runtime restarted. Review preserved work and explicitly create a new run; side effects are not automatically repeated.' });
        for (const attempt of this.attempts(run.id)) if (['running','ready','waiting_approval'].includes(attempt.state)) this.upsertAttempt({ ...attempt, state: 'interrupted', finishedAt: now() });
      });
      this.appendEvent({ eventId: randomUUID(), runId: run.id, sequence: 1, timestamp: now(), kind: 'run.interrupted', payload: { reason: 'Runtime restarted; no automatic replay of side effects.' } });
    }
    return unfinished.length;
  }
  close(): void { this.db.close(); }
}
