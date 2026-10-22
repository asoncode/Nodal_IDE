import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, lstat, mkdir, mkdtemp, readFile as readDisk, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFolder, duplicateFile, hashContent, listTrash, readFile, renameFile, restoreTrash, searchWorkspace, trashFile, workspaceEntries } from '../src/index.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'nodal-explorer-')); roots.push(root);
  const repo = path.join(root, 'repo'), data = path.join(root, 'data'); await mkdir(repo);
  await writeFile(path.join(repo, 'hello.txt'), 'Hello world\nhello helloWorld hello_world\nhello.\n');
  return { root, repo, data, hash: (await readFile(repo, 'hello.txt')).hash };
}

describe('Explorer file operations', () => {
  it('lists empty folders, excludes links/build metadata, and bounds visited entries', async () => {
    const { root, repo } = await fixture();
    expect(await createFolder(repo, 'empty')).toEqual({ path: 'empty', kind: 'directory' });
    await createFolder(repo, 'empty/nested');
    await mkdir(path.join(repo, '.git')); await writeFile(path.join(repo, '.git', 'config'), 'hidden');
    await symlink(root, path.join(repo, 'linked')); await link(path.join(repo, 'hello.txt'), path.join(root, 'hard.txt'));
    expect((await workspaceEntries(repo)).entries).toEqual([{ path: 'empty', kind: 'directory' }, { path: 'empty/nested', kind: 'directory' }]);
    expect((await workspaceEntries(repo, 1)).truncated).toBe(true);
    await expect(createFolder(repo, 'empty')).rejects.toThrow('already exists');
    await expect(createFolder(repo, 'missing/child')).rejects.toThrow('parent folder');
    for (const candidate of ['../outside', '.git/child', 'linked/child', '']) await expect(createFolder(repo, candidate)).rejects.toThrow();
  });
  it('duplicates and renames text without overwriting concurrent destinations', async () => {
    const { repo, hash } = await fixture();
    await chmod(path.join(repo, 'hello.txt'), 0o751);
    const copy = await duplicateFile(repo, 'hello.txt', 'copy.txt', hash);
    expect((await lstat(path.join(repo, 'copy.txt'))).mode & 0o777).toBe(0o751);
    expect(copy).toEqual({ ...(await readFile(repo, 'hello.txt')), path: 'copy.txt' });
    expect((await lstat(path.join(repo, 'copy.txt'))).nlink).toBe(1);
    await expect(renameFile(repo, 'hello.txt', 'copy.txt', hash)).rejects.toThrow('already exists');
    await expect(duplicateFile(repo, 'hello.txt', 'copy.txt', hash)).rejects.toThrow('already exists');
    const renamed = await renameFile(repo, 'hello.txt', 'renamed.txt', hash);
    expect(renamed.hash).toBe(hash); expect((await lstat(path.join(repo, 'renamed.txt'))).nlink).toBe(1);
    await expect(readDisk(path.join(repo, 'hello.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const outcomes = await Promise.allSettled([duplicateFile(repo, 'copy.txt', 'race.txt', hash), duplicateFile(repo, 'renamed.txt', 'race.txt', hash)]);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect((await readFile(repo, 'race.txt')).hash).toBe(hash);
  });
  it.each(['removed', 'replaced'])('preserves the only original copy if the source is %s during rename', async change => {
    const { repo, hash } = await fixture();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(link).mockImplementationOnce(async (source, destination) => {
      await actual.link(source, destination);
      await unlink(source);
      if (change === 'replaced') await writeFile(source, 'external replacement');
    });
    await expect(renameFile(repo, 'hello.txt', 'recovery.txt', hash)).rejects.toThrow('preserved for recovery');
    expect((await readFile(repo, 'recovery.txt')).hash).toBe(hash);
    expect((await lstat(path.join(repo, 'recovery.txt'))).nlink).toBe(1);
    if (change === 'replaced') expect(await readDisk(path.join(repo, 'hello.txt'), 'utf8')).toBe('external replacement');
    else await expect(readDisk(path.join(repo, 'hello.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('guards every source mutation with the disk hash and rejects folders, links and unsafe destinations', async () => {
    const { root, repo, data, hash } = await fixture();
    await writeFile(path.join(repo, 'hello.txt'), 'external change');
    for (const operation of [() => renameFile(repo, 'hello.txt', 'new.txt', hash), () => duplicateFile(repo, 'hello.txt', 'new.txt', hash), () => trashFile(repo, data, 'project', 'hello.txt', hash)]) await expect(operation()).rejects.toThrow('changed on disk');
    expect(await readDisk(path.join(repo, 'hello.txt'), 'utf8')).toBe('external change');
    await mkdir(path.join(repo, 'folder'));
    await expect(renameFile(repo, 'folder', 'new-folder', hash)).rejects.toThrow('Folder rename');
    await expect(trashFile(repo, data, 'project', 'folder', hash)).rejects.toThrow('Folder rename');
    const fresh = (await readFile(repo, 'hello.txt')).hash;
    await symlink(root, path.join(repo, 'linked'));
    for (const destination of ['../escape', '.git/escape', 'linked/escape']) await expect(renameFile(repo, 'hello.txt', destination, fresh)).rejects.toThrow();
    await link(path.join(repo, 'hello.txt'), path.join(root, 'outside'));
    await expect(duplicateFile(repo, 'hello.txt', 'new.txt', fresh)).rejects.toThrow('Linked');
  });
  it('rejects binary and oversized operations without losing the source', async () => {
    const { repo, data } = await fixture();
    for (const [name, bytes] of [['binary', Buffer.from([0, 1, 2])], ['large', Buffer.alloc(2 * 1024 * 1024 + 1, 'a')]] as const) {
      await writeFile(path.join(repo, name), bytes);
      await expect(trashFile(repo, data, 'project', name, hashContent(bytes))).rejects.toThrow();
      expect(await readDisk(path.join(repo, name))).toEqual(bytes);
    }
  });
  it('handles case-only rename explicitly on case-insensitive filesystems', async () => {
    const { repo, hash } = await fixture();
    const insensitive = await lstat(path.join(repo, 'HELLO.txt')).then(() => true, () => false);
    if (insensitive) await expect(renameFile(repo, 'hello.txt', 'HELLO.txt', hash)).rejects.toThrow('Case-only rename');
    else expect((await renameFile(repo, 'hello.txt', 'HELLO.txt', hash)).path).toBe('HELLO.txt');
  });
  it('persists project-scoped trash, restores without overwriting, and removes recovered entries', async () => {
    const { repo, data, hash } = await fixture();
    await chmod(path.join(repo, 'hello.txt'), 0o751);
    const removed = await trashFile(repo, data, 'project', 'hello.txt', hash);
    await expect(readDisk(path.join(repo, 'hello.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await listTrash(repo, data, 'project')).toEqual([{ ...removed, deletedAt: expect.any(String) }]);
    expect(await listTrash(repo, data, 'other-project')).toEqual([]);
    await expect(restoreTrash(repo, data, 'other-project', removed.trashId)).rejects.toThrow();
    await writeFile(path.join(repo, 'hello.txt'), 'replacement');
    await expect(restoreTrash(repo, data, 'project', removed.trashId)).rejects.toThrow('already exists');
    expect(await readDisk(path.join(repo, 'hello.txt'), 'utf8')).toBe('replacement');
    expect(await listTrash(repo, data, 'project')).toHaveLength(1);
    await rm(path.join(repo, 'hello.txt'));
    expect((await restoreTrash(repo, data, 'project', removed.trashId)).hash).toBe(hash);
    expect(await listTrash(repo, data, 'project')).toEqual([]);
    expect((await readFile(repo, 'hello.txt')).hash).toBe(hash);
    expect((await lstat(path.join(repo, 'hello.txt'))).mode & 0o777).toBe(0o751);
    await expect(trashFile(repo, path.join(repo, '.nodal'), 'project', 'hello.txt', hash)).rejects.toThrow('outside');
    expect((await readFile(repo, 'hello.txt')).hash).toBe(hash);
  });
  it('rejects forged metadata, linked trash storage, and path-like trash IDs', async () => {
    const { root, repo, data, hash } = await fixture();
    const removed = await trashFile(repo, data, 'project', 'hello.txt', hash);
    const directory = path.join(data, 'file-trash', hashContent('project'));
    const meta = path.join(directory, `${removed.trashId}.json`);
    const record = JSON.parse(await readDisk(meta, 'utf8'));
    await writeFile(meta, JSON.stringify({ ...record, path: '../escape' }));
    await expect(restoreTrash(repo, data, 'project', removed.trashId)).rejects.toThrow('Invalid trash path');
    expect(await listTrash(repo, data, 'project')).toEqual([]);
    await expect(restoreTrash(repo, data, 'project', '../escape')).rejects.toThrow('identifier');
    expect(await readdir(directory)).toContain(`${removed.trashId}.content`);
    const linkedData = path.join(root, 'linked-data'); await mkdir(linkedData); await symlink(root, path.join(linkedData, 'file-trash'));
    await expect(listTrash(repo, linkedData, 'project')).rejects.toThrow('Linked');
  });
});

describe('bounded literal workspace search', () => {
  it('returns one-based positions, case/word options, and literal punctuation', async () => {
    const { repo } = await fixture();
    expect((await searchWorkspace(repo, 'hello', { wholeWord: true })).matches.map(match => [match.line, match.column])).toEqual([[1, 1], [2, 1], [3, 1]]);
    expect((await searchWorkspace(repo, 'hello', { caseSensitive: true, wholeWord: true })).matches).toHaveLength(2);
    expect((await searchWorkspace(repo, 'hello.')).matches).toEqual([{ path: 'hello.txt', line: 3, column: 1, preview: 'hello.' }]);
    expect((await searchWorkspace(repo, 'hello')).matches).toHaveLength(5);
    await writeFile(path.join(repo, 'unicode'), 'İ hello 𐐀hello hello𐐀 [literal]');
    expect((await searchWorkspace(repo, 'hello', { wholeWord: true })).matches.filter(match => match.path === 'unicode').map(match => match.column)).toEqual([3]);
    expect((await searchWorkspace(repo, '[literal]')).matches).toHaveLength(1);
    for (const query of ['', 'a'.repeat(201), 'hello\nworld']) await expect(searchWorkspace(repo, query)).rejects.toThrow();
  });
  it('excludes credential names, binary files, large files, links, and omitted directories', async () => {
    const { root, repo } = await fixture();
    for (const name of ['.env', '.env.local', 'credentials.json', 'key.pem']) await writeFile(path.join(repo, name), 'unique-needle');
    await writeFile(path.join(repo, 'binary'), Buffer.from('unique-needle\0'));
    await writeFile(path.join(repo, 'large'), 'unique-needle'.repeat(200000));
    await mkdir(path.join(repo, 'node_modules')); await writeFile(path.join(repo, 'node_modules', 'dependency'), 'unique-needle');
    await writeFile(path.join(root, 'outside'), 'unique-needle'); await symlink(path.join(root, 'outside'), path.join(repo, 'linked'));
    await link(path.join(root, 'outside'), path.join(repo, 'hardlinked'));
    expect((await searchWorkspace(repo, 'unique-needle')).matches).toEqual([]);
  });
  it('caps matches and preview length and reports truncation', async () => {
    const { repo } = await fixture();
    await writeFile(path.join(repo, 'many'), `${'a'.repeat(1000)}needle\n`.repeat(300));
    const result = await searchWorkspace(repo, 'needle');
    expect(result.matches).toHaveLength(250); expect(result.truncated).toBe(true);
    expect(result.matches.every(match => match.preview.length <= 206)).toBe(true);
  });
  it('bounds total scanned bytes including binary files', async () => {
    const { repo } = await fixture();
    await rm(path.join(repo, 'hello.txt'));
    for (let index = 0; index < 17; index++) await writeFile(path.join(repo, `${String(index).padStart(2, '0')}.bin`), Buffer.alloc(2 * 1024 * 1024));
    await writeFile(path.join(repo, 'z-last.txt'), 'unique-needle');
    expect(await searchWorkspace(repo, 'unique-needle')).toEqual({ matches: [], truncated: true });
  });
});
