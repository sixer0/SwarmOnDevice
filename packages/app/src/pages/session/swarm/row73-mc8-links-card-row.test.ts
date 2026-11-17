// Swarm 1.3.3 row 73 (MC-8 item 5): the deliverable links on the decision card, the row view and the mission summary.
// Model half; the views mount row 72's MissionDeliverableLinksFor with the ids this model gives.
import { describe, expect, test } from "bun:test"
import { buildMission } from "./mission-model"
import { decisionDocumentIds, latestLinks, linkActions, missionDeliverableLinks, summaryDocumentIds } from "./mission-deliverables-model"
import { DIR72, fixture72, M72, PDF_D } from "./row72-mc8-open-preview.fixture"

const wire = () => {
  const w = fixture72()
  w.requests = [
    {
      id: "D-1",
      question: "Approve Rev D?",
      options: [{ id: "yes", label: "Yes", consequence: "ok" }],
      blockingRows: ["1"],
      status: "open",
      createdAt: "2026-11-17T10:00:00Z",
    },
  ] as never
  return w
}
const vm = () => buildMission(wire(), "en", new Set())

describe("row 73 links on card, row and summary", () => {
  test("a review card yields the document it concerns, latest revision with letter and Studio number", () => {
    const m = vm()
    expect(m.decision?.id).toBe("D-1")
    expect(decisionDocumentIds(m)).toEqual(["doc-d"])
    const links = latestLinks(missionDeliverableLinks(m, { documentId: "doc-d" }, DIR72))
    expect(links.length).toBe(3)
    expect(new Set(links.map((l) => l.revision))).toEqual(new Set(["Rev D · rev 256"]))
    expect(links[0].path).toBe(`deliverables/${M72}/${PDF_D}`)
  })

  test("a row with deliverables yields links; a row without yields none", () => {
    const m = vm()
    expect(missionDeliverableLinks(m, { rowId: "1" }, DIR72).length).toBeGreaterThan(0)
    expect(missionDeliverableLinks(m, { rowId: "3" }, DIR72)).toEqual([])
    expect(missionDeliverableLinks(m, {}, DIR72)).toEqual([])
  })

  test("a card that blocks no row with a copy, or no card, yields no document", () => {
    const m = vm()
    const w = wire()
    ;(w.requests as any)[0].blockingRows = ["3"]
    expect(decisionDocumentIds(buildMission(w, "en", new Set()))).toEqual([])
    const none = wire()
    delete (none.requests as any)[0].blockingRows
    expect(decisionDocumentIds(buildMission(none, "en", new Set()))).toEqual([])
    expect(decisionDocumentIds(null)).toEqual([])
  })

  test("the summary lists each document with a copy once", () => {
    const ids = summaryDocumentIds(vm())
    expect(ids).toContain("doc-d")
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("row 73 mission folder that is not the session's", () => {
  const OTHER = "/work/other-proj"
  test("links built against the mission folder keep Open and drop Preview", () => {
    const w = fixture72(OTHER)
    const m = buildMission(w, "en", new Set())
    const links = latestLinks(missionDeliverableLinks(m, { documentId: "doc-d" }, OTHER, DIR72))
    expect(links.length).toBe(3)
    const pdf = links.find((l) => l.format === "PDF")!
    expect(linkActions(pdf, { openSystem: () => {}, previewFile: () => {} })).toEqual(["open"])
    expect(pdf.openAbsPath).toBe(`${OTHER}/deliverables/${M72}/${PDF_D}`)
  })
  test("without the mission folder the same files give no action (fail closed)", () => {
    const m = buildMission(fixture72(OTHER), "en", new Set())
    const links = missionDeliverableLinks(m, { documentId: "doc-d" }, DIR72)
    expect(links.every((l) => linkActions(l).length === 0)).toBe(true)
  })
})
