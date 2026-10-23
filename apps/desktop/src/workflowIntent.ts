import type { Graph } from './model.js';

// A request edits the workflow when it asks for a change (verb) to something on the canvas (noun).
// Questions are answered in chat. The composer shows the routing and the user can override it.
const change = /\b(add|insert|remove|delete|drop|replace|swap|change|update|edit|modify|rename|rewire|reconnect|connect|move|split|paralleli[sz]e|regenerate|generate|create|build|make|redo|rebuild|restructure|reorganize|set|switch|use|assign|increase|decrease|raise|lower|allow)\b/i;
const canvas = /\b(workflow|graph|canvas|pipeline|nodes?|steps?|stages?|gates?|quality gates?|loops?|agents?|approvals?|edges?|branch(?:es)?|iterations?)\b/i;
const question = /^\s*(what|why|how|when|where|who|which|does|do|did|is|are|was|were|explain|describe|tell me)\b/i;

export function isWorkflowRequest(text: string): boolean {
  return !question.test(text) && change.test(text) && canvas.test(text);
}

/** Summarizes a proposal against the current canvas, matching steps by id and then by label. */
export function describeChanges(before: Graph, after: Graph) {
  const matched = new Set<string>();
  const added: string[] = [], changed: string[] = [];
  for (const node of after.nodes) {
    const previous = before.nodes.find(item => item.id === node.id) ?? before.nodes.find(item => item.label === node.label && item.kind === node.kind && !matched.has(item.id));
    if (!previous) { added.push(node.label); continue; }
    matched.add(previous.id);
    if (previous.label !== node.label || previous.kind !== node.kind || JSON.stringify(previous.config) !== JSON.stringify(node.config)) changed.push(node.label);
  }
  const removed = before.nodes.filter(node => !matched.has(node.id)).map(node => node.label);
  return { added, removed, changed };
}
