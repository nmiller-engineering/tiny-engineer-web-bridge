import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'web-ext-artifacts/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, browser: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'document', property: 'write', message: 'Never write HTML into extension pages.' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "AssignmentExpression[left.property.name='innerHTML']", message: 'Use textContent / DOM APIs instead of innerHTML.' },
        { selector: "AssignmentExpression[left.property.name='outerHTML']", message: 'Use DOM APIs instead of outerHTML.' },
        { selector: "CallExpression[callee.name='eval']", message: 'eval is forbidden.' },
      ],
      'no-console': ['error', { allow: ['debug', 'warn', 'error'] }],
    },
  },
  {
    // Content scripts run inside AI pages: no storage, no network.
    files: ['src/content/**/*.ts', 'src/detectors/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/shared/config', '**/shared/storage', '**/background/**'], message: 'Content scripts must not access configuration, storage or the device client.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Content scripts must not perform network requests.' }, { name: 'XMLHttpRequest', message: 'Content scripts must not perform network requests.' }, { name: 'WebSocket', message: 'Content scripts must not perform network requests.' }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tools/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
);
