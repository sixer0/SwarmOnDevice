// Row 130 test fixtures: one mission per builtin type (masterplan/01_specs_mission_contract.md §3.3), built through the
// real row 129 model so the deck is tested on what the app will feed it.
import { buildMission, type MissionGetWire, type MissionRowWire, type RowStatus } from "./mission-model"

export const TYPE_PHASES: Record<string, Array<[string, string, string]>> = {
  research: [
    ["identification", "Identifikasi", "Identification"],
    ["research", "Riset", "Research"],
    ["synthesis", "Sintesis", "Synthesis"],
    ["report", "Laporan", "Report"],
  ],
  debug: [
    ["reproduce", "Reproduksi", "Reproduce"],
    ["diagnose", "Diagnosis", "Diagnose"],
    ["fix", "Perbaikan", "Fix"],
    ["verify", "Verifikasi", "Verify"],
  ],
  "feature-release": [
    ["identification", "Identifikasi", "Identification"],
    ["research", "Riset", "Research"],
    ["implementation", "Implementasi", "Implementation"],
    ["verification", "Verifikasi", "Verification"],
    ["release", "Rilis", "Release"],
  ],
  document: [
    ["brief", "Brief", "Brief"],
    ["draft", "Draf", "Draft"],
    ["review", "Tinjauan", "Review"],
    ["publish", "Terbit", "Publish"],
  ],
}

const zero = { pending: 0, running: 0, "needs-review": 0, blocked: 0, done: 0, dropped: 0 }

export type FixtureOptions = { decision?: boolean; answered?: boolean; extraPhase?: boolean }

/** Rows over every phase with every status: 2 done, running, needs-review, blocked (issue), pending held by the open
 * request (blocked), pending (waiting), a long title, an unknown agent, a dropped row. */
export function fixtureGet(type: string, opts: FixtureOptions = {}): MissionGetWire {
  const phases = [...TYPE_PHASES[type]]
  if (opts.extraPhase) phases.push(["custom", "Kustom", "Custom"])
  const p = (i: number) => phases[Math.min(i, phases.length - 1)][0]
  const row = (id: string, phase: string, status: RowStatus, agent: string, title = `Row ${id}`, note?: string): MissionRowWire => ({
    id,
    phase,
    title,
    agent,
    status,
    note,
  })
  const rows = [
    row("1", p(0), "done", "request-translator"),
    row("2", p(0), "done", "task-architect"),
    row("3", p(1), "running", "data-collector", "A very long row title for the label"),
    row("4", p(1), "needs-review", "data-analyst"),
    row("5", p(2), "blocked", "coder-execution", "Render bridge", "check failed"),
    row("6", p(2), "pending", "coder-execution"),
    row("7", p(3), "pending", "verifier"),
    row("8", p(phases.length - 1), "pending", "my-custom-agent"),
    row("9", p(2), "dropped", "coder-execution"),
  ]
  const requests: MissionGetWire["requests"] = []
  if (opts.decision)
    requests.push({
      id: "D-07",
      question: "Keep legacy support?",
      options: [
        { id: "a", label: "Adapter", consequence: "+1 task" },
        { id: "b", label: "Defer", consequence: "smaller" },
      ],
      recommended: "a",
      blockingRows: ["6"],
      status: "open",
      createdAt: "2026-11-07T10:00:00Z",
    })
  if (opts.answered)
    requests.push({
      id: "D-01",
      question: "Scope?",
      options: [{ id: "a", label: "Narrow", consequence: "" }],
      status: "answered",
      createdAt: "2026-11-07T09:00:00Z",
      closedAt: "2026-11-07T09:30:00Z",
      answer: { option: "a", by: "user", decision: "U5" },
    })
  const shown = rows.filter((r) => r.status !== "dropped")
  return {
    mission: { id: `2026-11-07_${type}`, title: `${type} mission`, type, status: "running", rows },
    derived: {
      phases: phases.map(([id, nameId, en], i) => ({
        id,
        name: { id: nameId, en },
        order: i + 1,
        rows: rows.filter((r) => r.phase === id).map((r) => r.id),
        counts: zero,
      })),
      waves: [
        { wave: 1, rows: ["1", "2"] },
        { wave: 2, rows: ["3", "4", "5", "6", "7", "8"] },
      ],
      progress: { done: shown.filter((r) => r.status === "done").length, total: shown.length },
      checkpoints: { "3": { n: 2, m: 5 }, "4": { n: 1, m: 3 } },
    },
    requests,
    messages: [],
    deliverables: [
      {
        documentId: "doc-1",
        title: "Blueprint",
        docKey: "row-2-blueprint",
        docRev: "RevA",
        verified: true, // row 136b: host-computed (store rule)
        final: true,
        outputs: [{ fileId: "f1", format: "PDF", role: "PRIMARY", finalFileName: "Blueprint.pdf", verified: true }],
      },
    ],
  }
}

export const fixtureMission = (type: string, opts: FixtureOptions = {}, lang: "en" | "id" = "en") =>
  buildMission(fixtureGet(type, opts), lang)
