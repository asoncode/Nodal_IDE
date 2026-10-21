import type { Graph } from './index.js';
export type ChatProvider = 'claude' | 'codex';
export type ChatPermission = 'read-only' | 'scoped-edit';
export const CHAT_ATTACHMENT_LIMITS = { count: 8, fileBytes: 64 * 1024, totalBytes: 256 * 1024 } as const;
export type ChatAttachmentInput = { kind: 'reference'; path: string } | { kind: 'upload'; name: string; content: string };
export interface ChatAttachment { kind: 'reference' | 'upload'; name: string; path?: string; content: string }
export interface ChatFile { path: string; size: number }
export const isChatTextFilename = (name: string) => !/\.(?:pdf|png|jpe?g|gif|webp|ico|zip|gz|exe|dmg|docx?|xlsx?|pptx?|wasm|class|dll|so|dylib)$/i.test(name);
export function validateChatText(name: string, content: string): number {
  if (!isChatTextFilename(name) || /[\0\uFFFD]/.test(content)) throw new Error(`${name}: attach a UTF-8 code or text file. Images, PDFs and binary documents are not supported.`);
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > CHAT_ATTACHMENT_LIMITS.fileBytes) throw new Error(`${name}: attachments must be at most 64 KiB each.`);
  return bytes;
}
export interface ChatContext {
  graphId: string; graphName: string; nodeId: string; nodeLabel: string; instructions: string; runId?: string;
}
export interface ChatSession {
  id: string; projectId: string; provider: ChatProvider; model?: string; permission: ChatPermission;
  title: string; createdAt: string; updatedAt: string; context?: ChatContext; worktreePath?: string;
}
export interface ChatTurn {
  id: string; chatId: string; message: string; output: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  error?: string; createdAt: string; finishedAt?: string;
  attachments?: ChatAttachment[];
  approval?: { id: string; command: string; status: 'pending' | 'approved' | 'rejected' };
}
export interface ChatEvent {
  id: string; chatId: string; turnId: string; sequence: number; type: string; data: Record<string, unknown>; timestamp: string;
}
export interface ChatSnapshot { session: ChatSession; turns: ChatTurn[]; events: ChatEvent[] }
export interface CreateChatInput {
  projectId: string; provider: ChatProvider; model?: string; permission: ChatPermission;
  context?: { graph: Graph; nodeId: string; runId?: string };
}
export interface ChatDiff { diff: string; head: string; sourceHead: string; branch: string; dirty: boolean }
