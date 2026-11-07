/**
 * Renderer halaman pembungkus (S18, I07): cover, controlSheet, toc,
 * partDivider, signatureBlock, appendix (pembuka lampiran).
 *
 * Isi NormBlock (`block.content`) per kunci:
 *   cover / controlSheet -> FrontPage;  toc -> TocSpec;  partDivider -> PartSpec;
 *   signatureBlock -> SignatureBlock;   appendix -> Chapter (hanya pembuka:
 *   kicker, Datum Rule 128, judul; intro dan seksi dirender renderer
 *   chapter/section S16).
 * Renderer tidak menulis paragraf pemegang sectPr (K-12, KS-06): itu milik
 * perakit S20 yang menutup setiap unit.
 *
 * Urutan unsur mengikuti konvensi benchmark S93 (doc.json x.benchmark):
 * C5 PartSpec = body[] -> label -> title -> lede -> daftar bab;
 * C6 TocSpec = sealBand -> kicker -> title -> tabel entri -> note;
 * C7 SignatureBlock = baris peran, ruang tanda tangan, pemegang.
 */
import type {
  Chapter,
  Colophon,
  ControlBlock,
  ControlSheetData,
  CoverData,
  DeviceBlock,
  DocxBlockRenderer,
  DocxFragment,
  FrontItem,
  FrontPage,
  Inline,
  NormBlock,
  ParaFormat,
  ParamMap,
  PartSpec,
  RenderContext,
  RunProps,
  SignatureBlock,
  StudioDocV1,
  TableBlock,
  TocEntry,
  TocSpec,
} from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { explicitCoverApparatus } from "../../front/apparatus";
import {
  WRAPPER_TEXT as L,
  appendixOpenerKickerText,
  chapterLabelText,
  colophonTexts,
  CONTROL_FIELD_SHEETS_FIELD,
  controlBlockRowsText,
  controlRowsWithClassificationLine,
  controlSheetTemplateData,
  normalizedIssueStampText,
  verificationSummaryText,
  CONTROL_SHEET_COLUMN_LABELS,
  controlSheetBlockHeading,
  controlSheetColumnHeads,
  controlSheetKickerText,
  defaultPartLabelText,
  kickerSuppressed,
  tocKickerText,
  type ControlSheetBlockKind,
} from "../../front/texts";
import { railK2ReserveOf } from "../blocks/rail";
import { paraOf, pStr, roleFormat, type WrapperRole } from "./formats";
import {
  datumRuleParagraphXml,
  frontItemsXml,
  hasText,
  paraItem,
  pBool,
  pStrList,
  roleParagraphXml,
  sealBandTexts,
  signatureXml,
  spineText,
  spineXml,
  WrapperBuilder,
  type WrapperUnit,
} from "./render";
import {
  bookmarkParagraph,
  chapterTocTargetOf,
  hasDerivedToc,
  pageRefRunsXml,
  partTocTarget,
  tocEntryRoles,
  tocLevelsOf,
  tocOutline,
  tocOutlineRange,
  type TocTarget,
} from "./toc-refs";
import { inlinePlain, inlineRuns, paragraphXml, runsXml, scaleCols, tableXml, textInline, type WRow } from "./xml";

// ── Pembantu ─────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function contentOf<T>(block: NormBlock, key: string, guard: (v: Record<string, unknown>) => boolean): T {
  const c = block.content;
  if (!isObj(c) || !guard(c)) {
    throw new StudioEngineError("SCHEMA_INVALID", `isi blok pembungkus "${key}" tidak sesuai bentuk kontrak`, {
      blockId: block.blockId,
      type: block.type,
    });
  }
  return c as T;
}

function build(ctx: RenderContext, block: NormBlock, unit: WrapperUnit, fill: (b: WrapperBuilder) => void): DocxFragment {
  const b = new WrapperBuilder(ctx, block, unit);
  fill(b);
  return b.fragment();
}

function sealBandItem(b: WrapperBuilder): DeviceBlock | undefined {
  return pBool(b.params, "device.sealBand.enabled", true) ? { type: "device", device: "sealBand" } : undefined;
}

function rulePlaced(b: WrapperBuilder, where: "sampul" | "pembatas" | "atas judul bab"): boolean {
  return pBool(b.params, "device.datumRule.enabled", true) && pStrList(b.params, "device.datumRule.placements", ["atas judul bab", "sampul", "pembatas"]).includes(where);
}

function spinePlacedIn(p: ParamMap, where: "margin luar sampul" | "pembatas" | "sampul belakang"): boolean {
  return pBool(p, "device.spine.enabled", true) && pStrList(p, "device.spine.placements", ["margin luar sampul", "pembatas"]).includes(where);
}

function spinePlaced(b: WrapperBuilder, where: "margin luar sampul" | "pembatas"): boolean {
  return spinePlacedIn(b.params, where);
}

