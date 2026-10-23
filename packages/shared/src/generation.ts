import type { Graph } from './index.js';
import type { TeamPlan } from './team.js';

export type GenerationResult = { graph: Graph; summary: string; attempts: number; team?: TeamPlan };
export type GenerationSnapshot = {
  id: string;
  projectId: string;
  provider: 'codex' | 'claude';
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  createdAt: string;
  finishedAt?: string;
  result?: GenerationResult;
  error?: string;
};
