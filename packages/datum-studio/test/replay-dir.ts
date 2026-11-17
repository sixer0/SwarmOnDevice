// Swarm 1.3.3 row 146 (security M2, senior B1): the one place a replay test learns where the test-day replay inputs are.
//
// The replay inputs (research/replay/R1..R13 of the 1.3.3 patch folder) are the owner's test-day data and never enter
// the repository. A replay test reads them only through SWARM_REPLAY_DIR, the folder that holds R1_..., R2_..., and
// skips with a message that names the variable when it is unset or the input is missing. Run locally:
//   SWARM_REPLAY_DIR=<patch folder>/research/replay bun test <explicit test file>
import { test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export const REPLAY_ENV = "SWARM_REPLAY_DIR"

/** Absolute path of one replay input, or undefined when SWARM_REPLAY_DIR is unset. */
export function replayPath(...parts: string[]) {
  const root = process.env[REPLAY_ENV]
  if (!root) return undefined
  return path.join(root, ...parts)
}

/**
 * Resolve the replay inputs a test file needs. When any is missing, one skipped test is registered whose name says
 * why and how to run it, so the skip is visible in the run output; the caller guards its own tests with `present`.
 */
export function replayInputs<const T extends readonly string[]>(name: string, inputs: T) {
  const paths = inputs.map((p) => replayPath(p))
  const missing = inputs.filter((_, i) => !paths[i] || !existsSync(paths[i]!))
  const present = missing.length === 0
  if (!present) {
    const why = process.env[REPLAY_ENV] ? `${REPLAY_ENV} lacks ${missing.join(", ")}` : `${REPLAY_ENV} is not set`
    const message = `${name}: replay input not available (${why}); set ${REPLAY_ENV}=<1.3.3 patch folder>/research/replay to run`
    // The console reporter does not print skipped test names outside a terminal, so the reason is also logged.
    console.log(`[skip] ${message}`)
    test.skip(message, () => {})
  }
  return { present, paths: paths.map((p) => p ?? "") as { [K in keyof T]: string } }
}

/** The parsed snapshot of one R6 revision (R6_project1_rev44_rev100/revisions_43_44_45_99_100_101_full.jsonl). */
export function r6Revision(file: string, revisionNo: number) {
  const row = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { document_id: string; revision_no: number; snapshot: string; snapshot_sha256: string })
    .find((r) => r.revision_no === revisionNo)
  if (!row) throw new Error(`revision ${revisionNo} is not in ${file}`)
  return { documentId: row.document_id, revisionNo: row.revision_no, sha256: row.snapshot_sha256, snapshot: JSON.parse(row.snapshot) }
}

/** The paragraph and list blocks of one R6 revision, the text the language scanners read (rows 84 and 85). */
export function r6Prose(file: string, revisionNo: number) {
  const r = r6Revision(file, revisionNo)
  const blocks = (r.snapshot.blocks as Array<{ type: string }>).filter((b) => b.type === "paragraph" || b.type === "list")
  return { documentId: r.documentId, revisionNo: r.revisionNo, language: r.snapshot.doc.meta.language as string, blocks }
}
