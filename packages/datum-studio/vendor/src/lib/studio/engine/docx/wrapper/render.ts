/**
 * Pembangun fragmen + perangkat halaman + unsur halaman depan (S18).
 *
 * Satu `WrapperBuilder` per NormBlock pembungkus: mengumpulkan XML badan,
 * media (dedup per nama) dan menghitung wajah yang dipakai. Unsur
 * `FrontItem` (paragraf berperan, spacer, device, controlBlock, colophon,
 * signatureBlock, tabel) dirender di sini dengan format langsung; jenis blok
 * isi lain (list, aside, figur, ...) didelegasikan ke renderer pemiliknya
 * (S16/S19) pada saat panggil.
 */
import type {
  Block,
  Cell,
  CellParagraph,
  Colophon,
  ControlBlock,
  DeviceBlock,
  DocxBlockRenderer,
  DocxFragment,
  FrontItem,
  Inline,
  NormBlock,
  ParaFormat,
  ParagraphBlock,
  ParagraphRole,
  ProvenanceMark,
  RenderContext,
  Run,
  RunProps,
  SignatureBlock,
  TableBlock,
} from "../../../contract";
import { PROVENANCE_GLYPHS, TABLE_BLOCK_TYPES } from "../../../contract/enums";
import { StudioEngineError } from "../../../contract/errors";
import { FRONT_PAYLOAD_LABELS, issueStampTextOf, sealBandTextsOf, spineTextOf } from "../../front/texts";
import { docxBlocks } from "../blocks";
import { docxFigures } from "../figures";
import { resolveUnitSetup } from "../package/section";
import {
  mergePara,
  mergeRun,
  palette,
  paraOf,
  pBool,
  pNum,
  pStrList,
  roleFormat,
  textWidthTw,
  type CellFormat,
  type WrapperRole,
} from "./formats";
import {
  DEFAULT_LOGO_WIDTH_MM,
  inlineImageRunXml,
  loadDatumRule,
  loadLogo,
  mediaName,
  mediaRelId,
  WRAPPER_DOCPR_ID_BASE,
  type DecorativeKind,
  type LoadedImage,
  type MediaItem,
} from "./media";
import {
  facesInXml,
  inlinePlain,
  inlineRuns,
  isInlineEmpty,
  mmToTw,
  paragraphXml,
  runsXml,
  scaleCols,
  tableXml,
  textInline,
  type WCell,
  type WRow,
} from "./xml";

/** Konteks unit tempat unsur dirender (menentukan pemetaan peran). */
export type WrapperUnit = "cover" | "controlSheet" | "toc" | "part" | "appendix" | "signature";

// ── Pembangun fragmen ────────────────────────────────────────────────────

export class WrapperBuilder {
  private readonly parts: string[] = [];
  private readonly media = new Map<string, MediaItem>();
  private readonly extraFaces = new Set<string>();
  private pictures = 0;
  private logos = 0;

  constructor(
    readonly ctx: RenderContext,
    readonly block: NormBlock,
    readonly unit: WrapperUnit,
  ) {}

  get params() {
    return this.ctx.tpl.params;
  }

  get lang(): "ID" | "EN" {
    return this.ctx.snapshot.doc.meta.language === "EN" ? "EN" : "ID";
  }

  textWidthTw(): number {
    return textWidthTw(this.ctx, this.block.unitKey);
  }

  push(xml: string): void {
    if (xml) this.parts.push(xml);
  }

  warn(message: string, code?: string): void {
    this.ctx.log({ level: "warn", message, code, address: this.block.address ?? undefined, at: `docx/wrapper:${this.block.type}` });
  }

  /** Run gambar inline (aparatus dekoratif, FIX-HZ2); media didaftarkan sekali per nama. */
  imageRun(img: LoadedImage, widthMm: number, heightMm: number, decorative: DecorativeKind = "ornament"): string {
    const name = mediaName(img.data, img.ext);
    if (!this.media.has(name)) this.media.set(name, { name, data: img.data, contentType: img.contentType });
    this.pictures += 1;
    if (this.pictures > 15) this.warn("lebih dari 15 gambar dalam satu blok pembungkus; id wp:docPr dapat bertabrakan", "BY_CONSTRUCTION_FAILED");
    return inlineImageRunXml({
      relId: mediaRelId(name),
      name,
      widthMm,
      heightMm,
      docPrId: WRAPPER_DOCPR_ID_BASE + this.block.ordinal * 16 + this.pictures,
      decorative,
      lang: this.lang,
    });
  }

