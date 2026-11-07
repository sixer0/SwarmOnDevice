// Row 132 test fixture (not a test file): a document mission with five deliverables covering every §7.2 state.
// Row 136b (M5): `verified` / `final` per deliverable are what the host computes with the store rule; the app shows them.
import type { MissionGetWire } from "./mission-model"

export const PDF_A = "Kajian-DATUM_rev1_20261107T101010Z_abcdef12.pdf"
export const DOCX_A = "Kajian-DATUM_rev1_20261107T101010Z_abcdef12.docx"
export const HTML_C = "Catatan_rev0_20261107T111111Z_0123abcd.html"

export function fixture(): MissionGetWire {
  return {
    mission: {
      id: "m-doc-1",
      title: "Kajian DATUM",
      type: "document",
      status: "running",
      rows: [
        { id: "1", phase: "draft", title: "Write kajian", agent: "document-writer", status: "done" },
        { id: "2", phase: "verify", title: "Contract tests", agent: "test-expert", status: "needs-review" },
        { id: "3", phase: "draft", title: "Notes", agent: "document-writer", status: "running" },
        { id: "4", phase: "draft", title: "Annex", agent: "document-writer", status: "done" },
      ],
    },
    derived: {
      phases: [
        { id: "draft", name: { id: "Draf", en: "Draft" }, order: 1, rows: ["1", "3", "4"], counts: {} as never },
        { id: "verify", name: { id: "Verifikasi", en: "Verify" }, order: 2, rows: ["2"], counts: {} as never },
      ],
      waves: [{ wave: 1, rows: ["1", "2", "3", "4"] }],
      progress: { done: 2, total: 4 },
      checkpoints: {},
    },
    deliverables: [
      {
        documentId: "doc-a",
        title: "Kajian DATUM",
        docKey: "row-1-kajian",
        docRev: "Rev A",
        verified: true,
        final: true,
        outputs: [
          { fileId: "f1", format: "DOCX", role: "PRIMARY", finalFileName: DOCX_A, verified: true },
          { fileId: "f2", format: "PDF", role: "PRIMARY", finalFileName: PDF_A, verified: true },
          { fileId: "f3", format: "SVG", role: "FIGURE", finalFileName: "fig.svg", verified: true },
        ],
      },
      {
        documentId: "doc-b",
        title: "Laporan Uji <b>Kontrak</b>",
        docKey: "row-2-uji",
        docRev: "Rev B",
        verified: false,
        final: false,
        outputs: [
          { fileId: "f4", format: "PDF", role: "PRIMARY", finalFileName: "Uji_rev2_20261107T121212Z_11112222.pdf", verified: true },
          { fileId: "f5", format: "DOCX", role: "PRIMARY", finalFileName: "Uji_rev2_20261107T121212Z_11112222.docx", verified: false },
        ],
      },
      {
        documentId: "doc-c",
        title: "Catatan",
        docKey: "row-3-catatan",
        docRev: "Rev A",
        verified: true,
        final: true,
        outputs: [{ fileId: "f6", format: "HTML", role: "PRIMARY", finalFileName: HTML_C, verified: true }],
      },
      { documentId: "doc-d", title: "Loose", docKey: "loose", docRev: "Rev A", verified: false, final: false, outputs: [] },
      {
        // row done, but the verification state is not "verified" (C127 ruling 1): Unverified, never Final
        documentId: "doc-e",
        title: "Annex",
        docKey: "row-4-annex",
        docRev: "Rev A",
        verified: false,
        final: false,
        outputs: [
          {
            fileId: "f7",
            format: "PDF",
            role: "PRIMARY",
            finalFileName: "Annex_rev1_20261107T131313Z_33334444.pdf",
            verified: "unknown" as unknown as boolean,
          },
        ],
      },
    ],
  }
}
