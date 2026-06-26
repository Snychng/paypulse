import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// @tauri-apps/cli sets TAURI_DEV_HOST when running on a device/emulator
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  // tailwindcss() must come AFTER react() (PLAN §3)
  plugins: [react(), tailwindcss()],

  // `@/` → src/ (mirrors tsconfig paths so Vite resolves it too)
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },

  // Tauri expects a fixed port and fails if it is not available
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Multi-page: one bundle per webview entry (PLAN §1.3 / §4)
  build: {
    target: ["es2022", "chrome110", "safari15"],
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        mini: resolve(__dirname, "mini.html"),
        settings: resolve(__dirname, "settings.html"),
        popover: resolve(__dirname, "popover.html"),
      },
    },
  },

  // Vite envs starting with these prefixes are exposed to the client
  envPrefix: ["VITE_", "TAURI_ENV_*"],
}));
