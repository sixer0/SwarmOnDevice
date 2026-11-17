/**
 * Space reclaim of the Studio store (Swarm 1.3.3 row 83, ST-11; design masterplan/04_st11_migration_design.md F5,
 * decision C6 item d: purge and vacuum on request only, never automatic, never during a session write).
 *
 * A purge (row 82) frees pages inside the file; SQLite does not give them back to the file system
 * (`auto_vacuum = 0`). A full `VACUUM` rewrites the file without them. In WAL mode it does so in two copies:
 *   1. a temporary database of the used pages, in SQLite's temp folder (SQLITE_TMPDIR, TMPDIR, /var/tmp, /usr/tmp, /tmp);
 *   2. every page of the new file written to `<store>-wal`, which the final `wal_checkpoint(TRUNCATE)` copies over
 *      the main file and truncates.
 * So it needs about the used size twice in free disk space (once per location; twice on the same device), and it
 * must be the only writer for its whole duration.
 *
 * The only caller is `SqliteStudioStore.reclaimSpace`, which runs `reclaimStoreSpace` as one exclusive job of the
 * store's serial write queue after checking that no write transaction is running or queued and no session lock is
 * held. Nothing here runs by itself: no timer, no call from `open`, no tool (pinned by store-vacuum.test.ts).
 */
