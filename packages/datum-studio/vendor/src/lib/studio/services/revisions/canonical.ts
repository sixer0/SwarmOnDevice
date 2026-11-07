/**
 * JSON kanonik (kunci terurut, tanpa undefined) dan sha256 heks untuk
 * `inputSha256`/`snapshotSha256` revisi (S50). Deterministik lintas proses.
 */
// S85 R-08: JSON kanonik + sha256 SATU sumber (services/ingest/util), juga
// dipakai templat (paramsSha256) dan artefak (specSha256).
import { sha256Hex, stableStringify } from "../ingest/util";

export { sha256Hex, stableStringify };

export function canonicalSha256(v: unknown): string {
  return sha256Hex(stableStringify(v));
}

/** Salinan dalam lewat JSON (snapshot dan doc adalah data JSON murni). */
export function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
