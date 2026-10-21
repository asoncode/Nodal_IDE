export type TerminalOwner = { projectId: string; ownerId: string };
export type TerminalScope = TerminalOwner & { terminalId: string };
export type CreateTerminalInput = TerminalOwner & { cols: number; rows: number };
export type TerminalSession = TerminalOwner & {
  id: string;
  title: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited';
  exitCode?: number;
  signal?: number;
};
export type TerminalRead = {
  data: string;
  /** Absolute JavaScript string offsets, including output discarded from the buffer. */
  start: number;
  next: number;
  truncated: boolean;
  status: TerminalSession['status'];
  exitCode?: number;
  signal?: number;
};
