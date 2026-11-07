/**
 * Penomoran artefak per bab/lampiran (01_specs.md §4.1, D-06) untuk perakit
 * DOCX (S20).
 *
 * Aturan §4.1: blok keluarga tabel ber-`caption` -> `Tabel C.n`; `chart`/
 * `diagram`/`image`/`symbolSheet` ber-`caption` -> `Gambar C.n`; `derivation`
 * -> `Turunan D-C.n` (atau `id` eksplisit blok). Tabel tanpa caption (perangkat,
 * kotak) tidak bernomor. Penghitung direset per unit bab/lampiran; unit lain
 * (halaman depan, pembatas bagian) tidak menomori.
 *
 * Label yang sudah ada di snapshot (`NormBlock.artifactLabel` atau
 * `snapshot.numbering[blockId]`) MENANG: snapshot adalah sumber alamat yang
 * dipersistenkan (StudioBlock.artifactLabel), sehingga caption DOCX selalu sama
 * dengan alamat route/HTML. Selisih dengan hasil hitung dicatat sebagai
 * peringatan `NUMBERING_MISMATCH` (bukan galat).
 */
import type { NormBlock, NormUnit } from "../../../contract";
import { FIGURE_BLOCK_TYPES, TABLE_BLOCK_TYPES } from "../../../contract/enums";
import { kickerSuppressed } from "../../front/texts";

const TABLE_TYPES: ReadonlySet<string> = new Set<string>(TABLE_BLOCK_TYPES);
const FIGURE_TYPES: ReadonlySet<string> = new Set<string>(FIGURE_BLOCK_TYPES);

/** chap = posint | upper (§4.1). */
const CHAP_RE = /^(?:[1-9][0-9]*|[A-Z])$/;
/** `id` turunan eksplisit: `D-3.1`, `D-A.2`, `D-3.1a`. */
const DERIVATION_ID_RE = /^D-(?:[1-9][0-9]*|[A-Z])\.[1-9][0-9]*[a-z]?$/;

export interface NumberingIssue {
  blockId: string;
  address: string | null;
  computed: string;
  existing: string;
}

export interface NumberingResult {
  /** blockId -> label final (snapshot bila ada, selain itu hasil hitung). */
  labels: Map<string, string>;
  /** unitKey -> kunci bab (`3`, `A`) untuk unit bab/lampiran. */
  chapterKeys: Map<string, string>;
  mismatches: NumberingIssue[];
}

function hasCaption(content: unknown): boolean {
  if (content === null || typeof content !== "object") return false;
  const cap = (content as { caption?: unknown }).caption;
  return cap !== null && typeof cap === "object";
}

function explicitDerivationId(content: unknown): string | undefined {
  if (content === null || typeof content !== "object") return undefined;
  const id = (content as { id?: unknown }).id;
  return typeof id === "string" && DERIVATION_ID_RE.test(id) ? id : undefined;
}

function toLetter(n: number): string {
  // Lampiran A..Z (skema membatasi kunci lampiran ke satu huruf).
  return n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : String(n);
}

/**
 * Kunci bab sebuah unit: `unit.key` bila sudah berbentuk chap; selain itu
 * alamat blok judul bab/lampiran (alamat chapHead = chap); selain itu posisi
 * (bab ke-n -> "n", lampiran ke-n -> huruf ke-n).
 */
export function resolveChapterKeys(
  units: readonly NormUnit[],
  blocksByUnit: ReadonlyMap<string, readonly NormBlock[]>,
): Map<string, string> {
  const out = new Map<string, string>();
  let chapterPos = 0;
  let appendixPos = 0;
  for (const unit of units) {
    if (unit.kind !== "chapter" && unit.kind !== "appendix") continue;
    const pos = unit.kind === "chapter" ? ++chapterPos : ++appendixPos;
    if (CHAP_RE.test(unit.key)) {
      out.set(unit.key, unit.key);
      continue;
    }
    const heading = (blocksByUnit.get(unit.key) ?? []).find(
      (b) => (b.type === "chapter" || b.type === "appendix") && typeof b.address === "string" && CHAP_RE.test(b.address),
    );
    out.set(unit.key, heading?.address ?? (unit.kind === "chapter" ? String(pos) : toLetter(pos)));
  }
  return out;
}

/** Label artefak seluruh dokumen, deterministik (urutan unit lalu ordinal). */
export function computeNumbering(
  units: readonly NormUnit[],
  blocksByUnit: ReadonlyMap<string, readonly NormBlock[]>,
  existing: Readonly<Record<string, string>>,
): NumberingResult {
  const chapterKeys = resolveChapterKeys(units, blocksByUnit);
  const labels = new Map<string, string>();
  const mismatches: NumberingIssue[] = [];

  for (const unit of units) {
    const blocks = blocksByUnit.get(unit.key) ?? [];
    const chap = chapterKeys.get(unit.key);
    // IMPL-W4: bab berpenomoran sumber (kicker kosong eksplisit) memakai label sumber dari snapshot ("Tabel 6.1",
    // "Tabel FM.1"); selisih dengan hitungan kunci internal adalah disengaja, bukan NUMBERING_MISMATCH.
    const sourceNumbered = blocks.some((b) => b.type === "chapter" && b.content !== null && typeof b.content === "object" && kickerSuppressed((b.content as { kicker?: unknown }).kicker));
    let t = 0;
    let g = 0;
    let d = 0;
    for (const b of blocks) {
      let computed: string | undefined;
      if (chap !== undefined) {
        if (TABLE_TYPES.has(b.type) && hasCaption(b.content)) computed = `Tabel ${chap}.${++t}`;
        else if (FIGURE_TYPES.has(b.type) && hasCaption(b.content)) computed = `Gambar ${chap}.${++g}`;
        else if (b.type === "derivation") {
          d += 1;
          const id = explicitDerivationId(b.content);
          computed = `Turunan ${id ?? `D-${chap}.${d}`}`;
        }
      }
      const prior = b.artifactLabel ?? existing[b.blockId];
      if (prior !== undefined && prior !== "") {
        labels.set(b.blockId, prior);
        if (computed !== undefined && computed !== prior && !sourceNumbered) {
          mismatches.push({ blockId: b.blockId, address: b.address, computed, existing: prior });
        }
      } else if (computed !== undefined) {
        labels.set(b.blockId, computed);
      }
    }
  }
  return { labels, chapterKeys, mismatches };
}
