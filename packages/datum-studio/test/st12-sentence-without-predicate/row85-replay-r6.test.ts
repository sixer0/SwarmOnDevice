// Swarm 1.3.3 row 85 (ST-12), replay R6: project 1 revision 44 (the manuscript written as note fragments joined by
// full stops) and revision 100 of the same document (rewritten as whole sentences; user review of the render:
// "Prosa: kalimat utuh"). Both are read from R6_project1_rev44_rev100/revisions_43_44_45_99_100_101_full.jsonl under
// SWARM_REPLAY_DIR (paragraph and list blocks, as row 84's replay; row 146: the owner's study text is not kept in the
// repository, so these tests skip when the variable is unset). Without the replay the rule is pinned by
// row85-sentence-without-predicate.test.ts.
import { describe, expect, test } from "bun:test"
import { buildContext, LANGUAGE_SCANNERS } from "../../vendor/src/lib/studio/engine/lint/language/checks"
import { extractLayers } from "../../vendor/src/lib/studio/engine/lint/language/prose"
import { findSentencesWithoutPredicate } from "../../vendor/src/lib/studio/engine/lint/language/sentence-without-predicate"
import { splitSentences } from "../../vendor/src/lib/studio/engine/lint/language/tokenize"
import { releaseFor } from "../../vendor/src/lib/studio/services/render/lint"
import { runLint } from "../../vendor/src/lib/studio/engine/lint/scan"
import { useStudioEnv } from "../ported/_env"
import { canonicalTemplate, makeDoc, snapshotOf } from "../ported/engine-core/fixtures"
import { r6Prose, replayInputs } from "../replay-dir"

const R6 = replayInputs("row 85 replay R6", ["R6_project1_rev44_rev100/revisions_43_44_45_99_100_101_full.jsonl"] as const)
const load = (revisionNo: number) => {
  const fx = R6.present ? r6Prose(R6.paths[0], revisionNo) : { documentId: "", revisionNo: 0, language: "", blocks: [] }
  const layers = extractLayers({ doc: { meta: { language: fx.language } }, blocks: fx.blocks } as never)
  const hits = layers.prose.flatMap((u) => findSentencesWithoutPredicate(u.text, "ID").map((h) => `${u.address} ${h.sentence}`))
  return { fx, layers, hits }
}
const rev44 = load(44)
const rev100 = load(100)

describe.skipIf(!R6.present)("row 85 replay R6: revision 44 triggers C-36", () => {
  test("the fixture is revision 44 of the replayed document", () => {
    expect(rev44.fx.revisionNo).toBe(44)
    expect(rev44.fx.language).toBe("ID")
    expect(rev44.layers.prose).toHaveLength(52)
  })
  test("18 sentences without a predicate in 10 of the 52 prose paragraphs, each read and confirmed", () => {
    expect(rev44.hits).toEqual([
      '2.0.1 Klien fiktif "Badan Penanggulangan Daerah Provinsi Nusa Raya".',
      "2.4.1 audit penangkal petir eksisting.",
      "2.4.1 perencanaan anggaran rupiah (HRS/RAB), pengadaan, kontrak, jadwal konstruksi.",
      "2.4.1 subsistem lain (AC presisi, fire suppression, akses kontrol, satelit, radio eksisting) kecuali antarmukanya.",
      "2.4.1 survei dan pengukuran lapangan.",
      "2.4.1 keamanan siber tingkat kebijakan (hanya catatan segmentasi).",
      "2.5.1 Bab 5 arsitektur dan figur.",
      "2.5.1 Bab 7 rekomendasi dan uji terima.",
      "2.5.1 Lampiran A asumsi (A-01…A-32), Lampiran B sumber, Lampiran C penunjuk grafik.",
      "4.3.1 Geometri n dan aras = asumsi uji (A-26.",
      "4.4.3 Vonis = vonis uji, bukan klaim kepatuhan (F3.",
      "4.10.1 rumus dasar KATALOG-RUMUS.md:385-390 §10 (Mahon, PDF 136.",
      "4.11.4 Sasaran ≤5 Ω = persyaratan pemilik fiktif (A-23.",
      "A.0.5 pengganti = pengukuran instalasi percobaan.",
      "A.0.6 konvensi akhir-umur 80 % IEEE 485.",
      "A.0.6 nama kelas optik IEEE 802.3.",
      "A.0.6 praktik cakram/hot spare.",
      "B.0.1 Root <RAK> = /Applications/Swarm.app/Contents/Resources/knowledge-library/4 Knowledge Bank/ekas-lapis-teks.",
    ])
    expect(new Set(rev44.hits.map((h) => h.split(" ")[0])).size).toBe(10)
  })
  test("sentences of the same manuscript that carry a predicate stay quiet", () => {
    const quietAt = (address: string) => rev44.hits.filter((h) => h.startsWith(`${address} `))
    expect(quietAt("1.0.1")).toEqual([]) // "tidak ada pernyataan ... sebagai fakta.", "... masih terbuka."
    expect(quietAt("4.5.4")).toEqual([]) // "2+1 lebih buruk daripada 1+1", "Dilarang dikutip ..."
    expect(quietAt("4.12.2")).toEqual([]) // "IEC tidak menyajikan ...", "Tinggi struktur menara tidak ada di kontrak"
    expect(quietAt("A.0.3")).toEqual([]) // a pipe table row stored as a paragraph
    expect(rev44.hits).not.toContain("2.5.1 Bab 6 risiko.") // under four words
    expect(rev44.hits).not.toContain("2.4.1 Pekerjaan sipil/struktur dan pondasi menara.") // first short sentence: read as a run-in heading
  })
  test("the scanner reports them as warnings only: 10 REPORT, no FAIL, each with its paragraph address; release is not held", () => {
    const out = LANGUAGE_SCANNERS["C-36"](buildContext(rev44.layers, {}, "ID"))
    expect(out).toHaveLength(10)
    expect(out.every((i) => i.status === "REPORT" && typeof i.address === "string")).toBe(true)
    expect(out.find((i) => i.address === "4.10.1")!.detail).toContain('"rumus dasar KATALOG-RUMUS.md:385-390 §10 (Mahon, PDF 136."')
    for (const tier of ["TERBIT", "SERAH"] as const) expect(releaseFor(out, tier)).toBe("PASS")
  })
})

