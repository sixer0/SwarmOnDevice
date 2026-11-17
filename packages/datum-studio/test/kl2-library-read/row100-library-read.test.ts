/**
 * Swarm 1.3.3 row 100 (KL-2, U19, Q3): `studio_library_read` serves files of the technical library and records a read
 * against a running mission row (`markKnowledgeConsulted`), so the done gate (row 102) can see the library was read.
 * Checks: served from the root; traversal, absolute, NUL and symlink escape refused; non-text refused; a large file in
 * pages; read event stored with mission and row and visible in the row's `knowledge`; a read without a row is served and
 * not recorded; the tool never writes the library.
 * Temp folders: ROW100_TEST_DIR, else the OS temp folder. Nothing outside it is written.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import type { MissionRowInput, NewMission, RowKnowledge } from "../../src/store/mission/index.ts"
import {
  LIBRARY_FILE_MAX_BYTES,
  LIBRARY_INDEX_BASE,
  LIBRARY_PAGE_BYTES,
  LIBRARY_READ_TOOL,
  libraryReadExtension,
  type LibraryReadStore,
} from "../../src/mcp-host/library-read.ts"

const BASE = process.env.ROW100_TEST_DIR ?? join(tmpdir(), "row100-library-read")
mkdirSync(BASE, { recursive: true })
const RUN = realpathSync(mkdtempSync(join(BASE, "run-")))
const LIB = join(RUN, "knowledge-library")
const KB = join(LIB, ...LIBRARY_INDEX_BASE.split("/"))
const OUTSIDE = join(RUN, "outside")
const FIRST_CV = "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/RANTAI-JAMINAN.md"
const CARD_CV = "04_KNOWLEDGE-CARDS/COMPUTER-VISION/REF-CV-001.md"
const FIRST_NET = "04_KNOWLEDGE-CARDS/NETWORKING/REF-NET-001.md"
const BIG = "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/besar.md"

function put(rel: string, body: string | Uint8Array, root = KB) {
  const p = join(root, ...rel.split("/"))
  mkdirSync(join(p, ".."), { recursive: true })
  writeFileSync(p, body)
}

// A library shaped like the bundled edition: top-level guides, the indexed text layer under LIBRARY_INDEX_BASE.
put("PANDUAN-AKSES.md", "# Panduan akses\n", LIB)
put(FIRST_CV, "# Rantai jaminan visi komputer\nisi\n")
put(CARD_CV, "---\nreference_id: REF-CV-001\n---\nkartu\n")
put(FIRST_NET, "# Jaringan\n")
put("05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/biner.md", new Uint8Array([0x23, 0x20, 0x00, 0x41]))
put("05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/latin1.md", new Uint8Array([0x63, 0x61, 0x66, 0xe9]))
put("05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/gambar.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
put("05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/dok.pdf", "%PDF-1.4\n")
// 150 000 B of lines (each 100 B, ASCII), so the pages split on line ends.
const BIG_TEXT = Array.from({ length: 1500 }, (_, i) => `baris ${String(i).padStart(4, "0")} ${"x".repeat(88)}\n`).join("")
put(BIG, BIG_TEXT)
put(
  "indeks_pemicu.json",
  JSON.stringify({
    how_to_use: "-",
    domains: {
      "COMPUTER-VISION": { terms: ["kamera"], read_order: [FIRST_CV, CARD_CV] },
      NETWORKING: { terms: ["jaringan"], read_order: [FIRST_NET] },
      "DIAGRAM-STANDARD": { terms: ["diagram"], read_order: ["skill:gsp-diagram-standard/references/index.md"] },
    },
    weak: ["data"],
  }),
)
mkdirSync(OUTSIDE, { recursive: true })
writeFileSync(join(OUTSIDE, "rahasia.md"), "outside the library\n")
symlinkSync(join(OUTSIDE, "rahasia.md"), join(KB, "05_DOMAIN-KNOWLEDGE", "COMPUTER-VISION", "tautan-keluar.md"))
symlinkSync(OUTSIDE, join(KB, "05_DOMAIN-KNOWLEDGE", "folder-keluar"))
symlinkSync(join(KB, ...FIRST_NET.split("/")), join(KB, "05_DOMAIN-KNOWLEDGE", "COMPUTER-VISION", "tautan-dalam.md"))

// C33: a built-in skill on disk (gsp-diagram-standard), outside the library; and a second folder that is NOT on the allow-list.
const SKILL_ROOT = join(RUN, "skills", "gsp-diagram-standard")
const OTHER_SKILL = join(RUN, "skills", "other-skill")
const SKILL_FIRST = "skill:gsp-diagram-standard/references/index.md"
put("references/index.md", "# Indeks rujukan diagram\n", SKILL_ROOT)
put("references/cara_bingkai_lembar.md", "# Cara bingkai lembar\n", SKILL_ROOT)
put("references/pages/p028.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), SKILL_ROOT)
put("scripts/bingkai_lembar.py", "print(1)\n", SKILL_ROOT)
put("x.md", "# lain\n", OTHER_SKILL)
symlinkSync(join(OUTSIDE, "rahasia.md"), join(SKILL_ROOT, "references", "keluar.md"))
const SKILL_ROOTS = { "gsp-diagram-standard": SKILL_ROOT, "other-skill": OTHER_SKILL }

const snapshot = () =>
  (readdirSync(LIB, { recursive: true }) as string[])
    .sort()
    .flatMap((f) => {
      // files only: a folder's mtime moves when this test adds aksara.md
      const st = statSync(join(LIB, f), { throwIfNoEntry: false })
      return st?.isDirectory() ? [] : [`${f}:${st?.size ?? "-"}:${st?.mtimeMs ?? "-"}`]
    })
const BEFORE = snapshot()

// ---------- store with one mission: row 1 running with knowledge, row 2 running without, row 3 pending with knowledge
let tick = 1_800_000_000_000
const store = new SqliteStudioStore()
const MID = "2026-11-17_row100-library"
const KNOWLEDGE: RowKnowledge = {
  domains: [
    { domain: "COMPUTER-VISION", firstFile: FIRST_CV, consulted: [] },
    { domain: "NETWORKING", firstFile: FIRST_NET, consulted: [] },
  ],
}
function row(id: string): MissionRowInput {
  return { id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" }
}
const MISSION: NewMission = { id: MID, title: "Mission row 100", type: "feature-release", owner: "master-controller", project: { dir: join(RUN, "project") }, rows: [row("1"), row("2"), row("3"), row("4")], decisions: [{ id: "U1", by: "user", date: "2026-11-17", text: "User approves" }] }

const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: "info" | "warn" | "error", _source: string, message: string, context?: Record<string, unknown>) => logs.push({ level, message, context })
const SESSION = { sessionId: "s-row100", agentId: "swarm", fileRoot: join(RUN, "project") }
let tool: ReturnType<typeof libraryReadExtension>

beforeAll(async () => {
  await store.open(join(RUN, "store"), { release: "1.3.3", log: () => {}, agentClock: () => ++tick })
  const M = store.missions
  await store.transaction(async (t) => M.create(t, MISSION, { attested: true }))
  await store.transaction(async (t) => M.setRowKnowledge(t, MID, "1", KNOWLEDGE))
  await store.transaction(async (t) => M.setRowKnowledge(t, MID, "3", KNOWLEDGE))
  await store.transaction(async (t) => M.setRowKnowledge(t, MID, "4", { domains: [{ domain: "DIAGRAM-STANDARD", firstFile: SKILL_FIRST, consulted: [] }] }))
  await store.transaction(async (t) => M.approve(t, MID, "U1"))
  await store.transaction(async (t) => M.updateRows(t, MID, [{ id: "1", status: "running" }, { id: "2", status: "running" }, { id: "4", status: "running" }]))
  tool = libraryReadExtension(store as unknown as LibraryReadStore, { root: LIB, log })
})

afterAll(async () => {
  await store.close()
})

type Out = { text: string; data: Record<string, unknown>; isError: boolean }
async function call(args: Record<string, unknown>, t = tool): Promise<Out> {
  const r = await t.call(args, SESSION)
  return { text: String((r.content[0] as { text?: string }).text ?? ""), data: (r.structuredContent ?? {}) as Record<string, unknown>, isError: r.isError === true }
}
const consulted = (rowId: string) => store.missions.rowContract(MID, rowId).knowledge?.domains.map((d) => [d.domain, d.consulted] as const)

describe("row 100: studio_library_read", () => {
  test("register name, small schema, no library write", () => {
    expect(tool.name).toBe(LIBRARY_READ_TOOL)
    expect(LIBRARY_READ_TOOL).toBe("studio_library_read")
    expect(tool.inputSchema).toMatchObject({ required: ["path"], additionalProperties: false })
    expect(Object.keys((tool.inputSchema as { properties: object }).properties).sort()).toEqual(["cursor", "mission", "path", "row"])
    expect(tool.description.length).toBeLessThanOrEqual(200)
    expect(tool.description).not.toMatch(/\bKL\b/)
  })

  test("a file of the index is served from the library root, with its domain; no row = not recorded", async () => {
    const r = await call({ path: FIRST_CV })
    expect(r.isError).toBe(false)
    expect(r.text).toContain("# Rantai jaminan visi komputer\nisi\n")
    expect(r.text).toContain("not recorded")
    expect(r.data).toMatchObject({ ok: true, tool: LIBRARY_READ_TOOL, path: FIRST_CV, domain: "COMPUTER-VISION", recorded: false, bytes: { from: 0, to: 35, total: 35 } })
    expect(r.data.cursor).toBeUndefined()
    // a top-level guide of the edition is also inside the root
    const g = await call({ path: "PANDUAN-AKSES.md" })
    expect(g.isError).toBe(false)
    expect(g.text).toContain("# Panduan akses")
    expect(g.data.domain).toBeNull()
    // the domain comes from the folder when the file is not in a read order
    expect((await call({ path: "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/latin1.md" })).isError).toBe(true)
    expect((await call({ path: CARD_CV })).data.domain).toBe("COMPUTER-VISION")
    // nothing was recorded on any row
    expect(consulted("1")).toEqual([["COMPUTER-VISION", []], ["NETWORKING", []]])
  })

  test("traversal, absolute, NUL, backslash, hidden, empty segment and skill paths are refused", async () => {
    const bad: Array<[unknown, string]> = [
      ["../outside/rahasia.md", "PATH_INVALID"],
      ["05_DOMAIN-KNOWLEDGE/../../../outside/rahasia.md", "PATH_INVALID"],
      ["./PANDUAN-AKSES.md", "PATH_INVALID"],
      [join(OUTSIDE, "rahasia.md"), "PATH_INVALID"],
      ["C:/Windows/win.ini", "PATH_INVALID"],
      ["PANDUAN-AKSES.md\u0000.png", "PATH_INVALID"],
      ["05_DOMAIN-KNOWLEDGE\\COMPUTER-VISION\\RANTAI-JAMINAN.md", "PATH_INVALID"],
      ["05_DOMAIN-KNOWLEDGE//COMPUTER-VISION/RANTAI-JAMINAN.md", "PATH_INVALID"],
      [".git/config", "PATH_INVALID"],
      ["skill:gsp-diagram-standard/references/index.md", "PATH_INVALID"],
      ["", "INVALID_ARGUMENT"],
      [42, "INVALID_ARGUMENT"],
      ["x".repeat(513), "INVALID_ARGUMENT"],
    ]
    for (const [path, code] of bad) {
      const r = await call({ path })
      expect(r.isError, String(path)).toBe(true)
      expect(r.data.code, String(path)).toBe(code)
      expect(r.text).not.toContain("outside the library\n")
    }
    expect((await call({ path: FIRST_CV, extra: 1 })).data.code).toBe("INVALID_ARGUMENT")
  })

  test("a symlink out of the library is refused; a symlink that stays inside is served", async () => {
    const out = await call({ path: "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/tautan-keluar.md" })
    expect(out.isError).toBe(true)
    expect(out.data.code).toBe("PATH_OUTSIDE_ROOTS")
    expect(out.text).not.toContain("outside the library")
    expect(out.text).not.toContain(OUTSIDE)
    const dir = await call({ path: "05_DOMAIN-KNOWLEDGE/folder-keluar/rahasia.md" })
    expect(dir.isError).toBe(true)
    expect(dir.data.code).toBe("PATH_OUTSIDE_ROOTS")
    const inside = await call({ path: "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/tautan-dalam.md" })
    expect(inside.isError).toBe(false)
    expect(inside.text).toContain("# Jaringan")
  })

  test("non-text files are refused (NUL byte, not UTF-8, not a text extension); missing file and folder are refused", async () => {
    for (const p of ["05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/biner.md", "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/latin1.md", "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/dok.pdf"]) {
      const r = await call({ path: p })
      expect(r.isError, p).toBe(true)
      expect(r.data.code, p).toBe("PATH_INVALID")
    }
    // C33: an image is answered with its path and size, never as text
    const img = await call({ path: "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/gambar.png" })
    expect(img.isError).toBe(false)
    expect(img.data).toMatchObject({ image: true, bytes: { total: 4 }, domain: "COMPUTER-VISION" })
    expect((await call({ path: "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/tidak-ada.md" })).data.code).toBe("FILE_UNREADABLE")
    expect((await call({ path: "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION" })).data.code).toBe("FILE_UNREADABLE")
  })

  test(`a file larger than one page (${LIBRARY_PAGE_BYTES} B) comes in pages with a cursor; joined pages equal the file`, async () => {
    let cursor: number | undefined
    let joined = ""
    let pages = 0
    do {
      const r = await call({ path: BIG, ...(cursor !== undefined ? { cursor } : {}) })
      expect(r.isError).toBe(false)
      const bytes = r.data.bytes as { from: number; to: number; total: number }
      expect(bytes.total).toBe(150_000)
      expect(bytes.to - bytes.from).toBeLessThanOrEqual(LIBRARY_PAGE_BYTES)
      const body = r.text.slice(r.text.indexOf("\n---\n") + 5)
      expect(body.endsWith("\n")).toBe(true) // pages end on a line end
      joined += body
      cursor = r.data.cursor as number | undefined
      if (cursor !== undefined) expect(r.text).toContain(`cursor: ${cursor}`)
      pages++
    } while (cursor !== undefined && pages < 10)
    expect(pages).toBe(3)
    expect(joined).toBe(BIG_TEXT)
    expect((await call({ path: BIG, cursor: 150_000 })).data.code).toBe("INVALID_ARGUMENT")
    expect((await call({ path: BIG, cursor: -1 })).data.code).toBe("INVALID_ARGUMENT")
  })

  test("a multi-byte file is cut on a character boundary", async () => {
    const small = libraryReadExtension(store as unknown as LibraryReadStore, { root: LIB, log, pageBytes: 7 })
    put("05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/aksara.md", "ééééé") // 10 bytes, no line end
    const a = await call({ path: "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/aksara.md" }, small)
    expect(a.data.bytes).toEqual({ from: 0, to: 6, total: 10 })
    expect(a.data.cursor).toBe(6)
    expect((await call({ path: "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/aksara.md", cursor: 5 }, small)).data.code).toBe("INVALID_ARGUMENT")
    const b = await call({ path: "05_DOMAIN-KNOWLEDGE/COMPUTER-VISION/aksara.md", cursor: 6 }, small)
    expect(b.text.endsWith("éé")).toBe(true)
    expect(b.data.cursor).toBeUndefined()
  })

  test(`a file over the cap (${LIBRARY_FILE_MAX_BYTES} B) is refused with its size`, async () => {
    const capped = libraryReadExtension(store as unknown as LibraryReadStore, { root: LIB, log, maxBytes: 1000 })
    const r = await call({ path: BIG }, capped)
    expect(r.isError).toBe(true)
    expect(r.data.code).toBe("PAYLOAD_TOO_LARGE")
    expect((r.data.error as { details: Record<string, unknown> }).details).toMatchObject({ bytes: 150_000, maxBytes: 1000 })
  })

  test("with mission and a running row: the read is stored on the row's knowledge and the reply says so", async () => {
    const r = await call({ path: FIRST_CV, mission: MID, row: "1" })
    expect(r.isError).toBe(false)
    expect(r.data).toMatchObject({ recorded: true, recordedDomains: ["COMPUTER-VISION"], mission: MID, row: "1" })
    expect(r.text).toContain(`recorded: mission ${MID} row 1 (COMPUTER-VISION)`)
    // another file of the same domain is marked through its domain (not only the first file)
    const card = await call({ path: CARD_CV, mission: MID, row: "1" })
    expect(card.data).toMatchObject({ recorded: true, recordedDomains: ["COMPUTER-VISION"] })
    // the second read of the same file is served, not stored twice
    const again = await call({ path: FIRST_CV, mission: MID, row: "1" })
    expect(again.isError).toBe(false)
    expect(again.data).toMatchObject({ recorded: false, notRecorded: "already-marked" })
    expect(consulted("1")).toEqual([["COMPUTER-VISION", [FIRST_CV, CARD_CV]], ["NETWORKING", []]])
    // the store logged a row-change event with the consulted path
    const ev = store.missions.listEvents(MID, { take: 1000 }).filter((e) => e.verb === "row-change" && (e.detail as { consulted?: string }).consulted)
    expect(ev.map((e) => [e.row, (e.detail as { consulted: string }).consulted])).toEqual([["1", FIRST_CV], ["1", CARD_CV]])
  })

  test("reads that cannot be recorded are still served and say why", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ mission: MID, row: "2" }, "no-knowledge"],
      [{ mission: MID, row: "3" }, "row-not-running"],
      [{ mission: MID, row: "99" }, "ROW_UNKNOWN"],
      [{ mission: "2026-11-17_nowhere", row: "1" }, "MISSION_NOT_FOUND"],
    ]
    for (const [extra, reason] of cases) {
      const r = await call({ path: FIRST_NET, ...extra })
      expect(r.isError, reason).toBe(false)
      expect(r.text).toContain("# Jaringan")
      expect(r.data, reason).toMatchObject({ recorded: false, notRecorded: reason })
      expect(r.text).toContain(`not recorded (${reason})`)
    }
    // a top-level file belongs to no domain of the row
    expect((await call({ path: "PANDUAN-AKSES.md", mission: MID, row: "1" })).data).toMatchObject({ recorded: false, notRecorded: "no-domain" })
    expect(consulted("3")).toEqual([["COMPUTER-VISION", []], ["NETWORKING", []]])
    // mission without row (or the reverse) is an argument error, not a silent unrecorded read
    expect((await call({ path: FIRST_NET, mission: MID })).data.code).toBe("INVALID_ARGUMENT")
    expect((await call({ path: FIRST_NET, row: "1" })).data.code).toBe("INVALID_ARGUMENT")
  })

  test("without a library root the tool answers not available; a refused read on it never touches the store", async () => {
    for (const root of [null, "relative/lib", join(RUN, "no-such-folder")]) {
      const t = libraryReadExtension(store as unknown as LibraryReadStore, { root, log })
      const r = await call({ path: FIRST_CV, mission: MID, row: "1" }, t)
      expect(r.isError).toBe(false)
      expect(r.data).toMatchObject({ ok: false, available: false })
      expect(r.text).toContain("not available")
    }
    expect(consulted("1")).toEqual([["COMPUTER-VISION", [FIRST_CV, CARD_CV]], ["NETWORKING", []]])
  })

  test("refusals are logged without file contents; the library is unchanged", () => {
    const refusals = logs.filter((l) => l.level === "warn")
    expect(refusals.length).toBeGreaterThan(5)
    for (const l of refusals) expect(JSON.stringify(l)).not.toContain("outside the library")
    // only the one file this test added (aksara.md) is new
    expect(snapshot().filter((f) => !BEFORE.includes(f)).map((f) => f.split(":")[0])).toEqual([join(...LIBRARY_INDEX_BASE.split("/"), "05_DOMAIN-KNOWLEDGE", "COMPUTER-VISION", "aksara.md")])
  })
})

describe("row 100 / C33: skill:<name>/<path> of a built-in skill", () => {
  const withSkills = () => libraryReadExtension(store as unknown as LibraryReadStore, { root: LIB, skillRoots: SKILL_ROOTS, log })

  test("the skill's first file is served from the skill root and recorded on the row like a library file", async () => {
    const r = await call({ path: SKILL_FIRST, mission: MID, row: "4" }, withSkills())
    expect(r.isError).toBe(false)
    expect(r.text).toContain("# Indeks rujukan diagram")
    expect(r.data).toMatchObject({ path: SKILL_FIRST, domain: "DIAGRAM-STANDARD", recorded: true, recordedDomains: ["DIAGRAM-STANDARD"] })
    // another file of the same skill counts for the domain the index gives that skill
    const other = await call({ path: "skill:gsp-diagram-standard/references/cara_bingkai_lembar.md", mission: MID, row: "4" }, withSkills())
    expect(other.data).toMatchObject({ domain: "DIAGRAM-STANDARD", recorded: true })
    expect(consulted("4")).toEqual([["DIAGRAM-STANDARD", [SKILL_FIRST, "skill:gsp-diagram-standard/references/cara_bingkai_lembar.md"]]])
  })

  test("an image is not served as text: the reply gives its absolute path and size, and the read is recorded", async () => {
    const r = await call({ path: "skill:gsp-diagram-standard/references/pages/p028.jpg", mission: MID, row: "4" }, withSkills())
    expect(r.isError).toBe(false)
    const file = join(realpathSync(SKILL_ROOT), "references", "pages", "p028.jpg")
    expect(r.data).toMatchObject({ image: true, file, bytes: { total: 8 }, recorded: true, recordedDomains: ["DIAGRAM-STANDARD"] })
    expect(r.text).toContain(file)
    expect(r.text).not.toContain("\u00ff")
    expect(consulted("4")![0]![1]).toContain("skill:gsp-diagram-standard/references/pages/p028.jpg")
  })

  test("unknown or not allow-listed skills are refused", async () => {
    for (const p of ["skill:other-skill/x.md", "skill:nope/x.md", "skill:gsp-diagram-standard", "skill:/references/index.md", "skill:GSP-Diagram-Standard/references/index.md"]) {
      const r = await call({ path: p }, withSkills())
      expect(r.isError, p).toBe(true)
      expect(r.data.code, p).toBe("PATH_INVALID")
      expect(r.text).not.toContain("# lain")
    }
  })

  test("traversal and symlink escape out of the skill root are refused; non-text, non-image files too", async () => {
    const t = withSkills()
    for (const p of ["skill:gsp-diagram-standard/../other-skill/x.md", "skill:gsp-diagram-standard/references/../../other-skill/x.md", "skill:gsp-diagram-standard//references/index.md", "skill:gsp-diagram-standard/.hidden.md"]) {
      const r = await call({ path: p }, t)
      expect(r.data.code, p).toBe("PATH_INVALID")
      expect(r.text).not.toContain("# lain")
    }
    const link = await call({ path: "skill:gsp-diagram-standard/references/keluar.md" }, t)
    expect(link.data.code).toBe("PATH_OUTSIDE_ROOTS")
    expect(link.text).not.toContain("outside the library")
    expect((await call({ path: "skill:gsp-diagram-standard/scripts/bingkai_lembar.py" }, t)).data.code).toBe("PATH_INVALID")
    const capped = libraryReadExtension(store as unknown as LibraryReadStore, { root: LIB, skillRoots: SKILL_ROOTS, log, maxBytes: 4 })
    expect((await call({ path: "skill:gsp-diagram-standard/references/pages/p028.jpg" }, capped)).data.code).toBe("PAYLOAD_TOO_LARGE")
  })

  test("skill files are served without a library root; library files then answer not available", async () => {
    const t = libraryReadExtension(store as unknown as LibraryReadStore, { root: null, skillRoots: SKILL_ROOTS, log })
    const r = await call({ path: SKILL_FIRST }, t)
    expect(r.isError).toBe(false)
    expect(r.data).toMatchObject({ recorded: false, domain: null })
    expect((await call({ path: FIRST_CV }, t)).data).toMatchObject({ available: false })
  })
})
