// Swarm 1.3.3 row 74 (ST-10), replay R6: project 1, document ci6m49chw6rewonohzb42m91l. Inputs, all read-only copies
// in the patch task folder:
//   R6_project1_rev44_rev100/chapter_import_calls_session_e18a727e8.jsonl   the 59 studio_chapter_import_markdown calls
//   R6_project1_rev44_rev100/revisions_43_44_45_99_100_101_full.jsonl       six full revision rows (snapshots)
//   R7_studio_store_rows/revision_meta.jsonl                                revision number, scope and change note
//
// What the extract can and cannot show (asserted below, nothing substituted silently):
//   - It holds no snapshot pair (N-1, N) around ANY stored import, and the Markdown of 46 of the 59 calls was a file
//     path whose content is not in the extract. So no import can be replayed exactly: each is "not verifiable".
//   - Which imports lost figure blocks is still countable from the calls and the revision rows:
//       by pid evidence  a figure pid seen in the chapter before the import (in a snapshot, a `pid:` revision, or the
//                        overwrittenPids list of a refused call) and absent from the next snapshot, attributed to the
//                        first stored import of that chapter after the pid was last seen;
//       by change note   a stored import followed, before the next import of that chapter, by a revision of the same
//                        chapter whose note says the figures were installed again.
//   - For two of them (calls 44 and 54) the figure state before the import is the one of the rev 45 snapshot (same
//     pids as the refused calls 39 and 45 list). Those two are rebuilt with the REAL figure blocks and a SUBSTITUTED
//     text (the stored chapter minus its figure blocks, which is what a Markdown file without them imports to).
// No file -> the checks are "not verifiable" and the test says so.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { replayPath } from "../replay-dir"
import type { ChapterV2, StudioDocV2Resolved } from "../../vendor/src/lib/studio/contract"
import { StudioEngineError } from "../../vendor/src/lib/studio/contract/errors"
import { mergeSubmission, seededPidAllocator } from "../../vendor/src/lib/studio/services/compose"
import { assertNoFigureBlocksLost, findLostFigureBlocks } from "../../vendor/src/lib/studio/services/submit/overwrite"

type S = Record<string, any>
// Row 146: SWARM_REPLAY_DIR (ROW74_REPLAY_DIR still overrides); no fixed path.
const REPLAY = process.env.ROW74_REPLAY_DIR ?? replayPath() ?? ""
const CALLS = path.join(REPLAY, "R6_project1_rev44_rev100/chapter_import_calls_session_e18a727e8.jsonl")
const SNAPSHOTS = path.join(REPLAY, "R6_project1_rev44_rev100/revisions_43_44_45_99_100_101_full.jsonl")
const META = path.join(REPLAY, "R7_studio_store_rows/revision_meta.jsonl")
const DOC = "ci6m49chw6rewonohzb42m91l"
const FIGURES = ["chart", "diagram", "image"]
const present = [CALLS, SNAPSHOTS, META].every((f) => existsSync(f))
const jsonl = (f: string): S[] => readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l))

const chapterOf = (doc: StudioDocV2Resolved, key: string): ChapterV2 =>
  Object.values(doc.sections ?? {}).flatMap((p) => ((p as { chapters?: ChapterV2[] }).chapters ?? [])).find((c) => c.key === key)!
const blocksOf = (c: ChapterV2): S[] => [...(c.intro ?? []), ...c.sections.flatMap((s) => s.blocks)] as S[]
const figuresOf = (doc: StudioDocV2Resolved, key: string) => blocksOf(chapterOf(doc, key)).filter((b) => FIGURES.includes(b.type))
const stripIds = <T,>(x: T): T => JSON.parse(JSON.stringify(x, (k, v) => (k === "id" ? undefined : v)))
const mapBlocks = (c: ChapterV2, f: (b: S) => S[]): ChapterV2 =>
  ({ ...c, ...(c.intro ? { intro: (c.intro as S[]).flatMap(f) } : {}), sections: c.sections.map((s) => ({ ...s, blocks: (s.blocks as S[]).flatMap(f) })) }) as ChapterV2

function load() {
  const calls = jsonl(CALLS).map((c, index) => {
    const out = String(c.output ?? c.error ?? "")
    const stored = /^kirim bab (\S+): tersimpan; dokumen (\S+) \S+ rev (\d+) /.exec(out)
    const pids = /"overwrittenPids":(\[.*?\])/.exec(out)
    return {
      index,
      doc: String(c.arguments.documentId ?? ""),
      chapter: String(c.arguments.chapterKey ?? ""),
      inline: typeof c.arguments.markdown === "string",
      stored: stored ? Number(stored[3]) : null,
      refusedPids: pids ? (JSON.parse(pids[1]) as Array<{ pid: string; editedInRevision: number }>) : [],
    }
  })
  const snapshots = new Map(jsonl(SNAPSHOTS).map((r) => [Number(r.revision_no), JSON.parse(r.snapshot) as S]))
  const meta = jsonl(META).filter((r) => r.document_id === DOC).map((r) => ({ rev: Number(r.revision_no), scope: String(r.change_scope ?? ""), what: String(r.change_what ?? "") }))
  return { calls, snapshots, meta }
}

