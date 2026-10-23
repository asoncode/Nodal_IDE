import Ajv from 'ajv';
import type { ToolConfig } from '../../shared/src/index.js';
import type { NodeResult } from '../../core/src/engine.js';
import { blameFile, diffCommits, grepCommit, indexFile, isTestFile, logCommit, resolveCommit, showFile, treeFiles, type FileIndex } from '../../workspace/src/index.js';

export const TOOL_OUTPUT_LIMIT = 256 * 1024;
export type ToolOutput = Record<string, unknown> & { tool: ToolConfig['tool']; commit: string; count: number; truncated: boolean };
export type ToolEnvironment = {
  root: string; commit: string; baseCommit: string; inputs: Record<string, NodeResult>;
  /** Content-addressed index cache: a blob SHA always yields the same index. */
  index?: (blob: string, compute: () => Promise<FileIndex>) => Promise<FileIndex>;
};

/** Every tool is deterministic for a commit: same configuration and commit, same output. */
export async function runTool(config: ToolConfig, env: ToolEnvironment): Promise<{ status: 'succeeded' | 'failed'; output: ToolOutput; error?: string }> {
  const { root, commit } = env;
  const done = (fields: Record<string, unknown>, count: number, truncated = false) => ({ status: 'succeeded' as const, output: bound({ tool: config.tool, commit, count, truncated, ...fields }) });
  switch (config.tool) {
    case 'search': {
      const result = await grepCommit(root, commit, config.query, { regex: config.regex, caseSensitive: config.caseSensitive, scopes: config.paths, maxResults: config.maxResults });
      return done({ query: config.query, matches: result.matches, files: result.files }, result.matches.length, result.truncated);
    }
    case 'list': {
      const files = await treeFiles(root, commit, config.paths);
      return done({ files: files.slice(0, config.maxResults).map(({ path, size }) => ({ path, size })), total: files.length }, Math.min(files.length, config.maxResults), files.length > config.maxResults);
    }
    case 'read': {
      const files = await treeFiles(root, commit, config.paths);
      let remaining = config.maxBytes; let truncated = false;
      const read: { path: string; content: string; truncated: boolean }[] = [];
      for (const file of files) {
        if (remaining <= 0) { truncated = true; break; }
        const shown = await showFile(root, commit, file.path, Math.max(1024, remaining));
        if (shown.binary) continue;
        const content = shown.content.slice(0, remaining);
        read.push({ path: file.path, content, truncated: shown.truncated || content.length < shown.content.length });
        remaining -= content.length;
      }
      return done({ files: read, matched: files.length }, read.length, truncated || read.some(file => file.truncated));
    }
    case 'git': {
      if (config.mode === 'log') {
        const entries = await logCommit(root, commit, config.paths, config.maxResults);
        return done({ mode: 'log', entries }, entries.length);
      }
      if (config.mode === 'diff') {
        const base = config.ref ? await resolveCommit(root, config.ref) : env.baseCommit;
        const diff = await diffCommits(root, base, commit, config.paths);
        return done({ mode: 'diff', ...diff }, diff.files.length, diff.truncated);
      }
      if (config.paths.length !== 1) throw new Error('Blame needs exactly one literal file path.');
      const lines = await blameFile(root, commit, config.paths[0]!, config.maxResults);
      return done({ mode: 'blame', path: config.paths[0], lines }, lines.length);
    }
    case 'symbols': {
      const files = (await treeFiles(root, commit, config.paths)).filter(file => file.size <= 512 * 1024);
      const definitions: { path: string; name: string; kind: string; line: number }[] = [];
      let truncated = false;
      for (const file of files) {
        const index = await indexed(env, file.path, file.blob);
        for (const symbol of index.symbols) {
          if (config.name && symbol.name !== config.name) continue;
          if (definitions.length === config.maxResults) { truncated = true; break; }
          definitions.push({ path: file.path, ...symbol });
        }
        if (truncated) break;
      }
      const references = config.name ? await grepCommit(root, commit, config.name, { wordRegexp: true, caseSensitive: true, scopes: config.paths, maxResults: config.maxResults }) : undefined;
      return done({ name: config.name, method: 'heuristic', definitions, references: references?.matches ?? [] }, definitions.length, truncated || !!references?.truncated);
    }
    case 'test-impact': {
      const changed = config.paths.length
        ? (await treeFiles(root, commit, config.paths)).map(file => file.path)
        : (await diffCommits(root, env.baseCommit, commit, [])).files.filter(file => file.status !== 'D').map(file => file.path);
      const tests = (await treeFiles(root, commit)).filter(file => isTestFile(file.path));
      const found = new Map<string, Set<string>>();
      const note = (path: string, reason: string) => found.set(path, (found.get(path) ?? new Set()).add(reason));
      for (const path of changed) {
        if (isTestFile(path)) { note(path, 'changed test'); continue; }
        const stem = path.split('/').at(-1)!.replace(/\.[^.]+$/, '');
        if (stem.length < 3 || stem === 'index') continue;
        for (const test of tests) if (test.path.split('/').at(-1)!.toLowerCase().includes(stem.toLowerCase())) note(test.path, `name matches ${path}`);
        const referencing = await grepCommit(root, commit, stem, { wordRegexp: true, caseSensitive: true, filesOnly: true, scopes: tests.map(test => test.path), maxResults: 500 });
        for (const test of referencing.files) note(test, `references ${stem}`);
      }
      const impacted = [...found].slice(0, config.maxResults).map(([path, reasons]) => ({ path, reasons: [...reasons] }));
      return done({ approximate: true, method: 'test file names and references', changed, tests: impacted }, impacted.length, found.size > config.maxResults);
    }
    case 'validate': {
      let content: string | undefined;
      try { const shown = await showFile(root, commit, config.path); content = shown.binary ? undefined : shown.content; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const errors: string[] = [];
      if (content === undefined) errors.push(`${config.path} does not exist.`);
      else if (config.schema) {
        let value: unknown;
        try { value = JSON.parse(content); } catch { errors.push(`${config.path} is not valid JSON.`); }
        if (!errors.length) {
          const ajv = new Ajv({ strict: true, allErrors: true });
          const validate = ajv.compile(config.schema);
          if (!validate(value)) errors.push(ajv.errorsText(validate.errors));
        }
      }
      const valid = !errors.length;
      const result = done({ path: config.path, exists: content !== undefined, valid, errors }, valid ? 1 : 0);
      return !valid && config.required ? { ...result, status: 'failed', error: `Validation failed: ${errors.join('; ')}` } : result;
    }
    case 'step-output': {
      const input = env.inputs[config.nodeId];
      if (!input) throw new Error(`Step ${config.nodeId} is not an earlier step in this run.`);
      const output = input.output as Record<string, unknown> | undefined;
      const text = typeof output?.output === 'string' ? output.output : [output?.stdout, output?.stderr].filter(value => typeof value === 'string').join('\n') || JSON.stringify(output ?? {});
      return done({ nodeId: config.nodeId, status: input.status, text }, 1);
    }
  }
}

async function indexed(env: ToolEnvironment, path: string, blob: string): Promise<FileIndex> {
  const compute = async () => { const shown = await showFile(env.root, env.commit, path, 512 * 1024); return shown.binary ? { symbols: [], imports: [] } : indexFile(path, shown.content); };
  return env.index ? env.index(blob, compute) : compute();
}

/** Keeps outputs storable: oversized results drop their largest arrays and say so. */
function bound(output: ToolOutput): ToolOutput {
  if (Buffer.byteLength(JSON.stringify(output)) <= TOOL_OUTPUT_LIMIT) return output;
  const trimmed: ToolOutput = { ...output, truncated: true };
  for (const key of Object.keys(trimmed)) {
    const value = trimmed[key];
    if (Array.isArray(value)) trimmed[key] = value.slice(0, Math.max(1, Math.floor(value.length / 4)));
    if (typeof value === 'string' && value.length > 32 * 1024) trimmed[key] = `${value.slice(0, 32 * 1024)}\n…[truncated]`;
  }
  return Buffer.byteLength(JSON.stringify(trimmed)) <= TOOL_OUTPUT_LIMIT ? trimmed : { tool: output.tool, commit: output.commit, count: output.count, truncated: true, error: 'Result exceeded the storage limit; narrow the paths or maxResults.' };
}
