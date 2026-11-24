import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev -w @wander/web` proxies /api to the local server. Build output goes to dist/ui, served by the server.
export default defineConfig({
  plugins: [react()],
  base: '/ui/',
  build: { outDir: 'dist/ui', assetsDir: '', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4317' } },
});
