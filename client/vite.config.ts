import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const SERVER_URL = process.env.ARENA_SERVER_URL ?? 'http://localhost:8000';

// Mirrors the server route: /game/XXXX serves the game page.
function gameRoute(): Plugin {
  return {
    name: 'arena-game-route',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const match = req.url?.match(/^\/game\/[A-Z0-9]{4}(\?.*)?$/);
        if (match) req.url = `/game.html${match[1] ?? ''}`;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [gameRoute()],
  resolve: {
    alias: { '@shared': resolve(import.meta.dirname, '../shared') },
  },
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        game: resolve(import.meta.dirname, 'game.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // shared/ lives next to client/, outside the Vite root.
    fs: { allow: ['..'] },
    proxy: {
      '/api': SERVER_URL,
      '/healthz': SERVER_URL,
      '/ws': { target: SERVER_URL, ws: true },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