describe.skipIf(!R6.present)("row 85 replay R6: revision 100 (the rewritten manuscript) is the clean real text", () => {
  test("the fixture is revision 100 of the same document", () => {
    expect(rev100.fx.revisionNo).toBe(100)
    expect(rev100.fx.documentId).toBe(rev44.fx.documentId)
    expect(rev100.layers.prose).toHaveLength(121)
    expect(rev100.layers.prose.flatMap((u) => splitSentences(u.text))).toHaveLength(292)
  })
  test("no finding in 292 sentences; the scanner returns PASS", () => {
    expect(rev100.hits).toEqual([])
    expect(LANGUAGE_SCANNERS["C-36"](buildContext(rev100.layers, {}, "ID")).map((i) => i.status)).toEqual(["PASS"])
  })
})

// Through the real lint entry point (engine/lint/scan runLint, the runner the render and ingest paths call), with the
// replay blocks placed in a canonical TERBIT snapshot. C-36 is live since row 86 removed its staged marker.
describe.skipIf(!R6.present)("row 85 replay R6 through runLint", () => {
  useStudioEnv()
  const run = (blocks: unknown[]) => {
    const base = snapshotOf(makeDoc({ tier: "TERBIT" }))
    const snapshot = { ...base, doc: { ...base.doc, meta: { ...base.doc.meta, language: "ID" } }, blocks }
    return runLint({ snapshot: snapshot as never, tpl: canonicalTemplate(), tier: "TERBIT", stage: "post" }).checks.filter((c) => c.checkId === "C-36")
  }
  const sentences = (checks: ReadonlyArray<{ detail?: string }>) =>
    checks.reduce((a, c) => a + Number(/: (\d+) kalimat tanpa predikat/u.exec(c.detail ?? "")?.[1] ?? 0), 0)
  test("revision 44: 10 REPORT, 18 sentences, no FAIL; C-36 alone does not hold release", () => {
    const c36 = run(rev44.fx.blocks)
    expect(c36.map((c) => c.status)).toEqual(Array(10).fill("REPORT"))
    expect(sentences(c36)).toBe(18)
    expect(releaseFor(c36, "TERBIT")).toBe("PASS")
  })
  test("revision 100: PASS, 0 sentences", () => {
    const c36 = run(rev100.fx.blocks)
    expect(c36.map((c) => c.status)).toEqual(["PASS"])
    expect(sentences(c36)).toBe(0)
  })
})
