import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    proxy: {
      '/auth': 'http://localhost:8000',
      '/files': 'http://localhost:8000',
      '/storage': 'http://localhost:8000',
      '/api': 'http://localhost:8000',
      '/chat': { target: 'http://localhost:8000', ws: true },
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
