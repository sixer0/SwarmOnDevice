/**
 * Fungsi turunan parameter (S11; 01_specs.md §5.1 `DeriveFnId`, katalog
 * research/01 §3.3.5).
 *
 * Kunci keluaran dibaca dari registri: setiap ParamDef ber-`derive` diisi oleh
 * fungsi dengan id yang sama. `DERIVE_FALLBACK_KEYS` hanya dipakai bila
 * registri yang diberikan belum memuat ParamDef dengan id tersebut (baris
 * pengisi params berjalan paralel). Nilai TIDAK disalin dari katalog: semuanya
 * dihitung dari parameter induk di peta aktif.
 *
 * Aturan per fungsi: hasil `undefined` = nilai yang ada dipertahankan (input
 * tidak cukup atau parameter memang bergantung konteks dokumen).
 *
 * SR-60 (research/09 §6.2, D-158, D-162, D-165): rantai ukuran halaman satu
 * sumber `page.size`/`page.orientation` -> `page.sizeMm` -> kolom teks, blok
 * teks (= tinggi - atas - bawah; perbaikan 247), lebar dan tinggi figur,
 * SectionSetup twip. Semua fungsi di sini idempoten. Fungsi berskala-acuan
 * (`marginsFromDensity`, `typeScaleFromBase`, sub-medan R-07/R-20/R-21/R-30/R-37,
 * `colorLiterals`) TIDAK di sini: dijalankan sekali pada fase lapis (`./layer`).
 */
import type { DeriveFnId, ParamDef, ParamMap, ParamValue, StudioTier } from "../../contract";
import { pageSizeFromPaper } from "./paper";

/** Konteks dokumen opsional untuk turunan yang tidak bisa dihitung dari parameter saja. */
export interface DeriveContext {
  /** Jumlah sitasi rel (chip/tanda per paragraf) di dokumen; menyelesaikan `layout.railMode = auto` (KT-07). */
  railCitations?: number;
  /** Tanggal terbit ISO `YYYY-MM-DD` (meta.issueDate) untuk `doc.monthRoman`. */
  issueDate?: string;
  /** Nomor terbitan dari ARSIP untuk `device.issueStamp.issueNumber`. */
  issueNumber?: number;
}

type MutableParams = Record<string, ParamValue>;
/** `key` = kunci target yang sedang diisi (fungsi bertarget banyak, mis. `figureWidthFromClass`). */
type Deriver = (p: MutableParams, current: ParamValue | undefined, ctx: DeriveContext, key: string) => ParamValue | undefined;

/**
 * Fungsi berskala-acuan (research/09 §6.2 butir 2, 6, 13, 14): hanya fase lapis
 * (`./layer`), sekali per resolusi; `deriveAll` tidak menjalankannya.
 * `pageSizeFromPaper` = register DV-01, nama kanonik tunggal (D-172; id usang
 * research/09 dicabut dari `DeriveFnId`, D-211/IP-48).
 */
export const LAYER_PHASE_DERIVES = ["marginsFromDensity", "typeScaleFromBase", "headerFooterTabsFromSpan", "colorLiterals"] as const;
type LayerPhaseDeriveFnId = (typeof LAYER_PHASE_DERIVES)[number];

/** Kunci masukan (nama dari katalog/kontrak, bukan nilai). */
export const K = {
  pageSize: "page.sizeMm",
  inner: "grid.innerMarginMm",
  text: "grid.textColumnMm",
  gutter: "grid.gutterMm",
  rail: "grid.evidenceRailMm",
  outer: "grid.outerMarginMm",
  fullSpan: "grid.fullSpanMm",
  subcolumns: "grid.subcolumns",
  latticeX: "grid.latticeXMm",
  latticeY: "grid.latticeYMm",
  textBlockHeight: "grid.textBlockHeightMm",
  /** D-33: diperlakukan sebagai margin ATAS. */
  topMargin: "grid.topBottomMarginMm",
  /**
   * D-33/D-162: margin bawah = MASUKAN (research/09 N5, turunan beracuan).
   * Bila tidak tersimpan, dihitung sekali dari tinggi - atas - blok TERSIMPAN
   * (bentuk lama D-33, `ensureBottomMargin`); blok teks lalu diturunkan dari
   * margin (`textBlockFromPage`), sehingga tidak pernah negatif karena kertas.
   */
  bottomMargin: "grid.marginBottomMm",
  pageWidthCheck: "grid.pageWidthCheck",
  railMode: "layout.railMode",
  rederive: "grid.rederiveForNonA4",
  baselinePt: "type.baselinePt",
  bodyLeading: "type.scale.body.leading",
  diagramMaxHeight: "diagram.maxHeightMm",
  hairMm: "rules.hairMm",
  tier: "artifact.tier",
  outsideDivision: "artifact.audience.outsideDivision",
  docNumber: "doc.number",
  vatNominal: "vat.nominalRatePercent",
  vatDpp: "vat.dppFactor",
  classification: "classification.level",
  sectionWrapper: "render.section.wrapper",
  sectionInterior: "render.section.interior",
} as const;

