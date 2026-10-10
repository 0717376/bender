import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Порт бэкенда настраиваемый — удобно поднимать локальную копию рядом с рабочей.
const BACKEND = process.env.BACKEND ?? "http://127.0.0.1:8077";
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    host: "127.0.0.1",
    // Общие токены лежат выше корня приложения — dev-серверу нужно разрешение их читать.
    fs: { allow: [".."] },
    proxy: {
      "/auth": BACKEND,
      "/cards": BACKEND,
      "/api": BACKEND,
      "/chat": { target: BACKEND, ws: true },
    },
  },
});
