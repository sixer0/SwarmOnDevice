import { describe, expect, test } from "bun:test"
import {
  agentStatus,
  blockingSummary,
  buildMission,
  missionOptions,
  missionStatusLine,
  phaseFamily,
  pickSelected,
  rowIdOfKey,
  type MissionGetWire,
  type MissionRowWire,
  type RowStatus,
} from "./mission-model"

const zero = { pending: 0, running: 0, "needs-review": 0, blocked: 0, done: 0, dropped: 0 }

// The four builtin types (masterplan/01_specs_mission_contract.md §3.3).
const TYPES: Record<string, Array<[string, string, string]>> = {
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

const row = (id: string, phase: string, status: RowStatus, agent = "coder-execution", note?: string): MissionRowWire => ({
  id,
  phase,
  title: `Row ${id} title`,
  agent,
  status,
  note,
})

/** One fixture per type: rows spread over the type's phases with every status. */
function fixture(type: string): MissionGetWire {
  const phases = TYPES[type]
  const p = (i: number) => phases[Math.min(i, phases.length - 1)][0]
  const rows = [
    row("1", p(0), "done", "request-translator"),
    row("2", p(0), "done", "task-architect"),
    row("3", p(1), "running", "data-collector"),
    row("4", p(1), "needs-review", "data-analyst"),
    row("5", p(2), "blocked", "coder-execution", "check failed"),
    row("6", p(2), "pending", "coder-execution"),
    row("7", p(3), "pending", "verifier"),
    row("8", p(phases.length - 1), "pending", "my-custom-agent"),
    row("9", p(2), "dropped"),
  ]
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
        { wave: 2, rows: ["3", "4"] },
        { wave: 3, rows: ["5", "6"] },
        { wave: 4, rows: ["7"] },
        { wave: 5, rows: ["8"] },
      ],
      progress: { done: 2, total: 8 },
      checkpoints: { "3": { n: 2, m: 5 } },
    },
    requests: [
      {
        id: "D-02",
        question: "Second open?",
        options: [{ id: "a", label: "A", consequence: "a" }],
        blockingRows: ["7"],
        status: "open",
        createdAt: "2026-11-07T10:05:00Z",
      },
      {
        id: "D-01",
        question: "Scope?",
        context: "one line",
        options: [
          { id: "narrow", label: "Narrow", consequence: "faster" },
          { id: "wide", label: "Wide", consequence: "slower" },
        ],
        recommended: "narrow",
        blockingRows: ["6"],
        status: "open",
        createdAt: "2026-11-07T10:00:00Z",
      },
      {
        id: "D-00",
        question: "Approve plan?",
        options: [{ id: "yes", label: "Approve", consequence: "go" }],
        status: "answered",
        createdAt: "2026-11-07T09:00:00Z",
        closedAt: "2026-11-07T09:30:00Z",
        answer: { option: "yes", by: "user", decision: "U1" },
      },
    ],
    messages: [
      { seq: 1, at: "2026-11-07T09:10:00Z", from: "controller", to: "owner", kind: "report", text: "m1" },
      { seq: 2, at: "2026-11-07T09:40:00Z", from: "agent", to: "controller", kind: "report", text: "m2", row: "3" },
      { seq: 3, at: "2026-11-07T09:50:00Z", from: "owner", to: "controller", kind: "instruction", text: "m3" },
      { seq: 4, at: "2026-11-07T09:55:00Z", from: "agent", to: "controller", kind: "question", text: "m4" },
    ],
    deliverables: [
      {
        documentId: "doc-a",
        title: "Kajian",
        docKey: "row-1-kajian",
        docRev: "Rev A",
        verified: true, // row 136b: host-computed (store rule)
        final: true,
        outputs: [
          { fileId: "f1", format: "DOCX", role: "PRIMARY", finalFileName: "a.docx", verified: true },
          { fileId: "f2", format: "PDF", role: "PRIMARY", finalFileName: "a.pdf", verified: true },
          { fileId: "f3", format: "SVG", role: "FIGURE", finalFileName: "fig.svg", verified: true },
        ],
      },
      {
        documentId: "doc-b",
        title: "Draft note",
        docKey: "row-4-note",
        docRev: "Rev A",
        verified: false,
        final: false,
        outputs: [{ fileId: "f4", format: "HTML", role: "PRIMARY", finalFileName: "b.html", verified: false }],
      },
      { documentId: "doc-c", title: "Loose", docKey: "loose", docRev: "Rev A", verified: false, final: false, outputs: [] },
    ],
  }
}

