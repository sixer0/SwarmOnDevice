// 1.3.3 row 152 (senior review S2): the knowledge gate (datum-studio mission-store, row 102) counts a read only when
// datum-studio_studio_library_read recorded it with mission and row. The knowledge-library body must say so for a
// running mission row, for library paths and for `skill:` paths alike, while a plain file read stays fine outside a
// mission. The body keeps its 4096-byte cap at the 87, 150 and 200-byte roots, and the Mission Control skill already
// names the same call.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Skill } from "../../src/skill"

const ROOTS = [
  `/Users/${"u".repeat(20)}/Applications/Swarm.app/Contents/Resources/knowledge-library`,
  "/" + "r".repeat(149),
  "/" + "r".repeat(199),
]
const CALL = "datum-studio_studio_library_read"

describe("row 152: knowledge-library body steers mission-row reads to the recording tool", () => {
  test("the roots measured are 87, 150 and 200 bytes", () => {
    expect(ROOTS.map((r) => Buffer.byteLength(r))).toEqual([87, 150, 200])
  })

  test.each(ROOTS)("fits 4096 bytes with root %s", (root) => {
    const bytes = Buffer.byteLength(Skill.knowledgeLibraryEntry(root)!)
    console.log(`row152 body bytes: ${bytes} (root ${Buffer.byteLength(root)} bytes)`)
    expect(bytes).toBeLessThanOrEqual(4096)
  })

  test("names the recording call with path, mission and row inside a running mission row", () => {
    const body = Skill.knowledgeLibraryEntry(ROOTS[2])!
    const reading = body.split("\n").find((line) => line.startsWith("Reading:"))!
    expect(reading).toContain("Reading: outside a mission, use read, grep and glob with absolute paths.")
    expect(reading).toContain(`In a running mission row, open files (skill: paths too) with ${CALL} (path as listed, mission, row) so the read counts.`)
  })

  test("a skill: path goes to the same call whole", () => {
    const body = Skill.knowledgeLibraryEntry(ROOTS[2])!
    const line = body.split("\n").find((l) => l.startsWith("skill:NAME/PATH is outside Root:"))!
    expect(line).toContain("load built-in skill NAME, then open PATH under its root")
    expect(line).toContain("(in a mission row, pass it whole)")
  })

  test("no line of the body tells a mission row to read only with the file tools", () => {
    const body = Skill.knowledgeLibraryEntry(ROOTS[2])!
    expect(body).not.toContain("Reading: use read, grep and glob with absolute paths. Open library.json")
  })
})

describe("row 152: Mission Control skill names the recording call", () => {
  test("its KNOWLEDGE_NOT_CONSULTED fix reads through the call with mission and row, and nothing points at a file read", () => {
    const text = fs.readFileSync(path.join(import.meta.dir, "../../src/skill/mission-control.md"), "utf8")
    expect(text).toContain(`with ${CALL} (with mission and row)`)
    expect(text).not.toMatch(/library[^\n]*(read, grep and glob|read tool)/i)
    expect(text).not.toMatch(/(?<!datum-studio_)studio_library_read/)
    expect(text).not.toMatch(/studio_\w+ \{/)
    // Coordinator add-on: final files go to <project>/deliverables/<mission-id>/; 11_deliverables is only the export folder.
    expect(text).toContain("Final files live in <project>/deliverables/<mission-id>/, copied there by datum-studio_studio_render after a verified render")
    expect(text).toContain("11_deliverables/ is an export folder, not where final files go")
    for (const line of text.split("\n").filter((l) => l.includes("11_deliverables")))
      expect(line).not.toMatch(/(save|keep) final|final deliverables with/i)
    expect(text.split("\n").length).toBeLessThanOrEqual(180)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(24000)
  })
})
