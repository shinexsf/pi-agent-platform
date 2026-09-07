import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// Production assets and preview use the server's /web/ mount; local dev uses /.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/web/' : '/',
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
}));
