import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { openSqlite } from "#sqlite"
import { verifySnapshot } from "./backup.ts"
import { StoreError } from "./errors.ts"
import { sha256Hex } from "./ids.ts"
import { isInside, resolveStoreRel, STORE_DB_FILE } from "./paths.ts"
import type { ExportManifest, SnapshotReport } from "./types.ts"

/**
 * Row 37: export = a plain folder usable as a backup (spec 01_specs_studio_store.md §8.3).
 *   <target>/datum-studio.sqlite  VACUUM INTO snapshot (journal delete)
 *   <target>/assets/, docs/       copies of the immutable content-addressed files
 *   <target>/export.json          ExportManifest
 * Restore = `restoreExport(exportDir, newRoot)` (Swarm quit), or copy the folder into place.
 */
export const EXPORT_MANIFEST_FILE = "export.json"
const COPIED = ["assets", "docs"] as const

export interface ExportDeps {
  root: string
  release: string
  now: () => number
  /** Runs inside the store's write queue (checkpoint + VACUUM INTO). */
  snapshotTo: (file: string) => Promise<SnapshotReport>
}

export async function exportStoreTo(deps: ExportDeps, target: string): Promise<ExportManifest> {
  if (typeof target !== "string" || !target.startsWith("/") || target.includes("\u0000")) throw new StoreError("PATH_OUTSIDE_ROOT", "export target must be absolute")
  if (isInside(deps.root, target) || isInside(target, deps.root)) throw new StoreError("PATH_OUTSIDE_ROOT", "export target and store must not contain each other", { target })
  if (existsSync(target)) throw new StoreError("OUTPUT_EXISTS", "export target exists", { target })
  if (!existsSync(dirname(target)) || !statSync(dirname(target)).isDirectory()) throw new StoreError("NOT_FOUND", "export target parent missing", { target })
  mkdirSync(target, { mode: 0o700 })
  try {
    const dbFile = join(target, STORE_DB_FILE)
    const snap = await deps.snapshotTo(dbFile)
    for (const d of COPIED) {
      const src = join(deps.root, d)
      if (existsSync(src)) copyTree(src, join(target, d))
    }
    const manifest: ExportManifest = {
      store_id: snap.storeId ?? "",
      schema_version: snap.schemaVersion ?? "",
      release: deps.release,
      time: deps.now(),
      counts: { document: snap.counts.document, revision: snap.counts.revision, output_file: snap.counts.output_file, asset: snap.counts.asset },
    }
    writeFileSync(join(target, EXPORT_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
    verifyExport(target)
    return manifest
  } catch (e) {
    // A failed export leaves no half folder that could pass for a backup: move it aside, never delete.
    try {
      const aside = `${target}.failed-${deps.now()}`
      if (!existsSync(aside)) renameSync(target, aside)
    } catch {}
    throw e
  }
}

/** Copy a tree, refusing symlinks (they could point outside the export). */
function copyTree(src: string, dst: string): void {
  cpSync(src, dst, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    filter: (s) => {
      if (lstatSync(s).isSymbolicLink()) throw new StoreError("PATH_OUTSIDE_ROOT", "symlink inside the store is not exported", { path: s })
      return true
    },
  })
}

export interface ExportVerification {
  manifest: ExportManifest
  snapshot: SnapshotReport
  filesChecked: number
}

/** Restore check (spec §8.3 step 5). Throws INTEGRITY_MISMATCH on the first problem. */
export function verifyExport(dir: string): ExportVerification {
  const bad = (message: string, ctx: Record<string, unknown> = {}): never => {
    throw new StoreError("INTEGRITY_MISMATCH", `export check failed: ${message}`, { dir, ...ctx })
  }
  const mfile = join(dir, EXPORT_MANIFEST_FILE)
  if (!existsSync(mfile)) return bad("export.json missing")
  let manifest: ExportManifest
  try {
    manifest = JSON.parse(readFileSync(mfile, "utf8")) as ExportManifest
  } catch {
    return bad("export.json unreadable")
  }
  const snapshot = verifySnapshot(join(dir, STORE_DB_FILE))
  if (snapshot.integrity !== "ok") bad("integrity_check", { integrity: snapshot.integrity })
  if (snapshot.ftsIntegrity !== "ok") bad("FTS integrity-check", { fts: snapshot.ftsIntegrity })
  if (snapshot.storeId !== manifest.store_id) bad("store_id differs")
  if (snapshot.schemaVersion !== manifest.schema_version) bad("schema_version differs")
  for (const k of ["document", "revision", "output_file", "asset"] as const) {
    if (snapshot.counts[k] !== manifest.counts?.[k]) bad(`count ${k} differs`, { snapshot: snapshot.counts[k], manifest: manifest.counts?.[k] })
  }
  const db = openSqlite(join(dir, STORE_DB_FILE), { readonly: true })
  let filesChecked = 0
  try {
    const check = (rel: string, sha: string, bytes: number | null, prefixes: readonly string[]) => {
      const abs = resolveStoreRel(dir, rel, prefixes)
      if (!existsSync(abs) || !statSync(abs).isFile()) return bad("file missing", { rel })
      const data = readFileSync(abs)
      if (bytes !== null && data.byteLength !== Number(bytes)) bad("file size differs", { rel })
      if (sha256Hex(data) !== sha) bad("file sha256 differs", { rel })
      filesChecked++
    }
    for (const r of db.all<{ rel_path: string; sha256: string; bytes: number }>("SELECT rel_path, sha256, bytes FROM asset ORDER BY rel_path")) check(r.rel_path, r.sha256, r.bytes, ["assets/"])
    // previews live under tmp/ and are not part of an export (spec §8.2)
    for (const r of db.all<{ rel_path: string; sha256: string; bytes: number }>("SELECT rel_path, sha256, bytes FROM output_file WHERE kind <> 'preview' ORDER BY rel_path")) check(r.rel_path, r.sha256, r.bytes, ["docs/"])
  } finally {
    db.close()
  }
  return { manifest, snapshot, filesChecked }
}

/**
 * Restore an export into a NEW folder (must not exist or be empty). Verifies before and after.
 * The result is a normal store root; the host switches the file to WAL on first open.
 */
export function restoreExport(exportDir: string, newRoot: string): ExportVerification {
  verifyExport(exportDir)
  if (typeof newRoot !== "string" || !newRoot.startsWith("/")) throw new StoreError("PATH_OUTSIDE_ROOT", "restore target must be absolute")
  if (isInside(exportDir, newRoot) || isInside(newRoot, exportDir)) throw new StoreError("PATH_OUTSIDE_ROOT", "restore target and export must not contain each other")
  if (existsSync(newRoot) && readdirSync(newRoot).length > 0) throw new StoreError("OUTPUT_EXISTS", "restore target is not empty", { newRoot })
  mkdirSync(newRoot, { recursive: true, mode: 0o700 })
  cpSync(join(exportDir, STORE_DB_FILE), join(newRoot, STORE_DB_FILE))
  for (const d of COPIED) if (existsSync(join(exportDir, d))) copyTree(join(exportDir, d), join(newRoot, d))
  try {
    return verifyExport2(exportDir, newRoot)
  } catch (e) {
    try {
      renameSync(newRoot, `${newRoot}.failed-restore`)
    } catch {}
    throw e
  }
}

function verifyExport2(exportDir: string, newRoot: string): ExportVerification {
  // verify the restored copy with the same checks: temporarily view it as an export folder
  const mfile = join(exportDir, EXPORT_MANIFEST_FILE)
  cpSync(mfile, join(newRoot, EXPORT_MANIFEST_FILE))
  try {
    return verifyExport(newRoot)
  } finally {
    rmSync(join(newRoot, EXPORT_MANIFEST_FILE), { force: true })
  }
}
