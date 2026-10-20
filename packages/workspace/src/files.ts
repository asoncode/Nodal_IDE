import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const omitted = new Set(['.git', 'node_modules', '.nodal', 'target', 'dist']);
export const hashContent = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
export class FileConflictError extends Error {
  constructor() { super('File changed on disk. Reload or compare before saving.'); this.name = 'FileConflictError'; }
}

/** Resolve every component without following symlinks, including links inside the root. */
export async function resolveWorkspacePath(root: string, relativePath: string): Promise<string> {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0') || relativePath.includes('\\')) throw new Error('Expected a relative workspace path.');
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '..' || part === '.' || part.toLowerCase() === '.git')) throw new Error('Path traversal or Git metadata access denied.');
  const base = await realpath(root);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error('Linked file access denied.');
  }
  return current;
}

export type FileEntry = { path: string; size: number };
export async function listFiles(root: string, limit = 5000): Promise<FileEntry[]> {
  const base = await realpath(root);
  const files: FileEntry[] = [];
  async function walk(directory: string, prefix: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limit) return;
      if (omitted.has(entry.name) || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = await resolveWorkspacePath(base, relative);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) files.push({ path: relative, size: (await stat(absolute)).size });
    }
  }
  await walk(base, '');
  return files;
}

export async function readFile(root: string, relativePath: string): Promise<{ path: string; content: string; hash: string }> {
  const absolute = await resolveWorkspacePath(root, relativePath);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1 || info.size > MAX_FILE_BYTES) throw new Error('Only unlinked text files up to 2 MiB can be opened.');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Files must be at most 2 MiB.');
    if (bytes.includes(0)) throw new Error('Binary files cannot be opened in the text editor.');
    return { path: relativePath, content: bytes.toString('utf8'), hash: hashContent(bytes) };
  } finally { await handle.close(); }
}

export async function writeFile(root: string, relativePath: string, content: string, expectedHash: string): Promise<{ hash: string }> {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Files must be at most 2 MiB.');
  const absolute = await resolveWorkspacePath(root, relativePath);
  const handle = await open(absolute, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink > 1 || before.size > MAX_FILE_BYTES) throw new Error('Unsupported file.');
    if (hashContent(await handle.readFile()) !== expectedHash) throw new FileConflictError();
    // Revalidate the directory chain and identity before modifying the held descriptor.
    await resolveWorkspacePath(root, relativePath);
    const current = await lstat(absolute);
    const checked = await handle.stat();
    if (current.ino !== before.ino || current.dev !== before.dev || checked.mtimeMs !== before.mtimeMs || checked.size !== before.size) throw new FileConflictError();
    const bytes = Buffer.from(content);
    let written = 0;
    while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, written)).bytesWritten;
    await handle.truncate(bytes.length);
    await handle.sync();
    return { hash: hashContent(bytes) };
  } finally { await handle.close(); }
}
