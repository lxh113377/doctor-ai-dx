import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './'：构建产物 dist/ 可作为静态站点直接托管（本地演示双击 index.html 也可）
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      // 开发期：/api 与 /health 代理到本地 FastAPI
      '/api': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
    proxy: {
      // 生产预览（dist 静态托管）：同样代理 API 到本地 FastAPI
      '/api': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
    },
  },
  build: { outDir: 'dist', assetsDir: 'assets' },
})