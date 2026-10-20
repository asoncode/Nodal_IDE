import { defineConfig } from 'tsup';
export default defineConfig({ entry: ['packages/runtime/src/main.ts'], format: ['esm'], platform: 'node', target: 'node24', outDir: 'dist/runtime', external: ['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk'], removeNodeProtocol: false });
