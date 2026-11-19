import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __TARGET__: JSON.stringify('firefox') },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
