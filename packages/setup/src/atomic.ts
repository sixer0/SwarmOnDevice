// Atomic, kill-9-safe writes (01c §6.2). The rule: every mutation lands in a temp
// file in the SAME directory as the target, is fsync'd, then moved into place with a
// single rename(2). rename within one directory is atomic on APFS, so a `kill -9`
// at any instant leaves either the previous committed file or the new one — never a
// half-written file. A crashed writer leaves only a stray `*.tmp-*` sibling, which
// readers ignore because they open the committed name only.
//
// This is the mechanism behind state.json (§4), the staging->final move for tools
// (§6.2, exercised by rows 82+), and config-edit backups (row 97).

import { openSync, fsyncSync, closeSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { ensureParent } from "./paths.ts"

/** Write `data` to `absPath` atomically with the given file mode (e.g. 0600). */
export function atomicWriteText(absPath: string, data: string, mode: number): void {
  ensureParent(absPath)
  const tmp = join(dirname(absPath), `.tmp-${randomUUID()}`)
  // Write the whole payload to the temp name first (mode applied on create).
  writeFileSync(tmp, data, { encoding: "utf8", mode })
  // Reopen and fsync so the bytes are durable BEFORE the file becomes visible under
  // the final name. A kill -9 before this fsync leaves only the stray temp (ignored).
  const fd = openSync(tmp, "r+")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // Single atomic move into place. After this point the file is committed.
  renameSync(tmp, absPath)
}

export function atomicWriteJson(absPath: string, value: unknown, mode: number): void {
  atomicWriteText(absPath, JSON.stringify(value, null, 2) + "\n", mode)
}
