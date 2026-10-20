import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/persistence/src/index.js';
import { NodalService } from '../packages/runtime/src/service.js';
import { createNode, GraphSchema } from '../packages/shared/src/index.js';
import { git } from '../packages/workspace/src/index.js';
if (!process.argv.includes('--live')) throw new Error('Use --live to authorize a real Codex coding turn and explicit test/integration permissions in a disposable repository. Provider usage may be charged.');
const temp=await mkdtemp(join(tmpdir(),'nodal-live-'));const repo=join(temp,'repo');await mkdir(repo);await cp('examples/buggy-add',repo,{recursive:true});
for(const args of [['init','-b','main'],['add','--','.'],['-c','user.name=Nodal Test','-c','user.email=test@localhost','commit','-m','Failing fixture']]) {const result=await git(repo,args);assert.equal(result.exitCode,0,result.stderr);}
const store=new Store(':memory:');const service=new NodalService(store,join(temp,'data'));
try {
  const project=await service.dispatch('openProject',{path:repo}) as {id:string};
  const agent=createNode('agent','fix');if(agent.kind!=='agent')throw new Error();agent.timeoutMs=120000;agent.config.permission='scoped-edit';agent.config.instructions='Fix the add(a,b) function in add.js so it correctly adds numbers. Modify only add.js. Do not run commands, install dependencies, access the network, or change tests. The downstream command will run node --test. Return a brief summary.';
  const tests=createNode('command','tests');if(tests.kind!=='command')throw new Error();tests.config.command=process.execPath;tests.config.args=['--test'];
  const gate=createNode('quality_gate','gate');if(gate.kind!=='quality_gate')throw new Error();gate.config.predicate.sourceNodeId='tests';gate.config.maxIterations=2;
  const graph=GraphSchema.parse({id:'live-workflow',name:'Live Codex test-fix verification',nodes:[createNode('start','start'),agent,tests,gate,createNode('approval','review'),createNode('end','end')],edges:[{id:'a',source:'start',target:'fix'},{id:'b',source:'fix',target:'tests'},{id:'c',source:'tests',target:'gate'},{id:'loop',source:'gate',target:'fix',sourcePort:'fail',kind:'loop'},{id:'pass',source:'gate',target:'review',sourcePort:'pass'},{id:'end',source:'review',target:'end'}]});
  console.log('LIVE VERIFICATION: one bounded Codex coding workflow in a disposable sample; no real user repository is modified.');
  const run=await service.startRun(project.id,graph);const seen=new Set<string>();const deadline=Date.now()+150000;
  while(Date.now()<deadline) {
    for(const approval of store.approvals(run.id))if(approval.decision==='pending'&&!seen.has(approval.id)){seen.add(approval.id);console.log(`Authorizing declared disposable-fixture scope: ${approval.nodeId}`);await service.dispatch('approve',{runId:run.id,nodeId:approval.nodeId,approved:true});}
    if(['succeeded','failed','cancelled'].includes(store.run(run.id).status))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const result=store.run(run.id);assert.equal(result.status,'succeeded',result.error ?? 'Live workflow did not complete');
  const attempts=store.attempts(run.id);assert.equal((attempts.filter(a=>a.nodeId==='tests').at(-1)?.output as {exitCode:number})?.exitCode,0);
  assert((await readFile(join(repo,'add.js'),'utf8')).includes('a - b'),'Coding must not overwrite main');
  const changes=await service.dispatch('diff',{projectId:project.id,runId:run.id}) as {worktrees:Array<{nodeId:string;head:string;sourceHead:string;diff:string}>};
  const fix=changes.worktrees.filter(tree=>tree.nodeId==='fix').at(-1);assert(fix);assert(fix.diff.includes('add'));
  console.log('Reviewed disposable fixture diff:');console.log(fix.diff);
  const applied=await service.dispatch('applyChanges',{runId:run.id,nodeId:'fix',expectedHead:fix.head,expectedSourceHead:fix.sourceHead,approved:true}) as {merged:boolean};assert(applied.merged);
  const tested=await git(repo,['status','--porcelain']);assert.equal(tested.stdout.trim(),'');
  assert(!(await readFile(join(repo,'add.js'),'utf8')).includes('a - b'));
  console.log('PASS real Codex edit, isolated lineage, actual passing tests, quality verdict, durable human gate, reviewed diff, and explicit local integration.');
} finally {await service.close();store.close();await rm(temp,{recursive:true,force:true});}
