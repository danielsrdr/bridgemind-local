import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const hub = 'http://127.0.0.1:7777';
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwind()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1500, rollupOptions: { input: { main: at('./web/index.html'), dictation: at('./web/dictation.html') } } },
  server: { port: 5173, proxy: { '/api': hub, '/mcp': hub, '/hook': hub, '/ws': { target: hub, ws: true } } },
});
