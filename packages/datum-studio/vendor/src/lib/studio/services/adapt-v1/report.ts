/**
 * services/adapt-v1 — pencatat REPORT `SCHEMA_V1_ADAPTED` (`AdaptReportV1`,
 * register 03_structural_sections_specs.md §14.3, isi LD-03).
 *
 * Dua kelas medan yang dibuang adaptor:
 * - **Format inline** (R-38, D-138; tunduk `ingest.inlineFormat`): `format`,
 *   `runDefaults`, `fieldFormats`, properti tampilan run, `x` blok, `overrides`
 *   dokumen, dan wadah format paragraf turunannya. `reject` = 422
 *   `INLINE_FORMAT_REJECTED` bila ada satu saja; `strip` = buang + REPORT
 *   `INLINE_FORMAT_STRIPPED`.
 * - **Tata letak** (setup, lebar, kicker, label mesin, dll.): selalu dibuang
 *   (tampilan milik templat, §0) dan hanya dihitung di `stripped`.
 *
 * `stripped` dikunci nama medan v1; `countInlineFormat` memilah kelas pertama.
 */
import type { AdaptReportV1, InlineFormatPolicy, ValidationIssue } from "@/lib/studio/contract";

/** Medan format inline v1 (R-38). Kunci `stripped` dengan nama ini memicu kebijakan `ingest.inlineFormat`. */
export const INLINE_FORMAT_FIELDS: ReadonlySet<string> = new Set([
  "format",
  "runDefaults",
  "fieldFormats",
  "labelProps",
  "headingFormat",
  "paragraphFormat",
  "signRowFormat",
  "trailingFormat",
  "face",
  "faceRole",
  "szHalfPt",
  "color",
  "caps",
  "smallCaps",
  "spacingTw",
  "u",
  "x",
  "overrides",
]);

/** Batas pointer contoh yang dibawa issue `INLINE_FORMAT_REJECTED`. */
export const INLINE_FORMAT_POINTER_LIMIT = 50;

/** Jumlah medan format inline (kelas R-38) di sebuah REPORT. */
export function countInlineFormat(report: Pick<AdaptReportV1, "stripped">): number {
  let n = 0;
  for (const [k, v] of Object.entries(report.stripped)) if (INLINE_FORMAT_FIELDS.has(k)) n += v;
  return n;
}

/** Pencatat mutable selama satu adaptasi; `finish()` menghasilkan `AdaptReportV1`. */
export class AdaptRecorder {
  readonly stripped: Record<string, number> = {};
  readonly renamed: Record<string, number> = {};
  readonly dropped: AdaptReportV1["dropped"] = {
    spacer: 0,
    device: 0,
    symbolGlyphRuns: 0,
    fieldRuns: 0,
    frontItems: 0,
    tocEntries: 0,
  };
  /** Pointer contoh medan format inline (untuk issue 422 `reject`). */
  readonly inlinePointers: string[] = [];

  constructor(readonly policy: InlineFormatPolicy) {}

  strip(field: string, pointer: string): void {
    this.stripped[field] = (this.stripped[field] ?? 0) + 1;
    if (INLINE_FORMAT_FIELDS.has(field) && this.inlinePointers.length < INLINE_FORMAT_POINTER_LIMIT) {
      this.inlinePointers.push(`${pointer}/${escapePointer(field)}`);
    }
  }

  rename(key: string, n = 1): void {
    this.renamed[key] = (this.renamed[key] ?? 0) + n;
  }

  drop(kind: keyof AdaptReportV1["dropped"], n = 1): void {
    this.dropped[kind] += n;
  }

  /**
   * Hitung setiap properti `obj` di luar `consumed` sebagai medan yang dibuang.
   * Dipakai di setiap objek v1 agar akuntansi REPORT lengkap tanpa daftar manual.
   */
  rest(obj: object, consumed: readonly string[], pointer: string): void {
    for (const k of Object.keys(obj)) {
      if (!consumed.includes(k) && (obj as Record<string, unknown>)[k] !== undefined) this.strip(k, pointer);
    }
  }

  inlineIssues(): ValidationIssue[] {
    return this.inlinePointers.map((pointer) => ({
      pointer,
      keyword: "inlineFormat",
      checkId: "INLINE_FORMAT",
      message: "format tampilan inline tidak diterima (ingest.inlineFormat = reject); tampilan diatur templat",
    }));
  }

  finish(): AdaptReportV1 {
    return {
      schema: "studio.doc/v1",
      policy: this.policy,
      stripped: sortKeys(this.stripped),
      dropped: { ...this.dropped },
      renamed: sortKeys(this.renamed),
    };
  }
}

function sortKeys(r: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** RFC 6901. */
export function escapePointer(seg: string | number): string {
  return String(seg).replace(/~/g, "~0").replace(/\//g, "~1");
}