/**
 * Kunci target per fungsi turunan menurut katalog (research/01) dan research/09
 * §6.2, cadangan bila registri belum memuat ParamDef ber-`derive` id itu.
 * Parsial: id fase lapis dan id yang targetnya selalu dari registri tidak punya cadangan.
 */
export const DERIVE_FALLBACK_KEYS: Readonly<Partial<Record<DeriveFnId, readonly string[]>>> = {
  pageSizeFromPaper: [K.pageSize],
  textColumnFromPage: [K.text],
  textBlockFromPage: [K.textBlockHeight],
  baselineFromBodyLeading: [K.baselinePt],
  figureWidthFromClass: ["table.columnWidthSumMm", "chart.output.widthMm", "diagram.widthMm"],
  figureMaxHeightFromBlock: [K.diagramMaxHeight],
  sectionSetupFromGrid: [K.sectionWrapper, K.sectionInterior],
  rederiveNonA4: ["grid.rederiveForNonA4"],
  fullSpan: ["grid.fullSpanMm"],
  latticeX: ["grid.latticeXMm"],
  latticeY: ["grid.latticeYMm"],
  allowedFigureWidths: ["grid.allowedFigureWidthsMm"],
  pageWidthCheck: ["grid.pageWidthCheck"],
  railMode: ["layout.railMode"],
  railColsTw: ["render.rail.colsTw"],
  tierSuggested: ["artifact.tierSuggested"],
  pdfEnabledByTier: ["artifact.pdf.enabled"],
  reconciliationByTier: ["artifact.pageReconciliation.enabled"],
  lintByTier: ["artifact.lint.enabled"],
  fileName: ["naming.file.pattern"],
  figureFileFromCaption: ["naming.figureFile.fromCaption"],
  docNumberFileForm: ["doc.number.fileForm"],
  monthRoman: ["doc.monthRoman"],
  coverLeftMargin: ["cover.leftMarginMm"],
  coverRuleWidth: ["cover.datumRule.widthMm"],
  ruleWeightFromHair: ["device.datumRule.weightMm"],
  ticksFromSubcolumns: ["device.datumRule.ticks"],
  runningHeadRule: ["runningHead.ruleBelow"],
  totalRowRule: ["table.totalRow.ruleAbove"],
  captionIdentifierStyle: ["caption.identifier.style"],
  registerMaxDecimals: ["register.maxDecimals"],
  auditByTier: ["audit.untrackedNumbers.enabled", "audit.retiredValues.enabled"],
  admiraltyOnce: ["admiralty.scaleTablePrintedOnceInAppendix"],
  serahByTier: ["serah.secondIndependentRoute.required", "serah.reconciliationTable.required"],
  vatEffective: ["vat.effectiveRatePercent"],
  issueNumber: ["device.issueStamp.issueNumber"],
  chartEngine: ["chart.engine"],
  eyeCheckList: ["chart.eyeCheck.required"],
  wordLadder: ["rules.wordLadderSz"],
  diagramClassification: ["diagram.classification"],
  diagramLatticeSnap: ["diagram.latticeSnap"],
  diagramLineSpacing: ["diagram.docxPlacement.exactLineSpacingPt"],
};

