import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/persistence/src/index.js';
import { NodalService } from '../packages/runtime/src/service.js';
import { createCommandGraph } from '../packages/core/src/templates.js';
import { validateGraph } from '../packages/core/src/validation.js';
import { git } from '../packages/workspace/src/index.js';
import type { Graph } from '../packages/shared/src/index.js';
if (!process.argv.includes('--live')) throw new Error('Use --live to authorize a real Claude graph-planning request, which may consume provider usage.');
const temp=await mkdtemp(join(tmpdir(),'nodal-plan-'));const store=new Store(':memory:');const service=new NodalService(store,join(temp,'data'));
try {
  await writeFile(join(temp,'README.md'),'Graph generation verification fixture.\n');
  for(const args of [['init','-b','main'],['add','--','README.md'],['-c','user.name=Nodal Test','-c','user.email=test@localhost','commit','-m','Fixture']]) {const result=await git(temp,args);assert.equal(result.exitCode,0,result.stderr);}
  const project=await service.dispatch('openProject',{path:temp}) as {id:string};
  console.log('Starting explicitly authorized tool-free Claude planning request. Provider usage may be charged.');
  const preview=await service.dispatch('generateGraph',{projectId:project.id,graph:createCommandGraph(),provider:'claude',prompt:'Preserve the Start, Node version command, and End nodes. Add a Human Approval node between the command and End. Keep a simple acyclic graph; no agents, no other commands, no tools.'}) as {graph:Graph;summary:string};
  assert(validateGraph(preview.graph).valid);assert(preview.graph.nodes.some(node=>node.kind==='approval'));
  assert.equal(store.graphs(project.id).length,0,'Generation must not apply the proposed graph');assert.equal(store.runs(project.id).length,0,'Generation must not execute the graph');
  console.log('PASS live schema-constrained graph preview, connectivity validation, and no apply/execution before confirmation.');
} finally {await service.close();store.close();await rm(temp,{recursive:true,force:true});}
