import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/** CLOUD-02: one self-contained ES module for the state repository's coordinator workflow. */
export default defineConfig({
  root: import.meta.dirname,
  publicDir: false,
  logLevel: 'warn',
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: resolve(import.meta.dirname, 'src/cloud/cli.ts'),
    outDir: resolve(import.meta.dirname, 'dist/cloud'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      // The entry has no dynamic imports, so this is already a single self-contained file.
      output: { format: 'es', entryFileNames: 'agent-empire-coordinator.mjs' },
    },
  },
});