describe("buildMission per mission type", () => {
  for (const type of Object.keys(TYPES)) {
    test(type, () => {
      const vm = buildMission(fixture(type), "en", new Set(["a.pdf"]))
      const phases = TYPES[type]

      // Only the type's phases, in order, with the language's name.
      expect(vm.phases.map((p) => p.id)).toEqual(phases.map((p) => p[0]))
      expect(vm.phases.map((p) => p.name)).toEqual(phases.map((p) => p[2]))
      expect(vm.layout).toBe("radial")
      expect(vm.type).toBe(type)

      // Statuses (§5.1); dropped row 9 is not shown.
      expect(Object.keys(vm.agents).sort()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"])
      expect(vm.agents["1"].status).toBe("done")
      expect(vm.agents["3"].status).toBe("running")
      expect(vm.agents["4"].status).toBe("review")
      expect(vm.agents["5"].status).toBe("issue")
      expect(vm.agents["5"].note).toBe("check failed")
      expect(vm.agents["6"]).toMatchObject({ status: "blocked", heldBy: ["D-01"] })
      expect(vm.agents["7"]).toMatchObject({ status: "blocked", heldBy: ["D-02"] })
      expect(vm.agents["8"]).toMatchObject({ status: "waiting", tool: "hub", family: vm.phases.at(-1)!.family })
      expect(vm.agents["3"]).toMatchObject({ family: "research", tool: "lens", wave: 2, checkpoint: { n: 2, m: 5 } })
      expect(vm.agents["1"].deliverableId).toBe("doc-a")
      expect(vm.held).toBe(3)

      // Progress and per-phase counts exclude dropped.
      expect(vm.progress).toEqual({ done: 2, total: 8, pct: 25 })
      const first = vm.phases[0]
      expect(first).toMatchObject({ done: 2, total: 2, allDone: true, live: false })
      expect(vm.phases[1].live).toBe(true)
      expect(vm.phases.reduce((n, p) => n + p.total, 0)).toBe(8)

      // Waves: from the lowest unfinished wave, at most 4.
      expect(vm.waves.map((w) => w.wave)).toEqual([2, 3, 4, 5])
      expect(vm.waves[1].tone).toBe("issue")

      // Decision: oldest open; answered: latest answered.
      expect(vm.decision?.id).toBe("D-01")
      expect(vm.decision?.options.find((o) => o.recommended)?.id).toBe("narrow")
      expect(vm.openDecisions).toBe(2)
      expect(vm.answered).toEqual({ id: "D-00", question: "Approve plan?", optionLabel: "Approve", decision: "U1" })

      // Feed: last 4 by time, answered request merged in.
      expect(vm.feed.map((f) => f.key)).toEqual(["aD-00", "m2", "m3", "m4"])
      expect(vm.feed[0]).toMatchObject({ from: "owner", to: "controller", text: "D-00: Approve" })
      expect(vm.feed[1]).toMatchObject({ agent: "data-collector", row: "3" })

      // Deliverables (§7).
      const [a, b, c] = vm.deliverables
      expect(a).toMatchObject({ rowId: "1", status: "final", verified: true, formats: ["PDF", "DOCX"] })
      expect(a.files.map((f) => f.format)).toEqual(["PDF", "DOCX"])
      expect(a.projectPath).toBe(`docs/2026-11-07_${type}/a.pdf`)
      expect(b).toMatchObject({ rowId: "4", status: "review", verified: false, projectPath: null })
      expect(c).toMatchObject({ rowId: undefined, status: "draft", verified: false, formats: [] })
      expect(vm.finalCount).toBe(1)
    })
  }

  test("Indonesian phase names", () => {
    const vm = buildMission(fixture("document"), "id")
    expect(vm.phases.map((p) => p.name)).toEqual(["Brief", "Draf", "Tinjauan", "Terbit"])
  })
})

describe("edge states", () => {
  test("empty mission", () => {
    const vm = buildMission(
      {
        mission: { id: "2026-11-07_x", title: "x", type: "research", status: "draft", rows: [] },
        derived: { phases: [], waves: [], progress: { done: 0, total: 0 }, checkpoints: {} },
      },
      "en",
    )
    expect(vm).toMatchObject({ progress: { done: 0, total: 0, pct: 0 }, held: 0, layout: "lanes", decision: null })
    expect(vm).toMatchObject({ answered: null, feed: [], deliverables: [], finalCount: 0, waves: [] })
    expect(blockingSummary(vm)).toEqual([])
  })

  test("all waves done shows the last four", () => {
    const get = fixture("debug")
    get.mission.rows = get.mission.rows.map((r) => (r.status === "dropped" ? r : { ...r, status: "done" as const }))
    get.requests = []
    expect(buildMission(get, "en").waves.map((w) => w.wave)).toEqual([2, 3, 4, 5])
  })

  test("row 136b (M5): verified/Final are the host's values, never re-derived from the outputs", () => {
    const get = fixture("research")
    const row = get.mission.rows.find((r) => r.id === "1")!
    row.status = "done"
    const d = get.deliverables![0]
    // every listed PRIMARY output says verified, but the host's rule says not verified / not Final (e.g. a FIGURE is
    // unverified, or no layout witness): the old app rule said Verified + Final here, the panel now agrees with the gate
    d.outputs = d.outputs.map((o) => ({ ...o, verified: o.role === "PRIMARY" }))
    d.verified = false
    d.final = false
    expect(buildMission(get, "en").deliverables[0]).toMatchObject({ status: "draft", verified: false })
    // the reverse: an older unverified PRIMARY listed by an old host does not override the host's verdict
    d.outputs = [...d.outputs, { fileId: "old", format: "PDF", role: "PRIMARY", finalFileName: "old.pdf", verified: false }]
    d.verified = true
    d.final = true
    expect(buildMission(get, "en").deliverables[0]).toMatchObject({ status: "final", verified: true })
    // verified but not Final (no layout witness): In review even with the row done, never Final
    d.final = false
    expect(buildMission(get, "en").deliverables[0]).toMatchObject({ status: "review", verified: true })
    // a host before row 136b sends neither field: shown Unverified, never Final
    delete d.verified
    delete d.final
    expect(buildMission(get, "en").deliverables[0]).toMatchObject({ status: "draft", verified: false })
  })

  test("unsafe final file names are never a project path", () => {
    const get = fixture("research")
    get.deliverables![0].outputs = [
      { fileId: "x", format: "PDF", role: "PRIMARY", finalFileName: "../evil.pdf", verified: true },
    ]
    const vm = buildMission(get, "en", new Set(["../evil.pdf"]))
    expect(vm.deliverables[0].files).toEqual([])
    expect(vm.deliverables[0].projectPath).toBeNull()
  })

  test("blocking summary", () => {
    const vm = buildMission(fixture("research"), "en")
    expect(blockingSummary(vm)).toEqual([
      "5 Row 5 title (check failed)",
      "6 Row 6 title (D-01)",
      "7 Row 7 title (D-02)",
    ])
  })
})

describe("helpers", () => {
  test("agentStatus", () => {
    expect(agentStatus("pending", [])).toBe("waiting")
    expect(agentStatus("pending", ["D-1"])).toBe("blocked")
    expect(agentStatus("dropped", [])).toBeUndefined()
  })
  test("phaseFamily falls back by position", () => {
    expect(phaseFamily("custom", 1, 3)).toBe("plan")
    expect(phaseFamily("custom", 2, 3)).toBe("build")
    expect(phaseFamily("custom", 3, 3)).toBe("ship")
  })
  test("rowIdOfKey", () => {
    expect(rowIdOfKey("row-12a-kajian-x")).toBe("12a")
    expect(rowIdOfKey("row-12")).toBeUndefined()
    expect(rowIdOfKey(null)).toBeUndefined()
  })
  test("pickSelected and options", () => {
    const items = [
      { id: "a", status: "done" as const },
      { id: "b", status: "running" as const },
    ]
    expect(pickSelected(items, undefined)).toBe("b")
    expect(pickSelected(items, "a")).toBe("a")
    expect(pickSelected(items, "gone")).toBe("b")
    expect(pickSelected([], "a")).toBeUndefined()
    expect(
      missionOptions([
        {
          id: "a",
          title: "A",
          type: "debug",
          status: "running",
          progress: { done: 1, total: 3 },
          openRequests: ["D-1"],
          updatedAt: "t",
        },
      ]),
    ).toEqual([{ id: "a", title: "A", type: "debug", status: "running", pct: 33, openDecisions: 1 }])
  })
})

// Row 165D (F56-2, CP-17): the host sends each output's delivered DATUM title name; a file saved under it in
// docs/<mission>/ is found and opened (older C51 downloads still are); unsafe names never become a project path.
describe("row 165D: deliverables under the DATUM title name", () => {
  const DOCX = "Pemantauan Iklim Ruang Simpan Arsip Statis Gedung B 012-GSP-KT-XI-2026 RevA.docx"
  const PDF = "Pemantauan Iklim Ruang Simpan Arsip Statis Gedung B 012-GSP-KT-XI-2026 RevA.pdf"
  const titled = () => {
    const get = fixture("research")
    get.deliverables![0].outputs = [
      { fileId: "f1", format: "DOCX", role: "PRIMARY", finalFileName: "012-GSP-KT-XI-2026_rev8_20261107T194129Z_293ba138.docx", fileName: DOCX, verified: true },
      { fileId: "f2", format: "PDF", role: "PRIMARY", finalFileName: "012-GSP-KT-XI-2026_rev8_20261107T194129Z_aaaabbbb.pdf", fileName: PDF, verified: true },
    ]
    return get
  }

  test("a file in the project under the DATUM name is the deliverable's project path", () => {
    const vm = buildMission(titled(), "en", new Set([PDF]))
    expect(vm.deliverables[0].projectPath).toBe(`docs/${vm.id}/${PDF}`)
    expect(vm.deliverables[0].files.map((f) => f.fileName)).toEqual([PDF, DOCX])
  })

  test("an older C51 download is still found; the DATUM name wins when both are present", () => {
    const c51 = "012-GSP-KT-XI-2026_rev8_20261107T194129Z_aaaabbbb.pdf"
    expect(buildMission(titled(), "en", new Set([c51])).deliverables[0].projectPath).toEndWith(`/${c51}`)
    expect(buildMission(titled(), "en", new Set([c51, PDF])).deliverables[0].projectPath).toEndWith(`/${PDF}`)
  })

  test("unsafe DATUM names from the host are ignored, never a project path", () => {
    const get = titled()
    get.deliverables![0].outputs = [
      { fileId: "x", format: "PDF", role: "PRIMARY", finalFileName: "012-GSP-KT-XI-2026_rev8_20261107T194129Z_aaaabbbb.pdf", fileName: "../evil 012-GSP RevA.pdf", verified: true },
    ]
    const vm = buildMission(get, "en", new Set(["../evil 012-GSP RevA.pdf"]))
    expect(vm.deliverables[0].files[0].fileName).toBeUndefined()
    expect(vm.deliverables[0].projectPath).toBeNull()
  })
})

describe("row 165D: the file tab opens the DATUM-named deliverable", () => {
  test("openablePath accepts docs/<mission>/<DATUM name>, refuses traversal and non-Studio names", async () => {
    const { openablePath } = await import("./mission-deliverables-model")
    const ok = "docs/2026-11-07_research/Pemantauan Iklim Ruang Simpan Arsip Statis Gedung B 012-GSP-KT-XI-2026 RevA.pdf"
    expect(openablePath(ok)).toBe(ok)
    expect(openablePath("docs/2026-11-07_research/Nota uji 2026-11-08.html")).toBe("docs/2026-11-07_research/Nota uji 2026-11-08.html")
    expect(openablePath("docs/../Pemantauan 012-GSP-KT-XI-2026 RevA.pdf")).toBeNull()
    expect(openablePath("docs/m/sub/Pemantauan 012-GSP-KT-XI-2026 RevA.pdf")).toBeNull()
    expect(openablePath("docs/m/report.pdf")).toBeNull()
  })
})

// Row 173 (F146b-2): row 146b linked two Studio documents to row 2 (docKey row-2-laporan, an abandoned first build
// left Unverified, and row-2-kajian, verified at rev 17). The panel must show the row's verified latest document,
// not the abandoned draft, and one line per row.
describe("row 173: one deliverable per row, the verified latest one", () => {
  const out = (fileId: string, verified: boolean) => ({ fileId, format: "DOCX" as const, role: "PRIMARY" as const, finalFileName: `${fileId}.docx`, verified })
  const abandoned = { documentId: "cedk3", title: "Kajian (first build)", docKey: "row-2-laporan", docRev: "Rev A", revisionNo: 15, updatedAt: "2026-11-08T04:56:53Z", verified: false, final: false, outputs: [out("old", false)] }
  const verified = { documentId: "cb1mw", title: "Kajian", docKey: "row-2-kajian", docRev: "Rev A", revisionNo: 17, updatedAt: "2026-11-08T05:04:15Z", verified: true, final: true, outputs: [out("new", true)] }

  test("the verified document is the row's deliverable, whatever the host order", () => {
    for (const order of [[abandoned, verified], [verified, abandoned]]) {
      const get = fixture("document")
      get.deliverables = [...order, get.deliverables![0]]
      const vm = buildMission(get, "en")
      const row2 = vm.deliverables.filter((d) => d.rowId === "2")
      expect(row2.map((d) => d.documentId)).toEqual(["cb1mw"])
      expect(row2[0]).toMatchObject({ verified: true })
      expect(vm.deliverables.map((d) => d.documentId)).toContain("doc-a")
      expect(vm.agents["2"]?.deliverableId).toBe("cb1mw")
    }
  })

  test("no verified document: the newest one stands for the row", () => {
    const get = fixture("document")
    const newer = { ...verified, verified: false, final: false, outputs: [out("new", false)] }
    get.deliverables = [abandoned, newer]
    expect(buildMission(get, "en").deliverables.map((d) => d.documentId)).toEqual(["cb1mw"])
  })

  test("documents without a row link are all kept", () => {
    const get = fixture("document")
    get.deliverables = [
      { documentId: "x", title: "x", docKey: "loose-1", docRev: "Rev A", outputs: [] },
      { documentId: "y", title: "y", docKey: null, docRev: "Rev A", outputs: [] },
    ]
    expect(buildMission(get, "en").deliverables.map((d) => d.documentId)).toEqual(["x", "y"])
  })
})

// Row 190 (decision L48): a draft mission whose agent worked elsewhere showed only "0%"; a compact line now says why.
describe("row 190: mission status line", () => {
  test("draft shows not-started (not approved), approved-but-not-running its own line; running, done, cancelled none", () => {
    expect(missionStatusLine({ status: "draft", openDecisions: 0 })).toBe("notStarted")
    // Row 197 (S194-03): an approved mission is never called "not approved".
    expect(missionStatusLine({ status: "approved", openDecisions: 0 })).toBe("approvedNotStarted")
    expect(missionStatusLine({ status: "running", openDecisions: 0 })).toBeNull()
    expect(missionStatusLine({ status: "done", openDecisions: 0 })).toBeNull()
    expect(missionStatusLine({ status: "cancelled", openDecisions: 0 })).toBeNull()
  })
  test("paused shows the paused line", () => {
    expect(missionStatusLine({ status: "paused", openDecisions: 0 })).toBe("paused")
  })
  test("an open decision keeps the decision card the focus: no line", () => {
    expect(missionStatusLine({ status: "draft", openDecisions: 1 })).toBeNull()
    expect(missionStatusLine({ status: "paused", openDecisions: 2 })).toBeNull()
  })
  test("the line does not touch progress: a built draft mission keeps its progress numbers", () => {
    const wire = fixture("document")
    const model = buildMission({ ...wire, mission: { ...wire.mission, status: "draft" }, requests: [] }, "en")
    expect(model.progress).toEqual(buildMission(wire, "en").progress)
    expect(missionStatusLine(model)).toBe("notStarted")
  })
})

describe("row 197 (S194-03): self-approved (autonomous) from the host's derived.approval", () => {
  test("autonomous approval -> selfApproved; user approval, no approval, or a draft -> not", () => {
    const wire = fixture("document")
    const self = { decision: "C1", by: "controller", autonomous: true, label: "self-approved (autonomous)" }
    const user = { decision: "U1", by: "user", autonomous: false, label: "approved (decision by: user)" }
    expect(buildMission({ ...wire, derived: { ...wire.derived, approval: self } }, "en").selfApproved).toBe(true)
    expect(buildMission({ ...wire, derived: { ...wire.derived, approval: user } }, "en").selfApproved).toBe(false)
    expect(buildMission(wire, "en").selfApproved).toBe(false)
    const draft = { ...wire, mission: { ...wire.mission, status: "draft" as const }, derived: { ...wire.derived, approval: self } }
    expect(buildMission(draft, "en").selfApproved).toBe(false)
  })
})
