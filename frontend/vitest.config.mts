import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 组件层红线测试专用配置：与 vite.config.js 分离，构建链零影响
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.jsx'],
    restoreMocks: true,
  },
})
