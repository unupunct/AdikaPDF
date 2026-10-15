import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Writes PDF/A samples for veraPDF (CI job "veraPDF"): PDFA_OUT=dir npx vitest run --config tests/pdfa-ci/vitest.config.ts
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  test: { include: ['tests/pdfa-ci/**/*.run.ts'], testTimeout: 120000 },
});
