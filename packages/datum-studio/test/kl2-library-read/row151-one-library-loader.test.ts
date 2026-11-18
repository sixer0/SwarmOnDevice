// 1.3.3 row 151 (senior review S8 + the Studio half of S2): one trigger-index loader and one library-root resolution.
// - The matcher (rows 99/101, create/start) and the reader (row 100, studio_library_read) load the SAME index file for
//   every search case: each candidate file below carries its own domain name, so the domain each side reports names
//   the file it loaded.
// - One `libraryRootOf` (real path, folder check); the matcher reads no environment value.
// - The reply lines of create/start name the exact call `datum-studio_studio_library_read {path, mission, row}`.
// No server, no port.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as KM from "../../src/mcp-host/mission/knowledge-match.ts"
import * as OnRow from "../../src/mcp-host/mission/knowledge-on-row.ts"
import * as LR from "../../src/mcp-host/library-read.ts"
import { nextCall } from "../../src/mcp-host/mission/next-call.ts"
import { isStoreError } from "../../src/store/index.ts"
import { closeStores, mission, openStore } from "../mc5-row-close-gate/_seed.ts"

const BASE = path.join(tmpdir(), "row151-loader")
mkdirSync(BASE, { recursive: true })
const RUN = realpathSync(mkdtempSync(path.join(BASE, "run-")))
afterAll(async () => {
  rmSync(RUN, { recursive: true, force: true })
  await closeStores()
})

const BANK = "4 Knowledge Bank/ekas-lapis-teks"
const FILE = "05_DOMAIN-KNOWLEDGE/X/first.md"
let n = 0
function lib(): string {
  const root = path.join(RUN, `lib-${++n}`)
  mkdirSync(path.join(root, ...BANK.split("/"), "05_DOMAIN-KNOWLEDGE", "X"), { recursive: true })
  writeFileSync(path.join(root, ...BANK.split("/"), ...FILE.split("/")), "# first\n")
  return root
}
/** An index whose one domain names where it lies, so a match and a read both tell which file was loaded. */
function put(root: string, folder: string, name: string, domain: string, extra: Record<string, unknown> = {}) {
  const dir = folder === "" ? root : path.join(root, ...folder.split("/"))
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  writeFileSync(file, JSON.stringify({ domains: { [domain]: { terms: ["pemicu"], read_order: [FILE] } }, weak: [], ...extra }))
  return file
}
/** What each side loaded: the matcher's domain for "pemicu", the reader's domain for the first file. */
function sides(root: string) {
  const matched = OnRow.rowKnowledgeMatcher({ libraryRoot: root })("pemicu")
  return { matcher: matched.domains[0]?.domain ?? null, reader: LR.libraryDomainOf(LR.libraryRootOf(root), FILE) }
}

