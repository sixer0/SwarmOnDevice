/**
 * Nama berkas final (DC-17, register 05 §10 FN-01..FN-08; antarmuka I59-I62).
 * Murni: tanpa DB, tanpa IO, tanpa jam. Bentuk:
 * `<docNumberSafe>_rev<revisionNo>_<YYYYMMDDTHHMMSSZ>_<sha8>.<ext>`.
 * Nama dihitung saat baca dari baris `StudioOutputFile` + pemilik (KD-39);
 * tidak ada kolom tersimpan. Header C50 dan Content-Disposition (FN-06, FN-07)
 * dipasang DC-18, bukan di sini.
 *
 * Konstanta C51-C53 dan tipe T2-74 didefinisikan SATU kali di `L/contract`
 * (DC-05); modul ini mengimpornya (IB-DC-1, DC-18/DC-20) dan meneruskannya
 * untuk pemakai lama modul ini (uji DC-17) tanpa definisi kedua.
 */
import type { FinalFileNameParts, StudioOutputFormat } from "../../contract";
import { FINAL_ARTIFACT_PREFIX, FINAL_DOC_NUMBER_MAX, FINAL_FILENAME_PATTERN } from "../../contract/env";
import { isCalendarDay } from "../contracts/dates";
import { FORMAT_EXT } from "./naming";

export { FINAL_ARTIFACT_PREFIX, FINAL_DOC_NUMBER_MAX, FINAL_FILENAME_PATTERN };
export type { FinalFileNameParts };

const FINAL_RE = new RegExp(FINAL_FILENAME_PATTERN);
const ISO_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * I61 / FN-02: (1) runtun di luar `[A-Za-z0-9.-]` -> `-`; (2) `-` beruntun
 * jadi satu; (3) buang `-`/`.` di awal dan akhir; (4) potong C52 lalu buang
 * `-`/`.` akhir lagi; (5) kosong -> `DOC`.
 */
export function docNumberSafe(docNumber: string): string {
  const folded = String(docNumber).replace(/[^A-Za-z0-9.-]+/g, "-").replace(/-{2,}/g, "-");
  const trimmed = folded.replace(/^[-.]+/, "").replace(/[-.]+$/, "");
  const cut = trimmed.slice(0, FINAL_DOC_NUMBER_MAX).replace(/[-.]+$/, "");
  return cut === "" ? "DOC" : cut;
}

/** I59 / FN-01: rakit nama dari bagian-bagiannya (tanpa validasi ulang). */
export function formatFinalFileName(parts: FinalFileNameParts): string {
  const stamp = parts.renderedAt.replace(/[-:]/g, "");
  return `${parts.docNumberSafe}_rev${parts.revisionNo}_${stamp}_${parts.sha8}.${parts.ext}`;
}

/** Tanggal kalender (`isCalendarDay`, FIX-R40-3) dan jam sah (tanpa detik kabisat); `false` bila tidak. */
function validStamp(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  return h <= 23 && mi <= 59 && s <= 59 && isCalendarDay(y, mo, d);
}

/** I60 / FN-08: `null` bila tidak cocok C51 atau tanggal kalender tidak sah. */
export function parseFinalFileName(name: string): FinalFileNameParts | null {
  const m = FINAL_RE.exec(name);
  if (!m) return null;
  const st = STAMP_RE.exec(m[3]);
  if (!st) return null;
  const [y, mo, d, h, mi, s] = st.slice(1, 7).map(Number);
  if (!validStamp(y, mo, d, h, mi, s)) return null;
  return {
    docNumberSafe: m[1],
    revisionNo: Number(m[2]),
    renderedAt: `${st[1]}-${st[2]}-${st[3]}T${st[4]}:${st[5]}:${st[6]}Z`,
    sha8: m[4],
    ext: m[5] as FinalFileNameParts["ext"],
  };
}

/** FN-04: UTC, detik dipotong (bukan dibulatkan). */
function isoSecond(at: Date): string {
  if (Number.isNaN(at.getTime())) throw new RangeError("finalFileNameOf: createdAt tidak sah");
  const iso = at.toISOString().slice(0, 19) + "Z";
  if (!ISO_SECOND_RE.test(iso)) throw new RangeError("finalFileNameOf: tahun createdAt di luar 0000-9999");
  return iso;
}

/**
 * I62 / FN-03..FN-05: nama final satu berkas. Pemilik revisi memakai
 * `docNumberSafe(docNumber)` dan `revisionNo`; artefak (tanpa revisi) memakai
 * `rev0` dan `ART-<artifactId>` tanpa karakter di luar `[A-Za-z0-9-]`. Hasil
 * artefak dilewatkan `docNumberSafe` (identik untuk id biasa) agar tetap cocok
 * C51 bila id kosong atau melebihi C52.
 */
export function finalFileNameOf(
  file: { createdAt: Date; sha256: string; format: StudioOutputFormat },
  owner: { docNumber: string; revisionNo: number } | { artifactId: string },
): string {
  const isArtifact = "artifactId" in owner;
  return formatFinalFileName({
    docNumberSafe: isArtifact
      ? docNumberSafe(FINAL_ARTIFACT_PREFIX + owner.artifactId.replace(/[^A-Za-z0-9-]/g, ""))
      : docNumberSafe(owner.docNumber),
    revisionNo: isArtifact ? 0 : owner.revisionNo,
    renderedAt: isoSecond(file.createdAt),
    sha8: file.sha256.slice(0, 8).toLowerCase(),
    ext: FORMAT_EXT[file.format] as FinalFileNameParts["ext"],
  });
}