/**
 * C12 / CV-19 (opt-in nilai enum `sampul belakang` di `device.spine.placements`, register research/38 §2):
 * dokumen mendapat halaman sampul belakang berisi string punggung. Perencana unit memakai predikat ini
 * DAN mensyaratkan unit sampul di rencana (register §4.1: tanpa sampul, mis. NOTA, tanpa sampul belakang).
 */
export function backCoverPlaced(params: ParamMap): boolean {
  return spinePlacedIn(params, "sampul belakang");
}

// FIX-2 (F-055): teks bawaan pembungkus (tabel `L`) = satu sumber bersama HTML di `engine/front/texts.ts`.

/** Kunci bab/lampiran efektif (default posisi: 1..n, A..Z). */
function chapterKey(list: readonly Chapter[], ch: Chapter, appendix: boolean): string {
  if (ch.key) return ch.key;
  const i = list.indexOf(ch);
  return appendix ? String.fromCharCode(65 + Math.max(0, i)) : String(Math.max(0, i) + 1);
}

function findChapter(doc: StudioDocV1, key: string): { ch: Chapter; appendix: boolean } | undefined {
  const c = doc.chapters.find((x) => chapterKey(doc.chapters, x, false) === key);
  if (c) return { ch: c, appendix: false };
  const apps = doc.appendices ?? [];
  const a = apps.find((x) => chapterKey(apps, x, true) === key);
  return a ? { ch: a, appendix: true } : undefined;
}

function chapterLabel(b: WrapperBuilder, ch: Chapter, key: string, appendix: boolean): string {
  // IMPL-W4: kicker kosong eksplisit (penomoran sumber; nomor ada di judul bab) = label kosong.
  if (kickerSuppressed(ch.kicker)) return "";
  if (hasText(ch.kicker)) return inlinePlain(ch.kicker);
  return chapterLabelText(key, appendix, b.lang);
}

// ── cover ────────────────────────────────────────────────────────────────

/**
 * Blok kendali dari meta + P4V-12 (medan kosong dilewati, pasangan berurutan); teks = sumber bersama HTML (FIX-2 O-3).
 * Row 122 (CP-05): HALAMAN = medan NUMPAGES, VERIFIKASI = ringkasan rantai verifikasi lembar kendali, DATUM GEODETIK =
 * data templat R-83 (absen = dilewati, seperti sebelumnya).
 */
export function autoControlBlock(b: WrapperBuilder): ControlBlock | undefined {
  const doc = b.ctx.snapshot.doc;
  const cs = doc.front?.controlSheet?.data as ControlSheetData | undefined;
  const verification = verificationSummaryText(cs?.verificationChain);
  const rows = controlBlockRowsText(doc.meta, b.params, b.lang, { sheets: CONTROL_FIELD_SHEETS_FIELD, ...(verification ? { verification } : {}) });
  const cell = (t: string): Inline => (t === CONTROL_FIELD_SHEETS_FIELD ? { runs: [{ field: "NUMPAGES" }] } : textInline(t));
  return rows ? { type: "controlBlock", rows: rows.map((r) => [cell(r[0]), cell(r[1]), cell(r[2]), cell(r[3])]) } : undefined;
}

/** Row 122 (CP-15): baris "Klasifikasi : <K>" di bawah nomor dokumen blok kendali (helper bersama `front/texts.ts`). */
function withClassificationLine(b: WrapperBuilder, cb: ControlBlock): ControlBlock {
  return { ...cb, rows: controlRowsWithClassificationLine(cb.rows, b.ctx.snapshot.doc.meta, b.params, b.lang) };
}

/** Row 122 (CP-14): kolofon yang kanannya cap terbit diturunkan ulang dari meta (pemisah U+2014, huruf klasifikasi). */
function withIssueStamp(b: WrapperBuilder, c: Colophon): Colophon {
  if (!("text" in c.right)) return c;
  const t = normalizedIssueStampText(c.right.text, b.ctx.snapshot.doc.meta, b.params, b.lang);
  return t === undefined || t === c.right.text ? c : { ...c, right: { ...c.right, text: t } };
}

/** Kolofon dari P4V-13: entitas + NIB (kiri), cap terbit (kanan); teks = sumber bersama HTML (FIX-2 O-3). */
export function autoColophon(b: WrapperBuilder): Colophon {
  const c = colophonTexts(b.ctx.snapshot.doc.meta, b.params);
  return { type: "colophon", left: textInline(c.left), right: textInline(c.right) };
}

/**
 * Susun sampul mode auto menurut P4V-03 `cover.elementOrder`. `orderOverride`
 * (FIX-SERAH, D-295) = subset butir aparatus untuk sampul explicit.
 */
