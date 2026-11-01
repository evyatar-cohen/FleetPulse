// Vite (dev server + bundler) and Vitest (test runner) configuration.
// The proxy lets the client call relative URLs (/api/..., /ws) — Vite forwards them to the mock server,
// so the server address lives only here.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const MOCK_SERVER = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': MOCK_SERVER,
      '/ws': { target: MOCK_SERVER, ws: true },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
