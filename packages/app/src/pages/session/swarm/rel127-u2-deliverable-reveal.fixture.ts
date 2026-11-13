// Swarm 1.2.7 row 26 test fixture (not a test file): a document mission with a Studio PDF delivered into
// docs/<m>/11_deliverables/ (row 28 numbered export) and a Studio DOCX found flat in docs/<m>/ (legacy layout).
// The folder files (.command, .app, notes.md) are given by each test as the 11_deliverables listing. Synthetic only.
import type { MissionGetWire } from "./mission-model"

export const REVEAL_FIXTURE_DIR = "/work/proj-u2"
export const PDF_P = "Kajian-U2_rev1_20261113T101010Z_abcdef12.pdf"
export const DOCX_X = "Lampiran-U2_rev1_20261113T101010Z_12345678.docx"

export function revealFixture(): MissionGetWire {
  return {
    mission: {
      id: "m-u2",
      title: "U2 reveal",
      type: "document",
      status: "running",
      rows: [
        { id: "1", phase: "draft", title: "Write kajian", agent: "document-writer", status: "done" },
        { id: "2", phase: "draft", title: "Annex", agent: "document-writer", status: "running" },
      ],
    },
    derived: {
      phases: [{ id: "draft", name: { id: "Draf", en: "Draft" }, order: 1, rows: ["1", "2"], counts: {} as never }],
      waves: [{ wave: 1, rows: ["1", "2"] }],
      progress: { done: 1, total: 2 },
      checkpoints: {},
    },
    deliverables: [
      {
        documentId: "doc-p",
        title: "Kajian U2",
        docKey: "row-1-kajian",
        docRev: "Rev A",
        verified: true,
        final: true,
        outputs: [{ fileId: "p1", format: "PDF", role: "PRIMARY", finalFileName: PDF_P, verified: true }],
      },
      {
        documentId: "doc-x",
        title: "Lampiran U2",
        docKey: "row-2-annex",
        docRev: "Rev A",
        verified: false,
        final: false,
        outputs: [{ fileId: "x1", format: "DOCX", role: "PRIMARY", finalFileName: DOCX_X, verified: false }],
      },
    ],
  }
}
