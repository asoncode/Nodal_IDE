import { afterEach, describe, expect, it } from 'vitest';
import { chmod, link, mkdtemp, mkdir, readFile as fsReadFile, writeFile as fsWriteFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runProcess, readFile, writeFile, listFiles, git, inspectRepository, createAttemptWorktree,
  commitAttempt, previewMerge, mergeAttempt,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'nodal-workspace-test-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@localhost']]) {
    expect((await git(repo, args)).exitCode).toBe(0);
  }
  await fsWriteFile(path.join(repo, 'file.txt'), 'original\n');
  await git(repo, ['add', 'file.txt']);
  expect((await git(repo, ['commit', '-m', 'Initial'])).exitCode).toBe(0);
  return { root, repo, workspaceRoot: path.join(root, 'attempts') };
}

describe('safe local files', () => {
  it('edits a file using its read hash and detects external changes', async () => {
    const { repo } = await fixture();
    const initial = await readFile(repo, 'file.txt');
    await writeFile(repo, 'file.txt', 'new\n', initial.hash);
    expect(await fsReadFile(path.join(repo, 'file.txt'), 'utf8')).toBe('new\n');
    await fsWriteFile(path.join(repo, 'file.txt'), 'external\n');
    await expect(writeFile(repo, 'file.txt', 'overwrite\n', initial.hash)).rejects.toThrow('changed on disk');
    expect(await fsReadFile(path.join(repo, 'file.txt'), 'utf8')).toBe('external\n');
  });
  it('rejects traversal, Git internals, and symlink files/directories', async () => {
    const { root, repo } = await fixture();
    await fsWriteFile(path.join(root, 'secret'), 'secret');
    await symlink(path.join(root, 'secret'), path.join(repo, 'linked'));
    await symlink(root, path.join(repo, 'directory-link'));
    for (const candidate of ['../secret', '/etc/passwd', '.git/config', 'linked', 'directory-link/secret']) {
      await expect(readFile(repo, candidate)).rejects.toThrow();
    }
    expect((await listFiles(repo)).map((f) => f.path)).toEqual(['file.txt']);
  });
  it('rejects hard links so an editor write cannot change a file outside the workspace', async () => {
    const { root, repo } = await fixture();
    const initial = await readFile(repo, 'file.txt');
    await link(path.join(repo, 'file.txt'), path.join(root, 'outside.txt'));
    await expect(readFile(repo, 'file.txt')).rejects.toThrow('Linked');
    await expect(writeFile(repo, 'file.txt', 'unsafe', initial.hash)).rejects.toThrow('Linked');
    expect(await fsReadFile(path.join(root, 'outside.txt'), 'utf8')).toBe('original\n');
  });
});

