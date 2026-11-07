import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import { readFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"
// Row 45 (file_requests row 111, row 31 D9): the datum-studio-host utility process loads the Studio host barrel
// through `virtual:datum-studio-host`; Studio's vendored sources import `@/...` = vendor/src/ (its tsconfig paths).
const DATUM_STUDIO_DIR = path.resolve("../datum-studio")
const DATUM_STUDIO_HOST = path.join(DATUM_STUDIO_DIR, "src/mcp-host/index.ts")
const DATUM_STUDIO_VENDOR_SRC = path.join(DATUM_STUDIO_DIR, "vendor/src")

// Read as text: electron-vite runs this config under Node, and stage-library.ts only loads under Bun.
const knowledgeLibraryCommit = (() => {
  const match = readFileSync("./scripts/stage-library.ts", "utf8").match(/^\s*sourceCommit: "([0-9a-f]{40})",$/m)
  if (!match) throw new Error("stage-library.ts: pinned sourceCommit not found")
  return match[1]
})()

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        // datum-studio-host: out/main/datum-studio-host.js, the default entryPath of src/main/datum-studio-host/start.ts.
        input: {
          index: "src/main/index.ts",
          sidecar: "src/main/sidecar.ts",
          "datum-studio-host": "src/main/datum-studio-host.ts",
        },
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        // The main preset's `node` condition picks `#sqlite` -> sqlite.node.ts (node:sqlite under Electron's Node).
        // `@/` is mapped only for importers inside packages/datum-studio, so no other main source changes meaning.
        name: "datum:studio-host-module",
        enforce: "pre",
        resolveId(id, importer) {
          if (id === "virtual:datum-studio-host") return DATUM_STUDIO_HOST
          if (!id.startsWith("@/") || !importer?.startsWith(DATUM_STUDIO_DIR + path.sep)) return
          return this.resolve(path.join(DATUM_STUDIO_VENDOR_SRC, id.slice(2)), importer, { skipSelf: true })
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    define: {
      "import.meta.env.KNOWLEDGE_LIBRARY_COMMIT": JSON.stringify(knowledgeLibraryCommit),
    },
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
