import type { Graph } from '../../shared/src/index.js';
import { redact } from '../../persistence/src/index.js';

type Result = { status?: string; route?: string; error?: string; output?: unknown };
type Section = { header: string; body: string; kind: 'agent' | 'failing' | 'log' | 'tool' | 'none' };

const head = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, Math.max(0, max))}\n…[${text.length - max} later characters omitted]`;
const tail = (text: string, max: number) => text.length <= max ? text : `…[${text.length - max} earlier characters omitted]\n${text.slice(-Math.max(0, max))}`;
const field = (value: unknown, key: string) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Renders upstream results for an agent prompt. Agent responses (plans, summaries, review findings)
 * are kept ahead of process logs, failing command output is kept ahead of passing output, and logs
 * keep their tail, so a long install log can no longer push the architecture plan out of context.
 */
export function upstreamContext(inputs: Record<string, Result>, graph: Graph, budget = 40_000, options: { near?: Set<string> } = {}): string {
  const sections = Object.entries(inputs).flatMap(([id, result]): Section[] => {
    const node = graph.nodes.find(item => item.id === id);
    if (!node) return [];
    const header = `## ${node.label} (${node.kind}): ${result.status ?? 'unknown'}${result.route ? `, route ${result.route}` : ''}${result.error ? `\nError: ${result.error}` : ''}`;
    if (node.kind === 'agent' || node.kind === 'role') {
      const roleHeader = node.kind === 'role' ? `${header}\nRole: ${node.config.role.title}` : header;
      const text = String(field(result.output, 'output') ?? '');
      // Distant ancestors arrive as digests; full text stays retrievable with a step-output tool step.
      if (options.near && !options.near.has(id)) {
        const changed = field(result.output, 'changedFiles'); const handoffs = field(result.output, 'handoffs');
        const digest = [Array.isArray(changed) ? `Changed files: ${changed.slice(0, 40).join(', ') || 'none'}` : '', Array.isArray(handoffs) && handoffs.length ? `Handoffs: ${handoffs.map(item => String(field(item, 'name'))).join(', ')}` : '', `Summary (digest of an earlier step; read its full output with a step-output tool for ${id}):\n${text.slice(0, 1200)}${text.length > 1200 ? '…' : ''}`].filter(Boolean).join('\n');
        return [{ header: roleHeader, body: digest, kind: 'agent' }];
      }
      return [{ header: roleHeader, body: text, kind: 'agent' }];
    }
    if (node.kind === 'tool') {
      const { tool, commit, ...rest } = (result.output ?? {}) as Record<string, unknown>;
      return [{ header: `${header}\nTool: ${String(tool ?? node.config.tool)} at ${String(commit ?? '').slice(0, 12)}`, body: JSON.stringify(rest), kind: 'tool' }];
    }
    if (node.kind === 'command') {
      const output = result.output;
      const logs = [field(output, 'stdout'), field(output, 'stderr')].filter(text => typeof text === 'string' && text).join('\n');
      const command = `$ ${node.config.command} ${node.config.args.join(' ')}\nExit code: ${String(field(output, 'exitCode') ?? 'none')}${field(output, 'timedOut') ? ' (timed out)' : ''}`;
      return [{ header: `${header}\n${command}`, body: logs, kind: result.status === 'failed' ? 'failing' : 'log' }];
    }
    return [{ header, body: '', kind: 'none' }];
  });
  const fixed = sections.reduce((sum, section) => sum + section.header.length + 2, 0);
  const room = Math.max(0, budget - fixed - 200);
  const count = (kind: Section['kind']) => Math.max(1, sections.filter(section => section.kind === kind && section.body).length);
  // Shares are ceilings; text shorter than its share is kept whole.
  const shares = { agent: Math.floor(room * 0.5 / count('agent')), failing: Math.floor(room * 0.25 / count('failing')), tool: Math.floor(room * 0.12 / count('tool')), log: Math.floor(room * 0.13 / count('log')), none: 0 };
  const text = sections.map(section => {
    if (!section.body) return section.header;
    const body = section.kind === 'agent' || section.kind === 'tool' ? head(section.body, shares[section.kind]) : tail(section.body, shares[section.kind]);
    return `${section.header}\n${body}`;
  }).join('\n\n');
  return redact(head(text, budget - 60));
}
