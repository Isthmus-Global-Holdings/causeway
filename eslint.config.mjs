// Lint catches bugs, not style (Prettier owns formatting). The rules are all
// about promises: on Workers, an un-awaited promise is work that silently gets
// cut off when the response is sent (a HubSpot write that never lands).
// TypeScript doesn't catch that, and these type-aware rules do.
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/', '.wrangler/', 'hubspot/', 'dist/'] },
  {
    files: ['src/**/*.ts', 'extension/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
    },
  },
];