/**
 * Urutan evaluasi (research/09 §6.2): ukuran halaman dari kenop, kolom teks dan
 * blok teks dari halaman, bentang, kisi, garis dasar, lebar/tinggi figur, cek
 * lebar, moda rel, kolom rel, SectionSetup twip, lalu sisanya. Margin sudah
 * final dari fase lapis (`marginsFromDensity`) sebelum fungsi ini dipanggil.
 */
export const DERIVE_ORDER: readonly Exclude<DeriveFnId, LayerPhaseDeriveFnId>[] = [
  "pageSizeFromPaper",
  "rederiveNonA4",
  "textColumnFromPage",
  "textBlockFromPage",
  "fullSpan",
  "latticeX",
  "baselineFromBodyLeading",
  "latticeY",
  "allowedFigureWidths",
  "figureWidthFromClass",
  "figureMaxHeightFromBlock",
  "pageWidthCheck",
  "railMode",
  "railColsTw",
  "sectionSetupFromGrid",
  "coverLeftMargin",
  "coverRuleWidth",
  "ruleWeightFromHair",
  "ticksFromSubcolumns",
  "runningHeadRule",
  "totalRowRule",
  "captionIdentifierStyle",
  "registerMaxDecimals",
  "tierSuggested",
  "pdfEnabledByTier",
  "reconciliationByTier",
  "lintByTier",
  "auditByTier",
  "serahByTier",
  "fileName",
  "figureFileFromCaption",
  "docNumberFileForm",
  "monthRoman",
  "admiraltyOnce",
  "vatEffective",
  "issueNumber",
  "chartEngine",
  "eyeCheckList",
  "wordLadder",
  // Diagram (P9-04/38/51): setelah kisi (latticeX/latticeY) dihitung.
  "diagramClassification",
  "diagramLatticeSnap",
  "diagramLineSpacing",
];

const TW_PER_MM = 1440 / 25.4;
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

export const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
export const mmToTw = (mm: number): number => Math.round(mm * TW_PER_MM);

