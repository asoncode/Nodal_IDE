import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'nodal-bundle-'));
const child=spawn(process.execPath,[resolve('dist/runtime/main.js')],{env:{...process.env,NODAL_DATA_DIR:dir},stdio:['pipe','pipe','pipe']});
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
  child.stdin.end();assert.equal(await exit,0,stderr);
  console.log('PASS built runtime imports, SQLite migration, private launch handshake, desktop-origin API, templates, and graceful shutdown');
} finally {clearTimeout(timer);if(child.exitCode===null) {child.stdin.end();await exit;}await rm(dir,{recursive:true,force:true});}
