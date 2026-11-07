/**
 * Seksi dokumen (S14): resolusi SectionSetup per unit (templat R-09/R-10 +
 * grid P4G + setup eksplisit) dan serialisasi `w:sectPr`.
 *
 * Ukuran halaman SATU sumber (SR-16, D-158, KC-7 D-166, register §13.4): kenop
 * `page.size` + `page.orientation` (+ `page.customSizeMm`) lewat turunan SR-60
 * `pageSizeFromPaper` (DV-01, nama kanonik D-172), cadangan
 * `page.sizeMm` (hasil turunan yang sama di peta tersimpan). Tidak ada fallback
 * A4 di mesin: peta tanpa keduanya = BY_CONSTRUCTION_FAILED. `pageSizeTw`
 * tersimpan di `render.section.*` diabaikan (PC-05). Orientasi berlaku per
 * unit karena peta unit sadar slot memuat `page.orientation` efektif slot.
 *
 * Margin dari grid P4G (dalam, luar, atas, bawah); header/footer/gutter dan
 * cols/docGrid bawaan = BM.docx (research/07 §6: header/footer 737, gutter 0,
 * cols space 720, docGrid linePitch 360).
 *
 * Unit sadar slot (snapshot `studio.norm/v2`, unit bermedan `slotKey`):
 * `slot.setup` (R-41, SlotSetup tanpa `pageSizeTw`) menang atas setup unit,
 * termasuk `runningHead` (false = kepala kosong, true = kepala berjalan) dan
 * `startOnNewPage` (false = seksi `continuous`). Unit v1 tidak membaca
 * `slot.setup` (jalur v1 tidak berubah).
 */
import type {
  HeaderFooterSpec,
  NormUnit,
  NormUnitKind,
  ParamMap,
  ParamValue,
  ResolvedTemplate,
  SectionSetup,
  SlotSetup,
} from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { pageSizeFromPaper } from "../../tokens";
import { escapeXml, paramNumber, paramObject } from "./xml";

export type FullMargin = Required<NonNullable<SectionSetup["marginTw"]>>;

export interface ResolvedSectionSetup {
  pageSizeTw: [number, number];
  marginTw: FullMargin;
  cols?: { num: number; spaceTw: number };
  docGridLinePitch: number;
  titlePg: boolean;
  header: Exclude<HeaderFooterSpec, { mode: "inherit" }>;
  footer: Exclude<HeaderFooterSpec, { mode: "inherit" }>;
  /** `continuous` bila `slot.setup.startOnNewPage === false`; absen = halaman baru (bawaan Word). */
  startType?: "continuous";
}

export const BM_MARGIN_TW: FullMargin = { top: 1474, bottom: 1361, left: 1361, right: 1134, header: 737, footer: 737, gutter: 0 };
export const BM_COLS_SPACE_TW = 720;
export const BM_DOC_GRID_LINE_PITCH = 360;

/** Unit pembungkus (R-09) vs interior (R-10); KS-06 satu seksi per unit. */
export const WRAPPER_KINDS: ReadonlySet<NormUnitKind> = new Set(["cover", "controlSheet", "toc", "part"]);

/** Kunci parameter seksi slot (R-41). */
export const PARAM_SLOT_SETUP = "slot.setup";

export function mmToTw(mm: number): number {
  return Math.round((mm * 1440) / 25.4);
}

function pairMm(v: ParamValue | undefined): [number, number] | undefined {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number" && v[0] > 0 && v[1] > 0) {
    return [v[0], v[1]];
  }
  return undefined;
}

/**
 * Ukuran halaman (twip) dari peta parameter efektif: DV-01 `pageSizeFromPaper`
 * (`page.size`/`page.orientation`/`page.customSizeMm`), cadangan `page.sizeMm`.
 * Melempar BY_CONSTRUCTION_FAILED bila keduanya tidak terbaca (tanpa fallback A4).
 */
export function pageSizeTwFromParams(params: ParamMap): [number, number] {
  const mm = pageSizeFromPaper(params) ?? pairMm(params["page.sizeMm"]);
  if (!mm) {
    throw new StudioEngineError(
      "BY_CONSTRUCTION_FAILED",
      "Ukuran halaman tidak terbaca: page.size/page.orientation atau page.sizeMm wajib ada di parameter templat",
    );
  }
  return [mmToTw(mm[0]), mmToTw(mm[1])];
}

/**
 * Margin dari grid P4G (P4G-02 dalam -> kiri, P4G-06 luar -> kanan, P4G-12
 * `grid.topBottomMarginMm` -> atas (D-33), R-53 `grid.marginBottomMm` -> bawah)
 * bila ada; header/footer/gutter dan sisi yang tidak terbaca = BM.
 */
export function gridMarginTw(params: ParamMap): FullMargin {
  const side = (key: string, bm: number): number => {
    const mm = paramNumber(params, key);
    return mm !== undefined ? mmToTw(mm) : bm;
  };
  return {
    ...BM_MARGIN_TW,
    top: side("grid.topBottomMarginMm", BM_MARGIN_TW.top),
    bottom: side("grid.marginBottomMm", BM_MARGIN_TW.bottom),
    left: side("grid.innerMarginMm", BM_MARGIN_TW.left),
    right: side("grid.outerMarginMm", BM_MARGIN_TW.right),
  };
}

