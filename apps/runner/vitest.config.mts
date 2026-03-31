import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: {
      '@slackhive/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  esbuild: {
    target: 'node20',
  },
});
