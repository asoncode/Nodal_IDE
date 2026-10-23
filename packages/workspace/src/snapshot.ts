import { git, isSensitivePath } from './git.js';
import { roleOwnsPath } from '../../shared/src/roles.js';

/**
 * Read-only views of a pinned commit. Every function reads Git objects, never a working
 * directory, so results are identical for the same commit and nothing can be modified.
 */
export type TreeFile = { path: string; size: number; blob: string };
const COMMIT = /^[0-9a-f]{40}$/;
const BINARY = /\0/;

function assertCommit(commit: string) {
  if (!COMMIT.test(commit)) throw new Error('Snapshot reads require a full commit SHA.');
}
async function run(root: string, args: string[], maxOutputBytes?: number) {
  const result = await git(root, args, undefined, maxOutputBytes);
  if (result.exitCode !== 0 || result.cancelled || result.timedOut) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  return result;
}
// git() always runs with --literal-pathspecs, so scopes are matched here with the same matcher roles use.
const inScope = (scopes: string[], path: string) => !isSensitivePath(path) && (!scopes.length || roleOwnsPath(scopes, path));
const literal = (scopes: string[]) => scopes.every(scope => !/[*?]/.test(scope));

export async function resolveCommit(root: string, ref: string): Promise<string> {
  const result = await run(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  return result.stdout.trim();
}

export async function treeFiles(root: string, commit: string, scopes: string[] = []): Promise<TreeFile[]> {
  assertCommit(commit);
  const result = await run(root, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], 16 * 1024 * 1024);
  if (result.truncated) throw new Error('The repository tree is too large to list.');
  return result.stdout.split('\0').filter(Boolean).flatMap(line => {
    const tab = line.indexOf('\t');
    const [, type, blob, size] = line.slice(0, tab).split(/\s+/);
    const path = line.slice(tab + 1);
    return type === 'blob' && inScope(scopes, path) ? [{ path, blob: blob!, size: Number(size) || 0 }] : [];
  });
}

export async function showFile(root: string, commit: string, path: string, maxBytes = 1024 * 1024): Promise<{ content: string; truncated: boolean; binary: boolean }> {
  assertCommit(commit);
  if (isSensitivePath(path)) throw new Error(`Refusing to read a possible credential file: ${path}`);
  const result = await git(root, ['show', `${commit}:${path}`], undefined, maxBytes);
  if (result.exitCode !== 0 || result.cancelled || result.timedOut) {
    const error = new Error(`${path} does not exist at ${commit.slice(0, 12)}.`) as NodeJS.ErrnoException;
    error.code = 'ENOENT'; throw error;
  }
  return BINARY.test(result.stdout) ? { content: '', truncated: false, binary: true } : { content: result.stdout, truncated: result.truncated, binary: false };
}

export type GrepMatch = { path: string; line: number; column: number; text: string };
export async function grepCommit(root: string, commit: string, query: string, options: { regex?: boolean; caseSensitive?: boolean; wordRegexp?: boolean; filesOnly?: boolean; scopes?: string[]; maxResults?: number } = {}) {
  assertCommit(commit);
  const args = ['grep', '-z', '-I', '--full-name', options.filesOnly ? '-l' : '-n', ...(options.filesOnly ? [] : ['--column']),
    options.regex ? '-E' : '-F', ...(options.caseSensitive ? [] : ['-i']), ...(options.wordRegexp ? ['-w'] : []), '-e', query, commit, '--', ...(literal(options.scopes ?? []) ? options.scopes ?? [] : [])];
  const result = await git(root, args, undefined, 4 * 1024 * 1024);
  // git grep exits 1 when nothing matches.
  if (result.exitCode === 1 && !result.stdout) return { matches: [] as GrepMatch[], files: [] as string[], truncated: false };
  if (result.exitCode !== 0 || result.cancelled || result.timedOut) throw new Error(`Search failed: ${(result.stderr || 'invalid pattern').trim().slice(0, 300)}`);
  const max = options.maxResults ?? 100;
  const prefix = `${commit}:`;
  if (options.filesOnly) {
    const files = result.stdout.split('\0').map(item => item.trim()).filter(Boolean).map(item => item.startsWith(prefix) ? item.slice(prefix.length) : item).filter(path => inScope(options.scopes ?? [], path));
    return { matches: [] as GrepMatch[], files: files.slice(0, max), truncated: result.truncated || files.length > max };
  }
  const matches: GrepMatch[] = [];
  let truncated = result.truncated;
  for (const record of result.stdout.split('\n')) {
    if (!record) continue;
    const [file, line, column, ...text] = record.split('\0');
    const path = file!.startsWith(prefix) ? file!.slice(prefix.length) : file!;
    if (!inScope(options.scopes ?? [], path)) continue;
    if (matches.length === max) { truncated = true; break; }
    matches.push({ path, line: Number(line), column: Number(column), text: text.join('\0').slice(0, 400) });
  }
  return { matches, files: [...new Set(matches.map(match => match.path))], truncated };
}

