// Requires the package `typescript-eslint`, not the separate packages
// `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser`.
//   pnpm add -D eslint @eslint/js typescript-eslint
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // eslint.config.mjs itself and other JS files MUST be listed here: they
    // are in no tsconfig, and the type-aware block below would otherwise fail
    // on them with "was not found by the project service".
    ignores: [
      'dist/', 'build/', 'coverage/', 'node_modules/', '.next/', '.next-production/',
      '**/*.d.ts', '**/*.mjs', '**/*.cjs', '**/*.js',
    ],
  },
  js.configs.recommended,
  // Limit both rule sets explicitly to TypeScript. Without a files filter
  // they apply to every linted file, including this configuration.
  ...tseslint.configs.strictTypeChecked.map((c) => ({ ...c, files: ['**/*.ts', '**/*.tsx'] })),
  ...tseslint.configs.stylisticTypeChecked.map((c) => ({ ...c, files: ['**/*.ts', '**/*.tsx'] })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        // Replaces the manual project list and also covers files that are
        // in no tsconfig.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Promises have to be handled. Ignore deliberately through `void`.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    // Relaxations exclusively for tests, never globally.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
