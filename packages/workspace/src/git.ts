import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess, type ProcessResult } from './process.js';

export async function git(repoRoot: string, args: string[], signal?: AbortSignal): Promise<ProcessResult> {
  // A caller's Git environment must not redirect an attempt to a different index or repository.
  const env = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('GIT_')).map(key => [key, undefined]));
  return runProcess({ command: 'git', args: ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], cwd: repoRoot, env, signal, timeoutMs: 30_000 });
}
async function checkedGit(root: string, args: string[], preserveWhitespace = false): Promise<string> {
  const result = await git(root, args);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Git ${args[0]} failed.`);
  if (result.truncated) throw new Error('Git output exceeded the safe capture limit.');
  return preserveWhitespace ? result.stdout : result.stdout.trim();
}
export async function inspectRepository(repoRoot: string) {
  const root = await realpath(repoRoot);
  const topLevel = await checkedGit(root, ['rev-parse', '--show-toplevel']);
  if (await realpath(topLevel) !== root) throw new Error('Choose the repository root directory.');
  const head = await checkedGit(root, ['rev-parse', 'HEAD']);
  const branch = await checkedGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = await checkedGit(root, ['status', '--porcelain=v1']);
  return { root, head, branch, dirty: status.length > 0, status };
}
function validateRef(ref: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(ref) || ref.includes('..')) throw new Error('Invalid Git reference.');
}
export type AttemptWorktree = { path: string; branch: string; sourceCommit: string; repoRoot: string };
export async function createAttemptWorktree(input: {
  repoRoot: string; attemptId: string; baseRef?: string; workspaceRoot?: string;
}): Promise<AttemptWorktree> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.attemptId)) throw new Error('Invalid attempt id.');
  const repo = await inspectRepository(input.repoRoot);
  const base = input.baseRef ?? repo.head;
  validateRef(base);
  const sourceCommit = await checkedGit(repo.root, ['rev-parse', '--verify', `${base}^{commit}`]);
  const managedRoot = path.resolve(input.workspaceRoot ?? path.join(homedir(), '.local', 'share', 'nodal', 'worktrees'));
  await mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const branch = `nodal/${input.attemptId}-${randomUUID().slice(0, 8)}`;
  const worktreePath = path.join(await realpath(managedRoot), branch.replace('/', '-'));
  await checkedGit(repo.root, ['worktree', 'add', '-b', branch, worktreePath, sourceCommit]);
  return { path: worktreePath, branch, sourceCommit, repoRoot: repo.root };
}

export function isSensitivePath(filename: string): boolean {
  return filename.split('/').some((part) =>
    /^\.env(?:\.|$)/i.test(part) || /^(?:credentials(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|\.npmrc|\.pypirc|\.netrc|auth\.json|\.ssh|\.aws)$/i.test(part)
    || /\.(?:pem|key|p12|pfx)$/i.test(part));
}

/** Commit only a task worktree. Refuse credential-like paths, including tracked edits. */
export async function commitAttempt(worktree: AttemptWorktree, message = 'Nodal workflow changes'): Promise<{ head: string; changed: boolean }> {
  const repo = await inspectRepository(worktree.path);
  if (repo.branch !== worktree.branch || !repo.branch.startsWith('nodal/')) throw new Error('Only Nodal attempt branches may be committed automatically.');
  const tracked = await checkedGit(worktree.path, ['diff', 'HEAD', '--name-only', '-z'], true);
  const staged = await checkedGit(worktree.path, ['diff', '--cached', '--name-only', '-z'], true);
  const untracked = await checkedGit(worktree.path, ['ls-files', '--others', '--exclude-standard', '-z'], true);
  const files = [...new Set(`${tracked}\0${staged}\0${untracked}`.split('\0').filter(Boolean))];
  if (files.some(file => file.includes('[REDACTED]'))) throw new Error('Refusing to stage a path changed by credential redaction.');
  const blocked = files.filter(isSensitivePath);
  if (blocked.length) throw new Error(`Refusing to commit possible credentials: ${blocked.join(', ')}`);
  if (!files.length) return { head: repo.head, changed: false };
  for (const file of files) {
    let current = worktree.path;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error(`Refusing to commit linked path: ${file}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; // A deletion is safe to stage.
        throw error;
      }
    }
  }
  await checkedGit(worktree.path, ['add', '--all', '--', ...files]);
  if (!(await checkedGit(worktree.path, ['diff', '--cached', '--name-only']))) return { head: repo.head, changed: false };
  await checkedGit(worktree.path, ['-c', 'user.name=Nodal', '-c', 'user.email=nodal@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
  return { head: await checkedGit(worktree.path, ['rev-parse', 'HEAD']), changed: true };
}

export async function getDiff(repoRoot: string, ref?: string): Promise<string> {
  if (ref) validateRef(ref);
  const args = ref ? ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', ref, '--'] : ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'];
  return checkedGit(repoRoot, args);
}
export async function previewMerge(repoRoot: string, branch: string) {
  validateRef(branch);
  const repo = await inspectRepository(repoRoot);
  const sourceHead = await checkedGit(repoRoot, ['rev-parse', '--verify', `${branch}^{commit}`]);
  return { head: repo.head, sourceHead, branch, dirty: repo.dirty, diff: await getDiff(repoRoot, sourceHead) };
}
export type MergeResult = { merged: boolean; head: string; conflicts: string[]; message?: string };
export async function mergeAttempt(input: {
  repoRoot: string; branch: string; expectedHead: string; expectedSourceHead: string; approved: boolean;
}): Promise<MergeResult> {
  if (input.approved !== true) throw new Error('Merging requires explicit approval after diff review.');
  validateRef(input.branch);
  const preview = await previewMerge(input.repoRoot, input.branch);
  if (preview.dirty) throw new Error('Main workspace has uncommitted changes. Commit or stash them before merging.');
  if (preview.head !== input.expectedHead || preview.sourceHead !== input.expectedSourceHead) throw new Error('Branch changed after preview. Review the updated diff before merging.');
  const result = await git(input.repoRoot, ['-c', 'user.name=Nodal', '-c', 'user.email=nodal@localhost', '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', preview.sourceHead]);
  if (result.exitCode === 0) return { merged: true, head: await checkedGit(input.repoRoot, ['rev-parse', 'HEAD']), conflicts: [] };
  const conflicts = (await checkedGit(input.repoRoot, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
  const mergeState = await git(input.repoRoot, ['rev-parse', '--verify', 'MERGE_HEAD']);
  if (mergeState.exitCode === 0) {
    const abort = await git(input.repoRoot, ['merge', '--abort']);
    if (abort.exitCode !== 0) throw new Error('Merge failed and could not be aborted. Inspect the repository before continuing.');
  }
  return { merged: false, head: preview.head, conflicts, message: result.stderr.trim() || result.stdout.trim() };
}
