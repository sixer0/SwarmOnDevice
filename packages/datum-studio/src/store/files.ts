import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import { StoreError } from "./errors.ts"
import { newId, sha256Hex } from "./ids.ts"

/**
 * Content-addressed and write-once files under the store root (spec §6.5, §8.2).
 * Bytes are written to `<root>/tmp/write-<id>`, fsync'd, then renamed into place, so a crash
 * leaves an orphan in tmp/ (swept at start), never a half file at the final path.
 * A final path is never overwritten with different bytes.
 */
export interface WrittenFile {
  relPath: string
  sha256: string
  bytes: number
  /** false when an identical file was already there. */
  created: boolean
}

export function writeOnce(root: string, abs: string, relPath: string, data: Uint8Array): WrittenFile {
  const sha256 = sha256Hex(data)
  if (existsSync(abs)) {
    const have = sha256Hex(readFileSync(abs))
    if (have !== sha256) throw new StoreError("OUTPUT_EXISTS", "a different file already exists at this path", { relPath })
    return { relPath, sha256, bytes: data.byteLength, created: false }
  }
  const tmpDir = join(root, "tmp")
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
  const tmp = join(tmpDir, `write-${newId()}`)
  const fd = openSync(tmp, "wx", 0o600)
  try {
    let off = 0
    while (off < data.byteLength) off += writeSync(fd, data, off, data.byteLength - off)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 })
  renameSync(tmp, abs)
  try {
    const dfd = openSync(dirname(abs), "r")
    try {
      fsyncSync(dfd)
    } finally {
      closeSync(dfd)
    }
  } catch {
    // directory fsync is best effort (not supported on every filesystem)
  }
  return { relPath, sha256, bytes: data.byteLength, created: true }
}

/** Read a stored file and check it against the sha256 and size recorded in its row. */
export function readVerified(abs: string, expect: { sha256: string; bytes?: number; relPath: string }): Uint8Array {
  if (!existsSync(abs)) throw new StoreError("NOT_FOUND", "stored file missing", { relPath: expect.relPath })
  const data = readFileSync(abs)
  const sha = sha256Hex(data)
  if (sha !== expect.sha256 || (expect.bytes !== undefined && data.byteLength !== expect.bytes)) {
    throw new StoreError("INTEGRITY_MISMATCH", "stored file does not match its recorded sha256", { relPath: expect.relPath })
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/** Check a file already on disk before its row is written (files first, then rows). */
export function assertFileMatches(abs: string, relPath: string, sha256: string, bytes: number): void {
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new StoreError("NOT_FOUND", "output file must be written before its row", { relPath })
  readVerified(abs, { sha256, bytes, relPath })
}

/** Asset layout `assets/<sha[0..2]>/<sha>.<png|jpg>` (clone contract/env.ts:140-141). */
export function assetRelPath(sha256: string, mime: "image/png" | "image/jpeg"): string {
  return `assets/${sha256.slice(0, 2)}/${sha256}.${mime === "image/png" ? "png" : "jpg"}`
}

/** Magic-byte sniff, so an upload labelled PNG/JPEG really is one. */
export function sniffImage(data: Uint8Array): "image/png" | "image/jpeg" | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png"
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg"
  return null
}
