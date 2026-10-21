import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import type { TerminalRead, TerminalSession } from '../packages/shared/src/terminal.js';
const dir=await mkdtemp(join(tmpdir(),'nodal-bundle-'));
const sidecar=process.env.NODAL_VERIFY_SIDECAR && resolve(process.env.NODAL_VERIFY_SIDECAR);
const node=sidecar ? join(sidecar,process.platform==='win32'?'node.exe':'node') : process.execPath;
const main=sidecar ? join(sidecar,'main.js') : resolve('dist/runtime/main.js');
const child=spawn(node,[main],{cwd:sidecar || process.cwd(),env:{...process.env,NODAL_DATA_DIR:dir,PATH:`${dirname(node)}${delimiter}${process.env.PATH ?? ''}`},stdio:['pipe','pipe','pipe']});
let stderr='';child.stderr.on('data',bytes=>stderr+=String(bytes));
const exit=new Promise<number|null>(resolveExit=>child.once('exit',resolveExit));
const timer=setTimeout(()=>child.kill('SIGTERM'),30000);
try {
  const lines=createInterface({input:child.stdout});
  const line=await new Promise<string>((resolveLine,reject)=>{lines.once('line',resolveLine);child.once('exit',code=>reject(new Error(`Built runtime failed (${code}): ${stderr}`)));child.once('error',reject);});
  const connection=JSON.parse(line) as {url:string;token:string};
  assert.match(connection.url,/^http:\/\/127\.0\.0\.1:\d+$/);assert.equal(connection.token.length,64);
  const response=await fetch(connection.url+'/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${connection.token}`,Origin:'tauri://localhost'},body:JSON.stringify({method:'bootstrap',params:{}})});
  const body=await response.json() as {result?:{projects:unknown[];templates:unknown[]};error?:string};
  assert.equal(response.status,200,body.error ?? 'API status');assert.equal(body.result?.projects.length,0);assert(body.result!.templates.length>=3);
  async function api<T>(method:string,params:Record<string,unknown>):Promise<T> {
    const response=await fetch(connection.url+'/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${connection.token}`,Origin:'tauri://localhost'},body:JSON.stringify({method,params})});
    const result=await response.json() as {result:T;error?:string};
    assert.equal(response.status,200,result.error ?? method);assert(!result.error,result.error ?? method);return result.result;
  }
  const repo=join(dir,'project');await mkdir(repo);
  const git=spawnSync('git',['init','-b','main'],{cwd:repo,encoding:'utf8'});assert.equal(git.status,0,git.stderr);
  const project=await api<{id:string}>('openProject',{path:repo});
  const owner={projectId:project.id,ownerId:randomUUID()};
  const terminal=await api<TerminalSession>('createTerminal',{...owner,cols:80,rows:24});
  const scope={...owner,terminalId:terminal.id};
  await api('resizeTerminal',{...scope,cols:100,rows:30});
  const command=process.platform==='win32' ? `node -p "['NODAL','BUNDLE','SHELL','OK'].join('_')"\r` : `unset HISTFILE; node -p "['NODAL','BUNDLE','SHELL','OK'].join('_')"\r`;
  await api('writeTerminal',{...scope,data:command});
  let output='',after=0;
  const deadline=Date.now()+10000;
  while(!output.includes('NODAL_BUNDLE_SHELL_OK') && Date.now()<deadline) {
    const read=await api<TerminalRead>('readTerminal',{...scope,after});output+=read.data;after=read.next;
    if(!output.includes('NODAL_BUNDLE_SHELL_OK'))await new Promise(resolveWait=>setTimeout(resolveWait,50));
  }
  assert(output.includes('NODAL_BUNDLE_SHELL_OK'),'Built terminal never returned command output');
  await api('closeTerminals',owner);
  child.stdin.end();assert.equal(await exit,0,stderr);
  console.log('PASS built runtime imports, SQLite migration, private launch handshake, desktop-origin API, templates, real PTY command/resize/cleanup, and graceful shutdown');
} finally {clearTimeout(timer);if(child.exitCode===null) {child.stdin.end();await exit;}await rm(dir,{recursive:true,force:true});}
