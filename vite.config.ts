import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    ignorePatterns: ['node_modules/**', 'dist/**', 'tools/oxlint/anti-slop/**'],
    plugins: ['typescript', 'unicorn', 'oxc', 'node', 'promise', 'vitest'],
    jsPlugins: [
      {
        name: 'anti-slop',
        specifier: './tools/oxlint/anti-slop/index.ts',
      },
    ],
    rules: {
      'anti-slop/no-chained-type-assertions': 'error',
      'anti-slop/no-known-value-widening': 'error',
      'anti-slop/no-module-mocking': 'error',
      'anti-slop/no-object-parameters': 'error',
      'anti-slop/no-reflect-apply': 'error',
      'anti-slop/no-reflect-get': 'error',
      'anti-slop/no-json-type-argument': 'error',
      'anti-slop/no-unsafe-dictionary-type': 'error',
      'anti-slop/no-widen-then-assert': 'error',
      'anti-slop/no-zod-check-return-value': 'error',
      'anti-slop/prefer-shared-helper': 'error',
      'anti-slop/require-safety-comment-for-type-assertion': 'error',
      'typescript/no-floating-promises': 'error',
      'typescript/no-misused-promises': 'error',
      'typescript/no-unsafe-argument': 'error',
      'typescript/no-unsafe-assignment': 'error',
      'typescript/no-unsafe-call': 'error',
      'typescript/no-unsafe-member-access': 'error',
      'typescript/no-unsafe-return': 'error',
    },
    overrides: [
      {
        files: ['tests/**'],
        rules: {
          'anti-slop/require-safety-comment-for-type-assertion': 'off',
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
      reportUnusedDisableDirectives: 'warn',
    },
  },
  fmt: {
    ignorePatterns: ['dist/**', 'tools/oxlint/anti-slop/**'],
    printWidth: 100,
    tabWidth: 2,
    singleQuote: true,
    trailingComma: 'all',
  },
  pack: {
    entry: ['src/index.ts'],
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
  },
});
