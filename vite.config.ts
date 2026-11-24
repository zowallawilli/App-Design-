import { defineConfig } from "vite";

// base "./" erlaubt das Hosten in einem Unterordner (z. B. GitHub Pages).
export default defineConfig({
  base: "./",
  build: { chunkSizeWarningLimit: 1500 },
});
