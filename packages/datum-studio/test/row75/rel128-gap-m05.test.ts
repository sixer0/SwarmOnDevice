// Swarm 1.2.8 row 36 (AC-M05, M-05, register N8-383; ledger class PROBE). The 1.2.7 audit gave M-05 no verdict
// (handoff 2026-11-13 §1, row M-02/M-05); its only evidence was a C51 final name `<nomor>_rev<N>_<stamp>_<sha8>.pdf`.
// This probe pins today's documented rule (storage/paths.ts datumFileName, 1.2.6 row 75, U15, N-053/N-054):
//   - the delivered DATUM name of a stored revision is `<Judul> <nomor> Rev<X> rev<N>.<ext>` for every format,
//     the first revision (rev1) included, and passes DATUM_FILENAME_PATTERN;
//   - only a render without a stored revision (template sample) keeps `<Judul> <nomor> Rev<X>.<ext>`;
//   - both stored-revision render services pass the stored number (revision.ts, scope.ts);
//   - the C51 final name carries `_rev<N>_` with the same number, so the two names never disagree.
// The DATUM name is checked end to end through the pure render orchestrator (renderSnapshot, HTML only, no browser,
// no store). Synthetic title and number.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { useStudioEnv } from "../ported/_env"

useStudioEnv()
const K = await import("../engine-rev-a/row143a/_kit")
const { datumFileName, datumFileNameByForm } = await import("../../vendor/src/lib/studio/services/storage/paths")
const { DATUM_FILENAME_PATTERN } = await import("../../vendor/src/lib/studio/contract/env")
const { finalFileNameOf, parseFinalFileName } = await import("../../vendor/src/lib/studio/services/render/final-name")
const { renderSnapshot } = await import("../../vendor/src/lib/studio/services/render/pure/render")

const DATUM = new RegExp(DATUM_FILENAME_PATTERN)
const TITLE = "Laporan Uji Pasang Surut"
const NUM = "002/UJI/NT/XI/2026"
const SERVICES = path.resolve(import.meta.dir, "..", "..", "vendor", "src", "lib", "studio", "services", "render")

describe("rel128 gap M-05: the delivered file name always carries ` rev<N>` for a stored revision", () => {
  test("rule: `<Judul> <nomor> Rev<X> rev<N>.<ext>`, first revision included, every format", () => {
    for (const ext of ["docx", "pdf", "html", "svg", "png"]) {
      for (const n of [0, 1, 2, 258]) {
        const name = datumFileName(TITLE, NUM, "A", ext, n)
        expect(name).toBe(`${TITLE} 002-UJI-NT-XI-2026 RevA rev${n}.${ext}`)
        expect({ name, ok: DATUM.test(name) }).toEqual({ name, ok: true })
      }
    }
    expect(datumFileNameByForm(undefined, { title: TITLE, docNumber: NUM, rev: "B", issueDate: "2026-11-14", revisionNo: 1 }, "pdf")).toBe(
      `${TITLE} 002-UJI-NT-XI-2026 RevB rev1.pdf`,
    )
  })

  test("documented exception: no stored revision (template sample) keeps the pre-1.2.6 form", () => {
    expect(datumFileName(TITLE, NUM, "A", "pdf")).toBe(`${TITLE} 002-UJI-NT-XI-2026 RevA.pdf`)
  })

  test("end to end: renderSnapshot names the HTML output with ` rev<N>` when the service passes the stored number", async () => {
    const snap = K.compose(K.loadCase("case01.json"))
    const tpl = await K.template()
    const withRev = await renderSnapshot(snap as never, tpl, {
      formats: ["HTML"],
      measureLayout: false,
      naming: { title: TITLE, docNumber: NUM, rev: "A", revisionNo: 3 },
    })
    expect(withRev.files.map((f) => f.fileName)).toEqual([`${TITLE} 002-UJI-NT-XI-2026 RevA rev3.html`])
    const sample = await renderSnapshot(snap as never, tpl, { formats: ["HTML"], measureLayout: false, naming: { title: TITLE, docNumber: NUM, rev: "A" } })
    expect(sample.files.map((f) => f.fileName)).toEqual([`${TITLE} 002-UJI-NT-XI-2026 RevA.html`])
  }, 120_000)

  test("both stored-revision render services pass the stored numeric revision into naming", () => {
    const rev = readFileSync(path.join(SERVICES, "revision.ts"), "utf8")
    const scope = readFileSync(path.join(SERVICES, "scope.ts"), "utf8")
    expect(rev).toMatch(/naming:\s*\{[^}]*revisionNo:\s*rev\.revisionNo\s*\}/)
    expect(scope).toMatch(/naming:\s*\{[^}]*revisionNo:\s*plan\.revision\.revisionNo\s*\}/)
  })

  test("the C51 final name carries the same number as `_rev<N>_`", () => {
    const sha = "0123abcd" + "0".repeat(56)
    const final = finalFileNameOf({ createdAt: new Date("2026-11-14T08:00:00Z"), sha256: sha, format: "PDF" }, { docNumber: NUM, revisionNo: 258 })
    expect(final).toBe("002-UJI-NT-XI-2026_rev258_20261114T080000Z_0123abcd.pdf")
    expect(parseFinalFileName(final)?.revisionNo).toBe(258)
  })
})
