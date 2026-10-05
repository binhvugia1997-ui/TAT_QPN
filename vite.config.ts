import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    // The development preview is accessed through a proxied Arena host.
    allowedHosts: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
