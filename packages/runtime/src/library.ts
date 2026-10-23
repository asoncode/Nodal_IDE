import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GraphSchema, RoleSchema, type Graph, type Role } from '../../shared/src/index.js';
import { validateGraph } from '../../core/src/validation.js';
import { redactSecrets, isSensitivePath } from '../../workspace/src/index.js';

/**
 * A portable folder of workflows, roles, and lessons. Items are untrusted input: they are schema-checked
 * and validated on every read, never executed on import, and their commands still require approval.
 */
export const LIBRARY_KINDS = ['workflow', 'role', 'lesson'] as const;
export type LibraryKind = typeof LIBRARY_KINDS[number];
const ParameterSchema = z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), kind: z.enum(['path', 'command']), description: z.string().max(300).default(''), default: z.string().max(500).optional() }).strict();
export type LibraryParameter = z.infer<typeof ParameterSchema>;
export const LibraryItemSchema = z.object({
  nodalLibrary: z.literal(1), kind: z.enum(LIBRARY_KINDS), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), name: z.string().min(1).max(200), version: z.number().int().min(1),
  origin: z.object({ project: z.string().max(200), exportedAt: z.string() }).strict(), changelog: z.string().max(4000).default(''),
  parameters: z.array(ParameterSchema).max(30).default([]), content: z.unknown(),
}).strict();
export type LibraryItem = z.infer<typeof LibraryItemSchema>;
const placeholder = (name: string) => `{{${name}}}`;
export const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';

export function libraryLocation(configured?: string): string {
  const location = configured ?? join(homedir(), 'Nodal', 'Library');
  if (!isAbsolute(location)) throw new Error('Use an absolute folder path for the library.');
  return resolve(location);
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map(item => mapStrings(item, map));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapStrings(child, map)]));
  return value;
}
/** Every command step, including steps inside role playbooks. */
function commandSteps(graph: Graph): { command: string; args: string[] }[] {
  return graph.nodes.flatMap(node => node.kind === 'command' ? [node.config] : node.kind === 'role' ? node.config.playbook.nodes.flatMap(step => step.kind === 'command' ? [step.config] : []) : []);
}
const commandLine = (config: { command: string; args: string[] }) => [config.command, ...config.args].join(' ');

/** Values in a workflow that are likely project-specific: top-level directories in role and tool paths, and command lines. */
export function parameterCandidates(graph: Graph): { kind: 'path' | 'command'; value: string; suggestedName: string }[] {
  const dirs = new Set<string>();
  const visit = (paths: string[]) => { for (const path of paths) { const dir = path.split('/')[0]!; if (dir && !/[*?]/.test(dir) && path.includes('/')) dirs.add(dir); else if (dir && !/[*?.]/.test(dir)) dirs.add(dir); } };
  for (const node of graph.nodes) {
    const role = node.kind === 'agent' || node.kind === 'role' ? node.config.role : undefined;
    if (role) visit([...role.owns, ...role.knowledge, ...role.produces.map(item => item.path), ...role.consumes.map(item => item.path)]);
    if (node.kind === 'tool' && 'paths' in node.config) visit(node.config.paths);
  }
  const commands = new Set(commandSteps(graph).map(commandLine));
  const name = (text: string, suffix: string) => `${text.replace(/[^a-zA-Z0-9]+(.)?/g, (_m, c: string | undefined) => c ? c.toUpperCase() : '').replace(/^[^a-zA-Z]+/, '') || 'value'}${suffix}`;
  return [...[...dirs].map(value => ({ kind: 'path' as const, value, suggestedName: name(value, 'Dir') })), ...[...commands].map((value, index) => ({ kind: 'command' as const, value, suggestedName: index ? `testCommand${index + 1}` : 'testCommand' }))];
}

/** Replaces project-specific values with placeholders. Paths match exactly or as a directory prefix. */
export function parameterize<T>(content: T, parameters: (LibraryParameter & { value: string })[]): T {
  let result = structuredClone(content) as unknown;
  for (const parameter of parameters.filter(item => item.kind === 'command')) {
    const graph = result as Graph;
    for (const step of graph.nodes ? commandSteps(graph) : []) if (commandLine(step) === parameter.value) { step.command = placeholder(parameter.name); step.args = []; }
  }
  const paths = parameters.filter(item => item.kind === 'path').sort((a, b) => b.value.length - a.value.length);
  result = mapStrings(result, text => {
    for (const parameter of paths) {
      if (text === parameter.value) return placeholder(parameter.name);
      if (text.startsWith(`${parameter.value}/`)) return `${placeholder(parameter.name)}${text.slice(parameter.value.length)}`;
    }
    return text;
  });
  return result as T;
}

