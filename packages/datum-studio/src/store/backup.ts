import { existsSync } from "node:fs"
import { openSqlite } from "#sqlite"
import { StoreError } from "./errors.ts"
import type { SnapshotReport } from "./types.ts"

/**
 * Restore check of a `VACUUM INTO` snapshot (spec §8.3 step 5): integrity_check, FTS5
 * integrity-check, journal mode and counts. The snapshot is opened read-only; the FTS check
 * needs a writable handle (it is an INSERT command, even though it writes nothing), so it runs on
 * a second, short-lived handle that executes only that command.
 */
export function verifySnapshot(file: string): SnapshotReport {
  if (!existsSync(file)) throw new StoreError("NOT_FOUND", "snapshot file missing", { file })
  const ro = openSqlite(file, { readonly: true })
  let report: SnapshotReport
  try {
    const integrity = ro.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check ?? "missing"
    const journalMode = ro.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode ?? "unknown"
    const meta = (k: string) => ro.get<{ value: string }>("SELECT value FROM store_meta WHERE key = ?", [k])?.value ?? null
    const count = (t: string) => Number(ro.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)?.n ?? 0)
    report = {
      file,
      integrity,
      ftsIntegrity: "unknown",
      journalMode,
      schemaVersion: meta("schema_version"),
      storeId: meta("store_id"),
      counts: {
        document: count("document"),
        revision: count("revision"),
        output_file: count("output_file"),
        asset: count("asset"),
        doc_block: count("doc_block"),
      },
    }
  } finally {
    ro.close()
  }
  const rw = openSqlite(file)
  try {
    rw.exec("INSERT INTO doc_block_fts(doc_block_fts) VALUES('integrity-check')")
    report.ftsIntegrity = "ok"
  } catch (e) {
    report.ftsIntegrity = e instanceof Error ? e.message : String(e)
  } finally {
    rw.close()
  }
  return report
}