export function autoCoverItems(b: WrapperBuilder, data: CoverData | undefined, orderOverride?: readonly string[]): FrontItem[] {
  const meta = b.ctx.snapshot.doc.meta;
  const p = b.params;
  const order = orderOverride ?? pStrList(p, "cover.elementOrder", [
    "pita segel",
    "logo",
    "baris alamat di atas garis rambut",
    "ruang putih",
    "Datum Rule 166 mm",
    "kicker jenis dokumen",
    "judul",
    "standfirst",
    "baris cakupan",
    "blok kendali",
    "kolofon",
    "string punggung",
  ]);
  const items: FrontItem[] = [];
  const strInline = (s: string | undefined): Inline | undefined => (s && s.trim() !== "" ? textInline(s) : undefined);
  for (const el of order) {
    switch (el) {
      case "pita segel": {
        const s = sealBandItem(b);
        if (s) items.push(s);
        break;
      }
      case "logo":
        items.push({ type: "device", device: "logo" });
        break;
      case "baris alamat di atas garis rambut": {
        const addr = data?.addressLine ?? strInline(pStr(p, "cover.addressLine"));
        if (hasText(addr)) items.push(paraItem("addressLine", addr));
        items.push({ type: "device", device: "hairline" });
        break;
      }
      case "ruang putih":
        // Ruang putih sampul diwujudkan spasi sesudah garis rambut (K-03 after 800).
        break;
      case "Datum Rule 166 mm":
        if (rulePlaced(b, "sampul")) items.push({ type: "device", device: "datumRule" });
        break;
      case "kicker jenis dokumen": {
        const k = data?.kicker ?? strInline(pStr(p, "cover.kicker.text"));
        if (hasText(k)) items.push(paraItem("kicker", k));
        break;
      }
      case "judul": {
        const lines = data?.titleLines && data.titleLines.length > 0 ? data.titleLines : [textInline(meta.title)];
        for (const l of lines) items.push(paraItem("title", l));
        break;
      }
      case "standfirst":
        if (hasText(data?.standfirst)) items.push(paraItem("standfirst", data.standfirst));
        break;
      case "baris cakupan": {
        const s = data?.scopeLine ?? strInline(pStr(p, "cover.scopeLine"));
        if (hasText(s)) items.push(paraItem("scopeLine", s));
        break;
      }
      case "blok kendali": {
        const cb = data?.control ?? autoControlBlock(b);
        if (cb) items.push(withClassificationLine(b, cb));
        break;
      }
      case "kolofon":
        // K-10: spasi kosong sebelum kolofon (before 280, line 120 exact).
        items.push({ type: "spacer", format: { spacingBeforeTw: 280, spacingAfterTw: 0, lineTw: 120, lineRule: "exact" } });
        items.push(withIssueStamp(b, data?.colophon ?? autoColophon(b)));
        break;
      case "string punggung":
        if (spinePlaced(b, "margin luar sampul")) {
          items.push(hasText(data?.identityString) ? { type: "device", device: "spineString", text: data.identityString } : { type: "device", device: "spineString" });
        }
        break;
      default:
        b.warn(`unsur sampul tidak dikenal di cover.elementOrder: "${el}"`, "PARAM_UNKNOWN_KEY");
    }
  }
  return items;
}

function isFrontPage(v: Record<string, unknown>): boolean {
  return v.mode === "auto" || v.mode === "explicit";
}

export const renderCover: DocxBlockRenderer = (block, ctx) => {
  const page = contentOf<FrontPage>(block, "cover", isFrontPage);
  return build(ctx, block, "cover", (b) => {
    if (page.mode === "explicit" && page.body) {
      // FIX-SERAH (D-295): aparatus milik templat (D-139) yang tidak dibawa badan
      // konten-saja dipasang menurut cover.elementOrder; badan dirender apa adanya.
      const app = explicitCoverApparatus(b.params, page.body);
      if (app.before.length > 0) frontItemsXml(b, autoCoverItems(b, undefined, app.before));
      // Row 122 (CP-14, CP-15): cap terbit dan baris klasifikasi juga pada blok kendali/kolofon badan explicit.
      frontItemsXml(
        b,
        page.body.map((it) => (it.type === "colophon" ? withIssueStamp(b, it) : it.type === "controlBlock" ? withClassificationLine(b, it) : it)),
      );
      if (app.after.length > 0) frontItemsXml(b, autoCoverItems(b, undefined, app.after));
      return;
    }
    if (page.mode === "explicit") b.warn("sampul mode explicit tanpa body; disusun otomatis", "SCHEMA_INVALID");
    frontItemsXml(b, autoCoverItems(b, page.data as CoverData | undefined));
  });
};

// ── controlSheet ─────────────────────────────────────────────────────────

const K16_SPACER: ParaFormat = { spacingBeforeTw: 0, spacingAfterTw: 0, lineTw: 160, lineRule: "exact" };

/**
 * Tanda tangan dokumen (`front.signature`) ikut lembar kendali bila
 * lembar kendali ada: di akhir mode auto, dan di akhir mode explicit bila
 * body belum memuat signatureBlock. Perakit S20 tidak menempatkan
 * `signatureBlock` terpisah dalam kasus itu.
 */
export function controlSheetIncludesSignature(doc: StudioDocV1): boolean {
  return !!doc.front?.controlSheet && !!doc.front.signature;
}