describe('process runner', () => {
  it('streams real output, retains nonzero status, and treats metacharacters literally', async () => {
    const output: string[] = [];
    const result = await runProcess({
      command: process.execPath, cwd: tmpdir(),
      args: ['-e', 'console.log(process.argv[1]); console.error("failure"); process.exitCode=7', '$(touch never); hello'],
      onOutput: (event) => output.push(event.text),
    });
    expect(result.exitCode).toBe(7);
    expect(output.join('')).toContain('$(touch never); hello');
    expect(result.stderr).toContain('failure');
  });
  it('redacts credentials split between chunks and bounds retained logs', async () => {
    const output: string[] = [];
    const result = await runProcess({
      command: process.execPath, cwd: tmpdir(), maxOutputBytes: 1024,
      env: { TEST_API_KEY: 'secret-fixture-123456' },
      args: ['-e', 'process.stdout.write("secret-fixture-");setTimeout(()=>{console.log("123456");for(let i=0;i<2000;i++)console.log("line");},30)'],
      onOutput: (event) => output.push(event.text),
    });
    expect(output.join('')).toContain('[REDACTED]');
    expect(output.join('')).not.toContain('secret-fixture-123456');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
    expect(result.truncated).toBe(true);
  });
  it('times out and force terminates a SIGTERM resistant process', async () => {
    const result = await runProcess({
      command: process.execPath, cwd: tmpdir(), timeoutMs: 150,
      args: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
  it('cancels an active process and does not spawn an already cancelled run', async () => {
    const controller = new AbortController();
    const running = runProcess({ command: process.execPath, cwd: tmpdir(), signal: controller.signal, args: ['-e', 'setInterval(()=>{},1000)'] });
    controller.abort();
    expect((await running).cancelled).toBe(true);
    expect((await runProcess({ command: '/does-not-exist', cwd: tmpdir(), signal: controller.signal })).cancelled).toBe(true);
  });
  it('keeps multibyte logs within the byte cap without broken UTF-8', async () => {
    const result = await runProcess({ command: process.execPath, cwd: tmpdir(), maxOutputBytes: 1024, args: ['-e', 'for(let i=0;i<500;i++) console.log("😀")'] });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
    expect(result.stdout).not.toContain('\uFFFD');
    expect(result.truncated).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('kills descendants even after their group leader exits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nodal-process-tree-'));
    roots.push(root);
    const marker = path.join(root, 'survived');
    const childScript = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'leaked'),1000);setInterval(()=>{},1000)`;
    const result = await runProcess({
      command: process.execPath, cwd: root, timeoutMs: 300,
      args: ['-e', `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setInterval(()=>{},1000)`],
    });
    expect(result.timedOut).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 800));
    await expect(fsReadFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('isolated Git attempts', () => {
  it('isolates parallel agents and lets a descendant inherit a committed attempt', async () => {
    const { repo, workspaceRoot } = await fixture();
    const [first, second] = await Promise.all([
      createAttemptWorktree({ repoRoot: repo, attemptId: 'first', workspaceRoot }),
      createAttemptWorktree({ repoRoot: repo, attemptId: 'second', workspaceRoot }),
    ]);
    await fsWriteFile(path.join(first.path, 'file.txt'), 'first change\n');
    expect(await fsReadFile(path.join(second.path, 'file.txt'), 'utf8')).toBe('original\n');
    expect(await fsReadFile(path.join(repo, 'file.txt'), 'utf8')).toBe('original\n');
    const committed = await commitAttempt(first);
    const descendant = await createAttemptWorktree({ repoRoot: repo, attemptId: 'next', baseRef: committed.head, workspaceRoot });
    expect(await fsReadFile(path.join(descendant.path, 'file.txt'), 'utf8')).toBe('first change\n');
    expect(first.branch).not.toBe(second.branch);
  });
  it('requires reviewed heads and approval, protects dirty main, then merges explicitly', async () => {
    const { repo, workspaceRoot } = await fixture();
    const attempt = await createAttemptWorktree({ repoRoot: repo, attemptId: 'edit', workspaceRoot });
    await fsWriteFile(path.join(attempt.path, 'file.txt'), 'agent change\n');
    await commitAttempt(attempt);
    const preview = await previewMerge(repo, attempt.branch);
    const merge = { repoRoot: repo, branch: attempt.branch, expectedHead: preview.head, expectedSourceHead: preview.sourceHead, approved: true };
    await expect(mergeAttempt({ ...merge, approved: false })).rejects.toThrow('approval');
    await expect(mergeAttempt({ ...merge, expectedSourceHead: 'changed' })).rejects.toThrow('updated diff');
    await fsWriteFile(path.join(repo, 'untracked.txt'), 'user dirty file');
    await expect(mergeAttempt(merge)).rejects.toThrow('uncommitted');
    await rm(path.join(repo, 'untracked.txt'));
    expect((await mergeAttempt(merge)).merged).toBe(true);
    expect(await fsReadFile(path.join(repo, 'file.txt'), 'utf8')).toBe('agent change\n');
  });
  it('reports conflicts and restores main without discarding attempt worktrees', async () => {
    const { repo, workspaceRoot } = await fixture();
    const attempt = await createAttemptWorktree({ repoRoot: repo, attemptId: 'conflict', workspaceRoot });
    await fsWriteFile(path.join(attempt.path, 'file.txt'), 'agent change\n');
    await commitAttempt(attempt);
    await fsWriteFile(path.join(repo, 'file.txt'), 'user change\n');
    await git(repo, ['commit', '-am', 'User change']);
    const preview = await previewMerge(repo, attempt.branch);
    const result = await mergeAttempt({ repoRoot: repo, branch: attempt.branch, expectedHead: preview.head, expectedSourceHead: preview.sourceHead, approved: true });
    expect(result.merged).toBe(false);
    expect(result.conflicts).toContain('file.txt');
    expect((await inspectRepository(repo)).dirty).toBe(false);
    expect(await fsReadFile(path.join(repo, 'file.txt'), 'utf8')).toBe('user change\n');
    expect(await fsReadFile(path.join(attempt.path, 'file.txt'), 'utf8')).toBe('agent change\n');
  });
  it('refuses to include credential files in automatic task commits', async () => {
    const { repo, workspaceRoot } = await fixture();
    const attempt = await createAttemptWorktree({ repoRoot: repo, attemptId: 'secret', workspaceRoot });
    await fsWriteFile(path.join(attempt.path, '.env'), 'SECRET=fixture');
    await expect(commitAttempt(attempt)).rejects.toThrow('credentials');
  });
  it('refuses staged credentials even when the working copy was removed', async () => {
    const { repo, workspaceRoot } = await fixture();
    const attempt = await createAttemptWorktree({ repoRoot: repo, attemptId: 'staged-secret', workspaceRoot });
    await fsWriteFile(path.join(attempt.path, '.env'), 'SECRET=fixture');
    await git(attempt.path, ['add', '.env']);
    await rm(path.join(attempt.path, '.env'));
    await fsWriteFile(path.join(attempt.path, 'file.txt'), 'ordinary edit');
    await expect(commitAttempt(attempt)).rejects.toThrow('credentials');
    expect((await inspectRepository(attempt.path)).head).toBe(attempt.sourceCommit);
  });
  it.each(['symlink', 'hardlink'])('refuses %s paths in automatic commits', async (kind) => {
    const { root, repo, workspaceRoot } = await fixture();
    const attempt = await createAttemptWorktree({ repoRoot: repo, attemptId: kind, workspaceRoot });
    const target = path.join(root, 'outside.txt');
    await fsWriteFile(target, 'private data');
    await (kind === 'symlink' ? symlink : link)(target, path.join(attempt.path, 'innocent.txt'));
    await expect(commitAttempt(attempt)).rejects.toThrow('linked path');
  });
  it('preserves literal filenames and disables repository hooks', async () => {
    const { root, repo, workspaceRoot } = await fixture();
    const attempt = await createAttemptWorktree({ repoRoot: repo, attemptId: 'literal', workspaceRoot });
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    const marker = path.join(root, 'hook-ran');
    await fsWriteFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(hook, 0o755);
    for (const name of [' leading.txt', ':(glob)special.txt']) await fsWriteFile(path.join(attempt.path, name), 'safe');
    expect((await commitAttempt(attempt)).changed).toBe(true);
    expect((await inspectRepository(attempt.path)).dirty).toBe(false);
    await expect(fsReadFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
