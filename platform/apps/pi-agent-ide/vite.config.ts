import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// pi-agent-ide: JCEF 内嵌的 Vue 单页应用（无 vue-router）。
// base: './' 让构建产物用相对路径加载资源（JCEF 加载 /ide/ 时资源路径正确）。
export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});