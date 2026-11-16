import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// Pane build. Output goes to dist/pane (register §3 "Pane build output"); the desktop
// staging script copies it into the packaged app. `base: "./"` keeps asset URLs
// relative so the bridge can serve the pane from any path prefix.
export default defineConfig({
  plugins: [solid()],
  base: "./",
  build: {
    target: "esnext",
    outDir: "dist/pane",
    emptyOutDir: true,
    sourcemap: true,
  },
})