/** Susun lembar kendali mode auto (urutan BM p#12..p#21 + T005..T008). */
export function autoControlSheetItems(b: WrapperBuilder, data: ControlSheetData | undefined): FrontItem[] {
  const items: FrontItem[] = [];
  const s = sealBandItem(b);
  if (s) items.push(s);
  items.push(paraItem("kicker", data?.kicker ?? textInline(controlSheetKickerText(b.lang))));
  items.push(paraItem("pageTitle", data?.title ?? textInline(b.ctx.snapshot.doc.meta.title)));
  // C08 / CS-12 (R-67, opt-in): subjudul tabel teks SESUDAH judul (CS-02 membaca kicker + judul lebih dulu);
  // peran `cover.standfirst` yang sudah ada (register research/38 §1.3). Absen/false = tanpa paragraf.
  if (pBool(b.params, "controlSheet.subtitle.enabled", false)) items.push(paraItem("standfirst", textInline(L.controlSubtitle[b.lang])));
  const blocks: Array<{ kind: ControlSheetBlockKind; table?: TableBlock; method?: Inline }> = [];
  if (data?.revisionHistory) blocks.push({ kind: "revision", table: data.revisionHistory });
  if (data?.verificationChain) blocks.push({ kind: "verification", table: data.verificationChain });
  if (hasText(data?.methodStatement)) blocks.push({ kind: "method", method: data.methodStatement });
  if (data?.distribution) blocks.push({ kind: "distribution", table: data.distribution });
  blocks.forEach((blk, i) => {
    items.push(paraItem("blockHeading", textInline(controlSheetBlockHeading(i, blk.kind, b.lang))));
    if (blk.table) {
      items.push(blk.table);
      items.push({ type: "spacer", format: K16_SPACER });
    } else if (blk.method) {
      items.push(paraItem("methodStatement", blk.method));
    }
  });
  return items;
}

/** Row 122: lembar kendali lengkap Rev A hanya untuk tier TERBIT dan SERAH (NOTA tanpa pembungkus, ID p.10 DT-02). */
function fullWrapperTier(b: WrapperBuilder): boolean {
  const t = b.ctx.snapshot.doc.meta.tier;
  return t === "TERBIT" || t === "SERAH";
}

const plainCell = (c: TableBlock["rows"][number]["cells"][number] | undefined): string =>
  !c ? "" : typeof c.text === "string" ? c.text : Array.isArray(c.runs) ? c.runs.map((r) => ("t" in r ? r.t : "")).join("") : "";

/** Tabel teks sederhana lembar kendali (kolom pertama kode). */
function textTableBlock(heads: readonly string[], rows: readonly string[][]): TableBlock {
  return {
    type: "registerTable",
    columns: heads.map((_, i) => ({ role: i === 0 ? "id" : "text" })),
    rows: [{ kind: "header", cells: heads.map((t) => ({ text: t })) }, ...rows.map((r) => ({ cells: heads.map((_, i) => ({ text: r[i] ?? "" })) }))],
  } as TableBlock;
}

/**
 * Row 122 (C40 FIX CP-06, ID p.48): rantai verifikasi tiga lapis. Lapis templat P4K-02 yang tidak ada di tabel dokumen
 * ditambahkan berurutan (kode lapis; metode hanya di kolom METODE/Method); sel hasil tetap kosong, jadi tidak ada hasil
 * verifikasi yang dikarang. Baris dokumen dipertahankan apa adanya.
 */
function completedVerificationChain(table: TableBlock, layers: ReadonlyArray<{ id: string; method: string }>): TableBlock {
  if (layers.length === 0) return table;
  const head = table.rows.filter((r) => r.kind === "header");
  const data = table.rows.filter((r) => r.kind !== "header");
  const n = Math.max(1, table.columns?.length ?? head[0]?.cells.length ?? data[0]?.cells.length ?? 1);
  const heads = (head[head.length - 1]?.cells ?? []).map((c) => plainCell(c).trim().toLowerCase());
  const methodCol = heads.findIndex((h) => h === "metode" || h === "method");
  const byId = new Map(data.map((r) => [plainCell(r.cells[0]).trim(), r]));
  if (layers.every((l) => byId.has(l.id))) return table;
  const ordered: TableBlock["rows"] = [];
  for (const l of layers) {
    const have = byId.get(l.id);
    if (have) {
      ordered.push(have);
      byId.delete(l.id);
      continue;
    }
    ordered.push({ cells: Array.from({ length: n }, (_, i) => ({ text: i === 0 ? l.id : i === methodCol ? l.method : "" })) });
  }
  const rest = data.filter((r) => byId.has(plainCell(r.cells[0]).trim()));
  return { ...table, rows: [...head, ...ordered, ...rest] };
}

