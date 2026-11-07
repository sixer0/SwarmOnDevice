/**
 * Pembaca parameter templat untuk HTML dasar (S21). Semua nilai dibaca dari
 * `ResolvedTemplate.params` (keluaran S11 `engine/tokens`); konstanta di sini
 * hanya cadangan bila parameter tidak ada atau bertipe salah, dengan sumber
 * yang dicatat.
 */
import type { DocMeta, ParamMap, ParamValue, ResolvedTemplate } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { pageSizeFromPaper, resolveTokenColor } from "../../tokens";

/** Kunci parameter yang dibaca modul ini (nama dari katalog, bukan nilai). */
export const P = {
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
  textBlock: "grid.textBlockHeightMm",
  /** D-33: margin ATAS. */
  topMargin: "grid.topBottomMarginMm",
  /** D-33: margin BAWAH turunan S11. */
  bottomMargin: "grid.marginBottomMm",
  baselinePt: "type.baselinePt",
  faceSerif: "type.face.serif",
  faceCondensed: "type.face.condensed",
  faceMono: "type.face.mono",
  faceWorkbook: "type.face.workbookUi",
  faceSymbol: "type.face.symbolGlyph",
  fallbackStructural: "type.role.structural.fallback",
  fallbackReading: "type.role.reading.fallback",
  fallbackData: "type.role.data.fallback",
  fallbackWorkbook: "type.role.workbookUi.fallback",
  trackDisplay: "type.tracking.displayTighter",
  trackMicro: "type.tracking.microLabelWider",
  bodyAlign: "type.body.align",
  embedFonts: "render.docx.embedFonts",
  sectionWrapper: "render.section.wrapper",
  sectionInterior: "render.section.interior",
  entity: "org.entityName",
  orgShort: "org.shortName",
  kickerText: "cover.kicker.text",
  chapterPattern: "chapter.kicker.pattern",
  registerCells: "device.registerBlock.cells",
  registerBold: "device.registerBlock.boldFields",
  registerSeparator: "device.registerBlock.separator",
  registerEnabled: "device.registerBlock.enabled",
  datumEnabled: "device.datumRule.enabled",
  datumWeight: "device.datumRule.weightMm",
  datumFront: "device.datumRule.frontSegmentMm",
  sealHeight: "device.sealBand.heightMm",
  sealColour: "device.sealBand.colour",
  classInk: "color.classificationInk",
  railEnabled: "device.evidenceRail.enabled",
} as const;

/**
 * Cadangan nilai grid kanonik (katalog P4G; dipakai hanya bila parameter absen).
 * Ukuran halaman TIDAK punya cadangan (KC-7, D-158/D-166): lihat `pageSizeMm`.
 * Kolom teks dan blok teks juga TIDAK (turunan kertas, D-245 H1 / D-271): lihat `requiredGrid`.
 */
const GRID_FALLBACK = {
  inner: 24,
  gutter: 6,
  rail: 32,
  outer: 20,
  top: 26,
  subcolumns: 12,
} as const;

/** Nilai grid turunan kertas wajib (`grid.textColumnMm`, `grid.textBlockHeightMm`); absen = BY_CONSTRUCTION_FAILED. */
function requiredGrid(p: ParamMap, key: string): number {
  const v = num(p, key);
  if (v !== undefined && v > 0) return v;
  throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `parameter turunan ${key} tidak terbaca (wajib ada di parameter templat, tanpa cadangan A4)`, { keys: [key] });
}

