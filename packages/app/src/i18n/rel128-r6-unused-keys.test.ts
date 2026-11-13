import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Row 24 of docs/2026-11-13_swarm_1_2_8_patch (N8-321, AC-R6, RED-GREEN): the two Mission Control keys
// `session.mission.decision.answered` / `.recorded` had no use outside i18n, and `MissionVM.answered` had no reader.
// Both are gone: from the catalogues, from every exemption list, and from the view model.

const KEYS = ["session.mission.decision.answered", "session.mission.decision.recorded"]
const here = import.meta.dir
const read = (path: string) => readFileSync(join(here, path), "utf8")

describe("R-6 unused keys and MissionVM.answered (N8-321)", () => {
  test("neither key is in en, id or the exemption lists and the catalogues parse without them", async () => {
    for (const locale of ["en", "id"]) {
      const dict: Record<string, string> = (await import(`./${locale}.ts`)).dict
      for (const key of KEYS) expect({ locale, key, present: Object.hasOwn(dict, key) }).toEqual({ locale, key, present: false })
    }
    for (const file of ["en.ts", "id.ts", "parity.test.ts", "parity-exemption-guard.test.ts"]) {
      const text = read(file)
      // The comment in parity.test.ts names the keys in backticks; a catalogue or list entry is the quoted form.
      for (const key of KEYS) expect({ file, key, quoted: text.includes(`"${key}"`) }).toEqual({ file, key, quoted: false })
    }
  })

  test("MissionVM has no answered field and the model builds none", () => {
    const model = read("../pages/session/swarm/mission-model.ts")
    const start = model.indexOf("export type MissionVM = {")
    const block = model.slice(start, model.indexOf("\n}\n", start))
    expect(block).toContain("openDecisions: number")
    expect(block).not.toMatch(/\banswered\b/)
    expect(model).not.toContain("MissionAnsweredVM")
  })
})
