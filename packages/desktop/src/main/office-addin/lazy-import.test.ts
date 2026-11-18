// Plan row M3-02: lazy X.509 import guard (IA-5, C13 OQ-2; register §3 "Lazy X.509 rule").
// `index.ts` and `menu.ts` must never load `pkijs`, `asn1js` or the certificate module through a static import, directly
// or through any module they statically import. The guard reads source: Bun's transpiler lists each file's imports
// with their kind (type-only imports are erased; `import()` is kind "dynamic-import" and is not followed).
import { describe, expect, test } from "bun:test"
import { dirname, join, relative } from "node:path"

const MAIN = join(import.meta.dir, "..")
const SRC = join(MAIN, "..")
const FORBIDDEN_PACKAGES = ["pkijs", "asn1js"]
const CERT_MODULES = ["certs.ts", "keychain.ts", "renewal.ts"].map((name) => join(import.meta.dir, name))
const transpiler = new Bun.Transpiler({ loader: "ts" })

/** Every module reachable from `entry` by static imports inside the desktop `src/`, plus the bare packages they name. */
async function staticClosure(entry: string) {
  const files = new Set<string>()
  const packages = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (files.has(file)) continue
    files.add(file)
    const imports = transpiler.scanImports(await Bun.file(file).text()).filter((item) => item.kind !== "dynamic-import")
    for (const item of imports) {
      if (!item.path.startsWith(".")) {
        packages.add(item.path.startsWith("@") ? item.path.split("/").slice(0, 2).join("/") : item.path.split("/")[0]!)
        continue
      }
      const resolved = Bun.resolveSync(item.path, dirname(file))
      if (!/\.(ts|tsx)$/.test(resolved) || relative(SRC, resolved).startsWith("..")) continue
      queue.push(resolved)
    }
  }
  return { files, packages }
}

describe("IA-5 lazy X.509 import", () => {
  for (const entry of ["index.ts", "menu.ts"]) {
    test(`${entry} never statically reaches certs.ts, keychain.ts, renewal.ts, pkijs or asn1js`, async () => {
      const closure = await staticClosure(join(MAIN, entry))
      expect(closure.files.size).toBeGreaterThan(1)
      expect(CERT_MODULES.filter((file) => closure.files.has(file))).toEqual([])
      expect(FORBIDDEN_PACKAGES.filter((name) => closure.packages.has(name))).toEqual([])
    })
  }

  test("the guard detects a static path to certs.ts and pkijs (self-check)", async () => {
    const closure = await staticClosure(join(import.meta.dir, "renewal.ts"))
    expect(closure.files.has(join(import.meta.dir, "certs.ts"))).toBe(true)
    expect(closure.packages.has("pkijs")).toBe(true)
    expect(closure.packages.has("asn1js")).toBe(true)
  })

  test("type-only and dynamic imports are not followed (self-check)", async () => {
    // key-custody.ts imports certs.ts only as `import type`.
    const custody = await staticClosure(join(import.meta.dir, "key-custody.ts"))
    expect(custody.files.has(join(import.meta.dir, "certs.ts"))).toBe(false)
    expect(transpiler.scanImports('const m = await import("./certs")').map((item) => item.kind)).toEqual(["dynamic-import"])
    expect(transpiler.scanImports('import type { X } from "./certs"\nexport const y = 1')).toEqual([])
  })
})
