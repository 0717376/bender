import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Backend port is configurable so we can run on an unusual local port.
const BACKEND = process.env.BACKEND ?? "http://127.0.0.1:8077";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/auth": BACKEND,
      "/tasks": BACKEND,
      "/files": BACKEND,
      "/api": BACKEND,
      "/health": BACKEND,
      "/chat": { target: BACKEND, ws: true },
    },
  },
});
