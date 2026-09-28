import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // @kenjiuno/msgreader pulls in iconv-lite, which needs Node's Buffer.
      'iconv-lite': fileURLToPath(new URL('./src/lib/pdf/iconvLiteShim.ts', import.meta.url)),
    },
  },
  worker: { format: 'es' },
  server: {
    port: 5173,
    strictPort: true,
    // Cargo rewrites files under src-tauri/target while the dev server runs;
    // watching them crashes Vite with EBUSY on Windows.
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    // ADIKA_NO_MINIFY=1 keeps readable stacks for debugging builds.
    minify: process.env.ADIKA_NO_MINIFY ? false : 'esbuild',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
});
