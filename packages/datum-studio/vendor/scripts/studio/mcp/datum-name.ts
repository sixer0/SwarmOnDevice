/**
 * Swarm patch (row 165D, F56-2, CP-17): the name an output is delivered under by `studio_file_verify`.
 *
 * R10 already sends the DATUM name (`output_file.file_name`, storage/paths.ts datumFileName) in
 * `Content-Disposition` (filename* RFC 5987) for every document without a contractKind (files-serve.ts
 * defaultNameMode). The download saves under that title name when it is one safe path segment of the DATUM form
 * (contract/env.ts DATUM_FILENAME_PATTERN); otherwise under the C51 final name, as before.
 *
 * Path policy: the name comes from the server, so it is re-checked here before it touches a path: NFC, one segment,
 * no separators, `..`, control/bidi characters or `_`, an allowed extension, <= 255 characters. The joined path is
 * checked to stay directly inside the download folder.
 */
import path from "node:path";

import { DATUM_FILENAME_PATTERN } from "../../../src/lib/studio/contract/env";

const DATUM_NAME = new RegExp(DATUM_FILENAME_PATTERN);

/** true when `name` is a delivered DATUM name that is safe as one path segment. */
export function safeDatumName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  if (name.normalize("NFC") !== name) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0") || name === "." || name === "..") return false;
  return DATUM_NAME.test(name);
}

/**
 * The file name in a `Content-Disposition` value: `filename*=UTF-8''<pct>` first (RFC 5987/6266), else the quoted
 * `filename="..."`. Absent, malformed or undecodable -> null.
 */
export function dispositionFileName(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  const ext = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(value);
  if (ext) {
    try {
      return decodeURIComponent(ext[1]!);
    } catch {
      return null;
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*"([^"]*)"/i.exec(value);
  return plain ? plain[1]! : null;
}

/** The delivered DATUM name from R10 headers, or null when absent/unsafe (caller falls back to the C51 name). */
export function deliveredDatumName(headers: { get(name: string): string | null }): string | null {
  const name = dispositionFileName(headers.get("content-disposition"));
  return name !== null && safeDatumName(name) ? name : null;
}

/** `path.join(dir, name)` that must stay a direct child of `dir` (defence in depth after `safeDatumName`). */
export function joinInside(dir: string, name: string): string | null {
  const dest = path.join(dir, name);
  return path.dirname(path.resolve(dest)) === path.resolve(dir) && path.basename(dest) === name ? dest : null;
}