export async function logCommit(root: string, commit: string, scopes: string[], max: number) {
  assertCommit(commit);
  type Entry = { commit: string; author: string; date: string; subject: string };
  const parse = (line: string): Entry => { const [sha, author, date, subject] = line.split('\0'); return { commit: sha!, author: author!, date: date!, subject: subject! }; };
  if (literal(scopes)) {
    const result = await run(root, ['log', `--max-count=${max}`, '--format=%H%x00%an%x00%aI%x00%s', '--end-of-options', commit, '--', ...scopes]);
    return result.stdout.split('\n').filter(Boolean).map(parse);
  }
  // Glob scopes: scan a bounded window of history and keep commits that touched a matching file.
  const result = await run(root, ['log', '--max-count=1000', '--name-only', '--format=%x01%H%x00%an%x00%aI%x00%s', '--end-of-options', commit], 16 * 1024 * 1024);
  const entries: Entry[] = [];
  for (const block of result.stdout.split('\x01').filter(Boolean)) {
    const [header, ...files] = block.split('\n');
    if (files.some(file => file && inScope(scopes, file))) entries.push(parse(header!));
    if (entries.length === max) break;
  }
  return entries;
}

export async function diffCommits(root: string, base: string, commit: string, scopes: string[], maxBytes = 64 * 1024) {
  assertCommit(base); assertCommit(commit);
  const names = await run(root, ['diff', '--name-status', '-z', '--no-renames', base, commit]);
  const fields = names.stdout.split('\0').filter(Boolean);
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) if (inScope(scopes, fields[i + 1]!)) files.push({ status: fields[i]!, path: fields[i + 1]! });
  const patch = await git(root, ['diff', '--no-renames', '--no-color', base, commit, '--', ...files.map(file => file.path)], undefined, maxBytes);
  return { base, files, patch: files.length ? patch.stdout : '', truncated: patch.truncated };
}

export async function blameFile(root: string, commit: string, path: string, max: number) {
  assertCommit(commit);
  if (isSensitivePath(path) || /[*?]/.test(path)) throw new Error('Blame needs one literal, non-credential file path.');
  const result = await run(root, ['blame', '--line-porcelain', commit, '--', path], 8 * 1024 * 1024);
  const lines: { line: number; commit: string; author: string; text: string }[] = [];
  let current: { commit?: string; author?: string; line?: number } = {};
  for (const row of result.stdout.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(row);
    if (header) current = { commit: header[1], line: Number(header[2]) };
    else if (row.startsWith('author ')) current.author = row.slice(7);
    else if (row.startsWith('\t')) { lines.push({ line: current.line!, commit: current.commit!, author: current.author ?? '', text: row.slice(1, 401) }); if (lines.length === max) break; }
  }
  return lines;
}

export type FileIndex = { symbols: { name: string; kind: string; line: number }[]; imports: string[] };
const DEFINITIONS: [RegExp, RegExp[]][] = [
  [/\.(m|c)?[jt]sx?$/, [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function)\*?\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum)\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?(type)\s+([A-Za-z_$][\w$]*)\s*[=<]/, /^\s*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/]],
  [/\.py$/, [/^\s*(?:async\s+)?(def)\s+([A-Za-z_]\w*)/, /^\s*(class)\s+([A-Za-z_]\w*)/]],
  [/\.rs$/, [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn)\s+([A-Za-z_]\w*)/, /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|mod|type)\s+([A-Za-z_]\w*)/]],
  [/\.go$/, [/^func\s+(?:\([^)]*\)\s+)?()([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)\s+(struct|interface)/]],
  [/\.(java|kt|cs|swift|scala)$/, [/^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data)\s+)*(class|interface|enum|struct|record|object|protocol)\s+([A-Za-z_]\w*)/]],
  [/\.(c|cc|cpp|cxx|h|hpp)$/, [/^\s*(class|struct|enum|namespace)\s+([A-Za-z_]\w*)/]],
];
const IMPORTS = [/^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/, /require\(\s*['"]([^'"]+)['"]\s*\)/, /^\s*from\s+([\w.]+)\s+import\s/, /^\s*import\s+([\w.]+)/, /^\s*use\s+([\w:]+)/, /^\s*#include\s+[<"]([^>"]+)[>"]/];

/** Language-agnostic heuristics, not a compiler: definitions and imports found by line patterns. */
export function indexFile(path: string, content: string): FileIndex {
  const patterns = DEFINITIONS.find(([extension]) => extension.test(path))?.[1] ?? [];
  const symbols: FileIndex['symbols'] = []; const imports = new Set<string>();
  for (const [index, text] of content.split(/\r?\n/).entries()) {
    if (text.length > 2000) continue;
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      const go = path.endsWith('.go') && pattern.source.startsWith('^type');
      symbols.push({ name: go ? match[1]! : match[2]!, kind: go ? match[2]! : match[1] || 'function', line: index + 1 });
      break;
    }
    if (patterns.length) for (const pattern of IMPORTS) { const match = pattern.exec(text); if (match) { imports.add(match[1]!); break; } }
  }
  return { symbols: symbols.slice(0, 2000), imports: [...imports].slice(0, 500) };
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|Tests?\.(java|kt|cs)$/;
export const isTestFile = (path: string) => TEST_FILE.test(path);
