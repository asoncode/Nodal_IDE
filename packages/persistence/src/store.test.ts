import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './index.js';
import { GraphSchema } from '../../shared/src/index.js';
const graph = GraphSchema.parse({ id: 'g', name: 'Test', nodes: [{ id: 'start', kind: 'start', label: 'Start' }, { id: 'end', kind: 'end', label: 'End' }], edges: [{ id: 'e', source: 'start', target: 'end' }] });
function setup() { const store = new Store(':memory:'); const p = store.addProject('/tmp/test', 'Test'); store.createRun({ id: 'r', projectId: p.id, graph, status: 'running', createdAt: new Date().toISOString() }); return { store, p }; }
describe('durable journal', () => {
  it('round-trips immutable revisions without changing past runs', () => { const { store, p } = setup(); const saved = store.saveGraph(p.id, graph); store.saveGraph(p.id, { ...saved, name: 'Changed' }); expect(store.graphs(p.id)[0].revision).toBe(2); expect(store.run('r').graph.name).toBe('Test'); store.close(); });
  it('atomically appends monotonic events and materializes node state with redaction', () => { const { store } = setup(); for (let i = 0; i < 2; i++) store.appendEvent({ eventId: `e${i}`, runId: 'r', nodeId: 'start', sequence: 1, timestamp: 'now', kind: 'node.state', payload: { state: 'running', apiKey: 'PRIVATE', text: 'sk-proj-thisisasecret1234567890' } }); const events = store.events('r'); expect(events.map(e => e.sequence)).toEqual([1, 2]); expect(JSON.stringify(events)).not.toContain('PRIVATE'); expect(JSON.stringify(events)).not.toContain('thisisasecret'); expect(store.run('r').nodeStates?.start).toBe('running'); store.close(); });
  it('retains pending approvals and marks unfinished work interrupted', () => { const { store } = setup(); store.upsertAttempt({ id:'a',runId:'r',nodeId:'start',state:'running',iteration:1,attemptIndex:1,startedAt:'now' }); store.approval({id:'approval',runId:'r',nodeId:'start',decision:'pending',requestedAt:'now',message:'Approve?',scope:{}}); expect(store.recover()).toBe(1); expect(store.run('r').status).toBe('interrupted'); expect(store.attempts('r')[0].state).toBe('interrupted'); expect(store.approvals('r')[0].decision).toBe('pending'); expect(store.recover()).toBe(0); store.close(); });
  it('reopens a real SQLite journal and recovers approvals without repeating side effects', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nodal-restart-'));
    const path = join(directory, 'history.sqlite');
    try {
      const first = new Store(path); const project = first.addProject('/tmp/project', 'Recovery');
      first.createRun({ id: 'recover', projectId: project.id, graph, status: 'waiting_approval', createdAt: 'now' });
      first.approval({ id: 'pending', runId: 'recover', nodeId: 'start', decision: 'pending', requestedAt: 'now', message: 'Review side effects', scope: {} });
      first.appendEvent({ eventId: 'persisted', runId: 'recover', sequence: 1, timestamp: 'now', kind: 'node.started', payload: { attempt: { id: 'active', runId: 'recover', nodeId: 'start', state: 'running', iteration: 1, attemptIndex: 1, startedAt: 'now' } } });
      first.close();
      const reopened = new Store(path); expect(reopened.recover()).toBe(1);
      expect(reopened.run('recover').status).toBe('interrupted'); expect(reopened.attempts('recover')[0].state).toBe('interrupted');
      expect(reopened.approvals('recover')[0].decision).toBe('pending'); expect(reopened.events('recover').map(event => event.kind)).toEqual(['node.started', 'run.interrupted']); reopened.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('rolls a failed transaction back', () => { const { store } = setup(); expect(() => store.transaction(() => { store.db.prepare('DELETE FROM approvals').run(); throw new Error('injected'); })).toThrow('injected'); expect(store.run('r')).toBeDefined(); store.close(); });
});