/** Row 122 (CP-06): isi lembar kendali TERBIT/SERAH yang absen dari muatan dokumen diisi data templat. */
function withControlSheetTemplateData(b: WrapperBuilder, data: ControlSheetData | undefined): ControlSheetData | undefined {
  if (!fullWrapperTier(b)) return data;
  const t = controlSheetTemplateData(b.params);
  const out: ControlSheetData = { ...(data ?? { title: textInline(b.ctx.snapshot.doc.meta.title) }) };
  if (out.verificationChain) out.verificationChain = completedVerificationChain(out.verificationChain, t.layers);
  if (!hasText(out.methodStatement) && t.method) out.methodStatement = textInline(t.method);
  if (!out.distribution && t.distribution.length > 0) {
    const manual = b.params["controlSheet.columns.form"] === "manual";
    const heads = manual ? (["SALINAN", "PEMEGANG", "MEDIA", "KEMBALI"] as const).map((k) => CONTROL_SHEET_COLUMN_LABELS[k][b.lang]) : [...controlSheetColumnHeads("distribution", b.lang)];
    out.distribution = textTableBlock(heads, t.distribution);
  }
  return out;
}

/** Row 122 (C40 FIX CP-06/CP-09, ID p.48): tiga kolom tanda tangan dari data templat P4K-05/P4K-06 bila dokumen tidak mengirimnya. */
function templateSignature(b: WrapperBuilder): SignatureBlock | undefined {
  if (!fullWrapperTier(b)) return undefined;
  const roles = controlSheetTemplateData(b.params).signatures;
  return roles.length > 0 ? { type: "signatureBlock", roles: roles.map((r) => ({ role: textInline(r.role), holder: textInline(r.holder) })) } : undefined;
}

export const renderControlSheet: DocxBlockRenderer = (block, ctx) => {
  const page = contentOf<FrontPage>(block, "controlSheet", isFrontPage);
  return build(ctx, block, "controlSheet", (b) => {
    const signature = ctx.snapshot.doc.front?.signature ?? templateSignature(b);
    let items: FrontItem[];
    if (page.mode === "explicit" && page.body) {
      items = [...page.body];
      if (signature && !items.some((i) => i.type === "signatureBlock")) items.push(signature);
    } else {
      if (page.mode === "explicit") b.warn("lembar kendali mode explicit tanpa body; disusun otomatis", "SCHEMA_INVALID");
      items = autoControlSheetItems(b, withControlSheetTemplateData(b, page.data as ControlSheetData | undefined));
      if (signature) items.push(signature);
    }
    frontItemsXml(b, items);
  });
};

// ── toc ──────────────────────────────────────────────────────────────────

/** Tingkat baris daftar isi: tingkat entri kontrak + section turunan (FIX-T2, D-342 S2). */
export type TocRowLevel = TocEntry["level"] | "section";

/** Entri daftar isi turunan struktur (bentuk TocEntry, tingkat boleh `section`). */
export type DerivedTocEntry = Omit<TocEntry, "level"> & { level: TocRowLevel };

/** Baris daftar isi: entri + sasaran penanda nomor halaman (FIX-H4; hanya entri turunan). */
interface TocRow {
  entry: DerivedTocEntry;
  target?: TocTarget;
}

/**
 * Entri turunan struktur beserta sasaran PAGEREF-nya: kerangka `tocOutline`
 * (urutan C14, section tingkat 2 sesudah bab/lampirannya, tingkat = `toc.levels`).
 */
function deriveTocRows(b: WrapperBuilder): TocRow[] {
  const bookmarked = hasDerivedToc(b.ctx.snapshot);
  return tocOutline(b.ctx).map((node): TocRow => {
    const target = bookmarked ? node.target : undefined;
    switch (node.level) {
      case "part": {
        // FIX-SERAH (D-295): label bawaan sama dengan pembatas bagian bila konten tanpa label (compose v2).
        const p = node.part;
        const label = hasText(p.label) ? p.label : textInline(defaultPartLabelText(p.id, b.lang));
        return { entry: { level: "part", label, title: p.title, page: "" }, target };
      }
      case "section":
        // FIX-T2: label = nomor section (sama dengan kepala section), judul = judul section.
        return { entry: { level: "section", label: textInline(node.number), title: node.section.title, page: "" }, target };
      default: {
        const appendix = node.level === "appendix";
        return {
          entry: { level: node.level, label: textInline(chapterLabel(b, node.chapter, node.key, appendix)), title: node.chapter.title, page: "" },
          target,
        };
      }
    }
  });
}

/** Entri daftar isi dari struktur dokumen (C14: bagian lalu babnya, bab tanpa bagian, lampiran; section bila tingkatnya dimuat). */
export function deriveTocEntries(b: WrapperBuilder): DerivedTocEntry[] {
  return deriveTocRows(b).map((r) => r.entry);
}

/**
 * Isi nomor halaman entri: halaman literal konten bila ada, selain itu medan
 * PAGEREF ke penanda judul sasaran (FIX-H4), selain itu kosong.
 */
function tocPageRunsXml(b: WrapperBuilder, row: TocRow, run: RunProps): string {
  if (row.entry.page) return runsXml([{ t: row.entry.page }], run, b.params);
  return row.target ? pageRefRunsXml(row.target, run, b.params) : "";
}

