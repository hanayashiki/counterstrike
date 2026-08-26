import { defineConfig } from 'vite';

/** Builds the model viewer as one self-contained page. */
export default defineConfig({
  root: 'src/viewer',
  publicDir: false,
  build: {
    outDir: '../../dist/viewer',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
