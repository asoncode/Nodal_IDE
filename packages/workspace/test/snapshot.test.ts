import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { blameFile, diffCommits, git, grepCommit, indexFile, isTestFile, logCommit, resolveCommit, showFile, treeFiles } from '../src/index.js';

let root: string, first: string, second: string;
const commit = async (message: string) => {
  for (const args of [['add', '-A'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', message]]) {
    const result = await git(root, args); if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-snapshot-'));
  await git(root, ['init']);
  await mkdir(join(root, 'src/api'), { recursive: true }); await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'src/api/match.ts'), 'export function simulate(seed: number) {\n  return seed; // TODO(contract)\n}\nexport class Pitch {}\n');
  await writeFile(join(root, 'src/ui.py'), 'import json\n\ndef render():\n    return "TODO"\n');
  await writeFile(join(root, 'tests/match.test.ts'), "import { simulate } from '../src/api/match';\n");
  await writeFile(join(root, '.env'), 'SECRET=hidden TODO');
  first = await commit('first');
  await writeFile(join(root, 'src/api/match.ts'), 'export function simulate(seed: number) {\n  return seed + 1;\n}\n');
  second = await commit('second');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('commit snapshots', () => {
  it('lists, reads, and scopes files at a commit without exposing credential files', async () => {
    expect((await treeFiles(root, first)).map(file => file.path).sort()).toEqual(['src/api/match.ts', 'src/ui.py', 'tests/match.test.ts']);
    expect((await treeFiles(root, first, ['src/api'])).map(file => file.path)).toEqual(['src/api/match.ts']);
    expect((await treeFiles(root, first, ['src/*.py'])).map(file => file.path)).toEqual(['src/ui.py']);
    expect((await showFile(root, first, 'src/api/match.ts')).content).toContain('TODO(contract)');
    expect((await showFile(root, second, 'src/api/match.ts')).content).not.toContain('TODO');
    await expect(showFile(root, first, 'missing.ts')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(showFile(root, first, '.env')).rejects.toThrow('credential');
  });
  it('searches a pinned commit literally, by pattern, and within scopes', async () => {
    const all = await grepCommit(root, first, 'TODO');
    expect(all.files.sort()).toEqual(['src/api/match.ts', 'src/ui.py']);
    expect(all.matches[0]).toMatchObject({ line: expect.any(Number), column: expect.any(Number) });
    expect((await grepCommit(root, first, 'TODO', { scopes: ['src/api'] })).files).toEqual(['src/api/match.ts']);
    expect((await grepCommit(root, first, 'TODO\\(contract\\)', { regex: true })).matches).toHaveLength(1);
    expect((await grepCommit(root, second, 'TODO(contract)')).matches).toEqual([]);
    expect((await grepCommit(root, first, 'todo', { caseSensitive: true })).matches).toEqual([]);
  });
  it('reads history, diffs, and blame for commits and scopes', async () => {
    expect((await logCommit(root, second, ['src/api'], 10)).map(entry => entry.subject)).toEqual(['second', 'first']);
    expect((await logCommit(root, second, ['src/*.py'], 10)).map(entry => entry.subject)).toEqual(['first']);
    const diff = await diffCommits(root, first, second, []);
    expect(diff.files).toEqual([{ status: 'M', path: 'src/api/match.ts' }]); expect(diff.patch).toContain('+  return seed + 1;');
    expect((await blameFile(root, second, 'src/api/match.ts', 10))[1]).toMatchObject({ line: 2, commit: second, text: '  return seed + 1;' });
    expect(await resolveCommit(root, 'HEAD')).toBe(second);
  });
  it('indexes definitions and imports by language heuristics', () => {
    expect(indexFile('a.ts', 'export async function run() {}\nclass Box {}\nexport const value = 1;\nimport x from "./y";').symbols.map(s => s.name)).toEqual(['run', 'Box', 'value']);
    expect(indexFile('a.ts', 'import { a } from "./dep";').imports).toEqual(['./dep']);
    expect(indexFile('a.py', 'from models import Event\ndef play():\n    pass\nclass Team:').symbols.map(s => `${s.kind}:${s.name}`)).toEqual(['def:play', 'class:Team']);
    expect(indexFile('a.rs', 'pub fn simulate() {}\npub struct Pitch;').symbols.map(s => s.name)).toEqual(['simulate', 'Pitch']);
    expect(indexFile('a.go', 'func (m *Match) Play() {}\ntype Team struct {}').symbols.map(s => `${s.kind}:${s.name}`)).toEqual(['function:Play', 'struct:Team']);
    expect(isTestFile('tests/match.test.ts')).toBe(true); expect(isTestFile('src/test_api.py')).toBe(true); expect(isTestFile('src/api/match.ts')).toBe(false);
  });
});
