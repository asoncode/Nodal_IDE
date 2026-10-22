import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { FileConflictError, hashContent, readFile, resolveWorkspacePath } from './files.js';
import { isSensitivePath } from './git.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const omitted = new Set(['.git', 'node_modules', '.nodal', 'target', 'dist']);
export type WorkspaceEntry = { path: string; kind: 'file' | 'directory'; size?: number };
export async function workspaceEntries(root: string, limit = 5000): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
  const entries: WorkspaceEntry[] = [];
  let visited = 0, truncated = false;
  async function walk(directory: string, prefix: string) {
    for await (const entry of await opendir(directory)) {
      if (++visited > limit) { truncated = true; break; }
      if (omitted.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      try {
        const absolute = await resolveWorkspacePath(root, relative);
        const info = await lstat(absolute);
        if (info.isDirectory()) { entries.push({ path: relative, kind: 'directory' }); await walk(absolute, relative); }
        else if (info.isFile()) entries.push({ path: relative, kind: 'file', size: info.size });
      } catch { /* Concurrently removed, linked, or unreadable entries are unavailable. */ }
      if (truncated) break;
    }
  }
  await walk(await realpath(root), '');
  return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)), truncated };
}

function operationError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EEXIST') throw new Error('A file or folder already exists at this path.');
  if (code === 'ENOENT') throw new Error('File or parent folder no longer exists. Refresh the Explorer.');
  if (code === 'EXDEV') throw new Error('Moving files between filesystems is unsupported. Duplicate the file instead.');
  throw error;
}
export async function createFolder(root: string, relativePath: string): Promise<WorkspaceEntry> {
  if (!relativePath.trim()) throw new Error('Enter a folder name.');
  try { await mkdir(await resolveWorkspacePath(root, relativePath, true)); }
  catch (error) { operationError(error); }
  return { path: relativePath, kind: 'directory' };
}
const sameFile = (a: Stats, b: Stats) => a.ino === b.ino && a.dev === b.dev;
async function bytesFrom(handle: FileHandle): Promise<Buffer> {
  const info = await handle.stat();
  if (!info.isFile()) throw new Error('Folder rename, duplicate, and delete are not supported. Choose a file.');
  if (info.size > MAX_FILE_BYTES) throw new Error('Only text files up to 2 MiB are supported.');
  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
  let count = 0;
  while (count < buffer.length) {
    const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
    if (!bytesRead) break;
    count += bytesRead;
  }
  const bytes = buffer.subarray(0, count);
  if (count > MAX_FILE_BYTES) throw new Error('Only text files up to 2 MiB are supported.');
  if (bytes.includes(0)) throw new Error('Binary files cannot be modified in the text editor.');
  return bytes;
}
async function sourceFile(root: string, relativePath: string, expectedHash: string) {
  const absolute = await resolveWorkspacePath(root, relativePath);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Folder rename, duplicate, and delete are not supported. Choose a file.');
    if (info.nlink > 1) throw new Error('Linked file access denied.');
    const bytes = await bytesFrom(handle);
    if (hashContent(bytes) !== expectedHash) throw new FileConflictError();
    return { absolute, handle, info, bytes };
  } catch (error) { await handle.close(); throw error; }
}
// During rename our exclusive destination link makes nlink=2, so validate parents and endpoints separately.
async function endpoint(root: string, relativePath: string): Promise<string> {
  const parent = path.posix.dirname(relativePath);
  const directory = parent === '.' ? await realpath(root) : await resolveWorkspacePath(root, parent);
  return path.join(directory, path.posix.basename(relativePath));
}
async function revalidate(root: string, relativePath: string, source: Awaited<ReturnType<typeof sourceFile>>, expectedHash: string, links = 1) {
  const absolute = await endpoint(root, relativePath);
  const current = await lstat(absolute);
  const held = await source.handle.stat();
  if (current.isSymbolicLink() || !sameFile(current, source.info) || held.nlink !== links || hashContent(await bytesFrom(source.handle)) !== expectedHash) throw new FileConflictError();
}
async function removeOwned(absolute: string, info: Stats) {
  try { if (sameFile(await lstat(absolute), info)) await unlink(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function exclusiveCopy(absolute: string, bytes: Buffer, mode = 0o600) {
  const handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const info = await handle.stat();
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); return info; }
  catch (error) { await removeOwned(absolute, info); throw error; }
  finally { await handle.close(); }
}
const result = (relativePath: string, bytes: Buffer) => ({ path: relativePath, content: bytes.toString('utf8'), hash: hashContent(bytes) });
export async function renameFile(root: string, relativePath: string, newPath: string, expectedHash: string) {
  if (!newPath.trim()) throw new Error('Enter a file name.');
  const source = await sourceFile(root, relativePath, expectedHash);
  let destination: string | undefined, linked = false;
  try {
    destination = await resolveWorkspacePath(root, newPath, true);
    if (relativePath === newPath) throw new Error('Choose a different file name.');
    const existing = await lstat(destination).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; });
    if (existing && sameFile(existing, source.info)) throw new Error('Case-only rename is unsupported on this filesystem. Choose a different name first.');
    await revalidate(root, relativePath, source, expectedHash);
    await link(source.absolute, destination); linked = true;
    await revalidate(root, relativePath, source, expectedHash, 2);
    const target = await lstat(await endpoint(root, newPath));
    if (target.isSymbolicLink() || !sameFile(target, source.info)) throw new FileConflictError();
    await unlink(source.absolute); linked = false;
    return result(newPath, source.bytes);
  } catch (error) {
    if (linked && destination) {
      const originalStillPresent = await endpoint(root, relativePath).then(absolute => lstat(absolute)).then(info => !info.isSymbolicLink() && sameFile(info, source.info), () => false);
      if (originalStillPresent) await removeOwned(destination, source.info);
      else throw new Error(`File changed during rename. The destination "${newPath}" was preserved for recovery. Refresh the Explorer before continuing.`);
    }
    operationError(error);
  } finally { await source.handle.close(); }
}
export async function duplicateFile(root: string, relativePath: string, newPath: string, expectedHash: string) {
  if (!newPath.trim()) throw new Error('Enter a file name.');
  const source = await sourceFile(root, relativePath, expectedHash);
  let destination: string | undefined, created: Stats | undefined;
  try {
    destination = await resolveWorkspacePath(root, newPath, true);
    await revalidate(root, relativePath, source, expectedHash);
    created = await exclusiveCopy(destination, source.bytes, source.info.mode & 0o777);
    await revalidate(root, relativePath, source, expectedHash);
    return result(newPath, source.bytes);
  } catch (error) {
    if (destination && created) await removeOwned(destination, created);
    operationError(error);
  } finally { await source.handle.close(); }
}

