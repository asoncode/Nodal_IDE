import { describe, expect, it } from 'vitest';
import { createNode, type Graph } from '../../shared/src/index.js';
import { upstreamContext } from '../src/context.js';

const node = (kind: Parameters<typeof createNode>[0], id: string, label: string) => ({ ...createNode(kind, id, { x: 0, y: 0 }), label });
const graph = { nodes: [node('agent', 'architect', 'Architecture'), node('agent', 'backend', 'Implement backend'), node('command', 'install', 'Install backend deps'), node('command', 'tests', 'Run backend tests'), node('quality_gate', 'gate', 'Backend gate')] } as unknown as Graph;
const plan = `PLAN-START data contracts: MatchEvent{t,x,y}. ${'Simulator assumption. '.repeat(400)}PLAN-END`;

describe('upstream context for agents', () => {
  it('keeps the architecture plan and the failing test evidence despite large logs', () => {
    const text = upstreamContext({
      architect: { status: 'succeeded', output: { output: plan, usage: { input_tokens: 1 }, worktree: { path: '/tmp/x' } } },
      backend: { status: 'succeeded', output: { output: 'Implemented simulator and API.' } },
      install: { status: 'succeeded', output: { exitCode: 0, stdout: `Collecting fastapi\n${'Downloading wheel...\n'.repeat(10000)}Successfully installed fastapi`, stderr: '' } },
      tests: { status: 'failed', error: 'Command did not pass its required exit status.', output: { exitCode: 1, stdout: `${'.'.repeat(50000)}\nFAILED tests/test_counterfactual.py::test_matched_seeds - AssertionError`, stderr: '' } },
      gate: { status: 'succeeded', route: 'fail', output: { verdict: 'fail' } },
    } as never, graph, 40_000);
    expect(text.length).toBeLessThanOrEqual(40_000);
    expect(text).toContain('PLAN-START data contracts'); expect(text).toContain('PLAN-END');
    expect(text).toContain('Implemented simulator and API.');
    expect(text).toContain('FAILED tests/test_counterfactual.py::test_matched_seeds');
    expect(text).toContain('Successfully installed fastapi');
    expect(text).toContain('Backend gate (quality_gate): succeeded, route fail');
    expect(text).not.toContain('input_tokens');
    expect(text.indexOf('Architecture')).toBeLessThan(text.indexOf('Run backend tests'));
  });

  it('shortens agent responses only when they alone exceed their share', () => {
    const text = upstreamContext({ architect: { status: 'succeeded', output: { output: `HEAD ${'x'.repeat(100_000)} TAIL` } } } as never, graph, 10_000);
    expect(text.length).toBeLessThanOrEqual(10_000);
    expect(text).toContain('HEAD'); expect(text).toContain('later characters omitted');
  });
});
