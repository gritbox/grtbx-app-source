import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "/surface/" because that is where this app is served: a Vite dev server
// the bridge spawns and reverse-proxies under that path. `http-proxy` does no
// path rewriting, so any other value breaks asset resolution behind the proxy.
// Declared here rather than rewritten at seed time — provisioning used to `sed`
// this line, which meant a local copy could drift from the Sprite and give a
// passing local run against a broken deployment (ADR-014).
// Dev proxy points the WS at a locally-running bridge (default :8080).
export default defineConfig({
  base: "/surface/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
    },
  },
});
