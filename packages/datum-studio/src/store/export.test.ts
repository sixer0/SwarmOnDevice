/** Row 37 export/restore tests (bun). Temp: ROW37_TEST_DIR, else the OS temp folder. */
import { describe, expect, test, afterAll } from "bun:test"
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqlite } from "#sqlite"
import { canonicalJson, docNumberSafe, isStoreError, newId, restoreExport, sha256Hex, SqliteStudioStore, verifyExport, type RevisionRowsInput, type StoreErrorCode } from "./index.ts"

const BASE = process.env.ROW37_TEST_DIR ?? join(tmpdir(), "row37-export-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, "bun-"))
let tick = 1_800_000_000_000
const opened: SqliteStudioStore[] = []
async function openStore(name: string) {
  const s = new SqliteStudioStore()
  await s.open(join(RUN, name), { release: "1.2.0", agentClock: () => ++tick })
  opened.push(s)
  return s
}
afterAll(async () => {
  for (const s of opened) await s.close()
})
async function code(p: Promise<unknown> | (() => unknown), c: StoreErrorCode) {
  try {
    await (typeof p === "function" ? p() : p)
  } catch (e) {
    if (!isStoreError(e, c)) throw new Error(`expected ${c}, got ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  throw new Error(`expected ${c}, nothing thrown`)
}

const DEF = { schema: "studio.template/v2", slug: "nota-dinas", slots: [{ slotKey: "isi" }] }
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"))

function rows(ids: { ch: string; sub: string; b: string }, text: string, first: boolean): RevisionRowsInput {
  const s = newId(), c = newId(), u = newId()
  return {
    identities: first ? [{ id: ids.ch, pid: "p-ch1", kind: "CHAPTER" }, { id: ids.sub, pid: "p-s1", kind: "SUBSECTION" }, { id: ids.b, pid: "p-b1", kind: "BLOCK" }] : [],
    sections: [{ id: s, slot_key: "isi", section_type_key: "chapter", position: 1, filled: 1, payload: null, payload_sha256: "0".repeat(64) }],
    chapters: [{ id: c, doc_section_id: s, identity_id: ids.ch, chapter_key: "bab-1", position: 1, title: { text: "Bab 1" }, content_sha256: "1".repeat(64) }],
    subsections: [{ id: u, chapter_id: c, identity_id: ids.sub, section_no: 1, title: null, content_sha256: "2".repeat(64) }],
    blocks: [{ doc_section_id: s, chapter_id: c, subsection_id: u, identity_id: ids.b, pid: "p-b1", address: "1.1.1", ordinal: 1, para_no: 1, type: "paragraph", content: { text }, text_plain: text, content_sha256: sha256Hex(text) }],
  } as RevisionRowsInput
}
const content = (r: RevisionRowsInput, what: string) => ({ snapshot: { what }, inputSha256: sha256Hex(what), docRev: "A", change: { what, why: "t", impact: "none" }, createdBy: "swarm", rows: r })

/** Store with 2 documents (one revised twice), 1 asset, 2 output files. */
async function fixtureStore(name: string) {
  const store = await openStore(name)
  const tv = await store.transaction((tx) =>
    store.pinBuiltinVersion(tx, { slug: "nota-dinas", name: "Nota Dinas", kind: "DOCUMENT", versionNo: 1, definition: DEF, definitionSha256: sha256Hex(canonicalJson(DEF)), file: "nota-dinas.json", fileSha256: "a".repeat(64), release: "1.2.0" } as never),
  )
  for (let i = 1; i <= 2; i++) {
    const ids = { ch: newId(), sub: newId(), b: newId() }
    const doc = await store.transaction((tx) =>
      store.createDocument(tx, {
        docNumber: `00${i}/GSP/KT/X/2026`, numberSource: "AGENT", title: `Dokumen ${i}`, typeCode: "KT", classification: "TERBATAS", tier: "NOTA",
        templateVersionId: tv.id, missionFolder: `misi-${i}`, createdBy: "swarm", revision: content(rows(ids, `Tekanan pompa utama stabil ${i}`, true), "create"),
      } as never),
    )
    if (i === 1) {
      for (const t of ["Kalibrasi katup selesai", "Kalibrasi katup disetujui"]) {
        await store.transaction((tx) => store.appendRevision(tx, { documentId: doc.id, baseRevisionNo: "latest", ...content(rows(ids, t, false), t) } as never))
      }
    }
    const rev = (await store.getRevision(doc.id, "latest"))!.revision
    const bytes = new TextEncoder().encode(`%PDF-1.7 export ${i}`)
    const sha = sha256Hex(bytes)
    const rel = `docs/misi-${i}/studio/00${i}/rev-${rev.revision_no}/${docNumberSafe(doc.doc_number)}_rev${rev.revision_no}_20261107T000000Z_${sha.slice(0, 8)}.pdf`
    store.writeOutputBytes(rel, bytes)
    await store.transaction((tx) => store.putOutput(tx, { kind: "document", documentId: doc.id, revisionId: rev.id, format: "PDF", role: "PRIMARY", relPath: rel, fileName: rel.split("/").pop()!, bytes: bytes.byteLength, sha256: sha, mime: "application/pdf" }))
  }
  await store.putAsset(PNG, { mime: "image/png", widthPx: 1, heightPx: 1, createdBy: "swarm" })
  return store
}

function treeHashes(root: string, sub: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name), r = `${rel}/${e.name}`
      if (e.isDirectory()) walk(p, r)
      else out[r] = sha256Hex(readFileSync(p))
    }
  }
  if (existsSync(join(root, sub))) walk(join(root, sub), sub)
  return out
}

describe("export / restore", () => {
  test("export, restore into a new folder: rows, FTS, file hashes match", async () => {
    const store = await fixtureStore("src")
    const target = join(RUN, "export-1")
    const m = await store.exportTo(target)
    expect(m.counts).toEqual({ document: 2, revision: 4, output_file: 2, asset: 1 })
    expect(m.release).toBe("1.2.0")
    expect(readdirSync(target).sort()).toEqual(["assets", "datum-studio.sqlite", "docs", "export.json"])
    expect(JSON.parse(readFileSync(join(target, "export.json"), "utf8"))).toEqual(m)
    expect((statSync(target).mode & 0o777).toString(8)).toBe("700")

    const v = verifyExport(target)
    expect(v.filesChecked).toBe(3)
    expect(v.snapshot.journalMode).toBe("delete")

    const dest = join(RUN, "restored-1")
    const r = restoreExport(target, dest)
    expect(r.filesChecked).toBe(3)
    expect(existsSync(join(dest, "export.json"))).toBe(false)
    expect(treeHashes(dest, "assets")).toEqual(treeHashes(store.rootDir, "assets"))
    expect(treeHashes(dest, "docs")).toEqual(treeHashes(store.rootDir, "docs"))
    expect(Object.keys(treeHashes(dest, "docs")).length).toBe(2)

    // restored folder opens as a normal store: same rows, FTS finds the latest text, old text not
    const s2 = new SqliteStudioStore()
    await s2.open(dest, { release: "1.2.0", agentClock: () => ++tick })
    opened.push(s2)
    const hits = await s2.searchParagraphs({ q: "kalibrasi", includeArchived: true })
    const live = await store.searchParagraphs({ q: "kalibrasi", includeArchived: true })
    expect(hits.hits.length).toBe(1)
    expect(hits.hits.map((h) => h.documentId ?? (h as never as { document_id: string }).document_id)).toEqual(live.hits.map((h) => h.documentId ?? (h as never as { document_id: string }).document_id))
    expect((await s2.searchParagraphs({ q: "pompa", includeArchived: true })).hits.length).toBe(1) // doc 2 only
    const live2 = openSqlite(join(store.rootDir, "datum-studio.sqlite"), { readonly: true })
    const rest = openSqlite(join(dest, "datum-studio.sqlite"), { readonly: true })
    for (const t of ["document", "revision", "doc_block", "output_file", "asset", "template_version"]) {
      const q = `SELECT count(*) AS n FROM ${t}`
      expect(Number(rest.get<{ n: number }>(q)!.n)).toBe(Number(live2.get<{ n: number }>(q)!.n))
    }
    const sig = (db: typeof rest) => db.all<{ s: string }>("SELECT sha256 AS s FROM output_file ORDER BY rel_path").map((x) => x.s).join()
    expect(sig(rest)).toBe(sig(live2))
    live2.close()
    rest.close()
  })

  test("target guards", async () => {
    const store = await fixtureStore("guards")
    await code(store.exportTo(join(store.rootDir, "inside")), "PATH_OUTSIDE_ROOT")
    await code(store.exportTo(join(store.rootDir, "assets")), "PATH_OUTSIDE_ROOT")
    await code(store.exportTo(dirOf(store.rootDir)), "PATH_OUTSIDE_ROOT") // contains the store
    await code(store.exportTo("relative/x"), "PATH_OUTSIDE_ROOT")
    await code(store.exportTo(join(RUN, "no-parent", "x")), "NOT_FOUND")
    mkdirSync(join(RUN, "exists"))
    await code(store.exportTo(join(RUN, "exists")), "OUTPUT_EXISTS")
    expect(readdirSync(join(RUN, "exists")).length).toBe(0)
    const ok = join(RUN, "export-g")
    await store.exportTo(ok)
    await code(store.exportTo(ok), "OUTPUT_EXISTS")
    await code(() => restoreExport(ok, join(ok, "sub")), "PATH_OUTSIDE_ROOT")
    mkdirSync(join(RUN, "busy-dest"))
    writeFileSync(join(RUN, "busy-dest", "x"), "x")
    await code(() => restoreExport(ok, join(RUN, "busy-dest")), "OUTPUT_EXISTS")
  })

  test("symlink in the store is refused and leaves no half export", async () => {
    const store = await fixtureStore("symlink")
    symlinkSync("/etc/hosts", join(store.rootDir, "assets", "evil"))
    const target = join(RUN, "export-sym")
    await code(store.exportTo(target), "PATH_OUTSIDE_ROOT")
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(RUN).some((n) => n.startsWith("export-sym.failed-"))).toBe(true) // moved aside, not deleted
  })

  test("corrupted exports are detected", async () => {
    const store = await fixtureStore("corrupt")
    const good = join(RUN, "export-c")
    await store.exportTo(good)
    const variant = (name: string, mutate: (d: string) => void) => {
      const d = join(RUN, name)
      cpSync(good, d, { recursive: true })
      mutate(d)
      return d
    }
    const firstFile = (d: string, sub: string) => {
      const w = (p: string): string => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const q = join(p, e.name)
          if (e.isDirectory()) return w(q)
          return q
        }
        throw new Error("empty")
      }
      return w(join(d, sub))
    }
    // a doc output flipped byte
    await code(() => verifyExport(variant("c-doc", (d) => appendFileSync(firstFile(d, "docs"), "x"))), "INTEGRITY_MISMATCH")
    // an asset replaced with same-length garbage
    await code(() => verifyExport(variant("c-asset", (d) => { const f = firstFile(d, "assets"); writeFileSync(f, new Uint8Array(statSync(f).size).fill(7)) })), "INTEGRITY_MISMATCH")
    // missing file
    await code(() => verifyExport(variant("c-missing", (d) => rmSync(firstFile(d, "docs")))), "INTEGRITY_MISMATCH")
    // manifest missing / count tampered
    await code(() => verifyExport(variant("c-nomanifest", (d) => rmSync(join(d, "export.json")))), "INTEGRITY_MISMATCH")
    await code(() => verifyExport(variant("c-count", (d) => { const m = JSON.parse(readFileSync(join(d, "export.json"), "utf8")); m.counts.revision += 1; writeFileSync(join(d, "export.json"), JSON.stringify(m)) })), "INTEGRITY_MISMATCH")
    // sqlite damaged: truncated file is not a database
    const broken = variant("c-sqlite", (d) => writeFileSync(join(d, "datum-studio.sqlite"), readFileSync(join(d, "datum-studio.sqlite")).subarray(0, 5000)))
    let threw = false
    try { verifyExport(broken) } catch { threw = true }
    expect(threw).toBe(true)
    // restore refuses a corrupted export and creates nothing
    const dest = join(RUN, "restored-bad")
    await code(() => restoreExport(join(RUN, "c-doc"), dest), "INTEGRITY_MISMATCH")
    expect(existsSync(dest)).toBe(false)
    // the good one still verifies
    expect(verifyExport(good).filesChecked).toBe(3)
  })

  test("a store without assets or docs exports", async () => {
    const store = await openStore("empty")
    const m = await store.exportTo(join(RUN, "export-empty"))
    expect(m.counts).toEqual({ document: 0, revision: 0, output_file: 0, asset: 0 })
    expect(verifyExport(join(RUN, "export-empty")).filesChecked).toBe(0)
  })
})

function dirOf(p: string) {
  return p.slice(0, p.lastIndexOf("/"))
}
