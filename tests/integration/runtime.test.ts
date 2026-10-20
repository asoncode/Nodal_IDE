import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphSchema, createNode, type Graph } from '../../packages/shared/src/index.js';
import { Store, type StoredRun } from '../../packages/persistence/src/index.js';
import { NodalService } from '../../packages/runtime/src/service.js';
import { startServer } from '../../packages/runtime/src/server.js';
import { git } from '../../packages/workspace/src/index.js';

let root: string, store: Store, service: NodalService, projectId: string;
const waitFor = async <T>(read: () => T, match: (value: T) => boolean, ms = 8000) => { const started = Date.now(); while (Date.now() - started < ms) { const value = read(); if (match(value)) return value; await new Promise(r => setTimeout(r, 15)); } throw new Error('Timed out waiting for runtime state'); };
function graph(command = process.execPath, args = ['-e', 'console.log("real output")']): Graph {
  const n = createNode('command', 'cmd'); if (n.kind !== 'command') throw new Error(); n.config = { ...n.config, command, args };
  return GraphSchema.parse({ id: 'test', name: 'Integration command', nodes: [createNode('start','start'), n, createNode('end','end')], edges: [{id:'a',source:'start',target:'cmd'},{id:'b',source:'cmd',target:'end'}] });
}
async function approve(runId: string, nodeId = 'cmd') { await waitFor(() => store.approvals(runId), values => values.some(v => v.nodeId === nodeId && v.decision === 'pending')); return service.dispatch('approve', {runId,nodeId,approved:true}); }
async function completed(runId: string) { return waitFor(() => store.run(runId), r => ['succeeded','failed','cancelled'].includes(r.status)); }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(),'nodal-runtime-'));
  await writeFile(join(root,'hello.txt'),'original\n');
  for(const args of [['init','-b','main'],['add','--','.'],['-c','user.name=Test','-c','user.email=test@localhost','commit','-m','Initial']]) { const r=await git(root,args); if(r.exitCode!==0) throw new Error(r.stderr); }
  store = new Store(':memory:'); service = new NodalService(store, join(root,'.nodal'));
  const p = await service.dispatch('openProject',{path:root}) as {id:string}; projectId=p.id;
});
afterEach(async () => { await service.close(); store.close(); await rm(root,{recursive:true,force:true}); });
describe('real workflow vertical slice', () => {
  it('edits a local file with optimistic locking and round-trips graph layouts', async () => {
    const original=await service.dispatch('readFile',{projectId,path:'hello.txt'}) as {hash:string};
    await service.dispatch('writeFile',{projectId,path:'hello.txt',expectedHash:original.hash,content:'edited\n'});
    expect(await readFile(join(root,'hello.txt'),'utf8')).toBe('edited\n');
    await expect(service.dispatch('writeFile',{projectId,path:'hello.txt',expectedHash:original.hash,content:'stale'})).rejects.toThrow('changed');
    const g=graph(); g.nodes[1].position={x:431,y:82};
    const saved=await service.dispatch('saveGraph',{projectId,graph:g});
    expect(await service.dispatch('listGraphs',{projectId})).toEqual([saved]);
  });
  it('runs a real approved process, streams and persists status, and creates a new rerun', async () => {
    const run=await service.dispatch('run',{projectId,graph:graph()}) as StoredRun;
    await approve(run.id); expect((await completed(run.id)).status).toBe('succeeded');
    expect(store.events(run.id).some(e=>e.kind==='command.output' && JSON.stringify(e.payload).includes('real output'))).toBe(true);
    const attempt=store.attempts(run.id).find(a=>a.nodeId==='cmd')!;
    expect(attempt.worktreePath).toBeTruthy(); expect(attempt.sourceCommit).toBeTruthy();
    expect(store.checkpoints(run.id).length).toBeGreaterThan(0);
    expect((await service.dispatch('inspectRun',{runId:run.id}) as {run:StoredRun}).run.status).toBe('succeeded');
    const rerun=await service.dispatch('rerun',{runId:run.id,confirmed:true}) as StoredRun;
    expect(rerun.id).not.toBe(run.id); expect(store.run(run.id).status).toBe('succeeded');
    await service.dispatch('cancel',{runId:rerun.id}); await completed(rerun.id);
  });
  it('rejects arbitrary graph cycles before creating a run', async () => {
    const invalid=graph(); invalid.edges.push({id:'cycle',source:'cmd',target:'start',kind:'control'});
    await expect(service.dispatch('run',{projectId,graph:invalid})).rejects.toThrow(); expect(store.runs(projectId)).toHaveLength(0);
  });
  it('stops an active process and prevents later nodes', async () => {
    const run=await service.startRun(projectId,graph(process.execPath,['-e','console.log("started"); setInterval(()=>{},100)']));
    await approve(run.id);
    await waitFor(()=>store.events(run.id),events=>events.some(e=>e.kind==='command.output'));
    await service.dispatch('cancel',{runId:run.id}); expect((await completed(run.id)).status).toBe('cancelled');
    expect(store.attempts(run.id).some(a=>a.nodeId==='end')).toBe(false);
  });
  it('preserves isolated changes until explicit reviewed integration', async () => {
    const run=await service.startRun(projectId,graph(process.execPath,['-e','require("node:fs").writeFileSync("hello.txt","changed by command\\n")']));
    await approve(run.id); expect((await completed(run.id)).status).toBe('succeeded');
    expect(await readFile(join(root,'hello.txt'),'utf8')).toBe('original\n');
    // Runtime data is outside the user working tree in production; ignore test-fixture state here.
    await writeFile(join(root,'.git','info','exclude'),'.nodal/\n');
    const changes=await service.dispatch('diff',{projectId,runId:run.id}) as {worktrees:Array<{head:string;sourceHead:string;diff:string}>};
    expect(changes.worktrees[0].diff).toContain('changed by command');
    const result=await service.dispatch('applyChanges',{runId:run.id,nodeId:'cmd',expectedHead:changes.worktrees[0].head,expectedSourceHead:changes.worktrees[0].sourceHead,approved:true}) as {merged:boolean};
    expect(result.merged).toBe(true); expect(await readFile(join(root,'hello.txt'),'utf8')).toBe('changed by command\n');
  });
  it('keeps HTTP transport local, authenticated, origin-checked, and validated', async () => {
    const server=await startServer(service);
    const request=(token?:string,origin='http://127.0.0.1:5173',body:unknown={method:'runs',params:{projectId}})=>fetch(server.url+'/api',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
    try {
      expect((await request()).status).toBe(401);
      expect((await request('é'.repeat(64))).status).toBe(401);
      expect((await request(server.token,'https://evil.example')).status).toBe(403);
      expect((await request(server.token,undefined,{method:'files',params:{projectId,unexpected:true}})).status).toBe(400);
      expect((await request(server.token)).status).toBe(200);
      expect(server.server.address()).toMatchObject({address:'127.0.0.1'});
    } finally { await server.close(); }
  });
});
