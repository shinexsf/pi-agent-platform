import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// pi-agent-web: browser SPA, served by pi-agent-server under /web/.
// base: '/web/' so built index.html references '/web/assets/...', matching the
// server's mountStaticDir('/web/', ...) route.
export default defineConfig({
  base: '/web/',
  plugins: [vue(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ['10.10.1.2', 'localhost'],
    proxy: {
      '/api': 'http://localhost:3000',
      '/debug': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});