import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
// Порт бэкенда настраиваемый — удобно поднимать локальную копию рядом с рабочей.
const BACKEND = process.env.BACKEND ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    proxy: {
      '/auth': BACKEND,
      '/files': BACKEND,
      '/storage': BACKEND,
      '/api': BACKEND,
      '/chat': { target: BACKEND, ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          hljs: ['highlight.js'],
        },
      },
    },
  },
})
