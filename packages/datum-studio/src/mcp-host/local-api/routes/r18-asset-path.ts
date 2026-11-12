/**
 * W-13 asset input helpers shared by R18 (row 50b) and the `studio_asset_put` tool (row 50c).
 *
 * - {@link readAssetFile}: the read side of a `path` upload (01f §3.3 R1-R7). The vendored guard
 *   `resolveAllowedPath(..., "read-asset")` does the lexical, inside-root (lexical and realpath, so a symlink
 *   that leaves the root is refused `PATH_OUTSIDE_ROOTS`), extension, regular-file and stat-size checks and
 *   returns the REAL path. The file is then opened with O_NOFOLLOW, `fstat`ed on the handle and read with a
 *   cap of limit + 1 byte, so a swap or growth after the check cannot slip past the size limit.
 * - {@link assetMetadataWarning}: SEC-10 / SR-10 report-only notice built from the decoder's metadata scan
 *   (row 50a `readImageMetadata`). Nothing is stripped: the stored bytes stay the file's bytes (01f §3.4).
 *
 * Refusals are `McpToolError` with the existing MCP codes (`PATH_INVALID`, `PATH_OUTSIDE_ROOTS`,
 * `FILE_UNREADABLE`) or `ASSET_TOO_LARGE` (E-25). Hard links inside the root are an accepted residual (01f R-4).
 */
import fs from "node:fs"
import { STUDIO_MAX_ASSET_BYTES } from "../../../../vendor/src/lib/studio/contract/env"
import type { ImageMetadata } from "../../../../vendor/src/lib/studio/services/images/metadata"
import { McpToolError, REAL_NODE_FS, resolveAllowedPath } from "../../../../vendor/scripts/studio/mcp/safety"

/** HTTP status of each read-side refusal when it is answered by a route. */
export const ASSET_PATH_HTTP: Readonly<Record<string, number>> = {
  PATH_INVALID: 400,
  PATH_OUTSIDE_ROOTS: 403,
  FILE_UNREADABLE: 422,
  ASSET_TOO_LARGE: 413,
}

/** Read a PNG/JPEG candidate from inside `roots` (N-108: `[session.fileRoot]`); returns its bytes and real path. */
export function readAssetFile(raw: unknown, roots: readonly string[], limit = STUDIO_MAX_ASSET_BYTES): { bytes: Uint8Array; realPath: string } {
  if (typeof raw !== "string" || raw === "") throw new McpToolError("PATH_INVALID", "path must be a non-empty absolute path string")
  if (roots.length === 0) throw new McpToolError("PATH_OUTSIDE_ROOTS", "this session has no file root, so no path can be read; send dataBase64 instead")
  const realPath = resolveAllowedPath(raw, roots, "read-asset", REAL_NODE_FS, limit)
  const fd = openNoFollow(realPath)
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw new McpToolError("FILE_UNREADABLE", `${raw} is not a regular file`)
    if (st.size > limit) throw new McpToolError("ASSET_TOO_LARGE", `file ${st.size} B exceeds the ${limit} B asset limit`, { httpStatus: 413 })
    const buf = Buffer.allocUnsafe(limit + 1)
    let total = 0
    for (;;) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null)
      if (n === 0) break
      total += n
      if (total > limit) throw new McpToolError("ASSET_TOO_LARGE", `file grew past the ${limit} B asset limit while being read`, { httpStatus: 413 })
    }
    return { bytes: new Uint8Array(buf.subarray(0, total)), realPath }
  } finally {
    fs.closeSync(fd)
  }
}

function openNoFollow(realPath: string): number {
  try {
    return fs.openSync(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  } catch {
    // ELOOP (swapped to a symlink after the check), ENOENT, EACCES: one code, no fs detail to the caller.
    throw new McpToolError("FILE_UNREADABLE", "the file could not be opened for reading")
  }
}

/** SEC-10: one warning line when the image carries GPS, EXIF tags or PNG text chunks; null when clean. */
export function assetMetadataWarning(m: ImageMetadata): string | null {
  const found = [
    m.gps ? "GPS location" : "",
    m.exifTags.length > 0 ? `EXIF tags (${list(m.exifTags)})` : "",
    m.pngTextKeys.length > 0 ? `PNG text chunks (${list(m.pngTextKeys)})` : "",
  ].filter((s) => s !== "")
  if (found.length === 0) return null
  return `Warning: this image carries embedded metadata (${found.join("; ")}), which is copied verbatim into DOCX and HTML output. Studio does not strip it (the stored sha256 stays the file's own). To remove it, strip the file (sips --deleteProperty all <file>, or exiftool -all= <file>) and upload it again.`
}

function list(items: readonly string[]): string {
  return items.length > 8 ? `${items.slice(0, 8).join(", ")}, +${items.length - 8} more` : items.join(", ")
}
