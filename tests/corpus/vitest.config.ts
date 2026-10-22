import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify('corpus') },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src', import.meta.url)),
      'iconv-lite': fileURLToPath(new URL('../../src/lib/pdf/iconvLiteShim.ts', import.meta.url)),
    },
  },
  test: { include: ['tests/corpus/run.ts'], pool: 'forks', maxWorkers: 1, testTimeout: 24 * 3600_000, reporters: ['dot'] },
});