function merge(snapshot: S, chapter: ChapterV2) {
  const current = snapshot.source as StudioDocV2Resolved
  const merged = mergeSubmission(current, { $schema: "studio.chapter/v2", target: { documentId: DOC }, chapter } as never, {
    skeleton: snapshot.compose.skeleton,
    tier: snapshot.compose.tier,
    pids: seededPidAllocator("row74-replay"),
  })
  return { current, merged }
}

describe.skipIf(!present)("row 74 replay R6: which imports lost figure blocks", () => {
  test("no stored import has both neighbouring snapshots, and most calls sent a file path: no exact replay is possible", () => {
    const { calls, snapshots } = load()
    expect(calls).toHaveLength(59)
    const stored = calls.filter((c) => c.doc === DOC && c.stored !== null)
    const replayable = stored.filter((c) => snapshots.has(c.stored! - 1) && snapshots.has(c.stored!))
    console.log(`[row74 replay] stored imports on ${DOC}: ${stored.length}; with both snapshots: ${replayable.length}; calls with inline markdown: ${calls.filter((c) => c.inline).length} of 59`)
    expect([...snapshots.keys()].sort((a, b) => a - b)).toEqual([43, 44, 45, 99, 100, 101])
    expect(replayable).toEqual([])
    expect(calls.filter((c) => c.doc === DOC && c.inline)).toEqual([])
  })

  test("count: 3 imports by pid evidence (9 blocks), 5 by the re-install note", () => {
    const { calls, snapshots, meta } = load()
    const imports = calls.filter((c) => c.doc === DOC && c.stored !== null).map((c) => ({ call: c.index, rev: c.stored!, chapter: c.chapter }))

    // Figure pids and where each was seen: snapshots (with their chapter), `pid:` revisions, refused-call lists.
    const chapterOfPid = new Map<string, string>()
    const seen = new Map<string, number[]>()
    const note = (pid: string, rev: number) => seen.set(pid, [...(seen.get(pid) ?? []), rev])
    for (const [rev, snap] of snapshots) {
      for (const key of ["4", "5"]) for (const b of figuresOf(snap.source, key)) (chapterOfPid.set(b.id, key), note(b.id, rev))
    }
    for (const c of calls.filter((x) => x.doc === DOC)) for (const p of c.refusedPids) (chapterOfPid.has(p.pid) || chapterOfPid.set(p.pid, c.chapter), note(p.pid, p.editedInRevision))
    for (const r of meta) if (r.scope.startsWith("pid:") && chapterOfPid.has(r.scope.slice(4))) note(r.scope.slice(4), r.rev)

    const byPid = new Map<number, string[]>()
    for (const [pid, revs] of seen) {
      const last = Math.max(...revs)
      const nextSnapshot = [...snapshots.keys()].filter((r) => r > last).sort((a, b) => a - b)[0]
      if (nextSnapshot === undefined) continue // seen up to the last snapshot: not lost within the extract
      const still = figuresOf(snapshots.get(nextSnapshot)!.source, chapterOfPid.get(pid)!).some((b) => b.id === pid)
      if (still) continue
      const at = imports.filter((i) => i.chapter === chapterOfPid.get(pid) && i.rev > last && i.rev < nextSnapshot).sort((a, b) => a.rev - b.rev)[0]
      if (at) byPid.set(at.rev, [...(byPid.get(at.rev) ?? []), pid])
    }
    const pidRows = [...byPid].sort((a, b) => a[0] - b[0]).map(([rev, pids]) => ({ rev, call: imports.find((i) => i.rev === rev)!.call, blocks: pids.length }))
    console.log(`[row74 replay] lost by pid evidence: ${JSON.stringify(pidRows)}`)
    expect(pidRows).toEqual([
      { rev: 75, call: 44, blocks: 5 },
      { rev: 79, call: 49, blocks: 1 },
      { rev: 85, call: 54, blocks: 3 },
    ])

    const REINSTALL = /(Sisip|Pasang ulang|Pasang kembali).*grafik|Tambah blok diagram/i
    const byNote = imports.filter((i) => ["4", "5"].includes(i.chapter)).flatMap((i) => {
      const nextImport = imports.filter((x) => x.chapter === i.chapter && x.rev > i.rev).sort((a, b) => a.rev - b.rev)[0]?.rev ?? Infinity
      const hit = meta.find((r) => r.rev > i.rev && r.rev < nextImport && r.scope === `chapter:${i.chapter}` && REINSTALL.test(r.what))
      return hit ? [{ rev: i.rev, call: i.call, chapter: i.chapter, reinstalledAt: hit.rev }] : []
    })
    console.log(`[row74 replay] lost by re-install note: ${JSON.stringify(byNote)}`)
    expect(byNote.map((x) => [x.call, x.rev, x.reinstalledAt])).toEqual([
      [25, 21, 26],
      [44, 75, 76],
      [49, 79, 86],
      [54, 85, 87],
      [55, 96, 97],
    ])
  })

  test("calls 44 and 54 rebuilt (real figure blocks of rev 45, substituted text): refused with the list; with [[keep:<pid>]] nothing changes", () => {
    const { calls, snapshots } = load()
    const snap = snapshots.get(45)!
    for (const [call, key, refusedBy] of [[44, "4", 39], [54, "5", 45]] as const) {
      const figures = figuresOf(snap.source, key)
      // The refused call lists the same pids: the figure set of rev 45 is the one the import then removed.
      expect(calls[refusedBy].refusedPids.map((p) => p.pid).sort()).toEqual(figures.map((b) => b.id).sort())
      expect(calls[call].chapter).toBe(key)

      const withoutFigures = stripIds(mapBlocks(chapterOf(snap.source, key), (b) => (FIGURES.includes(b.type) ? [] : [b])))
      const lostRun = merge(snap, withoutFigures)
      expect(figuresOf(lostRun.merged.doc, key)).toEqual([]) // what the store did on 2026-11-17: the blocks are gone
      const lost = findLostFigureBlocks(lostRun.current, lostRun.merged)
      expect(lost.map((b) => b.id)).toEqual(figures.map((b) => b.id))
      expect(lost.map((b) => b.kind)).toEqual(figures.map((b) => b.type))
      for (const b of lost) expect(b.caption.length).toBeGreaterThan(10)
      const e = (() => {
        try {
          assertNoFigureBlocksLost({ current: lostRun.current, merged: lostRun.merged, latestRevisionNo: 45, documentId: DOC })
        } catch (x) {
          return x as StudioEngineError
        }
        return null
      })()
      expect(e).toBeInstanceOf(StudioEngineError)
      expect((e!.details as S).reason).toBe("FIGURE_BLOCKS_WOULD_BE_LOST")
      console.log(`[row74 replay] call ${call} (chapter ${key}) rebuilt -> ${e!.code}: ${e!.message}`)

      const withMarkers = stripIds(mapBlocks(chapterOf(snap.source, key), (b) => (FIGURES.includes(b.type) ? [{ type: "paragraph", text: `[[keep:${b.id}]]` }] : [b])))
      const keptRun = merge(snap, withMarkers)
      expect(findLostFigureBlocks(keptRun.current, keptRun.merged)).toEqual([])
      expect(keptRun.merged.changed).toBe(false)
      expect(figuresOf(keptRun.merged.doc, key)).toEqual(figures)

      const removal = stripIds(mapBlocks(chapterOf(snap.source, key), (b) => (FIGURES.includes(b.type) ? [{ type: "paragraph", text: `[[remove:${b.id}]]` }] : [b])))
      const removedRun = merge(snap, removal)
      expect(removedRun.merged.removedFigurePids).toEqual(figures.map((b) => b.id))
      expect(findLostFigureBlocks(removedRun.current, removedRun.merged)).toEqual([])
    }
  })

  test("real chapter revisions that kept their figures are not refused: rev 43 -> 44 (chapter 5), rev 100 -> 101 (chapter 4)", () => {
    const { snapshots } = load()
    for (const [from, to, key, count] of [[43, 44, "5", 3], [100, 101, "4", 5]] as const) {
      const stored = chapterOf(snapshots.get(to)!.source, key)
      for (const chapter of [stored, stripIds(stored)]) {
        const run = merge(snapshots.get(from)!, chapter)
        expect(run.merged.scopes).toEqual([`chapter:${key}`])
        expect(figuresOf(run.merged.doc, key)).toHaveLength(count)
        expect(findLostFigureBlocks(run.current, run.merged)).toEqual([])
      }
    }
  })

  test("calls 25, 49 and 55: not verifiable, the figure blocks they removed are in no snapshot of the extract", () => {
    const { calls, snapshots } = load()
    const known = new Set([...snapshots.values()].flatMap((s) => [...figuresOf(s.source, "4"), ...figuresOf(s.source, "5")].map((b) => b.id)))
    // Call 49 removed p-k6syks1tna (named by the refused calls 47 and 48); its content is in no snapshot.
    expect(calls[47].refusedPids.map((p) => p.pid)).toEqual(["p-k6syks1tna"])
    expect(known.has("p-k6syks1tna")).toBe(false)
    for (const call of [25, 49, 55]) {
      const rev = calls[call].stored!
      expect(snapshots.has(rev - 1)).toBe(false)
      console.log(`[row74 replay] call ${call} (rev ${rev}): not verifiable`)
    }
  })
})

test.skipIf(present)("row 74 replay R6: not verifiable (the replay extract is not on this machine)", () => {
  console.log(`[row74 replay] not verifiable: missing (set SWARM_REPLAY_DIR) ${[CALLS, SNAPSHOTS, META].filter((f) => !existsSync(f)).join(", ")}`)
})
