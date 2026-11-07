// Row 162c: where the built host loads elk.bundled.js from (staged copy only when a studio-manifest.json is present).
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ELK_STAGE_BUNDLE, loadElkConstructor, resolveElkBundle } from "./elk-runtime"

const tmp = () => realpathSync(mkdtempSync(join(process.env.ROW162C_TEST_DIR ?? tmpdir(), "elk-runtime-")))

describe("row 162c: elk-runtime resolveElkBundle", () => {
  test("no STUDIO_VENDOR_ROOT -> error, and the constructor load throws ELK_BUNDLE_MISSING", () => {
    expect(resolveElkBundle({})).toEqual({ error: "STUDIO_VENDOR_ROOT is not set" })
    expect(() => loadElkConstructor({})).toThrow(/^ELK_BUNDLE_MISSING: STUDIO_VENDOR_ROOT is not set$/)
  })

  test("a staged root (studio-manifest.json) uses ONLY its third_party copy, never a node_modules fallback", () => {
    const root = join(tmp(), "Res", "datum-studio")
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "studio-manifest.json"), "{}")
    // a node_modules copy beside it must not be picked up
    mkdirSync(join(root, "..", "node_modules", "elkjs", "lib"), { recursive: true })
    writeFileSync(join(root, "..", "node_modules", "elkjs", "lib", "elk.bundled.js"), "")
    expect(resolveElkBundle({ STUDIO_VENDOR_ROOT: root })).toEqual({ error: `${ELK_STAGE_BUNDLE} missing under the staged Studio root` })
    mkdirSync(join(root, "third_party", "elkjs"), { recursive: true })
    writeFileSync(join(root, ...ELK_STAGE_BUNDLE.split("/")), "")
    expect(resolveElkBundle({ STUDIO_VENDOR_ROOT: root })).toEqual({ file: join(root, "third_party", "elkjs", "elk.bundled.js") })
  })

  test("the repo layout (vendor root, no manifest) falls back to the datum-studio package's elkjs", () => {
    const vendor = resolve(import.meta.dir, "..", "..", "..", "..", "datum-studio", "vendor")
    const r = resolveElkBundle({ STUDIO_VENDOR_ROOT: vendor })
    expect(r).toEqual({ file: join(vendor, "..", "node_modules", "elkjs", "lib", "elk.bundled.js") })
    expect(typeof loadElkConstructor({ STUDIO_VENDOR_ROOT: vendor })).toBe("function")
  })
})
