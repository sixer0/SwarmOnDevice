// Row 69: "lock seam off" for the guard-level scenario (spec §8 Op 3 render half, U.8, §9 row 69 (2)).
// Loaded ONLY with `bun test --preload` by lock-off.child.ts (or by hand for the P6 mutation run). It serves a
// scratch copy of vendor/.../services/templates/form-lock.ts in which the P6 rule (locked categories) never fires.
// The real file is read, never written. If the P6 line is not found the preload throws, so a changed form-lock.ts
// cannot silently turn this into a no-op.
import { plugin } from "bun"
import { readFileSync } from "node:fs"

export const P6_LINE = "if (LOCKED_CATEGORIES.includes(category) && !P6_ALLOW_KEYS.includes(c.key) && !essentialField) {"

plugin({
  name: "row69-form-lock-p6-off",
  setup(build) {
    build.onLoad({ filter: /\/services\/templates\/form-lock\.ts$/ }, (args) => {
      const src = readFileSync(args.path, "utf8")
      if (!src.includes(P6_LINE)) throw new Error(`row69 lock-off preload: P6 line not found in ${args.path}`)
      ;(globalThis as { __row69LockOff?: string }).__row69LockOff = args.path
      return { contents: src.replace(P6_LINE, "if (false /* row69 scratch copy: P6 removed */) {"), loader: "ts" }
    })
  },
})
