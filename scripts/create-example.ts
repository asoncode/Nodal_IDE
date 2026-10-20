import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git } from '../packages/workspace/src/index.js';
const destination = resolve(process.argv[2] ?? '.nodal/example-project');
await mkdir(destination, { recursive: false }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return mkdir(resolve(destination, '..'), {recursive:true}).then(() => mkdir(destination)); throw new Error(`Choose a new directory: ${destination}`); });
await cp('examples/buggy-add', destination, { recursive: true, errorOnExist: false, force: false });
for (const args of [['init', '-b', 'main'], ['add', '--', '.'], ['-c','user.name=Nodal Example','-c','user.email=example@localhost','-c','commit.gpgsign=false','commit','-m','Initial failing example']]) {
  const result = await git(destination,args); if(result.exitCode!==0) throw new Error(result.stderr);
}
console.log(`Open this repository in Nodal: ${destination}\nThe two failing tests are intentional. Use Bug Hunt with authorized providers, or inspect and fix add.js yourself.`);
