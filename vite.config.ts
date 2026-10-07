import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const serverPort = process.env.TNP_PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    // The development preview is accessed through a proxied Arena host.
    allowedHosts: true,
    proxy: {
      // The browser only ever calls same-origin relative paths; Vite forwards them to the
      // authoritative local Node/SQLite server.
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
