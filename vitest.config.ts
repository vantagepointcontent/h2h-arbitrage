import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Unit tests only — integration tests in tests/ require a live dev server
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'tests/**'],
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});