// Builds the server the way script/build-node.ts does, next to the entry test/runtime/node-sidecar.test.ts runs on Node.
import path from "node:path"

const packageDir = path.resolve(import.meta.dir, "../..")
const built = await Bun.build({
  target: "node",
  entrypoints: [path.join(packageDir, "src/node.ts"), path.join(packageDir, "test/fixture/node-runtime-entry.ts")],
  outdir: process.argv[2]!,
  format: "esm",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: { OPENCODE_MODELS_DEV: "{}", OPENCODE_VERSION: "'0.0.0'", OPENCODE_CHANNEL: "'local'" },
  files: { "opencode-web-ui.gen.ts": "" },
})
if (!built.success) process.exit(1)