export function num(p: ParamMap, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function str(p: ParamMap, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" ? v : undefined;
}

export function bool(p: ParamMap, key: string): boolean | undefined {
  const v = p[key];
  return typeof v === "boolean" ? v : undefined;
}

export function list(p: ParamMap, key: string): readonly ParamValue[] {
  const v = p[key];
  return Array.isArray(v) ? v : [];
}

export function record(v: ParamValue | undefined): Readonly<Record<string, ParamValue>> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

/** Bulatkan ke 4 desimal agar CSS deterministik dan ringkas. */
export function r4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function mm(n: number): string {
  return `${r4(n)}mm`;
}

export function pt(n: number): string {
  return `${r4(n)}pt`;
}

/** Twip -> mm (1 in = 1440 tw = 25,4 mm). */
export function twToMm(tw: number): number {
  return (tw * 25.4) / 1440;
}

export interface PageGeometry {
  pageW: number;
  pageH: number;
  top: number;
  bottom: number;
  inner: number;
  outer: number;
  text: number;
  gutter: number;
  rail: number;
  fullSpan: number;
  pitchX: number;
  pitchY: number;
  /** Jarak tepi atas lembar ke garis dasar running head / tepi bawah ke blok register (mm). */
  headerMm: number;
  footerMm: number;
}

/** Margin seksi eksplisit `render.section.*.marginTw` bila diisi (twip -> mm). */
function sectionMargins(p: ParamMap, key: string): { top: number; bottom: number; left: number; right: number; header: number; footer: number } | undefined {
  const s = record(p[key]);
  const m = record(s?.marginTw);
  if (!m) return undefined;
  const vals = ["top", "bottom", "left", "right", "header", "footer"].map((k) => m[k]);
  if (!vals.every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
  const [top, bottom, left, right, header, footer] = (vals as number[]).map(twToMm);
  return { top, bottom, left, right, header, footer };
}

/**
 * Ukuran halaman efektif [lebar, tinggi] mm, satu sumber (register §13.4, KC-7):
 * turunan SR-60 DV-01 `pageSizeFromPaper` (nama kanonik D-172) dari
 * `page.size` + `page.orientation` (+ `page.customSizeMm`). Bila kenop tidak
 * terbaca (profil lama tanpa kenop) dipakai `page.sizeMm` tersimpan (nilai
 * turunan fungsi yang sama). Tanpa fallback A4: bila keduanya absen, galat
 * BY_CONSTRUCTION_FAILED (templat tidak terselesaikan lewat registri).
 * Orientasi per slot cukup ditimpa di peta parameter unit (SR-17).
 */
export function pageSizeMm(p: ParamMap): [number, number] {
  const fromKnob = pageSizeFromPaper(p);
  if (fromKnob) return fromKnob;
  const size = p[P.pageSize];
  if (Array.isArray(size) && size.length === 2) {
    const [w, h] = size;
    if (typeof w === "number" && typeof h === "number" && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return [w, h];
  }
  throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "ukuran halaman tidak dapat ditentukan: page.size/page.customSizeMm dan page.sizeMm absen atau tidak sah", {
    keys: ["page.size", "page.orientation", "page.customSizeMm", P.pageSize],
  });
}

/**
 * Geometri lembar dari grid (P4G) dan D-33: margin atas = `grid.topBottomMarginMm`,
 * margin bawah = turunan `grid.marginBottomMm` (cadangan: tinggi - atas - blok teks).
 * Margin seksi interior eksplisit (R-10 `marginTw`) menang bila diisi lengkap.
 */
export function pageGeometry(tpl: ResolvedTemplate): PageGeometry {
  const p = tpl.params;
  const [pageW, pageH] = pageSizeMm(p);
  const inner = num(p, P.inner) ?? GRID_FALLBACK.inner;
  const text = requiredGrid(p, P.text);
  const gutter = num(p, P.gutter) ?? GRID_FALLBACK.gutter;
  const rail = num(p, P.rail) ?? GRID_FALLBACK.rail;
  const outer = num(p, P.outer) ?? GRID_FALLBACK.outer;
  const top = num(p, P.topMargin) ?? GRID_FALLBACK.top;
  const bottom = num(p, P.bottomMargin) ?? pageH - top - requiredGrid(p, P.textBlock);
  const fullSpan = num(p, P.fullSpan) ?? text + gutter + rail;
  const subcols = num(p, P.subcolumns) ?? GRID_FALLBACK.subcolumns;
  const pitchX = num(p, P.latticeX) ?? fullSpan / Math.max(1, subcols + 3.5);
  const baseline = num(p, P.baselinePt) ?? 13.5;
  const pitchY = num(p, P.latticeY) ?? (baseline * 25.4) / 72;
  const sec = sectionMargins(p, P.sectionInterior);
  const g: PageGeometry = {
    pageW,
    pageH,
    top,
    bottom,
    inner,
    outer,
    text,
    gutter,
    rail,
    fullSpan,
    pitchX,
    pitchY,
    // Acuan RL (Sumber Lembar Bukti.html): running head dan blok register 13 mm dari tepi = separuh margin atas 26 mm.
    headerMm: top / 2,
    footerMm: top / 2,
  };
  if (sec) {
    g.top = sec.top;
    g.bottom = sec.bottom;
    g.inner = sec.left;
    g.outer = sec.right;
    g.headerMm = sec.header;
    g.footerMm = sec.footer;
  }
  return g;
}

/** Warna hex `#RRGGBB` untuk tokenRef/kunci; cadangan bila tidak terselesaikan. */
export function colour(tpl: ResolvedTemplate, ref: string | undefined, fallback: string): string {
  const hex = ref ? resolveTokenColor(tpl, ref) : undefined;
  return `#${hex ?? fallback}`;
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

/** `YYYY-MM-DD` -> `DD-<bulan Romawi>-YYYY` (gaya blok register acuan RL, mis. 31-VII-2026). */
export function registerDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return iso;
  return `${m[3]}-${ROMAN[month - 1]}-${m[1]}`;
}

const CLASS_CODES: Readonly<Record<string, string>> = {
  sangatrahasia: "SR",
  rahasia: "R",
  terbatas: "T",
  biasa: "B",
  sr: "SR",
  r: "R",
  t: "T",
  b: "B",
};

/** Kode klasifikasi (SR/R/T/B) dari label atau kode; `undefined` bila tidak dikenal. */
export function classificationCode(label: string): string | undefined {
  return CLASS_CODES[label.toLowerCase().replace(/[^a-z]/g, "")];
}

/**
 * Warna tinta klasifikasi (P4C-35 `color.classificationInk`), cadangan seal.
 * Swarm patch (row 49a, C104 H1): Rev A DT-28d = seal #6E1420 at every level, never alert (was cadangan alert 9B1C1C).
 */
export function classificationColour(tpl: ResolvedTemplate, meta: Pick<DocMeta, "classification">): string {
  const code = classificationCode(meta.classification);
  const map = record(tpl.params[P.classInk]);
  const ref = code && map && typeof map[code] === "string" ? (map[code] as string) : "seal";
  return colour(tpl, ref, "6E1420");
}

