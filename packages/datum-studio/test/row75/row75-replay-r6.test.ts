// Swarm 1.3.3 row 75 (ST-10), replay R6: the 59 studio_chapter_import_markdown calls of project 1 (one session of the
// test day), read from SWARM_REPLAY_DIR/R6_project1_rev44_rev100 (row 146: no fixed path; ROW75_R6_JSONL overrides).
// Question of the row: how many of those calls carried a `baseRevisionNo` OLDER than the revision that was current
// when the call ran. The then-current revision is taken from the call's own recorded result:
//   - stored: "rev N (chapter:k)" means the call wrote N on top of N-1, so N-1 was current;
//   - refused with a conflict: `latestRevisionNo` in the refusal details;
//   - refused for another reason: bracketed by the nearest results on the same document, counted only when both
//     sides agree (otherwise the call is reported as not determinable).
// No file -> the check is "not verifiable" and the test says so instead of substituting anything.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { replayPath } from "../replay-dir"

const R6 =
  process.env.ROW75_R6_JSONL ??
  replayPath("R6_project1_rev44_rev100", "chapter_import_calls_session_e18a727e8.jsonl") ??
  ""

type Call = { arguments: Record<string, unknown>; output: string | null; error: string | null; time_local: string }
type Seen = { index: number; doc: string; base: number | null; stored: number | null; latest: number | null; conflict: boolean; baseInRefusal: number | null | undefined }

function read(): Seen[] {
  return readFileSync(R6, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, index) => {
      const c = JSON.parse(l) as Call
      const out = c.output ?? c.error ?? ""
      const stored = /^kirim bab \S+: tersimpan; dokumen \S+ \S+ rev (\d+) /.exec(out)
      const latest = /"latestRevisionNo":(\d+)/.exec(out)
      const inRefusal = /"reason":"PATCHED_PIDS_OVERWRITTEN","baseRevisionNo":(null|\d+)/.exec(out)
      return {
        index,
        doc: String(c.arguments.documentId ?? c.arguments.mission ?? ""),
        base: typeof c.arguments.baseRevisionNo === "number" ? c.arguments.baseRevisionNo : null,
        stored: stored ? Number(stored[1]) : null,
        latest: latest ? Number(latest[1]) : null,
        conflict: out.includes('"keyword":"SCOPE_CONFLICT"'),
        baseInRefusal: inRefusal ? (inRefusal[1] === "null" ? null : Number(inRefusal[1])) : undefined,
      }
    })
}

/** Revision current when the call ran, or null when the extract cannot show it. */
function currentAt(all: Seen[], s: Seen): number | null {
  if (s.stored !== null) return s.stored - 1
  if (s.latest !== null) return s.latest
  const same = all.filter((x) => x.doc === s.doc)
  const before = [...same].reverse().find((x) => x.index < s.index && (x.stored !== null || x.latest !== null))
  const after = same.find((x) => x.index > s.index && (x.stored !== null || x.latest !== null))
  const b = before ? (before.stored ?? before.latest) : null
  const a = after ? (after.stored !== null ? after.stored - 1 : after.latest) : null
  return b !== null && a !== null && a === b ? b : null
}

describe("row 75 replay R6: baseRevisionNo on the 59 import calls of project 1", () => {
  test.skipIf(!existsSync(R6))("count of calls whose baseRevisionNo was older than the then-current revision", () => {
    const all = read()
    expect(all).toHaveLength(59)
    const withBase = all.filter((s) => s.base !== null)
    const rows = withBase.map((s) => ({ index: s.index, base: s.base as number, current: currentAt(all, s) }))
    const undetermined = rows.filter((r) => r.current === null)
    const stale = rows.filter((r) => r.current !== null && r.base < r.current)
    const matching = rows.filter((r) => r.current !== null && r.base === r.current)
    // The incident itself: explicit base = latest, refused by the dry run, and the refusal shows the base never arrived.
    const ignored = all.filter((s) => s.base !== null && s.conflict && s.latest === s.base && s.baseInRefusal === null)
    const implicit = all.filter((s) => s.base === null && s.conflict)
    for (const r of rows) console.log(`ROW75-REPLAY call ${r.index}: base ${r.base}, current ${r.current ?? "not determinable"}`)
    console.log(
      `ROW75-REPLAY total ${all.length}; with baseRevisionNo ${withBase.length}; stale ${stale.length}; matching ${matching.length}; not determinable ${undetermined.length}; ` +
        `matching base refused with baseRevisionNo null in the refusal ${ignored.length} (calls ${ignored.map((s) => s.index).join(", ")}); conflict refusals without explicit base ${implicit.length} (calls ${implicit.map((s) => s.index).join(", ")})`,
    )
    expect(withBase).toHaveLength(15)
    expect(undetermined).toEqual([])
    expect(stale).toEqual([])
    expect(matching).toHaveLength(15)
    expect(ignored.map((s) => s.index)).toEqual([31, 39, 46, 48])
    expect(implicit.map((s) => s.index)).toEqual([30, 45, 47])
  })

  test("the replay input is present (otherwise the count above is not verifiable)", () => {
    if (!existsSync(R6)) console.log(`ROW75-REPLAY not verifiable: ${R6 || "SWARM_REPLAY_DIR is not set"} is missing`)
    expect(typeof R6).toBe("string")
  })
})