describe("row 151: matcher and reader load the same index file", () => {
  const cases: Array<{ name: string; files: Array<[string, string, string]>; want: string | null }> = [
    { name: "root, builder name", files: [["", "indeks_pemicu.json", "ROOT-LOWER"]], want: "ROOT-LOWER" },
    { name: "root, edition name", files: [["", "INDEKS-PEMICU.json", "ROOT-UPPER"]], want: "ROOT-UPPER" },
    { name: "knowledge-library-index/", files: [["knowledge-library-index", "indeks_pemicu.json", "KLI-LOWER"]], want: "KLI-LOWER" },
    { name: "index base (the bank text layer), builder name", files: [[BANK, "indeks_pemicu.json", "BANK-LOWER"]], want: "BANK-LOWER" },
    { name: "index base, edition name", files: [[BANK, "INDEKS-PEMICU.json", "BANK-UPPER"]], want: "BANK-UPPER" },
    { name: "root wins over index base", files: [[BANK, "indeks_pemicu.json", "BANK-LOWER"], ["", "indeks_pemicu.json", "ROOT-LOWER"]], want: "ROOT-LOWER" },
    { name: "builder name wins over edition name in one folder", files: [["", "INDEKS-PEMICU.json", "ROOT-UPPER"], ["", "indeks_pemicu.json", "ROOT-LOWER"]], want: "ROOT-LOWER" },
    { name: "knowledge-library-index wins over index base", files: [[BANK, "INDEKS-PEMICU.json", "BANK-UPPER"], ["knowledge-library-index", "INDEKS-PEMICU.json", "KLI-UPPER"]], want: "KLI-UPPER" },
    { name: "no index anywhere", files: [], want: null },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const root = lib()
      for (const [folder, name, domain] of c.files) put(root, folder, name, domain)
      const s = sides(root)
      expect(s.matcher as string | null).toEqual(c.want)
      // without an index the reader falls back to the domain folder (X), which is not a domain of any index
      expect(s.reader).toBe(c.want ?? "X")
      const file = KM.resolveTriggerIndexPath({ libraryRoot: root })
      const want = c.files.find(([, , d]) => d === c.want)
      expect(file).toBe(want ? path.join(root, ...want[0].split("/").filter(Boolean), want[1]) : undefined)
    })
  }

  test("a malformed first file is not skipped by either side (both see no index)", () => {
    const root = lib()
    writeFileSync(path.join(root, "indeks_pemicu.json"), "{not json")
    put(root, BANK, "indeks_pemicu.json", "BANK-LOWER")
    expect(OnRow.rowKnowledgeMatcher({ libraryRoot: root })("pemicu").reason).toMatch(/^index not JSON: /)
    // the reader then falls back to the folder rule; it does not read the index under the bank
    expect(LR.libraryDomainOf(LR.libraryRootOf(root), FILE)).toBe("X")
  })

  test("a symlinked index is skipped by both sides; the next candidate is used", () => {
    const root = lib()
    const elsewhere = put(path.join(RUN, `elsewhere-${n}`), "", "indeks_pemicu.json", "LINKED")
    symlinkSync(elsewhere, path.join(root, "indeks_pemicu.json"))
    put(root, BANK, "indeks_pemicu.json", "BANK-LOWER")
    expect(sides(root)).toEqual({ matcher: "BANK-LOWER", reader: "BANK-LOWER" })
  })

  test("an index over the size cap is skipped by both sides", () => {
    const root = lib()
    put(root, "", "indeks_pemicu.json", "ROOT-LOWER", { pad: "x".repeat(KM.TRIGGER_INDEX_MAX_BYTES) })
    put(root, BANK, "indeks_pemicu.json", "BANK-LOWER")
    expect(statSync(path.join(root, "indeks_pemicu.json")).size).toBeGreaterThan(KM.TRIGGER_INDEX_MAX_BYTES)
    expect(sides(root)).toEqual({ matcher: "BANK-LOWER", reader: "BANK-LOWER" })
  })

  test("a root given through a symlink resolves to the same real folder on both sides", () => {
    const root = lib()
    put(root, BANK, "indeks_pemicu.json", "BANK-LOWER")
    const link = path.join(RUN, `link-${n}`)
    symlinkSync(root, link)
    expect(sides(link)).toEqual({ matcher: "BANK-LOWER", reader: "BANK-LOWER" })
  })

  test("one search list, documented: folders x names", () => {
    expect(KM.triggerIndexCandidates({ libraryRoot: "/lib" })).toEqual([
      "/lib/indeks_pemicu.json",
      "/lib/INDEKS-PEMICU.json",
      "/lib/knowledge-library-index/indeks_pemicu.json",
      "/lib/knowledge-library-index/INDEKS-PEMICU.json",
      `/lib/${BANK}/indeks_pemicu.json`,
      `/lib/${BANK}/INDEKS-PEMICU.json`,
    ])
    expect(LR.LIBRARY_INDEX_BASE).toBe(KM.LIBRARY_INDEX_BASE)
  })
})

describe("row 151: the loader caches per file, size and mtime", () => {
  test("same size and mtime = cached; a new mtime = read again", () => {
    const root = lib()
    const file = put(root, "", "indeks_pemicu.json", "AAAA-1")
    const t = new Date("2026-11-18T00:00:00Z")
    utimesSync(file, t, t)
    expect(sides(root).matcher).toBe("AAAA-1")
    // same length, same mtime: the cache answers
    writeFileSync(file, readFileSync(file, "utf8").replace("AAAA-1", "BBBB-2"))
    utimesSync(file, t, t)
    expect(sides(root)).toEqual({ matcher: "AAAA-1", reader: "AAAA-1" })
    const t2 = new Date("2026-11-18T00:00:05Z")
    utimesSync(file, t2, t2)
    expect(sides(root)).toEqual({ matcher: "BBBB-2", reader: "BBBB-2" })
  })
})

describe("row 151: one library root, no second environment read", () => {
  test("one libraryRootOf: the reader's is the matcher module's; the row helper exports none", () => {
    expect(LR.libraryRootOf).toBe(KM.libraryRootOf)
    expect("libraryRootOf" in OnRow).toBe(false)
  })

  test("libraryRootOf: real path of an absolute folder, else null", () => {
    const root = lib()
    const link = path.join(RUN, `root-link-${n}`)
    symlinkSync(root, link)
    expect(KM.libraryRootOf(link)).toBe(root)
    expect(KM.libraryRootOf("relative/x")).toBeNull()
    expect(KM.libraryRootOf(path.join(root, "absent"))).toBeNull()
    expect(KM.libraryRootOf(path.join(root, ...BANK.split("/"), ...FILE.split("/")))).toBeNull()
    expect(KM.libraryRootOf(null)).toBeNull()
    expect(KM.libraryRootOf(undefined)).toBeNull()
  })

  test("the matcher does not fall back to STUDIO_LIBRARY_ROOT", () => {
    const root = lib()
    put(root, "", "indeks_pemicu.json", "ENV-ONLY")
    const before = process.env.STUDIO_LIBRARY_ROOT
    process.env.STUDIO_LIBRARY_ROOT = root
    try {
      expect(OnRow.rowKnowledgeMatcher({})("pemicu")).toEqual({ domains: [], reason: "index path not known" })
    } finally {
      if (before === undefined) delete process.env.STUDIO_LIBRARY_ROOT
      else process.env.STUDIO_LIBRARY_ROOT = before
    }
  })

  test("source: STUDIO_LIBRARY_ROOT is read from the environment in start.ts only", () => {
    const src = path.resolve(import.meta.dir, "../../src")
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.ts$/.test(e.name) && /process\.env\.STUDIO_LIBRARY_ROOT|process\.env\[["']STUDIO_LIBRARY_ROOT/.test(readFileSync(p, "utf8"))) hits.push(path.relative(src, p))
      }
    }
    walk(src)
    expect(hits).toEqual([path.join("mcp-host", "start.ts")])
  })
})

