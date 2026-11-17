// Swarm 1.3.3 row 72 test fixture (not a test file): a document mission whose deliverables carry row 71's
// `projectFiles` (copies in <project>/deliverables/<mission>/). Synthetic only.
import type { MissionGetWire } from "./mission-model"

export const DIR72 = "/work/proj-72"
export const M72 = "2026-11-17_m72"
export const PDF_D = "012-GSP-KT-XI-2026 RevD rev256.pdf"
export const DOCX_D = "012-GSP-KT-XI-2026 RevD rev256.docx"
export const HTML_D = "012-GSP-KT-XI-2026 RevD rev256.html"
export const PDF_C = "012-GSP-KT-XI-2026 RevC rev201.pdf"
export const sha = (c: string) => c.repeat(64)

export function fixture72(dir = DIR72): MissionGetWire {
  const file = (name: string, format: string, docRev: string, revisionNo: number, latest: boolean, present = true) => ({
    path: `deliverables/${M72}/${name}`,
    absolutePath: `${dir}/deliverables/${M72}/${name}`,
    format,
    docRev,
    revisionNo,
    sha256: sha("a"),
    latest,
    present,
  })
  return {
    mission: {
      id: M72,
      title: "Row 72",
      type: "document",
      status: "running",
      rows: [
        { id: "1", phase: "draft", title: "Write kajian", agent: "document-writer", status: "needs-review" },
        { id: "2", phase: "draft", title: "Annex", agent: "document-writer", status: "running" },
        { id: "3", phase: "draft", title: "Notes", agent: "document-writer", status: "running" },
      ],
    },
    derived: {
      phases: [{ id: "draft", name: { id: "Draf", en: "Draft" }, order: 1, rows: ["1", "2", "3"], counts: {} as never }],
      waves: [{ wave: 1, rows: ["1", "2", "3"] }],
      progress: { done: 0, total: 3 },
      checkpoints: {},
    },
    deliverables: [
      {
        documentId: "doc-d",
        title: "Kajian 72",
        docKey: "row-1-kajian",
        docRev: "Rev D",
        revisionNo: 256,
        verified: true,
        outputs: [{ fileId: "d1", format: "PDF", role: "PRIMARY", finalFileName: "012-GSP-KT-XI-2026_rev256_20261117T101010Z_abcdef12.pdf", verified: true }],
        hasProjectCopy: true,
        projectFiles: [
          file(PDF_D, "PDF", "D", 256, true),
          file(DOCX_D, "DOCX", "D", 256, true),
          file(HTML_D, "HTML", "D", 256, true),
          file(PDF_C, "PDF", "C", 201, false),
        ],
      },
      {
        documentId: "doc-gone",
        title: "Lampiran 72",
        docKey: "row-2-lampiran",
        docRev: "Rev A",
        revisionNo: 7,
        verified: true,
        outputs: [{ fileId: "g1", format: "PDF", role: "PRIMARY", finalFileName: "099-GSP-KT-XI-2026_rev7_20261117T101010Z_abcdef12.pdf", verified: true }],
        hasProjectCopy: true,
        projectFiles: [file("099-GSP-KT-XI-2026 RevA rev7.pdf", "PDF", "A", 7, true, false)],
      },
      {
        documentId: "doc-none",
        title: "Catatan 72",
        docKey: "row-3-catatan",
        docRev: "Rev A",
        verified: false,
        outputs: [],
        hasProjectCopy: false,
      },
    ],
  } as MissionGetWire
}
