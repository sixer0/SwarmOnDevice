// 1.3.3 row 153 (senior S5): the app keeps reading docs/<m>/11_deliverables/ for missions made before 1.3.3 and labels it
// legacy; the one folder for new finals is deliverables/<mission>/. Evidence: the export still creates the numbered folder.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { MISSION_DELIVERABLES_DIR, openablePath, PROJECT_DELIVERABLES_DIR } from "./mission-deliverables-model"

const M = "2026-11-08_example"

describe("row 153 S5: legacy deliverable folder", () => {
  test("old missions: docs/<m>/11_deliverables/<name> still opens; new finals: deliverables/<m>/<name> opens too", () => {
    expect(MISSION_DELIVERABLES_DIR).toBe("11_deliverables")
    expect(PROJECT_DELIVERABLES_DIR).toBe("deliverables")
    expect(openablePath(`docs/${M}/11_deliverables/a.md`, "folder")).toBe(`docs/${M}/11_deliverables/a.md`)
    expect(openablePath(`deliverables/${M}/RevA.pdf`, "folder")).toBe(`deliverables/${M}/RevA.pdf`)
    expect(openablePath(`deliverables/${M}/a/RevA.pdf`, "folder")).toBeNull()
  })

  test("the constant is documented as the legacy source", () => {
    const src = readFileSync(new URL("./mission-deliverables-model.ts", import.meta.url), "utf8")
    expect(src.slice(0, src.indexOf("export const MISSION_DELIVERABLES_DIR"))).toContain("LEGACY source")
  })
})
