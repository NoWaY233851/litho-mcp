import { resolve } from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The widget ships as one self-contained HTML file: it is embedded into the
// server bundle and served as an MCP resource, so it cannot reference assets.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: { input: resolve(import.meta.dirname, "ui/app.html") },
  },
});
