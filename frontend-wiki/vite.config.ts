import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth': 'http://localhost:8000',
      '/files': 'http://localhost:8000',
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