import { existsSync, statfsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import type { SqliteDb } from "./driver-types.ts"
import { StoreError } from "./errors.ts"

/** `store_meta` key of the reclaim record: a JSON array, one entry per completed reclaim, oldest first. */
/** @internal test seam */
export const STORE_VACUUM_LOG_KEY = "store_vacuum_log"
/** Head room on top of the estimated copy, per location. */
const VACUUM_FREE_MARGIN_BYTES = 64 * 1024 * 1024
/** The WAL copy and the temporary copy are each about the used size plus page headers; 5 % covers the WAL frame headers (24 B per 4 KiB page) with room. */
const COPY_FACTOR = 1.05

interface StoreFileSize {
  /** Bytes of `datum-studio.sqlite`. */
  fileBytes: number
  /** Bytes of `datum-studio.sqlite-wal` (0 when absent). */
  walBytes: number
  pageSize: number
  pageCount: number
  freelistCount: number
}

interface ReclaimSpaceCheck {
  /** (page_count - freelist_count) * page_size before the reclaim: the estimated size of the new file. */
  usedBytes: number
  tempDir: string
  storeDir: string
  sameDevice: boolean
  needTempBytes: number
  needStoreBytes: number
  freeTempBytes: number
  freeStoreBytes: number
}

export interface ReclaimSpaceResult {
  requestedBy: string
  before: StoreFileSize
  after: StoreFileSize
  /** before (file + WAL) minus after (file + WAL). */
  reclaimedBytes: number
  /** Largest WAL seen: right after the VACUUM, before the final checkpoint. */
  walPeakBytes: number
  quickCheck: string
  durationMs: number
  steps: { checkpointMs: number; ftsOptimizeMs: number; vacuumMs: number; finalCheckpointMs: number; quickCheckMs: number }
  space: ReclaimSpaceCheck
  timeStarted: number
}

export interface ReclaimSpaceOptions {
  /** Who asked (operator name or command). Required: a reclaim is never anonymous. */
  requestedBy: string
  /** Rebuild the full-text index into one segment before the vacuum (default true). Changes no content. */
  ftsOptimize?: boolean
  /** Extra free bytes required per location (default VACUUM_FREE_MARGIN_BYTES). */
  marginBytes?: number
  /** Free bytes available to an unprivileged writer in the folder `dir`. Test seam; default statfs. */
  diskFree?: (dir: string) => number
}

/**
 * The folder the VACUUM temporary file is expected in. SQLite's unix VFS takes SQLITE_TMPDIR, then TMPDIR, then
 * /var/tmp, /usr/tmp, /tmp; `os.tmpdir()` is TMPDIR or /tmp. The store reads no environment itself (store contract,
 * pinned by store.test.ts), so a host that sets SQLITE_TMPDIR elsewhere is not seen here; on this Mac both resolve
 * to the data volume of the store.
 */
function sqliteTempDir(): string {
  return tmpdir()
}

function defaultDiskFree(dir: string): number {
  const s = statfsSync(dir)
  return Number(s.bavail) * Number(s.bsize)
}

const num = (v: unknown) => Number(v ?? 0)
const fileSize = (p: string) => (existsSync(p) ? statSync(p).size : 0)

function measureStoreFile(db: SqliteDb, file: string): StoreFileSize {
  return {
    fileBytes: fileSize(file),
    walBytes: fileSize(`${file}-wal`),
    pageSize: num(db.get<{ page_size: number }>("PRAGMA page_size")?.page_size),
    pageCount: num(db.get<{ page_count: number }>("PRAGMA page_count")?.page_count),
    freelistCount: num(db.get<{ freelist_count: number }>("PRAGMA freelist_count")?.freelist_count),
  }
}

/** Throws STORE_BUSY (reason `session-lock-held`) when any mission row lock is not released. */
function assertNoSessionLock(db: SqliteDb): void {
  const held = db.all<{ resource: string; mission_id: string; row_id: string; holder: string; time_acquired: number }>(
    "SELECT resource, mission_id, row_id, holder, time_acquired FROM mission_lock WHERE time_released IS NULL ORDER BY seq LIMIT 20",
  )
  if (held.length > 0) {
    const count = num(db.get<{ n: number }>("SELECT count(*) AS n FROM mission_lock WHERE time_released IS NULL")?.n)
    throw new StoreError("STORE_BUSY", `space reclaim refused: ${count} session lock(s) held`, {
      reason: "session-lock-held",
      count,
      locks: held.map((l) => ({ resource: l.resource, missionId: l.mission_id, rowId: l.row_id, holder: l.holder, timeAcquired: num(l.time_acquired) })),
    })
  }
}

/** Throws CONSTRAINT (reason `insufficient-disk-space`) with every number when the two copies do not fit. */
function checkReclaimSpace(size: StoreFileSize, storeDir: string, opts: Pick<ReclaimSpaceOptions, "marginBytes" | "diskFree">): ReclaimSpaceCheck {
  const margin = opts.marginBytes ?? VACUUM_FREE_MARGIN_BYTES
  const free = opts.diskFree ?? defaultDiskFree
  const usedBytes = (size.pageCount - size.freelistCount) * size.pageSize
  const copy = Math.ceil(usedBytes * COPY_FACTOR) + margin
  const tempDir = sqliteTempDir()
  const sameDevice = statSync(tempDir).dev === statSync(storeDir).dev
  const freeTempBytes = free(tempDir)
  const freeStoreBytes = sameDevice ? freeTempBytes : free(storeDir)
  // On one device both copies come out of the same free space.
  const needTempBytes = copy
  const needStoreBytes = sameDevice ? copy * 2 : copy
  const check: ReclaimSpaceCheck = { usedBytes, tempDir, storeDir, sameDevice, needTempBytes, needStoreBytes, freeTempBytes, freeStoreBytes }
  if (freeTempBytes < needTempBytes || freeStoreBytes < needStoreBytes) {
    throw new StoreError(
      "CONSTRAINT",
      `space reclaim refused: needs ${needStoreBytes} bytes free for the store copy (${freeStoreBytes} free) and ${needTempBytes} for the temporary copy in ${tempDir} (${freeTempBytes} free)`,
      { reason: "insufficient-disk-space", ...check },
    )
  }
  return check
}

function checkpointTruncate(db: SqliteDb, step: string): void {
  const r = db.get<{ busy: number; log: number; checkpointed: number }>("PRAGMA wal_checkpoint(TRUNCATE)")
  if (r && num(r.busy) !== 0) throw new StoreError("STORE_BUSY", `space reclaim: ${step} checkpoint blocked by an open reader`, { reason: "checkpoint-blocked", step, ...r })
}

/**
 * The reclaim itself, on the store's writer connection. The caller guarantees exclusivity (one queue job, no
 * transaction open on `db`). Steps: checkpoint(TRUNCATE) so the measure is the whole store; free-space check; FTS
 * optimize (own transaction); VACUUM; WAL peak; checkpoint(TRUNCATE); quick_check; record in `store_meta`.
 * VACUUM is one transaction: an interruption leaves the old file intact.
 */
export function reclaimStoreSpace(db: SqliteDb, file: string, storeDir: string, opts: ReclaimSpaceOptions & { now: () => number }): ReclaimSpaceResult {
  const clock = () => performance.now()
  const timeStarted = opts.now()
  const t0 = clock()
  assertNoSessionLock(db)
  // Before checkpoint: the space check uses page counts, which already include the WAL's pages.
  const space = checkReclaimSpace(measureStoreFile(db, file), storeDir, opts)
  let t = clock()
  checkpointTruncate(db, "initial")
  const checkpointMs = clock() - t
  const before = measureStoreFile(db, file)

  t = clock()
  if (opts.ftsOptimize !== false) {
    db.exec("BEGIN IMMEDIATE")
    try {
      db.run("INSERT INTO doc_block_fts(doc_block_fts) VALUES('optimize')")
      db.exec("COMMIT")
    } catch (e) {
      try {
        db.exec("ROLLBACK")
      } catch {
        // already rolled back
      }
      throw e
    }
  }
  const ftsOptimizeMs = clock() - t

  t = clock()
  db.exec("VACUUM")
  const vacuumMs = clock() - t
  const walPeakBytes = fileSize(`${file}-wal`)

  t = clock()
  checkpointTruncate(db, "final")
  const finalCheckpointMs = clock() - t

  t = clock()
  const quickCheck = String(db.get<{ quick_check: string }>("PRAGMA quick_check")?.quick_check ?? "")
  const quickCheckMs = clock() - t
  if (quickCheck !== "ok") throw new StoreError("INTEGRITY_MISMATCH", `quick_check after VACUUM: ${quickCheck}`, { reason: "quick-check", quickCheck })

  const vacuumed = measureStoreFile(db, file)
  const steps = { checkpointMs, ftsOptimizeMs, vacuumMs, finalCheckpointMs, quickCheckMs }
  // The record: one small write, then a checkpoint so the WAL is empty again when the store is handed back.
  const entry = { action: "vacuum", requestedBy: opts.requestedBy, timeStarted, before, after: vacuumed, walPeakBytes, durationMs: Math.round(clock() - t0), steps: roundSteps(steps) }
  db.exec("BEGIN IMMEDIATE")
  try {
    const prev = JSON.parse(db.get<{ value: string }>("SELECT value FROM store_meta WHERE key = ?", [STORE_VACUUM_LOG_KEY])?.value ?? "[]") as unknown[]
    db.run("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [STORE_VACUUM_LOG_KEY, JSON.stringify([...prev, entry])])
    db.exec("COMMIT")
  } catch (e) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // already rolled back
    }
    throw e
  }
  checkpointTruncate(db, "record")
  const after = measureStoreFile(db, file)
  return {
    requestedBy: opts.requestedBy,
    before,
    after,
    reclaimedBytes: before.fileBytes + before.walBytes - after.fileBytes - after.walBytes,
    walPeakBytes,
    quickCheck,
    durationMs: Math.round(clock() - t0),
    steps: roundSteps(steps),
    space,
    timeStarted,
  }
}

function roundSteps<T extends Record<string, number>>(s: T): T {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Math.round(v)])) as T
}