/**
 * Peran sel/paragraf entri per tingkat (FIX-TL, `tocEntryRoles` toc-refs = sumber bersama HTML):
 * bagian = peran bagian; bab = peran bab; section = `toc.section*` (indentasi tingkat 2, 1 pt
 * lebih kecil); lampiran = `toc.appendix*` bila templat menyetelnya, selain itu peran bab.
 */
function entryRoles(b: WrapperBuilder, level: TocRowLevel): readonly [WrapperRole, WrapperRole, WrapperRole] {
  return tocEntryRoles(level, b.ctx.tpl.roleFormats) as unknown as readonly [WrapperRole, WrapperRole, WrapperRole];
}

/** Daftar isi statis T010 (KT-10..KT-15, TCP-11/12): label | judul | halaman. */
function staticTocTable(b: WrapperBuilder, tocRows: readonly TocRow[]): void {
  const grid = scaleCols([1474, 7144, 793], b.textWidthTw());
  const rows: WRow[] = tocRows.map((row) => ({
    cells: entryRoles(b, row.entry.level).map((role, i) => {
      const rf = roleFormat(b.ctx, role);
      const e = row.entry;
      // Kolom halaman tanpa literal: medan PAGEREF (FIX-H4); dengan literal: teks apa adanya (Manual 000 T010).
      const content =
        i === 2 && !e.page && row.target
          ? tocPageRunsXml(b, row, rf.run ?? {})
          : runsXml(inlineRuns(i === 0 ? e.label : i === 1 ? e.title : textInline(e.page)), rf.run ?? {}, b.params);
      return {
        widthTw: grid[i],
        borders: rf.cell?.borders,
        marginsTw: rf.cell?.marginsTw,
        shading: rf.cell?.shading,
        paragraphsXml: paragraphXml(rf.para, content),
      };
    }),
  }));
  b.push(tableXml(grid, rows));
}

/**
 * Daftar isi medan TOC (R-22 "field"): `TOC \o "1-2" \h \z \u` kompleks yang
 * membentang paragraf entri; hasil cache = entri statis dengan halaman literal
 * bila diberikan, selain itu medan PAGEREF bersarang ke penanda judul (FIX-H4,
 * pola hasil TOC Word) agar soffice/Word yang tidak memperbarui medan TOC tetap
 * menampilkan isi bernomor halaman. `updateFields` (R-03) diatur S14.
 */
function fieldTocXml(b: WrapperBuilder, tocRows: readonly TocRow[]): void {
  const entries = tocRows.map((r) => r.entry);
  const width = b.textWidthTw();
  // FIX-T2: rentang kerangka medan = tingkat turunan (`toc.levels`; bawaan "1-2"); FIX-TQ: satu sumber `tocLevelsOf`.
  const range = tocOutlineRange(tocLevelsOf(b.ctx).levels);
  const begin = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "${range}" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`;
  const end = `<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  if (entries.length === 0) {
    const rf = roleFormat(b.ctx, "toc.chapterTitle");
    b.push(paragraphXml(rf.para, begin + runsXml([{ t: L.tocPlaceholder[b.lang] }], rf.run ?? {}, b.params) + end));
    return;
  }
  // FIX-H4: kolom label setara tabel statis T010 (tab kiri), halaman rata kanan di tepi kolom teks;
  // dulu satu tab kanan saja sehingga judul terdorong ke kanan dan halaman jatuh ke baris berikut.
  const labelTw = scaleCols([1474, 7144, 793], width)[0];
  entries.forEach((e, i) => {
    const [lr, tr, pr] = entryRoles(b, e.level).map((r) => roleFormat(b.ctx, r));
    // FIX-TL: entri section menjorok (indLeft peran section); tab judul ikut bergeser agar
    // judul section juga menjorok terhadap judul bab. Tingkat lain: tab tetap (keluaran lama).
    const shift = e.level === "section" ? (tr.para?.indLeftTw ?? 0) : 0;
    const para: ParaFormat = {
      ...tr.para,
      tabs: [
        { posTw: labelTw + shift, val: "left", leader: "none" },
        { posTw: width, val: "right", leader: "none" },
      ],
    };
    const runs =
      runsXml(inlineRuns(e.label), lr.run ?? {}, b.params) +
      runsXml([{ tab: true }], tr.run ?? {}, b.params) +
      runsXml(inlineRuns(e.title), tr.run ?? {}, b.params) +
      (e.page ? runsXml([{ tab: true }, { t: e.page }], pr.run ?? {}, b.params) : "") +
      (!e.page && tocRows[i].target ? runsXml([{ tab: true }], pr.run ?? {}, b.params) + tocPageRunsXml(b, tocRows[i], pr.run ?? {}) : "");
    b.push(paragraphXml(para, (i === 0 ? begin : "") + runs + (i === entries.length - 1 ? end : "")));
  });
}

function isTocSpec(v: Record<string, unknown>): boolean {
  return v.mode === "field" || v.mode === "static";
}

