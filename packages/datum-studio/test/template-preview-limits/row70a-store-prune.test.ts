// Row 70a (security M1, decision C90): the store method `prunePreviewOutputs(keep)`. A real temp store
// (SqliteStudioStore, bun:sqlite); nothing is a stand-in. Temp folders under ROW70A_TEST_DIR (default
// /private/tmp/claude-501/row70a/tests); nothing outside them is written, except one "outside" folder there too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { canonicalJson, isStoreError, sha256Hex, SqliteStudioStore, type BuiltinTemplateFile, type StoreLogEntry } from "../../src/store/index.ts"
import { makeDocumentOutput, makePreview, previewCensus, reader } from "./helpers.ts"

const BASE = process.env.ROW70A_TEST_DIR ?? "/private/tmp/claude-501/row70a/tests"
mkdirSync(BASE, { recursive: true })
const RUN = realpathSync(mkdtempSync(join(BASE, "store-")))
const logs: StoreLogEntry[] = []
let tick = 1_900_000_000_000
const store = new SqliteStudioStore()
let tvId = ""

const DEF = { schema: "studio.template/v2", slug: "nota-dinas", slots: [{ slotKey: "isi" }] }
const BUILTIN: BuiltinTemplateFile = { slug: "nota-dinas", name: "Nota Dinas", kind: "DOCUMENT", versionNo: 1, definition: DEF, definitionSha256: sha256Hex(canonicalJson(DEF)), file: "nota-dinas.json", fileSha256: "a".repeat(64), release: "1.2.0" }

beforeAll(async () => {
  await store.open(join(RUN, "datum-studio"), { release: "1.2.0", log: (e) => logs.push(e), agentClock: () => ++tick })
  tvId = (await store.transaction((tx) => store.pinBuiltinVersion(tx, BUILTIN))).id
})

afterAll(async () => {
  await store.close()
})

describe("row 70a: StudioStore.prunePreviewOutputs", () => {
  test("keeps the newest N previews; older previews lose their rows, files and folder; a document output and other files survive", async () => {
    const docOut = await makeDocumentOutput(store, tvId, "store")
    // A file under tmp/ outside tmp/preview/, and an orphan preview folder without rows: never touched.
    mkdirSync(join(store.rootDir, "tmp", "other"), { recursive: true })
    writeFileSync(join(store.rootDir, "tmp", "other", "keep.txt"), "keep")
    const made: string[] = []
    for (let i = 0; i < 5; i++) made.push((await makePreview(store, ["GSP Pratinjau Templat.docx", "GSP Pratinjau Templat.html", "GSP Pratinjau Templat.pdf"])).id)
    mkdirSync(join(store.rootDir, "tmp", "preview", "orphan-folder"), { recursive: true })
    writeFileSync(join(store.rootDir, "tmp", "preview", "orphan-folder", "x.bin"), "orphan")

    const r = await store.prunePreviewOutputs(2)
    expect(r).toEqual({ keptPreviews: 2, removedPreviews: 3, removedRows: 9, removedFiles: 9 })
    const c = previewCensus(store)
    // the two newest previews remain, with all three rows and files each
    const kept = made.slice(3)
    expect(c.rows).toEqual(kept.flatMap((id) => ["docx", "html", "pdf"].map((x) => `tmp/preview/${id}/GSP Pratinjau Templat.${x}`)).sort())
    expect(c.files.filter((f) => !f.includes("orphan-folder"))).toEqual(c.rows)
    for (const id of made.slice(0, 3)) expect(existsSync(join(store.rootDir, "tmp", "preview", id))).toBe(false)
    // non-preview output, other tmp file and the orphan folder survive
    expect(c.rowsOfOtherKinds).toBe(1)
    expect(sha256Hex(await store.readOutputVerified(docOut.id))).toBe(docOut.sha256)
    expect(readFileSync(join(store.rootDir, "tmp", "other", "keep.txt"), "utf8")).toBe("keep")
    expect(existsSync(join(store.rootDir, "tmp", "preview", "orphan-folder", "x.bin"))).toBe(true)
    expect(logs.some((e) => e.source === "StudioStore.prunePreviewOutputs" && e.level === "info")).toBe(true)

    // idempotent; keep 0 removes every preview row, never the document output
    expect(await store.prunePreviewOutputs(2)).toEqual({ keptPreviews: 2, removedPreviews: 0, removedRows: 0, removedFiles: 0 })
    expect((await store.prunePreviewOutputs(0)).removedPreviews).toBe(2)
    expect(previewCensus(store).rows).toEqual([])
    expect(previewCensus(store).rowsOfOtherKinds).toBe(1)
    expect(existsSync(docOut.abs)).toBe(true)
  })

  test("rows whose files are already gone (swept at open) are removed without error", async () => {
    const p = await makePreview(store)
    const q = await makePreview(store)
    // the sweep at store open removes files but leaves rows: simulate it for the older preview
    renameSync(join(store.rootDir, "tmp", "preview", p.id), join(RUN, `swept-${p.id}`))
    const r = await store.prunePreviewOutputs(1)
    expect(r).toEqual({ keptPreviews: 1, removedPreviews: 1, removedRows: 1, removedFiles: 0 })
    expect(previewCensus(store).rows).toEqual(q.relPaths)
    await store.prunePreviewOutputs(0)
  })

  test("a preview folder replaced by a link to a folder outside the store: the row goes, the outside file stays", async () => {
    const outside = join(RUN, "outside")
    mkdirSync(outside, { recursive: true })
    const old = await makePreview(store, ["GSP Pratinjau Templat.docx"])
    await makePreview(store)
    const folder = join(store.rootDir, "tmp", "preview", old.id)
    renameSync(folder, join(RUN, `moved-${old.id}`))
    writeFileSync(join(outside, "GSP Pratinjau Templat.docx"), "outside, must survive")
    symlinkSync(outside, folder)
    const r = await store.prunePreviewOutputs(1)
    expect(r.removedRows).toBe(1)
    expect(r.removedFiles).toBe(0)
    expect(readFileSync(join(outside, "GSP Pratinjau Templat.docx"), "utf8")).toBe("outside, must survive")
    expect(reader(store).all("SELECT id FROM output_file WHERE rel_path LIKE ?", [`tmp/preview/${old.id}/%`])).toEqual([])
    await store.prunePreviewOutputs(0)
  })

  test("keep must be a non-negative integer (SCHEMA_INVALID), nothing removed", async () => {
    await makePreview(store)
    for (const bad of [-1, 1.5, Number.NaN]) {
      let err: unknown = null
      try {
        await store.prunePreviewOutputs(bad)
      } catch (e) {
        err = e
      }
      expect(isStoreError(err, "SCHEMA_INVALID")).toBe(true)
    }
    expect(previewCensus(store).rows.length).toBe(1)
  })
})
