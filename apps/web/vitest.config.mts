import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/lib/**', 'src/app/agents/**'],
      exclude: ['src/app/agents/[slug]/page.tsx'], // UI component — tested separately
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@slackhive/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
});