function asSetup(v: Record<string, unknown> | undefined): SectionSetup {
  return (v ?? {}) as SectionSetup;
}

const EMPTY_HF = { mode: "empty" } as const;

function concrete(
  explicit: HeaderFooterSpec | undefined,
  fromTpl: HeaderFooterSpec | undefined,
): Exclude<HeaderFooterSpec, { mode: "inherit" }> {
  if (explicit && explicit.mode !== "inherit") return explicit;
  if (fromTpl && fromTpl.mode !== "inherit") return fromTpl;
  return EMPTY_HF;
}

/** Unit sadar slot (NormUnitV2): memiliki `slotKey`. */
export function isSlotUnit(unit: object): unit is { slotKey: string } {
  return typeof (unit as { slotKey?: unknown }).slotKey === "string";
}

/** `slot.setup` (R-41) efektif unit sadar slot; `pageSizeTw` dibuang (kelas T, register R-41). */
export function slotSetupOf(unit: object, params: ParamMap): SlotSetup | undefined {
  if (!isSlotUnit(unit)) return undefined;
  const raw = paramObject(params, PARAM_SLOT_SETUP);
  if (!raw) return undefined;
  const { pageSizeTw: _ignored, ...rest } = raw as SectionSetup & SlotSetup;
  void _ignored;
  return rest as SlotSetup;
}

/** Unit yang dapat diselesaikan setup-nya (setup boleh absen untuk unit sintetis). */
export type SetupUnit = Pick<NormUnit, "kind"> & { setup?: SectionSetup; slotKey?: string };

/**
 * SectionSetup lengkap untuk satu unit. Prioritas medan: `slot.setup` (unit
 * sadar slot) > setup unit > param `render.section.wrapper|interior` > grid
 * P4G > BM. Ukuran halaman: setup unit v1 eksplisit, selain itu kenop
 * (`pageSizeTwFromParams`). Header/footer `inherit` diambil dari param
 * templat; bila templat juga `inherit`/kosong -> `empty`.
 */
export function resolveUnitSetup(unit: SetupUnit, tpl: ResolvedTemplate): ResolvedSectionSetup {
  const isWrapper = WRAPPER_KINDS.has(unit.kind);
  const tplSetup = asSetup(paramObject(tpl.params, isWrapper ? "render.section.wrapper" : "render.section.interior"));
  const slot = slotSetupOf(unit, tpl.params);
  const u = unit.setup ?? {};
  const s: SectionSetup = slot ? { ...u, ...stripSlotFields(slot) } : u;
  const grid = gridMarginTw(tpl.params);
  const margin: FullMargin = { ...grid, ...(tplSetup.marginTw ?? {}), ...(s.marginTw ?? {}) };
  // v1: setup unit eksplisit tetap berlaku; unit sadar slot selalu dari kenop (R-41).
  const page = !isSlotUnit(unit) && unit.setup?.pageSizeTw ? unit.setup.pageSizeTw : pageSizeTwFromParams(tpl.params);
  const cols = s.cols ?? tplSetup.cols;
  let headerExplicit = s.header;
  if (slot && slot.header === undefined && slot.runningHead !== undefined) {
    headerExplicit = slot.runningHead ? { mode: "runningHead" } : EMPTY_HF;
  }
  const out: ResolvedSectionSetup = {
    pageSizeTw: [page[0], page[1]],
    marginTw: margin,
    cols: cols ? { num: cols.num, spaceTw: cols.spaceTw } : undefined,
    docGridLinePitch: s.docGridLinePitch ?? tplSetup.docGridLinePitch ?? BM_DOC_GRID_LINE_PITCH,
    titlePg: s.titlePg ?? tplSetup.titlePg ?? false,
    header: concrete(headerExplicit, tplSetup.header ?? (isWrapper ? EMPTY_HF : { mode: "runningHead" })),
    footer: concrete(s.footer, tplSetup.footer ?? (isWrapper ? EMPTY_HF : { mode: "registerBlock" })),
  };
  if (slot?.startOnNewPage === false) out.startType = "continuous";
  return out;
}

function stripSlotFields(s: SlotSetup): SectionSetup {
  const { startOnNewPage: _a, runningHead: _b, ...rest } = s;
  void _a;
  void _b;
  return rest;
}

/** Lebar blok teks (twip) = lebar halaman - margin kiri - kanan (BM: 9411 = 166 mm). */
export function textWidthTw(s: { pageSizeTw: readonly [number, number]; marginTw?: SectionSetup["marginTw"] }): number {
  const m = s.marginTw ?? BM_MARGIN_TW;
  return s.pageSizeTw[0] - m.left - m.right;
}

function int(name: string, v: number, min: number, max: number): number {
  if (!Number.isFinite(v) || Math.round(v) < min || Math.round(v) > max) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `sectPr ${name} di luar rentang [${min}, ${max}]: ${v}`);
  }
  return Math.round(v);
}

