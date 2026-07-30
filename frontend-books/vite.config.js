import { defineConfig } from 'vite'

// Порт бэкенда настраиваемый — удобно поднимать локальную копию рядом с рабочей.
const BACKEND = process.env.BACKEND ?? 'http://localhost:8000'

export default defineConfig({
  server: {
    // Общие токены лежат выше корня приложения — dev-серверу нужно разрешение их читать.
    fs: { allow: ['..'] },
    proxy: {
      '/auth': BACKEND,
      '/files': BACKEND,
      '/storage': BACKEND,
      '/chat': { target: BACKEND, ws: true },
    },
  },
})