describe("row 151 (S2): the reply names the recorded call, in words", () => {
  test("one line per domain: the tool datum-studio_studio_library_read with path verbatim, mission and row", () => {
    const lines = OnRow.knowledgeLines(
      {
        rows: [
          { row: "1", domains: [{ domain: "FIBER-OPTIC", firstFile: "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md" }] },
          { row: "2", domains: [{ domain: "DIAGRAM-STANDARD", firstFile: "skill:gsp-diagram-standard/references/index.md" }] },
        ],
        mission: [{ domain: "VIDEO-SURVEILLANCE", firstFile: "04_KNOWLEDGE-CARDS/VIDEO-SURVEILLANCE/A.md" }],
      },
      "2026-11-18_m",
    )
    console.log(`[row151] reply lines:\n${lines.join("\n")}`)
    expect(lines.slice(1)).toEqual([
      '  row 1: FIBER-OPTIC -> call the tool datum-studio_studio_library_read with path "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md", mission "2026-11-18_m", row "1"',
      '  row 2: DIAGRAM-STANDARD -> call the tool datum-studio_studio_library_read with path "skill:gsp-diagram-standard/references/index.md", mission "2026-11-18_m", row "2"',
      '  mission title (not stored on rows): VIDEO-SURVEILLANCE -> call the tool datum-studio_studio_library_read with path "04_KNOWLEDGE-CARDS/VIDEO-SURVEILLANCE/A.md" (no mission and row: nothing is recorded)',
    ])
    expect(lines.join("\n")).not.toContain("skill file ")
    expect(lines.join("\n")).not.toMatch(/\bKL\b/)
  })
})

// MC-1/MC-3: `tool_name {"...` is the shape models copy as a text-form tool call. Scope (coordinator ruling): the reply
// builders rows 99-102 and 151 added; the legacy hint table of the base commit is a listed follow-up, not tested here.
describe("row 151: no call-shaped `tool_name {\"` in the knowledge reply builders", () => {
  const CALL_SHAPED = /[a-z_]+ \{"/
  test("create/start knowledge lines, the read call, the KNOWLEDGE_NOT_CONSULTED hint and refusal", async () => {
    const texts = [
      ...OnRow.knowledgeLines({ rows: [{ row: "r\"1", domains: [{ domain: "A", firstFile: 'x {"y".md' }] }], mission: [{ domain: "B", firstFile: "b.md" }] }, "m-1"),
      ...OnRow.knowledgeLines({ rows: [], unavailable: "index path not known" }, "m-1"),
      OnRow.libraryReadCall("a.md"),
      OnRow.libraryReadCall("a.md", { mission: "m", row: "1" }),
      nextCall("KNOWLEDGE_NOT_CONSULTED"),
      await knowledgeRefusal(),
    ]
    for (const t of texts.filter((x) => !x.includes('x {"y"'))) expect(t).not.toMatch(CALL_SHAPED)
    // a value that itself holds the shape stays inside its quotes, after "path", never right after a tool name
    expect(texts.find((x) => x.includes('x {\\"y'))).toContain('with path "x {\\"y\\".md"')
  })
})

async function knowledgeRefusal(): Promise<string> {
  const store = await openStore("row151-refusal", false)
  const id = "2026-11-18_row151-refusal"
  await mission(store, id, ["1"])
  await store.transaction(async (t) => store.missions.setRowKnowledge(t, id, "1", { domains: [{ domain: "FIBER-OPTIC", firstFile: "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md", consulted: [] }] }))
  try {
    await store.transaction(async (t) => store.missions.updateRows(t, id, [{ id: "1", status: "done", note: "tests pass" } as never]))
  } catch (e) {
    if (isStoreError(e, "KNOWLEDGE_NOT_CONSULTED")) return (e as Error).message
    throw e
  }
  throw new Error("expected KNOWLEDGE_NOT_CONSULTED")
}
