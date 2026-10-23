import { describe, expect, it } from 'vitest';
import { describeChanges, isWorkflowRequest } from './workflowIntent.js';
import { createNode, emptyGraph } from './model.js';

describe('workflow requests in chat', () => {
  it.each([
    'Add a security review step before the merge',
    'regenerate the workflow so backend and frontend run in parallel',
    'Can you remove the Playwright install node?',
    'please make the quality gates allow 5 iterations',
    'Use Claude for the architecture agent instead of Codex',
    'rename the review node to Final review',
    'Create a workflow that builds the API, runs tests and asks for approval',
  ])('routes "%s" to the workflow generator', text => expect(isWorkflowRequest(text)).toBe(true));

  it.each([
    'How does the backend quality gate decide pass or fail?',
    'What does the architecture node do?',
    'Why did the workflow fail on the second iteration?',
    'Add input validation to the match simulator',
    'Fix the failing test in tests/test_api.py',
    'Explain the merge step',
  ])('keeps "%s" as a normal chat message', text => expect(isWorkflowRequest(text)).toBe(false));
});

describe('proposal summaries', () => {
  it('names added, removed, and changed steps', () => {
    const before = emptyGraph();
    const review = createNode('agent', 1); review.label = 'Review';
    const after = structuredClone(before); after.nodes = [...after.nodes, review];
    after.nodes[0] = { ...after.nodes[0], label: 'Begin' };
    expect(describeChanges(before, after)).toEqual({ added: ['Review'], removed: [], changed: ['Begin'] });
    expect(describeChanges(after, before)).toEqual({ added: [], removed: ['Review'], changed: ['Start'] });
  });
});
