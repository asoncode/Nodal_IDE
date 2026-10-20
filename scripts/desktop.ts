import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { delimiter, resolve } from 'node:path';
// Tauri validates resource paths in debug mode too. Release builds populate this directory.
await mkdir('apps/desktop/src-tauri/sidecar', { recursive: true });
const env = { ...process.env };
try {
  const localCargo = resolve('.nodal/tools/cargo/bin');
  await access(resolve(localCargo, process.platform === 'win32' ? 'cargo.exe' : 'cargo'));
  env.CARGO_HOME = resolve('.nodal/tools/cargo'); env.RUSTUP_HOME = resolve('.nodal/tools/rustup');
  env.PATH = `${localCargo}${delimiter}${env.PATH ?? ''}`;
} catch { /* A clean checkout uses the user's installed Rust toolchain. */ }
const cli = resolve('node_modules/@tauri-apps/cli/tauri.js');
const child = spawn(process.execPath, [cli, process.argv[2] ?? 'dev', ...process.argv.slice(3)], { cwd: resolve('apps/desktop'), env, stdio: 'inherit', shell: false });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
