import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// Pane build. Output goes to dist/pane (register §3 "Pane build output"); the desktop
// staging script copies it into the packaged app. `base: "./"` keeps asset URLs
// relative so the bridge can serve the pane from any path prefix.
// C52 / C66 F-5: the production build (`vite build`, mode "production", what the desktop
// stage runs) writes no source maps; `vite build --mode development` keeps them for debugging.
// Asset names stay content-hashed (vite default, C26(b)).
export default defineConfig(({ mode }) => ({
  plugins: [solid()],
  base: "./",
  build: {
    target: "esnext",
    outDir: "dist/pane",
    emptyOutDir: true,
    sourcemap: mode !== "production",
  },
}))
