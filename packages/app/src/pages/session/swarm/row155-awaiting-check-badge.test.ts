// Swarm 1.3.3 row 155 (S7): the awaiting-label-check marker of a closed row shows on the existing row view.
import { describe, expect, test } from "bun:test"
import { buildMission, labelCheckFigures } from "./mission-model"
import { fixture72 } from "./row72-mc8-open-preview.fixture"

const MARK = { checks: ["labels_verified"], since: "2026-11-17T10:00:00Z" }
const request = (over: Record<string, unknown> = {}) => ({
  id: "D-7",
  question: "Are the labels right?",
  context: "labels_verified row=1 document=doc-d revision=3 figures=2.1.2,2.2.2,3.1.2",
  options: [{ id: "approve", label: "Approve", consequence: "ok" }],
  status: "open",
  createdAt: "2026-11-17T10:00:00Z",
  ...over,
})
const build = (mark: unknown, requests: unknown[] = []) => {
  const w = fixture72()
  ;(w.mission.rows[0] as Record<string, unknown>).awaitingHumanCheck = mark
  w.requests = requests as never
  return buildMission(w, "en", new Set())
}
const rowId = () => fixture72().mission.rows[0].id

describe("row 155 awaiting label check badge (model)", () => {
  test("no marker: no badge", () => {
    expect(build(undefined).agents[rowId()]?.awaitingCheck).toBeUndefined()
  })
  test("cleared marker: no badge", () => {
    expect(build({ ...MARK, clearedBy: "U3" }, [request()]).agents[rowId()]?.awaitingCheck).toBeUndefined()
  })
  test("marker with an open label-check request: count, figures and link to the card", () => {
    const check = build(MARK, [request()]).agents[rowId()]?.awaitingCheck
    expect(check?.figures).toEqual(["2.1.2", "2.2.2", "3.1.2"])
    expect(check?.requestId).toBe("D-7")
  })
  test("marker without a request: badge, no figures, no link", () => {
    const check = build(MARK).agents[rowId()]?.awaitingCheck
    expect(check).toEqual({ figures: [] })
  })
  test("request not the card shown (an older one is shown): badge keeps figures, no link", () => {
    const older = request({ id: "D-1", context: undefined, createdAt: "2026-11-17T09:00:00Z" })
    const check = build(MARK, [older, request()]).agents[rowId()]?.awaitingCheck
    expect(check?.figures.length).toBe(3)
    expect(check?.requestId).toBeUndefined()
  })
  test("reader: other row, closed or malformed request gives nothing", () => {
    expect(labelCheckFigures(request({ context: "labels_verified row=2 document=d revision=1 figures=a" }) as never, "1")).toBeUndefined()
    expect(labelCheckFigures(request({ status: "answered" }) as never, "1")).toBeUndefined()
    expect(labelCheckFigures(request({ context: "labels_verified row=1" }) as never, "1")).toBeUndefined()
  })
})