/** Fills placeholders. A command placeholder becomes the command and its whitespace-separated arguments; no shell is involved. */
export function instantiate(content: unknown, parameters: LibraryParameter[], bindings: Record<string, string>): unknown {
  for (const parameter of parameters) if (!bindings[parameter.name]?.trim()) throw new Error(`Set a value for ${parameter.name}.`);
  let result = structuredClone(content);
  const graph = result as Graph;
  if (Array.isArray(graph?.nodes)) for (const step of commandSteps(graph)) {
    const parameter = parameters.find(item => item.kind === 'command' && step.command === placeholder(item.name));
    if (parameter) { const [command, ...args] = bindings[parameter.name]!.trim().split(/\s+/); step.command = command!; step.args = [...args, ...step.args]; }
  }
  result = mapStrings(result, text => text.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]{0,40})\}\}/g, (match, name: string) => {
    const parameter = parameters.find(item => item.name === name);
    return !parameter ? match : parameter.kind === 'path' ? bindings[name]!.trim().replace(/\/+$/, '') : bindings[name]!.trim();
  }));
  const left = JSON.stringify(result).match(/\{\{[a-zA-Z][a-zA-Z0-9_]{0,40}\}\}/);
  if (left) throw new Error(`The item uses ${left[0]} but does not declare it as a parameter.`);
  return result;
}

/** Suggested values for a target project: an existing directory with the same name, or a test command from its manifest files. */
export async function detectDefaults(root: string, parameters: LibraryParameter[], files: string[]): Promise<Record<string, string>> {
  const read = async (path: string) => { try { return await readFile(join(root, path), 'utf8'); } catch { return undefined; } };
  let test: string | undefined;
  const pkg = files.includes('package.json') ? await read('package.json') : undefined;
  if (pkg) { try { if ((JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts?.test) test = 'npm test'; } catch { /* not JSON */ } }
  if (!test && (files.includes('pyproject.toml') || files.includes('pytest.ini') || files.includes('setup.cfg'))) test = 'python3 -m pytest';
  if (!test && files.includes('Cargo.toml')) test = 'cargo test';
  if (!test && files.includes('go.mod')) test = 'go test ./...';
  return Object.fromEntries(parameters.flatMap(parameter => {
    if (parameter.kind === 'path') return parameter.default ? [[parameter.name, parameter.default]] : [];
    return test ? [[parameter.name, test]] : parameter.default ? [[parameter.name, parameter.default]] : [];
  }));
}

/** Parses and validates item content for its kind. Workflows get fresh IDs at import so they never collide. */
export function materialize(item: LibraryItem, bindings: Record<string, string>): { kind: 'workflow'; graph: Graph; problems: string[] } | { kind: 'role'; role: Role } | { kind: 'lesson'; text: string } {
  const content = instantiate(item.content, item.parameters, bindings);
  if (JSON.stringify(content) !== redactSecrets(JSON.stringify(content))) throw new Error('This library item appears to contain credentials and was not imported.');
  if (item.kind === 'workflow') {
    const parsed = GraphSchema.parse({ ...(content as object), id: randomUUID(), revision: 1, origin: { library: item.slug, version: item.version, bindings } });
    const check = validateGraph(parsed);
    return { kind: 'workflow', graph: check.graph ?? parsed, problems: check.errors.map(error => error.message) };
  }
  if (item.kind === 'role') {
    const role = RoleSchema.parse(content);
    for (const path of [...role.owns, ...role.knowledge]) if (isSensitivePath(path)) throw new Error('This role references a credential path.');
    return { kind: 'role', role };
  }
  const text = z.object({ text: z.string().trim().min(1).max(2000) }).strict().parse(content).text;
  return { kind: 'lesson', text };
}

export async function listLibrary(location: string): Promise<{ items: LibraryItem[]; errors: string[] }> {
  const items: LibraryItem[] = []; const errors: string[] = [];
  for (const kind of LIBRARY_KINDS) {
    const dir = join(location, `${kind}s`);
    let slugs: string[] = [];
    try { slugs = await readdir(dir); } catch { continue; }
    for (const slug of slugs.filter(name => /^[a-z0-9][a-z0-9-]{0,79}$/.test(name)).slice(0, 500)) {
      let versions: string[] = [];
      try { versions = (await readdir(join(dir, slug))).filter(name => /^\d{1,6}\.json$/.test(name)); } catch { continue; }
      for (const file of versions) {
        const path = join(dir, slug, file);
        try {
          if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('larger than 2 MB');
          const item = LibraryItemSchema.parse(JSON.parse(await readFile(path, 'utf8')));
          if (item.kind !== kind || item.slug !== slug || `${item.version}.json` !== file) throw new Error('kind, slug, or version does not match its location');
          items.push(item);
        } catch (error) { errors.push(`${kind}s/${slug}/${file}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
  }
  return { items: items.sort((a, b) => a.kind.localeCompare(b.kind) || a.slug.localeCompare(b.slug) || a.version - b.version), errors };
}

/** Saves the next version of an item. Existing versions are never overwritten. */
export async function saveToLibrary(location: string, input: Omit<LibraryItem, 'nodalLibrary' | 'version'>): Promise<LibraryItem> {
  const { items } = await listLibrary(location);
  const version = Math.max(0, ...items.filter(item => item.kind === input.kind && item.slug === input.slug).map(item => item.version)) + 1;
  const item = LibraryItemSchema.parse({ ...input, nodalLibrary: 1, version });
  if (JSON.stringify(item) !== redactSecrets(JSON.stringify(item))) throw new Error('Library items must not contain credentials.');
  const dir = join(location, `${item.kind}s`, item.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${version}.json`), `${JSON.stringify(item, null, 2)}\n`, { flag: 'wx' });
  return item;
}
