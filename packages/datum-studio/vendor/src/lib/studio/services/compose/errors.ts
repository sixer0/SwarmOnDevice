/**
 * Galat terstruktur compose. Semua galat = `StudioEngineError` (route memetakan
 * ke HTTP lewat `studioErrorFrom`); `message` berbahasa Indonesia dan menyebut
 * perbaikan dalam bahasa isi (§2.7, §11.1), `details` sesuai contoh §11.2.
 */
import { StudioEngineError, type StudioErrorCode } from "../../contract";

export function composeFail(code: StudioErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new StudioEngineError(code, message, details);
}

/** Daftar berlabel untuk pesan ("A, B"). */
export function listText(items: readonly string[]): string {
  return items.join(", ");
}
