// Row 132 (spec 01_specs_mission_control_ui.md §6 items 32-34, §7; C127): Deliverables panel.
// Model half here; the DOM render runs in a child process (browser conditions + Solid JSX transform), as row 112 did.
import { describe, expect, test } from "bun:test"
import { buildMission } from "./mission-model"
import { DOCX_A, fixture, HTML_C, PDF_A } from "./mission-deliverables.fixture"
import {
  activateDeliverable,
  deliverableLines,
  finalTally,
  lineMeta,
  openablePath,
} from "./mission-deliverables-model"

const present = new Set([PDF_A, DOCX_A, HTML_C])
const vm = () => buildMission(fixture(), "en", present)

describe("row 132 deliverables model", () => {
  test("list: tile, extra formats, TaskRef, revision, status per deliverable", () => {
    const lines = deliverableLines(vm())
    expect(lines.map((l) => l.documentId)).toEqual(["doc-a", "doc-b", "doc-c", "doc-d", "doc-e"])
    const [a, b, c, d] = lines
    expect([a.tile, a.extra, a.taskRef, a.rev, a.status]).toEqual(["PDF", ["DOCX"], "Write kajian", "Rev A", "final"])
    expect(lineMeta(a)).toBe("+ DOCX · Write kajian · Rev A")
    expect([b.tile, b.extra, b.taskRef, b.status]).toEqual(["PDF", ["DOCX"], "Contract tests", "review"])
    expect([c.tile, c.extra, c.status]).toEqual(["HTML", [], "review"])
    expect(lineMeta(c)).toBe("Notes · Rev A")
    expect([d.tile, d.taskRef, d.rowId, d.status]).toEqual(["-", "-", undefined, "draft"])
    expect(b.name).toBe("Laporan Uji <b>Kontrak</b>") // kept as data; the view renders it as text
  })

  test("verified vs unverified: only all-PRIMARY-verified is Verified; anything else is Unverified and never Final", () => {
    const byId = Object.fromEntries(deliverableLines(vm()).map((l) => [l.documentId, l]))
    expect(byId["doc-a"].verified).toBe(true)
    expect(byId["doc-b"].verified).toBe(false) // one PRIMARY unverified
    expect(byId["doc-c"].verified).toBe(true)
    expect(byId["doc-d"].verified).toBe(false) // no outputs
    expect(byId["doc-e"].verified).toBe(false) // state other than verified
    expect(byId["doc-e"].status).toBe("draft") // row done but unverified: not Final
  })

  test("n/m final", () => {
    expect(finalTally(vm())).toEqual({ final: 1, total: 5 })
    expect(finalTally(null)).toEqual({ final: 0, total: 0 })
    expect(vm().finalCount).toBe(1)
  })

  test("selection: the line of the selected row is marked; none without a selection", () => {
    expect(deliverableLines(vm(), "2").map((l) => l.selected)).toEqual([false, true, false, false, false])
    expect(deliverableLines(vm()).some((l) => l.selected)).toBe(false)
  })

  test("click: selects the linked row and opens the project file (PDF first) in the file tab", () => {
    const calls: string[] = []
    const actions = { selectRow: (id: string) => calls.push(`select:${id}`), openFile: (p: string) => calls.push(`open:${p}`) }
    const [a, b, c, d] = deliverableLines(vm())
    expect(activateDeliverable(a, actions)).toBe("opened")
    expect(activateDeliverable(b, actions)).toBe("not-in-project")
    expect(activateDeliverable(c, actions)).toBe("opened")
    expect(activateDeliverable(d, actions)).toBe("not-in-project")
    expect(calls).toEqual([
      "select:1",
      `open:docs/m-doc-1/${PDF_A}`,
      "select:2",
      "select:3",
      `open:docs/m-doc-1/${HTML_C}`,
    ])
    expect(activateDeliverable(a, {})).toBe("not-in-project")
  })

  test("1.2.7 L-2: opening a document deliverable also opens the review/file pane (after the tab); not-in-project does not", () => {
    const calls: string[] = []
    const actions = {
      openFile: (p: string) => calls.push(`open:${p}`),
      openPane: (p: string) => calls.push(`pane:${p}`),
    }
    const [a, b] = deliverableLines(vm())
    expect(activateDeliverable(a, actions)).toBe("opened")
    expect(activateDeliverable(b, actions)).toBe("not-in-project")
    expect(calls).toEqual([`open:docs/m-doc-1/${PDF_A}`, `pane:docs/m-doc-1/${PDF_A}`])
    const exe = { ...a, path: null, origin: "folder" as const }
    expect(activateDeliverable(exe, actions)).toBe("not-in-project")
    expect(calls.length).toBe(2)
  })

  test("only docs/<mission>/<Studio output name> is ever opened (§12, C102)", () => {
    expect(openablePath(`docs/m1/${PDF_A}`)).toBe(`docs/m1/${PDF_A}`)
    expect(openablePath("docs/m1/readme.pdf")).toBeNull()
    expect(openablePath(`docs/../${PDF_A}`)).toBeNull()
    expect(openablePath(`/etc/${PDF_A}`)).toBeNull()
    expect(openablePath(`docs/a/b/${PDF_A}`)).toBeNull()
    expect(openablePath(null)).toBeNull()
    const line = { ...deliverableLines(vm())[0], path: "../../x/Kajian_rev1_20261107T101010Z_abcdef12.pdf" }
    const opened: string[] = []
    expect(activateDeliverable(line, { openFile: (p) => opened.push(p) })).toBe("not-in-project")
    expect(opened).toEqual([])
  })
})

describe("row 132 deliverables panel (DOM)", () => {
  test("renders the list, labels, n/m final, selection and the open-in-tab call", async () => {
    const run = Bun.spawn(
      [
        process.execPath,
        "test",
        "--conditions=browser",
        "--preload",
        "./happydom.ts",
        "./src/pages/session/swarm/mission-deliverables.render.ts",
      ],
      { cwd: new URL("../../../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
    )
    const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
    if (code !== 0) throw new Error(output)
    expect(output).toContain(" 0 fail")
    expect(output).toMatch(/ [1-9][0-9]* pass/)
  }, 60_000)
})
