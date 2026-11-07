// Row 162c (C126, C153): what `elkjs/lib/elk.bundled.js` means inside the electron-vite main build.
//
// elk.bundled.js (elkjs 0.12.0, EPL-2.0 OR GPL-3.0-or-later) is shipped as its OWN byte-unmodified file at
// Res/datum-studio/third_party/elkjs/elk.bundled.js with LICENSE.md and NOTICE.md beside it
// (scripts/stage-datum-studio.ts), never inlined into the mixed host chunk. The `datum:elk-runtime` plugin of
// electron.vite.config.ts resolves the adapter's `import ELK from "elkjs/lib/elk.bundled.js"`
// (datum-studio vendor engine/diagram/elk/adapter.ts) to THIS module, which loads the staged file with Node's
// require at the first `new ELK()`. Bun tests of the adapter import the npm file directly and never see this module.
//
// Where the file is: the host gets STUDIO_VENDOR_ROOT = layout.vendorRoot (lifecycle.ts createHostEnv), which is
// Res/datum-studio (packaged) or packages/desktop/.datum-studio-stage (staged dev). Those roots carry
// studio-manifest.json and then ONLY the staged copy is used. The repo layout (no stage; vendorRoot =
// packages/datum-studio/vendor) falls back to the package's own node_modules/elkjs, dev only.
//
// The require runs lazily inside the constructor, so a missing file is an exception thrown by `new ELK()`, which the
// adapter turns into ElkUnavailable (the old layout then stands); the host chunk itself always loads. The module
// evaluation also runs inside the adapter's L4 guard (`self` hidden for the construction call).
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"

/** The staged file, relative to the Studio root (Res/datum-studio). */
export const ELK_STAGE_DIR = "third_party/elkjs"
export const ELK_STAGE_BUNDLE = `${ELK_STAGE_DIR}/elk.bundled.js`
const STAGE_MANIFEST = "studio-manifest.json"

type ElkCtor = new (options?: unknown) => object

/** The one file this process may load, or a reason why there is none. */
export function resolveElkBundle(env: Record<string, string | undefined> = process.env): { file: string } | { error: string } {
  const root = env.STUDIO_VENDOR_ROOT
  if (!root) return { error: "STUDIO_VENDOR_ROOT is not set" }
  const staged = join(root, ...ELK_STAGE_BUNDLE.split("/"))
  if (existsSync(join(root, STAGE_MANIFEST))) {
    return existsSync(staged) ? { file: staged } : { error: `${ELK_STAGE_BUNDLE} missing under the staged Studio root` }
  }
  // Repo layout (dev only): <pkg>/vendor -> <pkg>/node_modules/elkjs/lib/elk.bundled.js.
  const dev = join(root, "..", "node_modules", "elkjs", "lib", "elk.bundled.js")
  return existsSync(dev) ? { file: dev } : { error: "elkjs/lib/elk.bundled.js not found beside the repo vendor root" }
}

const loaded = new Map<string, ElkCtor>()

export function loadElkConstructor(env: Record<string, string | undefined> = process.env): ElkCtor {
  const where = resolveElkBundle(env)
  if ("error" in where) throw new Error(`ELK_BUNDLE_MISSING: ${where.error}`)
  const cached = loaded.get(where.file)
  if (cached) return cached
  // third_party/elkjs/package.json says "type": "commonjs", so the UMD file takes its CommonJS branch.
  const mod = createRequire(where.file)(where.file) as ElkCtor | { default?: ElkCtor }
  const ctor = typeof mod === "function" ? mod : mod?.default
  if (typeof ctor !== "function") throw new Error("ELK_BUNDLE_INVALID: elk.bundled.js did not export a constructor")
  loaded.set(where.file, ctor)
  return ctor
}

/** Stand-in for the bundle's default export: `new ELK(opts)` returns the real ELK instance. */
function ELK(options?: unknown): object {
  const Ctor = loadElkConstructor()
  return new Ctor(options)
}

export default ELK as unknown as ElkCtor