function num(p: MutableParams, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isRecord(v: ParamValue | undefined): v is { [k: string]: ParamValue } {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

/** Rasio angka atau string "a/b" (mis. `vat.dppFactor` = "11/12"). */
export function ratio(v: ParamValue | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return undefined;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*$/.exec(v);
  if (!m) {
    const n = Number(v.replace(",", "."));
    return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
  }
  const a = Number(m[1].replace(",", "."));
  const b = Number(m[2].replace(",", "."));
  return b === 0 ? undefined : a / b;
}

/** Ukuran halaman [lebar, tinggi] mm (nilai `page.sizeMm` di peta, tanpa cadangan). */
export function pageSize(p: ParamMap): [number, number] | undefined {
  const v = p[K.pageSize];
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") return [v[0], v[1]];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, ParamValue>;
    const w = o.widthMm ?? o.w ?? o.width;
    const h = o.heightMm ?? o.h ?? o.height;
    if (typeof w === "number" && typeof h === "number") return [w, h];
  }
  return undefined;
}

function tierOf(p: MutableParams): StudioTier | undefined {
  const t = p[K.tier];
  return t === "NOTA" || t === "TERBIT" || t === "SERAH" ? t : undefined;
}

/** Komponen grid horizontal; `undefined` bila salah satu tidak terbaca. */
function gridParts(p: MutableParams): { inner: number; text: number; gutter: number; rail: number; outer: number } | undefined {
  const inner = num(p, K.inner);
  const text = num(p, K.text);
  const gutter = num(p, K.gutter);
  const rail = num(p, K.rail);
  const outer = num(p, K.outer);
  if (inner === undefined || text === undefined || gutter === undefined || rail === undefined || outer === undefined) return undefined;
  return { inner, text, gutter, rail, outer };
}

/**
 * Moda rel efektif (KT-07): nilai eksplisit A/B dipakai apa adanya; rel 0 mm
 * berarti B; `auto` diselesaikan dari jumlah sitasi rel bila konteks ada
 * (> 0 -> A, 0 -> B); tanpa konteks tetap `auto`.
 */
export function resolveRailMode(p: ParamMap, railCitations?: number): "A" | "B" | "auto" {
  const v = p[K.railMode];
  if (v === "A" || v === "B") return v;
  const rail = p[K.rail];
  if (typeof rail === "number" && rail === 0) return "B";
  if (typeof railCitations === "number" && Number.isFinite(railCitations)) return railCitations > 0 ? "A" : "B";
  return "auto";
}

/**
 * Margin bawah bentuk lama (D-33) bila belum tersimpan: tinggi - atas - blok
 * teks, dari nilai TERSIMPAN sebelum ukuran halaman diturunkan dari kenop.
 * Dipanggil sekali per peta di awal `deriveAll` dan fase lapis; bila margin
 * bawah sudah ada (tersimpan, disematkan preset, atau ParamDef N5), tidak
 * mengubah apa pun.
 */
export function ensureBottomMargin(p: MutableParams): void {
  if (num(p, K.bottomMargin) !== undefined) return;
  const size = pageSize(p);
  const top = num(p, K.topMargin);
  const block = num(p, K.textBlockHeight);
  if (size && top !== undefined && block !== undefined) p[K.bottomMargin] = round4(size[1] - top - block);
}

/** Twip SectionSetup dari grid (research/09 §6.2 butir 12); `undefined` = tidak berubah. */
function sectionSetupFromGrid(p: MutableParams, current: ParamValue | undefined): ParamValue | undefined {
  if (!isRecord(current)) return undefined;
  const size = pageSize(p);
  if (!size) return undefined;
  let changed = false;
  const next: Record<string, ParamValue> = { ...current };

  const pageTw = [mmToTw(size[0]), mmToTw(size[1])];
  const curTw = current.pageSizeTw;
  if (!(Array.isArray(curTw) && curTw[0] === pageTw[0] && curTw[1] === pageTw[1])) {
    next.pageSizeTw = pageTw;
    changed = true;
  }

  // marginTw hanya bila sub-medan sudah ada; header/footer/gutter tidak disentuh.
  const margin = current.marginTw;
  if (isRecord(margin)) {
    const src: Record<string, number | undefined> = {
      top: num(p, K.topMargin),
      bottom: num(p, K.bottomMargin),
      left: num(p, K.inner),
      right: num(p, K.outer),
    };
    const m: Record<string, ParamValue> = { ...margin };
    let mChanged = false;
    for (const [side, mm] of Object.entries(src)) {
      if (mm === undefined || !(side in margin)) continue;
      const tw = mmToTw(mm);
      if (m[side] !== tw) {
        m[side] = tw;
        mChanged = true;
      }
    }
    if (mChanged) {
      next.marginTw = m;
      changed = true;
    }
  }

  // Tab kanan kepala halaman = bentang penuh (hanya bila tab kanan sudah ada).
  const span = num(p, K.fullSpan);
  const header = current.header;
  if (span !== undefined && isRecord(header) && isRecord(header.format) && Array.isArray(header.format.tabs)) {
    const tw = mmToTw(span);
    let tChanged = false;
    const tabs = header.format.tabs.map((t) => {
      if (isRecord(t) && t.val === "right" && t.posTw !== tw) {
        tChanged = true;
        return { ...t, posTw: tw };
      }
      return t;
    });
    if (tChanged) {
      next.header = { ...header, format: { ...header.format, tabs } };
      changed = true;
    }
  }
  return changed ? next : undefined;
}

const pageSizeDeriver: Deriver = (p) => pageSizeFromPaper(p);

/** Bagian dari nilai Deriver yang dipakai bersama; tabel lengkap di bawah. */
const DERIVER_TABLE = {
  pageSizeFromPaper: pageSizeDeriver,
  // P4G-17 dipensiunkan (research/09 §6.2 butir 15, register PC-04): kolom teks
  // selalu diturunkan `textColumnFromPage`, twip seksi oleh `sectionSetupFromGrid`.
  // Bendera tetap true (atau nilai boolean tersimpan) tanpa efek samping.
  rederiveNonA4: (_p, current) => (typeof current === "boolean" ? current : true),
  // P4G-03 (research/09 butir 3): W - dalam - talang - rel - luar, selalu.
  textColumnFromPage: (p) => {
    const size = pageSize(p);
    const inner = num(p, K.inner);
    const gutter = num(p, K.gutter);
    const rail = num(p, K.rail);
    const outer = num(p, K.outer);
    if (!size || inner === undefined || gutter === undefined || rail === undefined || outer === undefined) return undefined;
    return round4(size[0] - inner - gutter - rail - outer);
  },
  // P4G-11 (research/09 butir 4, perbaikan 247 D-162): H - atas - bawah.
  textBlockFromPage: (p) => {
    const size = pageSize(p);
    const top = num(p, K.topMargin);
    const bottom = num(p, K.bottomMargin);
    return size && top !== undefined && bottom !== undefined ? round4(size[1] - top - bottom) : undefined;
  },
  // P4T-17 (butir 7): garis dasar = leading badan efektif.
  baselineFromBodyLeading: (p) => num(p, K.bodyLeading),
  // P5-14, P7-20, P9-36 (butir 9): `<jenis>.widthClass` text -> kolom teks, full -> bentang.
  // Tanpa kenop kelas lebar (registri lama) nilai yang ada dipertahankan.
  figureWidthFromClass: (p, _current, _ctx, key) => {
    const cls = p[`${key.split(".")[0]}.widthClass`];
    if (cls === "text") return num(p, K.text);
    if (cls === "full") return num(p, K.fullSpan);
    return undefined;
  },
  // P9-45 (butir 10): tinggi maksimum diagram = blok teks.
  figureMaxHeightFromBlock: (p) => num(p, K.textBlockHeight),
  sectionSetupFromGrid: (p, current) => sectionSetupFromGrid(p, current),
  fullSpan: (p) => {
    const g = gridParts(p);
    return g ? round4(g.text + g.gutter + g.rail) : undefined;
  },
  latticeX: (p) => {
    const text = num(p, K.text);
    const sub = num(p, K.subcolumns);
    return text !== undefined && sub !== undefined && sub > 0 ? round4(text / sub) : undefined;
  },
  latticeY: (p) => {
    const b = num(p, K.baselinePt);
    return b !== undefined ? round4((b * 25.4) / 72) : undefined;
  },
  allowedFigureWidths: (p) => {
    const text = num(p, K.text);
    const span = num(p, K.fullSpan);
    return text !== undefined && span !== undefined ? [text, span] : undefined;
  },
  pageWidthCheck: (p) => {
    const g = gridParts(p);
    return g ? round4(g.inner + g.text + g.gutter + g.rail + g.outer) : undefined;
  },
  railMode: (p, _current, ctx) => resolveRailMode(p, ctx.railCitations),
  // R-13: moda A = [kolom teks, gutter, rel] twip; moda B = [bentang penuh].
  // `auto` tanpa konteks memakai susunan moda A (alokasi grid kanonik D-4.1).
  railColsTw: (p) => {
    const g = gridParts(p);
    if (!g) return undefined;
    const mode = p[K.railMode];
    if (mode === "B") return [mmToTw(g.text + g.gutter + g.rail)];
    return [mmToTw(g.text), mmToTw(g.gutter), mmToTw(g.rail)];
  },
  coverLeftMargin: (p) => num(p, K.inner),
  coverRuleWidth: (p) => num(p, K.fullSpan),
  ruleWeightFromHair: (p) => num(p, K.hairMm),
  ticksFromSubcolumns: (p) => num(p, K.subcolumns),
  runningHeadRule: () => "rules.hair",
  totalRowRule: () => "rules.primary",
  captionIdentifierStyle: () => undefined,
  // Batas mesin E-12: 0..3 desimal.
  registerMaxDecimals: (_p, current) =>
    typeof current === "number" && Number.isFinite(current) ? Math.min(3, Math.max(0, Math.trunc(current))) : 3,
  tierSuggested: (p) => {
    const o = p[K.outsideDivision];
    return typeof o === "boolean" ? (o ? "TERBIT" : "NOTA") : undefined;
  },
  // Tabel 3.1: NOTA false, SERAH true, TERBIT = pilihan (B hanya untuk TERBIT).
  pdfEnabledByTier: (p, current) => {
    const t = tierOf(p);
    if (t === "NOTA") return false;
    if (t === "SERAH") return true;
    if (t === "TERBIT") return typeof current === "boolean" ? current : false;
    return undefined;
  },
  reconciliationByTier: (p) => (tierOf(p) ? tierOf(p) === "SERAH" : undefined),
  lintByTier: (p) => (tierOf(p) ? tierOf(p) !== "NOTA" : undefined),
  auditByTier: (p) => (tierOf(p) ? tierOf(p) === "SERAH" : undefined),
  serahByTier: (p) => (tierOf(p) ? tierOf(p) === "SERAH" : undefined),
  fileName: () => undefined,
  figureFileFromCaption: () => undefined,
  docNumberFileForm: (p) => {
    const n = p[K.docNumber];
    return typeof n === "string" && n.length > 0 ? n.replace(/\//g, "-") : undefined;
  },
  monthRoman: (_p, _current, ctx) => {
    const m = /^\d{4}-(\d{2})-\d{2}/.exec(ctx.issueDate ?? "");
    const month = m ? Number(m[1]) : 0;
    return month >= 1 && month <= 12 ? ROMAN[month - 1] : undefined;
  },
  admiraltyOnce: () => undefined,
  vatEffective: (p) => {
    const nominal = num(p, K.vatNominal);
    const dpp = ratio(p[K.vatDpp]);
    return nominal !== undefined && dpp !== undefined ? round4(nominal * dpp) : undefined;
  },
  issueNumber: (_p, _current, ctx) =>
    typeof ctx.issueNumber === "number" && Number.isInteger(ctx.issueNumber) && ctx.issueNumber >= 1 ? ctx.issueNumber : undefined,
  chartEngine: () => undefined,
  eyeCheckList: () => undefined,
  wordLadder: () => undefined,
  // P9-04: diwarisi klasifikasi dokumen induk (= P6-02).
  diagramClassification: (p) => (typeof p[K.classification] === "string" ? p[K.classification] : undefined),
  // P9-38: = P4G-09 x P4G-10.
  diagramLatticeSnap: (p) => {
    const x = num(p, K.latticeX);
    const y = num(p, K.latticeY);
    return x !== undefined && y !== undefined ? { xMm: x, yMm: y } : undefined;
  },
  // P9-51: = baseline (P4T-17).
  diagramLineSpacing: (p) => num(p, K.baselinePt),
} satisfies Readonly<Record<Exclude<DeriveFnId, LayerPhaseDeriveFnId>, Deriver>>;

/**
 * Tabel fungsi turunan idempoten: lengkap untuk setiap `DeriveFnId` kontrak
 * kecuali id fase lapis (`satisfies` di atas memeriksanya saat kompilasi);
 * id fase lapis dilewati `deriveAll` (lihat `./layer`).
 */
export const DERIVERS: Readonly<Partial<Record<DeriveFnId, Deriver>>> = DERIVER_TABLE;

/** Kunci target per fungsi turunan menurut registri (cadangan katalog bila belum ada). */
export function deriveTargets(registry: readonly ParamDef[]): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const d of registry) {
    if (!d.derive) continue;
    const arr = out.get(d.derive) ?? [];
    if (!arr.includes(d.key)) arr.push(d.key);
    out.set(d.derive, arr);
  }
  // Cadangan hanya untuk turunan tanpa target registri (termasuk pageSizeFromPaper).
  for (const id of DERIVE_ORDER) {
    if (out.has(id)) continue;
    const fb = DERIVE_FALLBACK_KEYS[id];
    if (fb) out.set(id, [...fb]);
  }
  return out;
}

/**
 * Hitung semua turunan idempoten atas salinan `p`. Idempoten: memanggil ulang
 * pada keluarannya menghasilkan peta yang sama (fungsi berskala-acuan tidak
 * dijalankan di sini; lihat `./layer`).
 */
export function deriveAll(p: ParamMap, registry: readonly ParamDef[], ctx: DeriveContext = {}): Record<string, ParamValue> {
  const out: MutableParams = { ...p };
  ensureBottomMargin(out);
  const targets = deriveTargets(registry);
  for (const id of DERIVE_ORDER) {
    const fn = DERIVERS[id];
    if (!fn) continue;
    for (const key of targets.get(id) ?? []) {
      const v = fn(out, out[key], ctx, key);
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}
