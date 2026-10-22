// Atomic, kill-9-safe writes (01c §6.2). The rule: every mutation lands in a temp
// file in the SAME directory as the target, is fsync'd, then moved into place with a
// single rename(2). rename within one directory is atomic on APFS, so a `kill -9`
// at any instant leaves either the previous committed file or the new one — never a
// half-written file. A crashed writer leaves only a stray `*.tmp-*` sibling, which
// readers ignore because they open the committed name only.
//
// This is the mechanism behind state.json (§4), the staging->final move for tools
// (§6.2, exercised by rows 82+), and config-edit backups (row 97).
//
// EXACT MODE, WHATEVER THE CALLER'S UMASK (row 273). A mode passed at create(2) is masked by
// the process umask, so under `umask 077` a declared 0644 lands as 0600 — row 215 attempt 1
// failed exactly that way (estate verifyUnits demands the declared mode: "mode 600 != 644").
// The temp file is therefore created owner-only (0600) and exclusively, filled, then given the
// DECLARED mode explicitly — a mode change is not subject to the umask — and only then fsync'd and
// renamed. The committed name therefore appears atomically with its exact mode: there is no instant
// at which the final path carries a wrong mode, and nothing changes the final path's mode after the
// rename (the mode is set on the temp inode inside the target's own directory). Consequence: a
// file declared 0644 is now 0644 even under umask 077 (the declared design; the umask no longer
// narrows it), and a declared 0600 can no longer be narrowed by an exotic umask either.
//
// ONE HANDLE, NO PATH RE-RESOLUTION (row 273b, closing row 265e F1/F2 and F-264d-4/-9). Row 273 set the
// mode with chmod(2) on the temp PATH and then re-opened that path to fsync. A path is re-resolved on
// every call, so anyone able to swap a symlink in at the temp name between create and chmod could
// redirect the mode change onto another file. Now every step after the exclusive create acts on the
// SAME file descriptor: write(2) the bytes, fchmod(2) the declared mode, fsync(2), close, and only then
// rename. fchmod acts on the inode already open, never on a name, so no swap of the temp name can
// redirect it. The declared mode is masked to permission bits (`& 0o777`, F2): setuid/setgid/sticky are
// never set by this primitive whatever a caller declares. There is no read-only re-open any more, so a
// declared mode without owner-read (0200, 0000) no longer throws half-way (F-264d-9), and a write that
// fails before the rename removes its OWN temp name instead of leaving it behind.
// Residual, not closed here: rename(2) still resolves the temp NAME, so a swapped name is what gets
// committed. Reaching it needs write access to the target's directory, which is owner-only (0700,
// paths.ts ensureParent) for every caller, i.e. the same uid.

import { openSync, writeSync, fchmodSync, fsyncSync, closeSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { ensureParent } from "./paths.ts"

/** Write `data` to `absPath` atomically with EXACTLY the given permission bits (e.g. 0600, 0644),
 *  independent of the process umask (row 273). Special bits are masked off (row 273b). */
export function atomicWriteText(absPath: string, data: string, mode: number): void {
  ensureParent(absPath)
  const tmp = join(dirname(absPath), `.tmp-${randomUUID()}`)
  const exactMode = mode & 0o777 // F2: permission bits only, never setuid/setgid/sticky
  // Exclusive create, owner-only: the temp is private while its bytes are being written, and "wx"
  // refuses to open anything already sitting at the name (a planted file or symlink included).
  const fd = openSync(tmp, "wx", 0o600)
  let committed = false
  try {
    try {
      const bytes = new TextEncoder().encode(data)
      let offset = 0
      while (offset < bytes.length) {
        const n = writeSync(fd, bytes.subarray(offset))
        if (n <= 0) throw new Error(`atomicWriteText: short write to ${tmp}`)
        offset += n
      }
      // F1: the declared mode goes onto the inode this fd holds (not umask-masked, not path-resolved).
      fchmodSync(fd, exactMode)
      // Bytes and mode durable BEFORE the file becomes visible under the final name. A kill -9 before
      // the rename leaves only the stray temp (ignored by readers).
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // Single atomic move into place. After this point the file is committed, already at `exactMode`.
    renameSync(tmp, absPath)
    committed = true
  } finally {
    if (!committed) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* best-effort: the original error is the one that matters */
      }
    }
  }
}

export function atomicWriteJson(absPath: string, value: unknown, mode: number): void {
  atomicWriteText(absPath, JSON.stringify(value, null, 2) + "\n", mode)
}
