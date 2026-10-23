import { cp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname, delimiter } from 'node:path';
import { preparePty, verifyPty } from './prepare-pty.ts';
const destination = resolve('apps/desktop/src-tauri/sidecar');
await mkdir(destination, { recursive: true });
await cp('dist/runtime/main.js', join(destination, 'main.js'));
await cp(process.execPath, join(destination, process.platform === 'win32' ? 'node.exe' : 'node'));
await chmod(join(destination, process.platform === 'win32' ? 'node.exe' : 'node'), 0o755);
const dependencies: Record<string, string> = {};
for (const name of ['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk', 'zod', 'node-pty', 'ajv']) {
  const installed = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')) as { version: string };
  dependencies[name] = installed.version;
}
await writeFile(join(destination, 'package.json'), JSON.stringify({ name: 'nodal-sidecar', private: true, type: 'module', dependencies }, null, 2));
const install = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: destination, env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }, stdio: 'inherit', shell: false });
if (install.status !== 0) throw new Error('Sidecar dependency installation failed');
await preparePty(destination);
verifyPty(destination, join(destination, process.platform === 'win32' ? 'node.exe' : 'node'));
console.log('Staged local Node runtime, official provider SDKs, and verified native PTY. Build on each target OS/architecture.');
