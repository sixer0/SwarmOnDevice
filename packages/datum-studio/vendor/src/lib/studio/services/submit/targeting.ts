/**
 * Penargetan dokumen yang ADA untuk kiriman `studio.doc/v2` (D-232, SUB-1).
 *
 * Bentuk sama dengan kiriman bab/slot (R12/R13): `target.documentId` +
 * `baseRevisionNo` opsional. Skema SID01 kontrak (`additionalProperties: false`)
 * belum memuat kedua medan itu (permintaan kontrak SUB-1 di `file_requests.md`),
 * jadi R04 memisahkan medan sebelum skema/ingest dan meneruskannya sebagai
 * PARAMETER EKSPLISIT (IP-64, SR-55 M1; FIX-S): `ingestDocument(doc, caller,
 * { submitTargeting })` -> `V2Options.submitTargeting` -> `submitDocumentV2(caller,
 * body, targeting)`. Tanpa konteks async implisit.
 *
 * Urutan sumber di `submitDocumentV2`: argumen eksplisit -> medan di badan
 * (berlaku begitu kontrak SID01 memuatnya). Tanpa penargetan apa pun = perilaku
 * buat-baru/upsert misi lama, tidak berubah.
 */
import type { DocTargetV2, StudioDocV2 } from "../../contract";

/** Penargetan kiriman dokumen v2 ke dokumen yang ada. */
export interface DocV2Targeting {
  target?: DocTargetV2;
  baseRevisionNo?: number;
}

/**
 * Pisahkan `target`/`baseRevisionNo` dari badan dokumen v2. Badan tanpa kedua medan
 * dikembalikan apa adanya (objek sama, sha masukan tidak berubah).
 */
export function splitDocV2Targeting<T extends StudioDocV2>(body: T): { body: T; targeting: DocV2Targeting | undefined } {
  const rec = body as unknown as Record<string, unknown>;
  if (rec.target === undefined && rec.baseRevisionNo === undefined) return { body, targeting: undefined };
  const { target, baseRevisionNo, ...rest } = rec;
  const targeting: DocV2Targeting = {};
  if (target !== undefined) targeting.target = target as DocTargetV2;
  if (baseRevisionNo !== undefined) targeting.baseRevisionNo = baseRevisionNo as number;
  return { body: rest as unknown as T, targeting };
}