type TrashRecord = { trashId: string; projectId: string; path: string; deletedAt: string; hash: string; mode: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function trashDirectory(root: string, dataDir: string, projectId: string) {
  await mkdir(dataDir, { recursive: true });
  const base = await realpath(dataDir), workspace = await realpath(root);
  const relative = path.relative(workspace, base);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('File trash storage must be outside the workspace.');
  await syncDirectory(path.dirname(base));
  let directory = base;
  for (const component of ['file-trash', hashContent(projectId)]) {
    const next = await resolveWorkspacePath(directory, component, true);
    try { await mkdir(next, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await syncDirectory(directory);
    directory = await resolveWorkspacePath(directory, component);
    if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid file trash storage.');
  }
  return directory;
}
async function trashRecord(directory: string, projectId: string, trashId: string): Promise<TrashRecord> {
  if (!uuid.test(trashId)) throw new Error('Invalid trash identifier.');
  const record: unknown = JSON.parse((await readFile(directory, `${trashId}.json`)).content);
  if (!record || typeof record !== 'object') throw new Error('Invalid trash record.');
  const value = record as TrashRecord;
  if (value.trashId !== trashId || value.projectId !== projectId || typeof value.path !== 'string' || typeof value.deletedAt !== 'string' || !Number.isFinite(Date.parse(value.deletedAt)) || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash) || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777) throw new Error('Invalid trash record.');
  // Validate syntax independently of whether its original parent still exists.
  if (!value.path || path.isAbsolute(value.path) || value.path.includes('\\') || value.path.includes('\0') || value.path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('Invalid trash path.');
  return value;
}
export async function trashFile(root: string, dataDir: string, projectId: string, relativePath: string, expectedHash: string) {
  const source = await sourceFile(root, relativePath, expectedHash);
  try {
    const directory = await trashDirectory(root, dataDir, projectId), trashId = randomUUID();
    const record: TrashRecord = { trashId, projectId, path: relativePath, deletedAt: new Date().toISOString(), hash: expectedHash, mode: source.info.mode & 0o777 };
    const contentPath = await resolveWorkspacePath(directory, `${trashId}.content`, true);
    const copied = await exclusiveCopy(contentPath, source.bytes);
    try { await exclusiveCopy(await resolveWorkspacePath(directory, `${trashId}.json`, true), Buffer.from(JSON.stringify(record))); }
    catch (error) { await removeOwned(contentPath, copied); throw error; }
    await syncDirectory(directory);
    // Both persisted copies exist before removal; failures leave a recoverable backup.
    await revalidate(root, relativePath, source, expectedHash);
    await unlink(source.absolute);
    return { path: relativePath, trashId };
  } finally { await source.handle.close(); }
}
export async function listTrash(root: string, dataDir: string, projectId: string) {
  const directory = await trashDirectory(root, dataDir, projectId);
  const records: { trashId: string; path: string; deletedAt: string }[] = [];
  for await (const entry of await opendir(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const record = await trashRecord(directory, projectId, entry.name.slice(0, -5));
      const content = await readFile(directory, `${record.trashId}.content`);
      if (content.hash === record.hash) records.push({ trashId: record.trashId, path: record.path, deletedAt: record.deletedAt });
    } catch { /* Incomplete or invalid trash entries cannot be restored. */ }
  }
  return records.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}
export async function restoreTrash(root: string, dataDir: string, projectId: string, trashId: string) {
  const directory = await trashDirectory(root, dataDir, projectId);
  const record = await trashRecord(directory, projectId, trashId);
  const source = await sourceFile(directory, `${trashId}.content`, record.hash);
  try {
    const destination = await resolveWorkspacePath(root, record.path, true);
    await revalidate(directory, `${trashId}.content`, source, record.hash);
    await exclusiveCopy(destination, source.bytes, record.mode);
    // The restored file is committed. A cleanup failure must not report that restoration failed.
    try {
      await syncDirectory(path.dirname(destination));
      await unlink(await resolveWorkspacePath(directory, `${trashId}.json`));
      await unlink(await resolveWorkspacePath(directory, `${trashId}.content`));
    } catch { /* Retain any remaining backup; exclusive restoration still prevents overwrites. */ }
    return result(record.path, source.bytes);
  } catch (error) { operationError(error); }
  finally { await source.handle.close(); }
}

export async function searchWorkspace(root: string, query: string, options: { caseSensitive?: boolean; wholeWord?: boolean } = {}) {
  if (!query || query.length > 200 || /[\r\n]/.test(query)) throw new Error('Enter a single-line search query of 1–200 characters.');
  const listed = await workspaceEntries(root);
  const matches: { path: string; line: number; column: number; preview: string }[] = [];
  let scanned = 0, truncated = listed.truncated;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.caseSensitive ? 'gu' : 'giu');
  for (const file of listed.entries) {
    if (file.kind !== 'file' || isSensitivePath(file.path) || (file.size ?? 0) > MAX_FILE_BYTES) continue;
    if (scanned + (file.size ?? 0) > 32 * 1024 * 1024) { truncated = true; break; }
    let content: string | undefined;
    try {
      const handle = await open(await resolveWorkspacePath(root, file.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink > 1 || info.size > MAX_FILE_BYTES) continue;
        const remaining = 32 * 1024 * 1024 - scanned;
        if (info.size > remaining) { truncated = true; break; }
        const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES, remaining));
        let count = 0;
        while (count < buffer.length) {
          const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
          if (!bytesRead) break;
          count += bytesRead;
        }
        scanned += count;
        const bytes = buffer.subarray(0, count);
        if ((await handle.stat()).size > count) { truncated = true; continue; }
        if (!bytes.includes(0)) content = bytes.toString('utf8');
      } finally { await handle.close(); }
    } catch { continue; }
    if (content === undefined) continue;
    for (const [line, text] of content.split(/\r?\n/).entries()) {
      for (const match of text.matchAll(pattern)) {
        const index = match.index;
        const end = index + match[0].length;
        if (options.wholeWord && (/[\p{L}\p{N}_]$/u.test(text.slice(Math.max(0, index - 2), index)) || /^[\p{L}\p{N}_]/u.test(text.slice(end, end + 2)))) continue;
        if (matches.length === 250) return { matches, truncated: true };
        matches.push({ path: file.path, line: line + 1, column: index + 1, preview: text.slice(Math.max(0, index - 100), index + Math.min(query.length, 200) + 100) });
      }
    }
  }
  return { matches, truncated };
}
