import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
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
});