export const renderToc: DocxBlockRenderer = (block, ctx) => {
  const spec = contentOf<TocSpec>(block, "toc", isTocSpec);
  return build(ctx, block, "toc", (b) => {
    const items: FrontItem[] = [];
    const seal = spec.sealBand ?? sealBandItem(b);
    if (seal) items.push(seal);
    items.push(paraItem("kicker", spec.kicker ?? textInline(tocKickerText(b.lang))));
    if (hasText(spec.title)) items.push(paraItem("title", spec.title));
    frontItemsXml(b, items);
    let rows: TocRow[];
    if (spec.entries && spec.entries.length > 0) {
      rows = spec.entries.map((entry) => ({ entry }));
    } else {
      if (tocLevelsOf(b.ctx).invalid) b.warn("parameter toc.levels tidak dikenal (bilangan bulat 1-3); kedalaman bawaan 2 dipakai", "SCHEMA_INVALID");
      rows = deriveTocRows(b);
      if (spec.mode === "static" && rows.some((r) => !r.target)) {
        b.warn("daftar isi statis tanpa entries: sebagian entri turunan tanpa sasaran nomor halaman", "BY_CONSTRUCTION_FAILED");
      }
    }
    if (spec.mode === "static") staticTocTable(b, rows);
    else fieldTocXml(b, rows);
    if (hasText(spec.note)) b.push(roleParagraphXml(b, "toc.note", spec.note));
  });
};

// ── partDivider ──────────────────────────────────────────────────────────

/** Badan pembatas bagian bawaan (BM T011, p#27-p#28): pita, spasi 1400, Datum Rule. */
export function autoPartBody(b: WrapperBuilder): FrontItem[] {
  const items: FrontItem[] = [];
  const s = sealBandItem(b);
  if (s) items.push(s);
  items.push({ type: "spacer", format: { spacingBeforeTw: 1400, spacingAfterTw: 0, lineTw: 120, lineRule: "exact" } });
  if (rulePlaced(b, "pembatas")) items.push({ type: "device", device: "datumRule" });
  return items;
}

/** Daftar bab pembatas bagian T012 (C5: label = teks kicker bab, judul = teks judul bab; U46/U47, TCP-13). */
function partChapterList(b: WrapperBuilder, part: PartSpec): void {
  const doc = b.ctx.snapshot.doc;
  const no = roleFormat(b.ctx, "part.chapterNo");
  const ti = roleFormat(b.ctx, "part.chapterTitle");
  const grid = scaleCols([907, 8505], b.textWidthTw());
  const rows: WRow[] = [];
  for (const key of part.chapterKeys) {
    const hit = findChapter(doc, key);
    if (!hit) {
      b.warn(`chapterKeys "${key}" pada bagian ${part.id} tidak menunjuk bab mana pun`, "ADDRESS_NOT_FOUND");
      continue;
    }
    rows.push({
      cells: [
        {
          widthTw: grid[0],
          borders: no.cell?.borders,
          marginsTw: no.cell?.marginsTw,
          shading: no.cell?.shading,
          paragraphsXml: paragraphXml(no.para, runsXml([{ t: chapterLabel(b, hit.ch, key, hit.appendix) }], no.run ?? {}, b.params)),
        },
        {
          widthTw: grid[1],
          borders: ti.cell?.borders,
          marginsTw: ti.cell?.marginsTw,
          shading: ti.cell?.shading,
          paragraphsXml: paragraphXml(ti.para, runsXml([{ t: inlinePlain(hit.ch.title) }], ti.run ?? {}, b.params)),
        },
      ],
    });
  }
  if (rows.length > 0) b.push(tableXml(grid, rows));
}

function isPartSpec(v: Record<string, unknown>): boolean {
  return typeof v.id === "string" && isObj(v.title) && Array.isArray(v.chapterKeys);
}

/**
 * Lede pembatas bagian (K-22). Moda rel K2 (A + `framePr`, FIX-T2/D-350, paritas FIX-R1
 * `hostFormat` varian plain): prosa tanpa chip selebar teks penuh, jadi indentasi kanan PERAN
 * yang sama dengan cadangan rel dibuang. `table3col` (Manual 000) dan moda B: tanpa cadangan,
 * keluaran sama dengan `roleParagraphXml`.
 */
function partLedeXml(b: WrapperBuilder, lede: Inline): string {
  const rf = roleFormat(b.ctx, "part.lede");
  const para: ParaFormat = { ...(rf.para ?? {}) };
  if (para.indRightTw !== undefined && para.indRightTw === railK2ReserveOf((k) => b.params[k])) delete para.indRightTw;
  return paragraphXml(para, runsXml(inlineRuns(lede), { ...(rf.run ?? {}) }, b.params));
}

