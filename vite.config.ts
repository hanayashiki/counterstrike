import { defineConfig } from 'vite';

const SERVER_PORT = Number(process.env.GAME_SERVER_PORT ?? 8787);

export default defineConfig({
  root: 'src/client',
  // Rigged character models and their licences are served as static assets.
  publicDir: 'public',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  define: {
    __GAME_SERVER_PORT__: JSON.stringify(SERVER_PORT),
  },
});
