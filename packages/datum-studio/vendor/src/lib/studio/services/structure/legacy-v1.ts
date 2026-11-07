/**
 * Rekonstruksi snapshot `studio.norm/v1` dari baris struktur hasil backfill
 * (IP-52, D-209; asal: recomposer lokal `prisma/backfill-studio-structure.ts`
 * SR-37 — kini satu sumber di sini, skrip mengimpornya).
 *
 * Snapshot v1 tetap dirender jalur lama (blueprint 05 §2.8) dan tidak dapat
 * dikomposisi ulang byte-identik dari baris v2: adaptor v1->v2 (SR-09, kebijakan
 * `strip`) membuang spacer, device, entri toc, dan format inline. Maka untuk
 * norm/v1 "rekonstruksi" berarti:
 *   1. `sections` hasil bangun ulang baris (tanpa pid bab/section/blok) sama
 *      persis dengan `adaptV1(snapshot.doc).sections` (tanpa pid), dan
 *   2. setiap pid hasil adaptor (blockId v1 ternormalisasi) muncul pada posisi
 *      yang sama di baris;
 * lalu snapshot v1 TERSIMPAN dikembalikan apa adanya sehingga
 * `canonicalSha256(snapshot) === StudioRevision.snapshotSha256`.
 *
 * Murni (tanpa DB, tanpa berkas, tanpa jam): masukan sama -> keluaran sama.
 */
import { createHash } from "node:crypto";
import type { ChapterV2, NormDocSnapshot, StudioDocV2Resolved, StudioIngestRequest } from "../../contract";
import { adaptV1 } from "../adapt-v1";
import { canonicalSha, stripChapterIds } from "./rows";

export type LegacySectionsMap = NonNullable<StudioDocV2Resolved["sections"]>;

export interface LegacyAdaptation {
  sections: LegacySectionsMap;
  /** Aset adaptor sebagai `{ assetRef: "sha256:<hex>" }` (dataBase64 di-hash). */
  assets: Record<string, { assetRef: string }>;
  report: { dropped: Record<string, number>; strippedFields: number };
}

/** Adaptasi deterministik `snapshot.doc` v1 -> `sections` v2 (dipakai saat tulis backfill dan saat verifikasi). */
export function adaptLegacySnapshot(snapshot: NormDocSnapshot): LegacyAdaptation {
  const req = { document: snapshot.doc } as unknown as StudioIngestRequest;
  // Kebijakan strip: baris v2 hanya isi (tampilan milik templat); `trusted` tidak relevan untuk strip.
  const a = adaptV1(req, "strip", true, {});
  const assets: Record<string, { assetRef: string }> = {};
  for (const [k, v] of Object.entries(a.doc.assets ?? {})) {
    if ("assetRef" in v && typeof v.assetRef === "string") assets[k] = { assetRef: v.assetRef };
    else if ("dataBase64" in v && typeof v.dataBase64 === "string") {
      assets[k] = { assetRef: `sha256:${createHash("sha256").update(Buffer.from(v.dataBase64, "base64")).digest("hex")}` };
    }
  }
  const strippedFields = Object.values(a.report.stripped ?? {}).reduce((s, n) => s + n, 0);
  return { sections: (a.doc.sections ?? {}) as LegacySectionsMap, assets, report: { dropped: { ...a.report.dropped }, strippedFields } };
}

/** sha `sections` tanpa pid struktural (bab/section/blok) untuk perbandingan isi. */
export function sectionsShaWithoutPids(sections: LegacySectionsMap): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sections)) {
    const p = v as unknown as { chapters?: ChapterV2[] };
    out[k] = Array.isArray(p.chapters) ? { ...(v as object), chapters: p.chapters.map((c) => stripChapterIds(c)) } : v;
  }
  return canonicalSha(out);
}

/** Pid bab/section/blok dalam urutan dokumen (null = tanpa id). */
function pidSequence(sections: LegacySectionsMap): Array<string | null> {
  const seq: Array<string | null> = [];
  for (const v of Object.values(sections)) {
    for (const c of (v as unknown as { chapters?: ChapterV2[] }).chapters ?? []) {
      seq.push(c.id ?? null);
      for (const b of c.intro ?? []) seq.push(b.id ?? null);
      for (const s of c.sections ?? []) {
        seq.push(s.id ?? null);
        for (const b of s.blocks ?? []) seq.push(b.id ?? null);
      }
    }
  }
  return seq;
}

/** Jumlah pid adaptor yang tidak sama dengan pid baris pada posisi yang sama. */
export function adaptorPidMismatches(expected: LegacySectionsMap, rebuilt: LegacySectionsMap): number {
  const a = pidSequence(expected);
  const b = pidSequence(rebuilt);
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let n = 0;
  a.forEach((p, i) => {
    if (p !== null && p !== b[i]) n++;
  });
  return n;
}

export interface LegacyReconstructionCheck {
  expectedSectionsSha256: string;
  rebuiltSectionsSha256: string;
  pidMismatches: number;
  /** true = baris mereproduksi `adaptV1(snapshot.doc)` (isi tanpa pid sama + pid adaptor sama). */
  matches: boolean;
}

/** Cek kesetaraan jalur lama: `sections` hasil bangun ulang baris vs `adaptV1(stored.doc)`. */
export function checkLegacyReconstruction(stored: NormDocSnapshot, rebuiltSections: LegacySectionsMap): LegacyReconstructionCheck {
  const expected = adaptLegacySnapshot(stored).sections;
  const expectedSectionsSha256 = sectionsShaWithoutPids(expected);
  const rebuiltSectionsSha256 = sectionsShaWithoutPids(rebuiltSections);
  const pidMismatches = adaptorPidMismatches(expected, rebuiltSections);
  return {
    expectedSectionsSha256,
    rebuiltSectionsSha256,
    pidMismatches,
    matches: expectedSectionsSha256 === rebuiltSectionsSha256 && pidMismatches === 0,
  };
}
