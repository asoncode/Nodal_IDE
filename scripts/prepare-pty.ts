import { createRequire } from 'node:module';
import { chmod, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Some node-pty prebuilt tarballs ship the POSIX helper without its execute bit.
export async function preparePty(root = process.cwd()) {
  if (process.platform === 'win32') return;
  const require = createRequire(join(resolve(root), 'package.json'));
  const directory = dirname(require.resolve('node-pty/package.json'));
  for (const relative of [`prebuilds/${process.platform}-${process.arch}/spawn-helper`, 'build/Release/spawn-helper', 'build/Debug/spawn-helper']) {
    const file = join(directory, relative);
    try { await stat(file); await chmod(file, 0o755); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function verifyPty(root: string, node = process.execPath) {
  const script = `
    import { spawn } from 'node-pty';
    const marker = 'NODAL_PACKAGED_PTY_OK';
    const p = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo ' + marker], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
      : spawn('/bin/sh', ['-c', 'test -t 0 && printf ' + marker], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
    let output = '';
    p.onData(data => output += data);
    p.onExit(event => { clearTimeout(timer); if (event.exitCode || !output.includes(marker)) { console.error('PTY smoke test failed'); process.exitCode = 1; } });
    p.resize(100, 30);
    const timer = setTimeout(() => { p.kill(); process.exitCode = 1; }, 5000);
  `;
  const result = spawnSync(node, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error(`Bundled PTY failed to start: ${result.error?.message ?? result.stderr}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await preparePty();
