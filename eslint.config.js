import tseslint from 'typescript-eslint';
export default tseslint.config({ignores:['**/node_modules/**','**/dist/**','.nodal/**','**/sidecar/**','**/target/**','**/gen/**','playwright-report/**','test-results/**']}, ...tseslint.configs.recommended, {rules:{'@typescript-eslint/no-explicit-any':'off','@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}]}});
