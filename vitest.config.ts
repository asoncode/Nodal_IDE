import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['packages/**/*.test.ts','apps/desktop/src/**/*.test.ts','apps/desktop/src/**/*.test.tsx','tests/**/*.test.ts'],testTimeout:20000,exclude:['**/node_modules/**','**/target/**','**/sidecar/**','**/dist/**','.nodal/**','tests/e2e/**']}});
