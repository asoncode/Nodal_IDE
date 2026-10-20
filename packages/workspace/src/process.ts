import { spawn } from 'node:child_process';

export type ProcessOutput = { stream: 'stdout' | 'stderr'; text: string };
export type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
};
export type ProcessOptions = {
  command: string;
  args?: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onOutput?: (output: ProcessOutput) => void;
  env?: NodeJS.ProcessEnv;
};

/** Redact common credentials before output enters callbacks or durable storage. */
export function redactSecrets(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let result = value;
  for (const [key, secret] of Object.entries(env)) {
    if (secret && secret.length >= 6 && /(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(key)) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@');
}

/** Commands run without a shell. Callers must obtain permission for arbitrary commands. */
export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const { command, args = [], cwd, onOutput, signal } = options;
  const max = Math.max(1024, Math.min(options.maxOutputBytes ?? 256 * 1024, 4 * 1024 * 1024));
  const env = { ...process.env, ...options.env };
  if (signal?.aborted) return Promise.resolve({
    exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: true, truncated: false,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, cancelled = false, truncated = false;
    let closed = false, escalationDone = true, settled = false;
    let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const pending = { stdout: '', stderr: '' };
    const oversized = { stdout: false, stderr: false };
    const emit = (stream: 'stdout' | 'stderr', raw: string) => {
      const text = redactSecrets(raw, env);
      const previous = stream === 'stdout' ? stdout : stderr;
      const combined = previous + text;
      // Byte bounding also covers multibyte output.
      const bytes = Buffer.from(combined);
      let start = Math.max(0, bytes.length - max);
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
      const retained = bytes.subarray(start).toString('utf8');
      if (bytes.length > max) truncated = true;
      if (stream === 'stdout') stdout = retained; else stderr = retained;
      onOutput?.({ stream, text });
    };
    const consume = (stream: 'stdout' | 'stderr', chunk: string) => {
      // Buffer through line boundaries so a credential split across chunks is still redacted.
      for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        if (!oversized[stream]) pending[stream] += part;
        if (pending[stream].length > max) {
          pending[stream] = '';
          oversized[stream] = true;
          truncated = true;
        }
        if (part.endsWith('\n')) {
          emit(stream, oversized[stream] ? '[oversized output line omitted]\n' : pending[stream]);
          pending[stream] = ''; oversized[stream] = false;
        }
      }
    };
    const kill = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(sig);
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = () => {
      if (!closed || !escalationDone || settled) return;
      settled = true;
      cleanup();
      for (const stream of ['stdout', 'stderr'] as const) {
        if (pending[stream] || oversized[stream]) emit(stream, oversized[stream] ? '[oversized output line omitted]' : pending[stream]);
      }
      resolve({ exitCode, signal: exitSignal, stdout, stderr, timedOut, cancelled, truncated });
    };
    const stop = () => {
      if (!escalationDone) return;
      escalationDone = false;
      kill('SIGTERM');
      // Kill the process group even if its leader exits before its descendants.
      killTimer = setTimeout(() => { kill('SIGKILL'); escalationDone = true; finish(); }, 350);
    };
    const abort = () => { cancelled = true; stop(); };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, options.timeoutMs ?? 120_000));
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => consume('stdout', chunk));
    child.stderr.on('data', (chunk: string) => consume('stderr', chunk));
    child.on('error', (error) => { settled = true; cleanup(); reject(new Error(redactSecrets(error.message, env))); });
    child.on('close', (code, sig) => { closed = true; exitCode = code; exitSignal = sig; finish(); });
    if (signal?.aborted) abort();
  });
}
