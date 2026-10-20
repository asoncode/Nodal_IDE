import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNode, GraphSchema } from '../packages/shared/src/index.js';
import { Store } from '../packages/persistence/src/index.js';
import { NodalService } from '../packages/runtime/src/service.js';
import { git } from '../packages/workspace/src/index.js';
console.log('DETERMINISTIC TEST FIXTURE: real local commands and tests; no coding provider is called.');
const temp=await mkdtemp(join(tmpdir(),'nodal-quality-loop-'));const repo=join(temp,'repo');await mkdir(repo);await cp('examples/buggy-add',repo,{recursive:true});
for(const args of [['init','-b','main'],['add','--','.'],['-c','user.name=Nodal Fixture','-c','user.email=fixture@localhost','commit','-m','Failing example']]) {const result=await git(repo,args);assert.equal(result.exitCode,0,result.stderr);}
const store=new Store(join(temp,'data','nodal.sqlite'));const service=new NodalService(store,join(temp,'data'));
try {
  const project=await service.dispatch('openProject',{path:repo}) as {id:string};
  const repair=createNode('command','repair');assert.equal(repair.kind,'command');
  if(repair.kind!=='command')throw new Error();
  repair.label='Deterministic repair fixture';repair.config.command=process.execPath;repair.config.args=['-e',`const fs=require('node:fs');const count=Number(fs.existsSync('fixture-count.txt')?fs.readFileSync('fixture-count.txt','utf8'):0)+1;fs.writeFileSync('fixture-count.txt',String(count));if(count>=2)fs.writeFileSync('add.js','export function add(a,b){return a+b;}\\n');console.log('Fixture iteration',count);`];
  const tests=createNode('command','tests');if(tests.kind!=='command')throw new Error();tests.config.command=process.execPath;tests.config.args=['--test'];
  const quality=createNode('quality_gate','quality');if(quality.kind!=='quality_gate')throw new Error();quality.config.predicate.sourceNodeId='tests';quality.config.maxIterations=3;
  const graph=GraphSchema.parse({id:'deterministic-quality-loop',name:'Demo Mode: real test-fix loop',nodes:[createNode('start','start'),repair,tests,quality,createNode('end','end')],edges:[{id:'a',source:'start',target:'repair'},{id:'b',source:'repair',target:'tests'},{id:'c',source:'tests',target:'quality'},{id:'loop',source:'quality',target:'repair',sourcePort:'fail',kind:'loop'},{id:'pass',source:'quality',target:'end',sourcePort:'pass'}]});
  const run=await service.startRun(project.id,graph);const seen=new Set<string>();const deadline=Date.now()+30000;
  while(Date.now()<deadline) {
    for(const approval of store.approvals(run.id)) if(approval.decision==='pending'&&!seen.has(approval.id)){seen.add(approval.id);console.log(`Fixture authorizes ${approval.nodeId} iteration command in disposable repository`);await service.dispatch('approve',{runId:run.id,nodeId:approval.nodeId,approved:true});}
    const state=store.run(run.id);if(['succeeded','failed','cancelled'].includes(state.status))break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  const result=store.run(run.id);assert.equal(result.status,'succeeded',result.error ?? 'Run did not succeed');
  const attempts=store.attempts(run.id).filter(a=>a.nodeId==='tests');assert.deepEqual(attempts.map(a=>a.state),['failed','succeeded']);
  assert.equal((await readFile(join(repo,'add.js'),'utf8')).includes('a - b'),true,'Main repository must stay unchanged');
  assert(store.events(run.id).some(e=>e.kind==='loop.iteration'));
  console.log('PASS real failing tests → bounded retry → actual file fix → passing tests; both attempts and diffs persisted; main repository unchanged.');
} finally {await service.close();store.close();await rm(temp,{recursive:true,force:true});}
