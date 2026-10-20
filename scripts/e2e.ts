import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { preview } from 'vite';
import { Store } from '../packages/persistence/src/index.js';
import { NodalService } from '../packages/runtime/src/service.js';
import { startServer } from '../packages/runtime/src/server.js';
import { git } from '../packages/workspace/src/index.js';

// All browser operations go through gstack's persistent Playwright-backed browse CLI.
const candidates = [process.env.NODAL_BROWSE_BIN, join(homedir(),'.agents/skills/gstack/browse/dist/browse'), join(homedir(),'.Codex/skills/gstack/browse/dist/browse')].filter(Boolean) as string[];
let binary = '';
for (const candidate of candidates) { try { await access(candidate); binary = candidate; break; } catch { /* Try next installed skill path. */ } }
if (!binary) throw new Error('Install the gstack browse skill or set NODAL_BROWSE_BIN to its executable. See docs/TESTING.md.');
async function browse(...args: string[]): Promise<string> {
  return new Promise((resolveResult,reject) => {
    const child = spawn(binary,args,{stdio:['ignore','pipe','pipe'],shell:false});
    let output='',error=''; child.stdout.on('data',chunk=>output+=String(chunk)); child.stderr.on('data',chunk=>error+=String(chunk));
    child.on('error',reject); child.on('exit',code=>code===0?resolveResult(output):reject(new Error(`Browser ${args[0]} ${args[0] === "goto" ? "[launch URL]" : args[1] ?? ""} failed: ${error || output}`)));
  });
}
async function eventually(check:()=>Promise<boolean>, message:string, timeout=20000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) { if(await check()) return; await new Promise(r=>setTimeout(r,120)); }
  throw new Error(message);
}
const temp=await mkdtemp(join(tmpdir(),'nodal-ui-'));
const repo=join(temp,'project'), data=join(temp,'data'); await mkdir(repo);
await writeFile(join(repo,'index.js'),'export const answer = 42;\n');
for(const args of [['init','-b','main'],['add','--','.'],['-c','user.name=Nodal Test','-c','user.email=test@localhost','commit','-m','Initial']]) {
  const result=await git(repo,args); assert.equal(result.exitCode,0,result.stderr);
}
const store=new Store(join(data,'nodal.sqlite'));
const service=new NodalService(store,data);
const runtime=await startServer(service,{origins:['http://127.0.0.1:5174']});
const vite=await preview({configFile:'apps/desktop/vite.config.ts',preview:{host:'127.0.0.1',port:5174,strictPort:true}});
try {
  await browse('viewport','1500x960');
  await browse('console','--clear');
  await browse('goto',`http://127.0.0.1:5174/?test=${Date.now()}#token=${runtime.token}&port=${new URL(runtime.url).port}`);
  await eventually(async()=> (await browse('text')).includes('Local runtime connected'),'Runtime bootstrap failed',40000);
  await browse('click','.view-title button[aria-label="Open Folder"]');
  await browse('wait','[role="dialog"]');
  await browse('fill','input[placeholder="/Users/you/projects/my-app"]',repo);
  await eventually(async()=> (await browse('js','document.querySelector(".dialog-actions .primary")?.disabled')).trim() === 'false','Repository submit stayed disabled');
  await browse('click','.dialog-actions .primary');
  await eventually(async()=> (await browse('text')).includes('index.js'),`Repository explorer did not load. Browser: ${await browse('text')}`);
  const project=store.projects()[0]; assert(project);
  console.log('PASS open repository and inspect files');

  await browse('click','button[aria-label="Workflows"]');
  await browse('click','.sidebar-item:has-text("Local command")');
  await browse('click','.react-flow__node[data-id="command"]');
  await browse('fill','label.field:has-text("Name") input','Approved version check');
  await browse('fill','label.field:has-text("Executable") input',process.execPath);
  await browse('click','button[aria-label="Add node"]');
  await browse('click','.palette-options button:has-text("Human approval")');
  await browse('fill','label.field:has-text("Name") input','Review command evidence');
  const ids = JSON.parse(await browse('js','Array.from(document.querySelectorAll(".react-flow__node")).map(node=>node.getAttribute("data-id"))')) as string[];
  const approvalId = ids.find(nodeId => !['start','command','end'].includes(nodeId)); assert(approvalId);
  await browse('click',`.react-flow__node[data-id="${approvalId}"]`);
  await browse('press','ArrowRight');
  // Dispatch the SVG click through React Flow's public DOM handler; straight paths have zero-height click boxes.
  await browse('js',`document.querySelector('.react-flow__edge[data-id="command-end-out"]').dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
  await browse('click','button:has-text("Delete connection")');
  await browse('click','.react-flow__handle.source[data-nodeid="command"]');
  await browse('click',`.react-flow__handle.target[data-nodeid="${approvalId}"]`);
  await browse('click',`.react-flow__handle.source[data-nodeid="${approvalId}"]`);
  await browse('click','.react-flow__handle.target[data-nodeid="end"]');
  await browse('click','.command-actions button[aria-label="Save"]');
  await eventually(async()=>store.graphs(project.id).length===1,'Graph was not persisted');
  assert.equal(store.graphs(project.id)[0].nodes.find(n=>n.id==='command')?.label,'Approved version check');
  assert.equal(store.graphs(project.id)[0].nodes.length,4); assert.equal(store.graphs(project.id)[0].edges.length,3);
  assert((store.graphs(project.id)[0].nodes.find(node=>node.id===approvalId)?.position.x ?? 0)>100);
  console.log('PASS node add, keyboard move, port connections, configuration, and save');

  await browse('click','.run-button');
  await eventually(async()=>store.runs(project.id).length===1,'Run did not start');
  const runId=store.runs(project.id)[0].id;
  await eventually(async()=>store.approvals(runId).some(a=>a.decision==='pending'),'Command permission was not durable');
  await browse('click','.panel-tabs button:has-text("Approvals")');
  await eventually(async()=> (await browse('text')).includes('not an OS sandbox'),'Command trust boundary not visible');
  await browse('click','.approval-item .primary');
  await eventually(async()=>store.approvals(runId).some(a=>a.nodeId===approvalId && a.decision==='pending'),'Human gate did not block durably');
  await eventually(async()=> (await browse('text')).includes('Review the results before continuing'),'Human gate not visible');
  await browse('click','.approval-item .primary');
  await eventually(async()=>store.run(runId).status==='succeeded','Approved command and human gate did not complete');
  await browse('click','.panel-tabs button:has-text("Console")');
  await eventually(async()=> (await browse('text')).includes(process.version),'Real command output not visible');
  assert(store.events(runId).some(e=>e.kind==='command.output'));
  console.log('PASS durable approval, real process, streaming output, persisted run');

  await browse('click','button[aria-label="Explorer"]');
  await browse('click','.file-list button[title="index.js"]');
  await browse('click','.monaco-editor .view-lines');
  await browse('press',process.platform==='darwin'?'Meta+A':'Control+A');
  const edited='export const answer = 43; // saved through Monaco';
  await browse('type',edited);
  await browse('click','.command-actions button[aria-label="Save"]');
  await eventually(async()=> (await readFile(join(repo,'index.js'),'utf8'))===edited,'Monaco save changed or lost typed bytes');
  await browse('click','button[aria-label="Source control"]');
  await eventually(async()=> (await browse('text')).includes('+export const answer = 43'),'Git diff not visible');
  console.log('PASS Monaco edit/save with exact disk bytes and Git diff inspection');

  await browse('click','.editor-tab[data-tab="replay"] button');
  await eventually(async()=> (await browse('text')).includes('run › completed'),'Historical run events not visible');
  assert.equal(store.runs(project.id).length,1,'Replay started an unexpected run');
  await browse('click','.editor-tab[data-tab="graph"] button');
  await browse('click','.command-actions button[aria-label="Save"]');
  const saved=store.graphs(project.id)[0]; assert.equal(saved.nodes.length,4); assert.equal(saved.edges.length,3);
  await mkdir('docs/screenshots',{recursive:true});
  await browse('screenshot',resolve('docs/screenshots/nodal.png'));
  const errors=await browse('console','--errors');
  assert(errors.includes('no console errors'),errors);
  console.log('PASS offline replay, graph round-trip, no browser errors; screenshot docs/screenshots/nodal.png');
} finally {
  await new Promise<void>((resolveClose,reject)=>vite.httpServer.close(error=>error?reject(error):resolveClose())); await runtime.close(); store.close(); await rm(temp,{recursive:true,force:true});
}
