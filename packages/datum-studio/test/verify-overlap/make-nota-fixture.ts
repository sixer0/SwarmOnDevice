// Row 205 (1.2.3, HB-1): writes a one-page NOTA Studio HTML (the ported parity fixture doc_nota_memo cut to its first
// chapter and first section, tier NOTA, through
// normalizeDocument -> assembleHtml with test/engine-rev-a/html/_kit.ts), the short document the real-Electron run
// (packages/desktop/test/datum-render-electron/row205-flow-viewport.test.ts) must pass OVERLAP_CLIP on.
// Pure local, no DB, no network, no browser. Run from packages/datum-studio:
//   bun test/verify-overlap/make-nota-fixture.ts <out.html>
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { renderHtml } from "../engine-rev-a/html/_kit"

const src = path.join(import.meta.dir, "..", "ported", "_fixtures", "tests", "parity", "fixtures", "doc", "doc_nota_memo.json")
const doc = JSON.parse(readFileSync(src, "utf8"))
// The whole memo prints on 2 pages; its first chapter and section make the one-page nota of the HB-1 report.
doc.chapters = [{ ...doc.chapters[0], sections: [doc.chapters[0].sections[0]] }]
const r = await renderHtml(doc)
const arg = process.argv[2]
if (!arg) throw new Error("usage: bun test/verify-overlap/make-nota-fixture.ts <out.html>")
const out = path.resolve(arg)
writeFileSync(out, r.html)
console.log(`${out} ${Buffer.byteLength(r.html)} bytes`)
