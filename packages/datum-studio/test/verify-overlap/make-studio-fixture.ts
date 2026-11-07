// Row 151: writes a real Studio HTML release artefact (row 123's v1 fixture through
// normalizeDocument -> assembleHtml, test/engine-rev-a/html/_kit.ts), the known-good page that the real-Electron run
// (packages/desktop/test/datum-render-electron/row151-check-page.test.ts) must pass with 0 findings (spec §9 G1).
// Pure local, no DB, no network, no browser. Run from packages/datum-studio:
//   bun test/verify-overlap/make-studio-fixture.ts <out.html>
// The output (about 2.6 MB, fonts inlined) is written to the given path, never into the repo.
import { writeFileSync } from "node:fs"
import path from "node:path"
import { renderHtml } from "../engine-rev-a/html/_kit"

const r = await renderHtml()
const arg = process.argv[2]
if (!arg) throw new Error("usage: bun test/verify-overlap/make-studio-fixture.ts <out.html>")
const out = path.resolve(arg)
writeFileSync(out, r.html)
console.log(`${out} ${Buffer.byteLength(r.html)} bytes`)
