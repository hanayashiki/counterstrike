import { defineConfig } from 'vite';

/** Builds the model viewer as one self-contained page. */
export default defineConfig({
  root: 'src/viewer',
  // Share the client's asset directory so /models/*.glb resolves exactly as it
  // does in the game.
  publicDir: '../client/public',
  server: { port: 5174, strictPort: false, open: false },
  build: {
    outDir: '../../dist/viewer',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
