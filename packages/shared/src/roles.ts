import { z } from 'zod';

/** Portable repository paths only; external references need an approval model first. */
export const RolePathSchema = z.string().min(1).max(500).refine(value =>
  !value.startsWith('/') && !/[:\\\x00-\x1f]/.test(value) &&
  !value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'),
'Use a relative repository path without traversal or Git metadata. External knowledge is not supported.');
const ScopeSchema = RolePathSchema.refine(value => !/[\[\]{}!()]/.test(value), 'Scopes support literal paths, *, ** and ? only.');
const HandoffSchema = z.object({
  name: z.string().trim().min(1).max(100),
  path: RolePathSchema.refine(value => !/[*?]/.test(value), 'Handoffs require a literal file path.'),
  required: z.boolean().default(true),
}).strict();
export const RoleSchema = z.object({
  id: z.string().min(1).max(200), title: z.string().trim().min(1).max(200),
  expertise: z.string().trim().min(1).max(12000),
  knowledge: z.array(ScopeSchema).max(50).default([]),
  owns: z.array(ScopeSchema).max(50).default([]),
  produces: z.array(HandoffSchema.extend({ schema: z.record(z.string(), z.unknown()).optional() })).max(30).default([]),
  consumes: z.array(HandoffSchema).max(30).default([]),
  skills: z.array(z.string().trim().min(1).max(4000)).max(20).default([]),
}).strict();
export type Role = z.infer<typeof RoleSchema>;
export type VerifiedHandoff = {
  name: string; path: string; contentHash: string; producerNodeId: string; attemptId: string; commit: string;
};

/** Deliberately small glob language shared by policy and UI; directories include descendants. */
export function roleOwnsPath(scopes: string[], filename: string): boolean {
  return scopes.some(scope => {
    let pattern = '';
    for (let i = 0; i < scope.length; i++) {
      const char = scope[i];
      if (char === '*' && scope[i + 1] === '*') {
        i++;
        if (scope[i + 1] === '/') { i++; pattern += '(?:.*/)?'; } else pattern += '.*';
      } else if (char === '*') pattern += '[^/]*';
      else if (char === '?') pattern += '[^/]';
      else pattern += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
    return new RegExp(`^${pattern}${/[*?]/.test(scope) ? '' : '(?:/.*)?'}$`).test(filename);
  });
}
