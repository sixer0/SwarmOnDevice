// Swarm 1.3.3 row 84 (ST-12), replay R6: project 1 revision 44, the manuscript whose semicolons were replaced by
// full stops mid-sentence (review finding R-07 of 03_render_rev44_review.md). Reads the paragraph and list blocks of
// that revision's snapshot from R6_project1_rev44_rev100/revisions_43_44_45_99_100_101_full.jsonl under
// SWARM_REPLAY_DIR (row 146: the owner's study text is not kept in the repository; skipped when the variable is unset).
// The rule's behaviour without the replay is pinned by row84-lowercase-after-stop.test.ts.
import { describe, expect, test } from "bun:test"
import { buildContext, LANGUAGE_SCANNERS } from "../../vendor/src/lib/studio/engine/lint/language/checks"
import { findLowercaseAfterStop } from "../../vendor/src/lib/studio/engine/lint/language/lowercase-after-stop"
import { extractLayers } from "../../vendor/src/lib/studio/engine/lint/language/prose"
import { r6Prose, replayInputs } from "../replay-dir"

const R6 = replayInputs("row 84 replay R6", ["R6_project1_rev44_rev100/revisions_43_44_45_99_100_101_full.jsonl"] as const)
const fx = R6.present ? r6Prose(R6.paths[0], 44) : { revisionNo: 0, language: "", blocks: [] }
const layers = extractLayers({ doc: { meta: { language: fx.language } }, blocks: fx.blocks } as never)
const hits = layers.prose.flatMap((u) => findLowercaseAfterStop(u.text).map((h) => ({ address: u.address, ...h })))

describe.skipIf(!R6.present)("row 84 replay R6: revision 44 triggers C-35", () => {
  test("the fixture is revision 44 of the replayed document", () => {
    expect(fx.revisionNo).toBe(44)
    expect(fx.language).toBe("ID")
    expect(layers.prose).toHaveLength(52)
  })
  test("63 findings in 31 of the 52 prose paragraphs", () => {
    expect(hits).toHaveLength(63)
    expect(new Set(hits.map((h) => h.address)).size).toBe(31)
  })
  test("the sentence the review quoted (R-07) is found, with its paragraph", () => {
    const at = hits.filter((h) => h.address === "4.6.1").map((h) => h.excerpt)
    expect(at).toEqual([
      "…(KATALOG-RUMUS.md:408-416. aturan WS wajib bila > 64…",
      "…WS wajib bila > 64 kB. defect halaman K-3…",
      "…untuk semua jalur ≥ 25 km. verifikasi RTT terukur.",
    ])
  })
  test("three more findings, quoted", () => {
    const all = hits.map((h) => `${h.address} ${h.excerpt}`)
    expect(all).toContain("1.0.1 …BLOCKER, 8 MAJOR, 12 MINOR. seluruhnya…")
    expect(all).toContain("2.4.1 …dan pondasi menara. audit penangkal petir…")
    expect(all).toContain("6.0.1 …diperbarui hasil tinjauan. dua risiko baru…")
  })
  test("the exceptions in the same manuscript stay quiet: abbreviation, ellipsis, units, symbols, identifiers, pipe rows", () => {
    const wordsAt = (address: string) => hits.filter((h) => h.address === address).map((h) => h.word)
    expect(wordsAt("4.11.1")).toEqual(["hasil"]) // "s.d. kedalaman" is not a finding
    expect(wordsAt("3.5.1")).toEqual(["verifikasi", "dokumen"]) // "00_... dan 01_..." is not
    expect(wordsAt("4.7.1")).toEqual(["kurva", "margin"]) // "). kVA ≥" and "). η = 0,90" are not
    expect(wordsAt("4.8.1")).toEqual([]) // "). t = 2 jam"
    expect(wordsAt("4.12.2")).toEqual(["kolom"]) // "m. h = 48", "m. h = 54", "m. h = 60", "kritis. h = 75"
    expect(wordsAt("4.8.3")).toEqual(["penjumlahan", "skenario", "pembanding", "surfaced"]) // "Ah. m12:" is not
    expect(wordsAt("A.0.3")).toEqual([]) // a pipe table row stored as a paragraph
  })
  test("the scanner reports them as warnings only: 31 REPORT, no FAIL, each with its paragraph address", () => {
    const out = LANGUAGE_SCANNERS["C-35"](buildContext(layers, {}, "ID"))
    expect(out).toHaveLength(31)
    expect(out.every((i) => i.status === "REPORT" && typeof i.address === "string")).toBe(true)
  })
})
