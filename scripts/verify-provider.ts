import { checkAvailability, runProvider, type ProviderId } from '../packages/providers/src/index.js';

const provider = process.argv[2];
if (provider !== 'codex' && provider !== 'claude') {
  console.error('Usage: pnpm exec tsx scripts/verify-provider.ts <codex|claude> [--live <repository-directory>]');
  process.exitCode = 1;
} else {
  const status = await checkAvailability(provider as ProviderId);
  console.log(JSON.stringify(status, null, 2));
  const liveIndex = process.argv.indexOf('--live');
  if (liveIndex !== -1) {
    const cwd = process.argv[liveIndex + 1];
    if (!cwd) throw new Error('--live requires the repository directory. A live run sends a provider request and may consume paid usage.');
    if (!status.available) throw new Error('Provider executable is unavailable.');
    console.log('Starting an explicitly requested read-only live SDK turn. Provider usage may be charged.');
    const result = await runProvider({
      provider, cwd, prompt: 'Reply with exactly: NODAL_PROVIDER_OK. Do not call tools.',
      permissionMode: 'read-only', noTools: provider === 'claude', maxTurns: 1, timeoutMs: 45_000,
      onEvent: (event) => console.log(JSON.stringify(event)),
    });
    if (!result.output.includes('NODAL_PROVIDER_OK')) throw new Error('Provider responded, but the verification marker was not returned.');
    console.log('Live SDK stream and final result verified.');
  }
}
