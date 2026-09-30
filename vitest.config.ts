import { defineConfig } from 'vitest/config';

// Workspace packages export `acr-source` (TypeScript) and `default` (built JS); tests run against source.
export default defineConfig({
  resolve: { conditions: ['acr-source'] },
  ssr: { resolve: { conditions: ['acr-source'] } },
  test: {
    include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