/** R-80 (C26, RB-08c): mulai penomoran lembar; "bab1" = PAGE mulai 1 di seksi Bab 1, selain itu = "dokumen". */
export const PARAM_SHEET_NUMBERING = "device.registerBlock.sheetNumbering";

/**
 * True bila R-80 = "bab1"; absen, "dokumen", atau nilai tak dikenal = penomoran dokumen (tanpa `w:pgNumType`).
 * Row 122 (C40 FIX CP-11): the document language decides the edition (research/14 F4). ID Manual Rev A p.48:
 * "Sampul, lembar kendali, dan pembatas tidak bernomor. Penomoran lembar dimulai dari halaman pertama Bab 1",
 * so an ID document always restarts at Bab 1; EN p.50 "Sheets count from the cover" keeps R-80 (default "dokumen").
 * `language` absent = the R-80 value alone (behaviour before row 122).
 */
export function sheetNumberingFromChapter1(params: ParamMap, language?: "ID" | "EN"): boolean {
  return params[PARAM_SHEET_NUMBERING] === "bab1" || language === "ID";
}

export interface SectPrOptions {
  /** `w:pgNumType w:start` (C26): nomor halaman awal seksi; absen = lanjut dari seksi sebelumnya. */
  pgNumStart?: number;
}

/**
 * `w:sectPr` satu seksi (urutan CT_SectPr: headerReference, footerReference,
 * type, pgSz, pgMar, pgNumType, cols, titlePg, docGrid). Referensi header/footer bertipe
 * `default` (BM: 58 referensi default, 0 first/even). `pageSizeTw` wajib
 * (diselesaikan `resolveUnitSetup`). `w:orient` ditulis hanya bila lebar >
 * tinggi; `w:type continuous` hanya bila `startType` diisi; `w:pgNumType` hanya
 * bila `opts.pgNumStart` diisi.
 */
export function sectPrXml(
  s: SectionSetup & { startType?: ResolvedSectionSetup["startType"] },
  rel: { headerRId: string; footerRId: string },
  opts: SectPrOptions = {},
): string {
  if (!s.pageSizeTw) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "sectPr tanpa pageSizeTw: ukuran halaman wajib diselesaikan dari kenop page.size");
  }
  const [pw, ph] = s.pageSizeTw;
  const m: FullMargin = { ...BM_MARGIN_TW, ...(s.marginTw ?? {}) };
  const w = int("pgSz.w", pw, 1440, 31680);
  const h = int("pgSz.h", ph, 1440, 31680);
  const orient = w > h ? ` w:orient="landscape"` : "";
  let cols = `<w:cols w:space="${BM_COLS_SPACE_TW}"/>`;
  if (s.cols) {
    const num = int("cols.num", s.cols.num, 1, 45);
    const space = int("cols.space", s.cols.spaceTw, 0, 31680);
    cols = num > 1 ? `<w:cols w:num="${num}" w:space="${space}"/>` : `<w:cols w:space="${space}"/>`;
  }
  const refs =
    (rel.headerRId ? `<w:headerReference w:type="default" r:id="${escapeXml(rel.headerRId)}"/>` : "") +
    (rel.footerRId ? `<w:footerReference w:type="default" r:id="${escapeXml(rel.footerRId)}"/>` : "");
  return (
    `<w:sectPr>${refs}` +
    (s.startType === "continuous" ? `<w:type w:val="continuous"/>` : "") +
    `<w:pgSz w:w="${w}" w:h="${h}"${orient}/>` +
    `<w:pgMar w:top="${int("pgMar.top", m.top, -31680, 31680)}" w:right="${int("pgMar.right", m.right, 0, 31680)}" ` +
    `w:bottom="${int("pgMar.bottom", m.bottom, -31680, 31680)}" w:left="${int("pgMar.left", m.left, 0, 31680)}" ` +
    `w:header="${int("pgMar.header", m.header, 0, 31680)}" w:footer="${int("pgMar.footer", m.footer, 0, 31680)}" ` +
    `w:gutter="${int("pgMar.gutter", m.gutter, 0, 31680)}"/>` +
    (opts.pgNumStart !== undefined ? `<w:pgNumType w:start="${int("pgNumType.start", opts.pgNumStart, 0, 32767)}"/>` : "") +
    cols +
    (s.titlePg ? `<w:titlePg/>` : "") +
    `<w:docGrid w:linePitch="${int("docGrid.linePitch", s.docGridLinePitch ?? BM_DOC_GRID_LINE_PITCH, 0, 31680)}"/>` +
    `</w:sectPr>`
  );
}

/**
 * Paragraf pemegang sectPr di akhir unit (K-12, peran U11, KS-06): `sectPr`
 * menjadi anak terakhir `w:pPr`. `pPrInnerXml` = isi pPr peran U11 dari S20.
 */
export function sectionBreakParagraphXml(sectPr: string, pPrInnerXml = ""): string {
  return `<w:p><w:pPr>${pPrInnerXml}${sectPr}</w:pPr></w:p>`;
}