  /** Logo hanya sekali per dokumen dan hanya di sampul (P4V-04, DT-14). */
  claimLogo(): boolean {
    const max = pNum(this.params, "cover.logo.maxOccurrencesPerDocument") ?? 1;
    if (this.unit !== "cover" || this.logos >= max) return false;
    this.logos += 1;
    return true;
  }

  mergeFragment(f: DocxFragment): void {
    this.push(f.xml);
    for (const m of f.media ?? []) if (!this.media.has(m.name)) this.media.set(m.name, m);
    for (const face of f.facesUsed ?? []) this.extraFaces.add(face);
  }

  fragment(): DocxFragment {
    const xml = this.parts.join("");
    const faces = new Set([...facesInXml(xml), ...this.extraFaces]);
    const media = [...this.media.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { xml, media: media.length > 0 ? media : undefined, facesUsed: [...faces].sort() };
  }
}

// ── Paragraf ─────────────────────────────────────────────────────────────

const GLYPH_RE = /[■◈◇△]/;
const GLYPH_TO_MARK: Readonly<Record<string, ProvenanceMark>> = Object.fromEntries(
  (Object.entries(PROVENANCE_GLYPHS) as Array<[ProvenanceMark, string]>).map(([m, g]) => [g, m]),
);

/**
 * Pisahkan glif provenans di run teks tanpa wajah eksplisit ke run ber-`glyphRun`
 * (pernyataan metode K-17: Serif + glif DejaVu RS11). Run ber-`face` dibiarkan
 * apa adanya (C1: runs verbatim).
 */
function splitGlyphs(runs: readonly Run[], glyph: Partial<Record<ProvenanceMark, RunProps>> | undefined): Run[] {
  if (!glyph) return [...runs];
  const out: Run[] = [];
  for (const r of runs) {
    // Run konten-saja (RT-01): glif bertanda `faceRole: symbolGlyph` juga memakai glyphRun peran.
    if (!("t" in r) || r.face || (r.faceRole && r.faceRole !== "symbolGlyph") || !GLYPH_RE.test(r.t)) {
      out.push(r);
      continue;
    }
    const { t, faceRole, ...props } = r;
    for (const piece of t.split(/([■◈◇△])/)) {
      if (piece === "") continue;
      const mark = GLYPH_TO_MARK[piece];
      out.push(mark && glyph[mark] ? { ...props, ...glyph[mark], t: piece } : { ...props, ...(faceRole ? { faceRole } : {}), t: piece });
    }
  }
  return out;
}

/** Paragraf berperan: format = peran <- eksplisit; run = peran <- runDefaults <- run. */
export function roleParagraphXml(
  b: WrapperBuilder,
  role: WrapperRole,
  inline: Inline | undefined,
  explicit?: { format?: ParaFormat; runDefaults?: RunProps },
): string {
  const rf = roleFormat(b.ctx, role);
  const fmt = mergePara(rf.para, explicit?.format);
  const base = mergeRun(rf.run, explicit?.runDefaults) ?? {};
  const runs = role === "controlSheet.methodStatement" ? splitGlyphs(inlineRuns(inline), rf.glyphRun) : inlineRuns(inline);
  return paragraphXml(fmt, runsXml(runs, base, b.params));
}

function paragraphRoleFor(unit: WrapperUnit, role: ParagraphRole | undefined, titleIndex: { index: number; count: number }): WrapperRole {
  switch (role) {
    case "kicker":
      return unit === "controlSheet" || unit === "toc" ? "front.kicker" : unit === "appendix" ? "chapter.kicker" : "wrapper.kicker";
    case "title":
      if (unit === "cover") return titleIndex.index === titleIndex.count - 1 ? "cover.titleLast" : "cover.titleFirst";
      if (unit === "part") return "part.title";
      if (unit === "toc") return "toc.title";
      if (unit === "appendix") return "chapter.title";
      return "front.pageTitle";
    case "pageTitle":
      return unit === "toc" ? "toc.title" : "front.pageTitle";
    case "blockHeading":
      return "controlSheet.blockHeading";
    case "methodStatement":
      return "controlSheet.methodStatement";
    case "addressLine":
      return "cover.addressLine";
    case "standfirst":
      return "cover.standfirst";
    case "scopeLine":
      return "cover.scopeLine";
    case "identity":
      return unit === "cover" ? "cover.identityString" : "body.paragraph";
    case "lede":
      return unit === "part" ? "part.lede" : unit === "cover" ? "cover.standfirst" : "body.paragraph";
    case "note":
      return unit === "toc" ? "toc.note" : "body.paragraph";
    default:
      return "body.paragraph";
  }
}

// ── Sel dan tabel ────────────────────────────────────────────────────────

/** Paragraf sel: `paragraphs` (kosong [] -> `<w:p/>`), `text`, atau `runs`. */
export function cellParagraphsXml(b: WrapperBuilder, cell: Pick<Cell, "paragraphs" | "text" | "runs">, para: ParaFormat | undefined, run: RunProps): string {
  let paras: CellParagraph[];
  if (cell.paragraphs) paras = cell.paragraphs;
  else if (cell.runs) paras = [{ runs: cell.runs }];
  else if (cell.text !== undefined) paras = [{ text: cell.text }];
  else paras = [];
  if (paras.length === 0) return "<w:p/>";
  return paras.map((p) => paragraphXml(mergePara(para, p.format), runsXml(inlineRuns(p), run, b.params))).join("");
}

function cellFmt(explicit: Pick<Cell, "borders" | "marginsTw" | "shading">, role: CellFormat | undefined): CellFormat {
  return {
    borders: explicit.borders ?? role?.borders,
    marginsTw: explicit.marginsTw ?? role?.marginsTw,
    shading: explicit.shading ?? role?.shading,
  };
}

/** Lebar kolom: widthTw / widthMm / sisa dibagi rata dari lebar total. */
function columnWidths(t: TableBlock, totalTw: number): number[] {
  const given = t.columns.map((c) => c.widthTw ?? (c.widthMm !== undefined ? mmToTw(c.widthMm) : undefined));
  const known = given.reduce<number>((a, w) => a + (w ?? 0), 0);
  const unknown = given.filter((w) => w === undefined).length;
  if (unknown === 0) return given as number[];
  const each = Math.max(1, Math.floor(Math.max(0, totalTw - known) / unknown));
  return given.map((w) => w ?? each);
}

/** Peran sel tabel menurut unit (lembar kendali U37/U38; lainnya sama). */
function tableRoles(unit: WrapperUnit): { header: WrapperRole; body: WrapperRole; mono: WrapperRole } {
  if (unit === "part") return { header: "controlTable.header", body: "part.chapterTitle", mono: "part.chapterNo" };
  return { header: "controlTable.header", body: "controlTable.cell", mono: "cover.controlValue" };
}

/**
 * Tabel di halaman pembungkus (riwayat revisi, rantai verifikasi, distribusi,
 * daftar bab override) dengan format langsung TP-01 + TCP-06/07; nilai sel
 * eksplisit (C12) menang atas peran.
 */
export function frontTableXml(b: WrapperBuilder, t: TableBlock & { runDefaults?: RunProps }): void {
  const roles = tableRoles(b.unit);
  const header = roleFormat(b.ctx, roles.header);
  const body = roleFormat(b.ctx, roles.body);
  const mono = roleFormat(b.ctx, roles.mono);
  const grid = columnWidths(t, t.layout?.widthTw ?? b.textWidthTw());
  if (t.caption) {
    const cap = roleFormat(b.ctx, "caption");
    const label = t.caption.label ? runsXml([{ t: t.caption.label + (t.caption.separator ?? " ") }], mergeRun(cap.labelRun, t.caption.labelProps) ?? {}, b.params) : "";
    b.push(paragraphXml(mergePara(cap.para, t.caption.format), label + runsXml(inlineRuns(t.caption.inline), cap.run ?? {}, b.params)));
  }
  const rows: WRow[] = t.rows.map((row) => {
    const isHeader = row.kind === "header";
    let col = 0;
    const cells: WCell[] = row.cells.map((cell) => {
      const span = Math.max(1, cell.gridSpan ?? 1);
      const spec = t.columns[col];
      const width = cell.widthTw ?? grid.slice(col, col + span).reduce((a, w) => a + w, 0);
      col += span;
      const isMono = !isHeader && (spec?.role === "id" || spec?.role === "numeral");
      const rf = isHeader ? header : body;
      let para = rf.para;
      if (spec?.align === "right" || spec?.align === "center") para = { ...para, jc: spec.align };
      const run = mergeRun(isMono ? mono.run : rf.run, t.runDefaults) ?? {};
      if (cell.nested) b.warn("tabel bersarang di halaman pembungkus tidak didukung; sel bersarang dilewati", "BY_CONSTRUCTION_FAILED");
      return {
        widthTw: width,
        gridSpan: span > 1 ? span : undefined,
        vMerge: cell.vMerge,
        vAlign: cell.vAlign,
        ...cellFmt(cell, rf.cell),
        paragraphsXml: cellParagraphsXml(b, cell, para, run),
      };
    });
    return { cells, cantSplit: row.cantSplit, repeatHeader: row.repeatHeader };
  });
  b.push(tableXml(grid, rows, { indentTw: t.layout?.indentTw }));
  if (t.source) {
    const src = roleFormat(b.ctx, "figure.source");
    b.push(paragraphXml(mergePara(src.para, t.source.format), runsXml(inlineRuns(t.source.inline), src.run ?? {}, b.params)));
  }
}

// ── Perangkat halaman ────────────────────────────────────────────────────

/**
 * Teks pita segel bawaan: P4V-14 `wrapper.header` dengan {kelas}; kanan = copyControl (satu sumber `front/texts.ts`).
 * S15: bawaan berbahasa (EN bila bahasa EN dan param = bawaan registri).
 */
export function sealBandTexts(b: WrapperBuilder): [string, string] {
  return sealBandTextsOf(b.ctx.snapshot.doc.meta, b.params, b.lang);
}

function sealBandXml(b: WrapperBuilder, d: DeviceBlock): void {
  const [lt, rt] = sealBandTexts(b);
  const rf = roleFormat(b.ctx, "wrapper.sealBand");
  const grid = scaleCols([4706, 4706], b.textWidthTw());
  const run = rf.run ?? {};
  const left: WCell = {
    widthTw: grid[0],
    ...cellFmt({}, rf.cell),
    paragraphsXml: paragraphXml(mergePara(rf.para, { jc: "left", ...d.format }), runsXml(inlineRuns(d.left ?? textInline(lt)), run, b.params)),
  };
  // TCP-02: sel kanan tanpa margin kiri, rata kanan.
  const rightCell = cellFmt({}, rf.cell);
  const right: WCell = {
    widthTw: grid[1],
    ...rightCell,
    marginsTw: rightCell.marginsTw ? { ...rightCell.marginsTw, left: 0 } : undefined,
    paragraphsXml: paragraphXml(mergePara(rf.para, { jc: "right", ...d.format }), runsXml(inlineRuns(d.right ?? textInline(rt)), run, b.params)),
  };
  b.push(tableXml(grid, [{ cells: [left, right] }]));
}

/** Cap terbit P4S-26 (`device.issueStamp.format`; S13: format bawaan berbahasa, EN "-- ISSUE {n}"). */
export function issueStampText(b: WrapperBuilder): string {
  // FIX-2 (O-3): satu sumber bersama HTML (engine/front/texts).
  return issueStampTextOf(b.ctx.snapshot.doc.meta, b.params, b.lang);
}

/** String punggung P4S-24: jenis, subjek, bahasa, revisi, bulan, tahun (FIX-F D-314: satu sumber bersama HTML, engine/front/texts). */
export function spineText(b: WrapperBuilder): string {
  return spineTextOf(b.ctx.snapshot.doc.meta, b.params);
}

// ── String punggung berputar (P4S-23, IP-13/F-026) ─────────────────────

/** Lebar kolom punggung (twip) = satu baris K-11 (180 tw exact) + kelonggaran. */
const SPINE_COL_TW = 240;
/** Lebar glif Mono (em) untuk perkiraan panjang string punggung. */
const MONO_ADVANCE_EM = 0.6;
const SPINE_PAD_TW = 120;

/**
 * String punggung. `device.spine.rotationDeg` = 90 (bawaan katalog P4S-23):
 * tabel mengambang 1x1 di margin luar (kanan, halaman recto) dengan
 * `w:textDirection tbRl` (= `writing-mode: vertical-rl` mesin HTML), tinggi
 * baris tepat = perkiraan panjang string (Mono 0,6 em + spasi run), dibatasi
 * tinggi area teks. Nilai 0 = paragraf mendatar (pola python-docx/BM).
 */
export function spineXml(b: WrapperBuilder, text: Inline, format?: ParaFormat): string {
  const rotation = pNum(b.params, "device.spine.rotationDeg") ?? 90;
  if (rotation !== 90) return roleParagraphXml(b, "cover.identityString", text, { format });

  const rf = roleFormat(b.ctx, "cover.identityString");
  const run = rf.run ?? {};
  // Dalam bingkai berputar, spasi sebelum/sesudah menggeser teks melintang; dinolkan.
  const para = roleParagraphXml(b, "cover.identityString", text, { format: { ...format, spacingBeforeTw: 0, spacingAfterTw: 0, jc: "left" } });

  // Setup seksi unit: satu sumber ukuran halaman dan margin (`resolveUnitSetup`:
  // setup unit/slot > templat > grid, ukuran dari kenop page.size; KC-7, tanpa
  // fallback A4). Unit tidak ditemukan = setup pembungkus (string punggung milik sampul).
  const unit = b.ctx.snapshot.units.find((u) => u.key === b.block.unitKey);
  const setup = resolveUnitSetup(unit ?? { kind: "cover" }, b.ctx.tpl);
  const [pageW, pageH] = setup.pageSizeTw;
  const m = setup.marginTw;
  const right = m.right;
  const areaH = pageH - m.top - m.bottom;
  const sizeTw = (run.szHalfPt ?? Math.round((pNum(b.params, "device.spine.sizePt") ?? 6) * 2)) * 10;
  const perChar = sizeTw * MONO_ADVANCE_EM + (run.spacingTw ?? 0);
  const chars = [...inlinePlain(text)].length;
  const heightTw = Math.max(567, Math.min(areaH, Math.round(chars * perChar + 2 * SPINE_PAD_TW)));
  const x = Math.max(0, Math.round(pageW - right / 2 - SPINE_COL_TW / 2));
  const none = `w:val="none" w:sz="0" w:space="0" w:color="auto"`;
  const tblBorders = ["top", "left", "bottom", "right", "insideH", "insideV"].map((k) => `<w:${k} ${none}/>`).join("");
  return (
    `<w:tbl><w:tblPr>` +
    `<w:tblpPr w:leftFromText="0" w:rightFromText="0" w:topFromText="0" w:bottomFromText="0" w:vertAnchor="margin" w:horzAnchor="page" w:tblpX="${x}" w:tblpY="0"/>` +
    `<w:tblOverlap w:val="never"/>` +
    `<w:tblW w:w="${SPINE_COL_TW}" w:type="dxa"/><w:tblBorders>${tblBorders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>` +
    `<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="${SPINE_COL_TW}"/></w:tblGrid>` +
    `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${heightTw}" w:hRule="exact"/></w:trPr>` +
    `<w:tc><w:tcPr><w:tcW w:w="${SPINE_COL_TW}" w:type="dxa"/><w:textDirection w:val="tbRl"/><w:vAlign w:val="top"/></w:tcPr>${para}</w:tc></w:tr></w:tbl>`
  );
}

function datumRuleRoleFor(unit: WrapperUnit): WrapperRole {
  return unit === "appendix" ? "chapter.datumRule" : "wrapper.datumRule";
}

/**
 * Lebar Datum Rule turunan: kolom teks (bab/lampiran) atau `cover.datumRule.widthMm` /
 * bentang penuh (pembungkus). Absen = BY_CONSTRUCTION_FAILED (D-245 H1, tanpa cadangan literal A4).
 */
function datumRuleWidthMm(b: WrapperBuilder, interior: boolean): number {
  const keys = interior ? ["grid.textColumnMm"] : ["cover.datumRule.widthMm", "grid.fullSpanMm"];
  for (const k of keys) {
    const v = pNum(b.params, k);
    if (v !== undefined) return v;
  }
  throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Lebar Datum Rule tidak terbaca: ${keys.join(" / ")} wajib ada di parameter templat`, { keys });
}

/** Paragraf Datum Rule (K-04 bentang penuh pembungkus, K-24 kolom teks bab/lampiran; A4 166/128 mm). */
export function datumRuleParagraphXml(b: WrapperBuilder, d: Partial<DeviceBlock> = {}): string {
  const c = palette(b.params);
  const interior = b.unit === "appendix";
  const widthMm = d.widthMm ?? datumRuleWidthMm(b, interior);
  const rule = loadDatumRule(b.ctx, widthMm, interior ? c.interiorInk : c.ink, d.asset);
  const heightMm = d.heightMm ?? rule.heightMm;
  return paragraphXml(paraOf(b.ctx, datumRuleRoleFor(b.unit), d.format), b.imageRun(rule.img, rule.widthMm, heightMm, "datumRule"));
}

export function deviceXml(b: WrapperBuilder, d: DeviceBlock): void {
  switch (d.device) {
    case "sealBand":
      sealBandXml(b, d);
      return;
    case "logo": {
      if (!b.claimLogo()) {
        b.warn("logo dilewati: hanya sekali per dokumen dan hanya di sampul (P4V-04)", "BY_CONSTRUCTION_FAILED");
        return;
      }
      const img = loadLogo(b.ctx, d.asset);
      const widthMm = d.widthMm ?? DEFAULT_LOGO_WIDTH_MM;
      const heightMm = d.heightMm ?? (img.widthPx && img.heightPx ? (widthMm * img.heightPx) / img.widthPx : widthMm / 2);
      b.push(paragraphXml(paraOf(b.ctx, "cover.logo", d.format), b.imageRun(img, widthMm, heightMm, "logo")));
      return;
    }
    case "hairline":
      b.push(paragraphXml(paraOf(b.ctx, "cover.hairline", d.format)));
      return;
    case "datumRule":
      b.push(datumRuleParagraphXml(b, d));
      return;
    case "spineString": {
      const text = d.text ?? { runs: [{ t: spineText(b), caps: true }] };
      b.push(spineXml(b, text, d.format));
      return;
    }
    case "issueStamp": {
      const rf = roleFormat(b.ctx, "cover.colophonRight");
      const text = d.text ?? textInline(issueStampText(b));
      b.push(paragraphXml(mergePara(rf.para, d.format), runsXml(inlineRuns(text), rf.run ?? {}, b.params)));
      return;
    }
  }
}

// ── Blok kendali, kolofon, tanda tangan ──────────────────────────────────

/** Blok kendali sampul T002 (KT-03/KT-04, TCP-03/04): 4 sel per baris. */
export function controlBlockXml(b: WrapperBuilder, cb: ControlBlock): void {
  const label = roleFormat(b.ctx, "cover.controlLabel");
  const value = roleFormat(b.ctx, "cover.controlValue");
  const c = palette(b.params);
  const grid = cb.colsTw && cb.colsTw.length === 4 ? cb.colsTw.map((w) => Math.round(w)) : scaleCols([1814, 3175, 1474, 2948], b.textWidthTw());
  const rows: WRow[] = cb.rows.map((row, ri) =>
    ({
      cells: row.map((inline, ci) => {
        const rf = ci % 2 === 0 ? label : value;
        const fmt = cellFmt({}, rf.cell);
        // TCP-03: baris pertama bergaris atas tinta 0,44 mm.
        if (ri === 0 && !fmt.borders?.top) fmt.borders = { ...fmt.borders, top: { val: "single", sz: 10, color: c.ink, space: 0 } };
        return { widthTw: grid[ci], ...fmt, paragraphsXml: paragraphXml(rf.para, runsXml(inlineRuns(inline), rf.run ?? {}, b.params)) };
      }),
    }),
  );
  b.push(tableXml(grid, rows));
}

/** Kolofon sampul T003 (KT-05/06, TCP-05): entitas + NIB | cap terbit. */
export function colophonXml(b: WrapperBuilder, col: Colophon): void {
  const left = roleFormat(b.ctx, "cover.colophonLeft");
  const right = roleFormat(b.ctx, "cover.colophonRight");
  const grid = scaleCols([4706, 4706], b.textWidthTw());
  b.push(
    tableXml(grid, [
      {
        cells: [
          { widthTw: grid[0], ...cellFmt({}, left.cell), paragraphsXml: paragraphXml(left.para, runsXml(inlineRuns(col.left), left.run ?? {}, b.params)) },
          { widthTw: grid[1], ...cellFmt({}, right.cell), paragraphsXml: paragraphXml(right.para, runsXml(inlineRuns(col.right), right.run ?? {}, b.params)) },
        ],
      },
    ]),
  );
}

/** Tiga peran tanda tangan manual, urutan kolom (ID:2501, EN:2570; label = tabel teks, bukan `controlSheet.signatures.roles`). */
const SIGNATURE_FILL_KEYS = ["made", "checked", "approved"] as const;

const roleKeyText = (s: string): string => s.trim().toLowerCase();

/**
 * C09 / CS-06 (R-68, opt-in): selalu tiga kolom tanda tangan. Peran kiriman yang labelnya sama dengan label
 * tabel teks (ID atau EN, tanpa beda huruf) menempati kolomnya; peran lain mengisi kolom kosong pertama dari
 * kiri; kolom sisa = label bawaan bahasa dokumen dengan pemegang kosong (garis pemegang tetap tergambar).
 * Tiga peran atau lebih: tidak diubah.
 */
export function filledSignature(s: SignatureBlock, lang: "ID" | "EN"): SignatureBlock {
  if (s.roles.length >= SIGNATURE_FILL_KEYS.length) return s;
  const slots: Array<SignatureBlock["roles"][number] | undefined> = SIGNATURE_FILL_KEYS.map(() => undefined);
  const rest: SignatureBlock["roles"][number][] = [];
  for (const r of s.roles) {
    const t = roleKeyText(inlinePlain(r.role));
    const i = SIGNATURE_FILL_KEYS.findIndex((k) => roleKeyText(FRONT_PAYLOAD_LABELS[k].ID) === t || roleKeyText(FRONT_PAYLOAD_LABELS[k].EN) === t);
    if (i >= 0 && !slots[i]) slots[i] = r;
    else rest.push(r);
  }
  for (const r of rest) slots[slots.findIndex((x) => !x)] = r;
  const roles = slots.map((r, i) => r ?? { role: textInline(FRONT_PAYLOAD_LABELS[SIGNATURE_FILL_KEYS[i]][lang]), holder: { runs: [] } });
  // Lebar kolom kiriman hanya berlaku untuk jumlah kolom kiriman.
  const { colsTw: _cols, ...keep } = s;
  void _cols;
  return { ...keep, roles };
}

/**
 * Blok tanda tangan T008 (C7/G-03): baris peran (KT-07, TCP-08), baris ruang
 * tanda tangan kosong (KT-09 `signRowFormat`, TCP-09), baris pemegang (KT-08,
 * TCP-10), dan baris tanggal opsional bila ada `date`.
 */
export function signatureXml(b: WrapperBuilder, block: SignatureBlock): void {
  const s = pBool(b.params, "controlSheet.signatures.fillRoles", false) ? filledSignature(block, b.lang) : block;
  const n = s.roles.length;
  if (n === 0) {
    b.warn("signatureBlock tanpa peran dilewati", "SCHEMA_INVALID");
    return;
  }
  const total = b.textWidthTw();
  const grid =
    s.colsTw && s.colsTw.length === n ? s.colsTw.map((w) => Math.round(w)) : scaleCols(n === 3 ? [3118, 3175, 3118] : Array.from({ length: n }, () => 1), total);
  const head = roleFormat(b.ctx, "controlTable.header");
  const space = roleFormat(b.ctx, "signature.space");
  const holder = roleFormat(b.ctx, "controlTable.cell");
  const c = palette(b.params);
  const rightPad = space.cell?.marginsTw?.right ?? 226;
  const rows: WRow[] = [
    {
      cells: s.roles.map((r, i) => ({
        widthTw: grid[i],
        marginsTw: { top: 113, left: 0, bottom: 0, right: rightPad },
        paragraphsXml: paragraphXml(head.para, runsXml(inlineRuns(r.role), head.run ?? {}, b.params)),
      })),
    },
    {
      cells: s.roles.map((_r, i) => ({
        widthTw: grid[i],
        ...cellFmt({}, space.cell),
        paragraphsXml: paragraphXml(mergePara(space.para, s.signRowFormat)),
      })),
    },
    {
      cells: s.roles.map((r, i) => ({
        widthTw: grid[i],
        borders: { top: { val: "single", sz: 5, color: c.rule, space: 0 } },
        marginsTw: { top: 79, left: 0, bottom: 0, right: rightPad },
        paragraphsXml: paragraphXml(holder.para, runsXml(inlineRuns(r.holder), holder.run ?? {}, b.params)),
      })),
    },
  ];
  if (s.roles.some((r) => r.date && !isInlineEmpty(r.date))) {
    rows.push({
      cells: s.roles.map((r, i) => ({
        widthTw: grid[i],
        marginsTw: { top: 40, left: 0, bottom: 0, right: rightPad },
        paragraphsXml: r.date ? paragraphXml(holder.para, runsXml(inlineRuns(r.date), holder.run ?? {}, b.params)) : "<w:p/>",
      })),
    });
  }
  b.push(tableXml(grid, rows));
}

// ── Dispatcher unsur halaman depan ───────────────────────────────────────

const TABLE_TYPES: ReadonlySet<string> = new Set(TABLE_BLOCK_TYPES);

/** Delegasi blok isi non-pembungkus ke renderer pemiliknya (S16/S19). */
function delegateBlock(b: WrapperBuilder, item: Block, index: number): void {
  const renderers = { ...docxBlocks, ...docxFigures } as Partial<Record<string, DocxBlockRenderer>>;
  const r = renderers[item.type];
  if (!r) {
    b.ctx.log({
      level: "error",
      code: "BY_CONSTRUCTION_FAILED",
      message: `blok "${item.type}" di halaman pembungkus tidak punya renderer DOCX; dilewati`,
      address: b.block.address ?? undefined,
      at: "docx/wrapper",
    });
    return;
  }
  const synthetic: NormBlock = {
    blockId: item.blockId ?? `${b.block.blockId}.front${index}`,
    address: null,
    ordinal: b.block.ordinal,
    unitKey: b.block.unitKey,
    type: item.type,
    content: item,
    textPlain: "",
    contentSha256: "",
  };
  b.mergeFragment(r(synthetic, b.ctx));
}

/** Render daftar FrontItem berurutan (mode explicit atau hasil susun mode auto). */
export function frontItemsXml(b: WrapperBuilder, items: readonly FrontItem[]): void {
  const titleCount = items.filter((i) => i.type === "paragraph" && (i as ParagraphBlock).role === "title").length;
  let titleSeen = 0;
  items.forEach((item, idx) => {
    switch (item.type) {
      case "spacer":
        b.push(paragraphXml(item.format));
        return;
      case "device":
        deviceXml(b, item);
        return;
      case "controlBlock":
        controlBlockXml(b, item);
        return;
      case "colophon":
        colophonXml(b, item);
        return;
      case "signatureBlock":
        signatureXml(b, item);
        return;
      case "paragraph": {
        const p = item as ParagraphBlock;
        const tIndex = p.role === "title" ? titleSeen++ : 0;
        const role = paragraphRoleFor(b.unit, p.role, { index: tIndex, count: titleCount });
        if (p.rail && p.rail.length > 0) b.warn("rel bukti pada paragraf pembungkus diabaikan", "BY_CONSTRUCTION_FAILED");
        b.push(roleParagraphXml(b, role, p, { format: p.format, runDefaults: p.runDefaults }));
        return;
      }
      default:
        if (TABLE_TYPES.has(item.type)) {
          frontTableXml(b, item as TableBlock & { runDefaults?: RunProps });
          return;
        }
        delegateBlock(b, item as Block, idx);
    }
  });
}

/** Paragraf role dari Inline (pembantu susun mode auto). */
export function paraItem(role: ParagraphRole, inline: Inline, format?: ParaFormat): ParagraphBlock {
  return { type: "paragraph", role, ...inline, ...(format ? { format } : {}) } as ParagraphBlock;
}

export function hasText(i: Inline | undefined): i is Inline {
  return !!i && !isInlineEmpty(i);
}

export { inlinePlain, pBool, pStrList };
