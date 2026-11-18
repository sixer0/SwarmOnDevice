// Swarm 1.3.3 row 103 (KL-3): replay R6, project 1 revision 100 (research/05_replay_inventory.md R6).
// Input: the revision 100 snapshot from R6_project1_rev44_rev100/revisions_43_44_45_99_100_101_full.jsonl under
// SWARM_REPLAY_DIR, reduced to schema, doc.meta, register and blocks (row 146: the owner's study text is not kept in
// the repository; skipped when the variable is unset). Without the replay the rule is pinned by
// row103-internal-abbreviation.test.ts.
// Spec KL-3 expects 48 warnings; the rule gives 50. Breakdown pinned below; explanation in
// implementation/103_kl3_internal_abbreviation_lint.md.
import { describe, expect, test } from "bun:test"
import type { NormDocSnapshot } from "../../vendor/src/lib/studio/contract"
import { buildContext } from "../../vendor/src/lib/studio/engine/lint/language/checks"
import {
  findInternalAbbreviations,
  internalAbbreviation,
  textPlacesOf,
} from "../../vendor/src/lib/studio/engine/lint/language/internal-abbreviation"
import { extractLayers } from "../../vendor/src/lib/studio/engine/lint/language/prose"
import { releaseFor } from "../../vendor/src/lib/studio/services/render/lint"
import { runLint } from "../../vendor/src/lib/studio/engine/lint/scan"
import { useStudioEnv } from "../ported/_env"
import { canonicalTemplate, makeDoc, snapshotOf } from "../ported/engine-core/fixtures"
import { r6Revision, replayInputs } from "../replay-dir"

const R6 = replayInputs("row 103 replay R6", ["R6_project1_rev44_rev100/revisions_43_44_45_99_100_101_full.jsonl"] as const)
const rev100 = (R6.present ? reduced(r6Revision(R6.paths[0], 100).snapshot) : { blocks: [] }) as unknown as NormDocSnapshot
const out = R6.present ? internalAbbreviation(buildContext(extractLayers(rev100), {}, "ID", rev100)) : []
const where = (re: RegExp) => out.filter((i) => re.test(i.detail ?? "")).length

describe.skipIf(!R6.present)("R6 revision 100", () => {
  test("50 warnings, all REPORT, none FAIL", () => {
    expect(out.length).toBe(50)
    expect(out.every((i) => i.status === "REPORT")).toBe(true)
  })

  test("breakdown: 39 body paragraphs, 1 chapter title, 1 chart source line, 3 control-sheet statement, 6 source-list entries", () => {
    expect(where(/^paragraf [^F]\S* \(paragraf\)/)).toBe(39)
    expect(where(/^judul 3 \(judul bab\)/)).toBe(1)
    expect(where(/^keterangan 4\.6\.10 \(baris sumber\)/)).toBe(1)
    expect(where(/^paragraf F:controlSheet/)).toBe(3)
    expect(where(/^paragraf F:references\/\d+ \(entri daftar sumber\)/)).toBe(6)
  })

  test("the folder name in the source list paragraph B.0.2 is exempt as a path", () => {
    const exempt = textPlacesOf(rev100).flatMap((p) =>
      findInternalAbbreviations(p.segments).filter((h) => h.exempt).map((h) => ({ address: p.address, why: h.exempt })),
    )
    expect(exempt).toEqual([{ address: "B.0.2", why: "path" }])
  })

  test("table cells are not scanned (32 occurrences there)", () => {
    const tables = rev100.blocks.filter((b) => b.type === "table")
    const inCells = tables.reduce((a, b) => a + (JSON.stringify(b.content).match(/\bEKAS\b/g)?.length ?? 0), 0)
    expect(inCells).toBe(32)
    const tableAddresses = new Set(tables.map((b) => b.address))
    expect(out.some((i) => tableAddresses.has(i.address ?? null))).toBe(false)
  })

  test("first mention gets the full name, later ones the short name", () => {
    expect(out[0].detail).toContain('"pustaka pengetahuan teknis GSP"')
    expect(out.slice(1).every((i) => i.detail!.includes('tulis "pustaka teknis"'))).toBe(true)
  })

  test("warnings never block release", () => {
    expect(releaseFor(out, "TERBIT")).toBe("PASS")
    expect(releaseFor(out, "SERAH")).toBe("PASS")
  })
})

// Through the real lint entry point (engine/lint/scan runLint, called by render and ingest), with the revision 100
// blocks placed in a canonical TERBIT snapshot. C-37 is live since row 103 removed its staged marker.
describe.skipIf(!R6.present)("R6 revision 100 through runLint", () => {
  useStudioEnv()
  test("C-37 runs (not NOT_RUN): 50 REPORT, no FAIL, release not held by C-37", () => {
    const base = snapshotOf(makeDoc({ tier: "TERBIT" }))
    const snapshot = { ...base, doc: { ...base.doc, meta: { ...base.doc.meta, language: "ID" } }, blocks: rev100.blocks }
    const c37 = runLint({ snapshot: snapshot as never, tpl: canonicalTemplate(), tier: "TERBIT", stage: "post" }).checks.filter((c) => c.checkId === "C-37")
    expect(c37.map((c) => c.status)).toEqual(Array(50).fill("REPORT"))
    expect(releaseFor(c37, "TERBIT")).toBe("PASS")
  })
})

/** The parts of a stored snapshot this replay reads (the shape of the former fixture: units and numbering empty). */
function reduced(snapshot: { schema: unknown; doc: { meta: unknown }; register: unknown; blocks: unknown[] }) {
  return { schema: snapshot.schema, doc: { meta: snapshot.doc.meta }, units: [], numbering: {}, register: snapshot.register, blocks: snapshot.blocks }
}