export const renderPartDivider: DocxBlockRenderer = (block, ctx) => {
  const part = contentOf<PartSpec>(block, "partDivider", isPartSpec);
  return build(ctx, block, "part", (b) => {
    const body = part.body && part.body.length > 0 ? part.body : autoPartBody(b);
    frontItemsXml(b, body);
    const label = hasText(part.label) ? part.label : textInline(defaultPartLabelText(part.id, b.lang));
    b.push(roleParagraphXml(b, "wrapper.kicker", label));
    // FIX-H4: penanda sasaran PAGEREF daftar isi (hanya bila TOC turunan ada).
    b.push(bookmarkParagraph(partTocTarget(ctx, part.id), roleParagraphXml(b, "part.title", part.title)));
    if (hasText(part.lede)) b.push(partLedeXml(b, part.lede));
    if (part.showChapterList !== false && part.chapterKeys.length > 0) partChapterList(b, part);
    if (!part.body && spinePlaced(b, "pembatas")) {
      b.push(spineXml(b, { runs: [{ t: spineText(b), caps: true }] }));
    }
  });
};

// ── backCover (C12 / CV-19) ──────────────────────────────────────────────

/**
 * Sampul belakang: halaman kosong yang hanya memuat string punggung berputar, perangkat yang sama dengan
 * sampul dan pembatas (`spineXml`). Manual tidak meminta teks lain (DT-13f ID:2718-2723, EN:2766,
 * EN:2778-2783; register §3.4). Paragraf jangkar sesudah tabel mengambang: unit ini unit terakhir,
 * langsung diikuti sectPr badan. Header/footer kosong (tanpa PAGE/register, RB-07/RB-08/SB-01) milik seksi
 * pembungkus perakit; renderer tidak menulis sectPr (K-12).
 */
export const renderBackCover: DocxBlockRenderer = (block, ctx) =>
  build(ctx, block, "cover", (b) => {
    if (backCoverPlaced(b.params)) b.push(spineXml(b, { runs: [{ t: spineText(b), caps: true }] }));
    else b.warn('sampul belakang tanpa penempatan "sampul belakang" di device.spine.placements; string punggung dilewati', "BY_CONSTRUCTION_FAILED");
    b.push(paragraphXml(paraOf(ctx, "spacer.generic")));
  });

// ── signatureBlock ───────────────────────────────────────────────────────

function isSignature(v: Record<string, unknown>): boolean {
  return v.type === "signatureBlock" && Array.isArray(v.roles);
}

export const renderSignatureBlock: DocxBlockRenderer = (block, ctx) => {
  const sig = contentOf<SignatureBlock>(block, "signatureBlock", isSignature);
  return build(ctx, block, "signature", (b) => signatureXml(b, sig));
};

// ── appendix (pembuka) ───────────────────────────────────────────────────

/**
 * Pembuka lampiran: normalisasi S48 memisahkan seksi menjadi blok sendiri,
 * sehingga isi blok `appendix` = {key, kicker, title, setup} tanpa `sections`
 * (D-79). `sections`, bila ada, tetap harus larik.
 */
function isChapter(v: Record<string, unknown>): boolean {
  return isObj(v.title) && (v.sections === undefined || Array.isArray(v.sections));
}

export const renderAppendixOpener: DocxBlockRenderer = (block, ctx) => {
  const ch = contentOf<Chapter>(block, "appendix", isChapter);
  return build(ctx, block, "appendix", (b) => {
    const apps = ctx.snapshot.doc.appendices ?? [];
    const idx = apps.findIndex((a) => a === ch || (!!ch.blockId && a.blockId === ch.blockId));
    const key = ch.key ?? (idx >= 0 ? String.fromCharCode(65 + idx) : block.unitKey);
    const kicker = hasText(ch.kicker) ? ch.kicker : textInline(appendixOpenerKickerText(key, b.lang, b.params["appendix.kicker.pattern"]));
    b.push(roleParagraphXml(b, "chapter.kicker", kicker));
    if (rulePlaced(b, "atas judul bab")) b.push(datumRuleParagraphXml(b));
    // FIX-H4: penanda sasaran PAGEREF daftar isi (kunci efektif sama dengan entri turunan).
    const target = idx >= 0 ? chapterTocTargetOf(ctx, apps[idx], true) : undefined;
    b.push(bookmarkParagraph(target, roleParagraphXml(b, "chapter.title", ch.title)));
  });
};

// ── Ekspor pembantu untuk perakit/header ─────────────────────────────────

/**
 * Paragraf Datum Rule mandiri (mis. untuk penempatan di kepala/kaki halaman
 * oleh S14/S20): mengembalikan fragmen dengan media rule.
 */
export function datumRuleFragment(ctx: RenderContext, block: NormBlock, opts: { interior: boolean; widthMm?: number; format?: ParaFormat }): DocxFragment {
  return build(ctx, block, opts.interior ? "appendix" : "part", (b) => {
    b.push(datumRuleParagraphXml(b, { widthMm: opts.widthMm, format: opts.format ?? paraOf(ctx, opts.interior ? "chapter.datumRule" : "wrapper.datumRule") }));
  });
}

export { sealBandTexts };
