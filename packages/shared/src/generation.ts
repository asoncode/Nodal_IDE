import type { Graph } from './index.js';

export type GenerationResult = { graph: Graph; summary: string; attempts: number };
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
