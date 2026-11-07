/**
 * Renderer HTML pembungkus (padanan S18): cover rata kiri (pita segel, logo
 * sekali, blok kendali, kolofon), controlSheet, toc, partDivider,
 * signatureBlock. Pembuka appendix ada di `text.ts` (berbagi kepala bab).
 *
 * Mode explicit merender `body[]` berurutan persis. Unsur milik baris lain
 * (keluarga tabel, figur, derivation) diserahkan ke `htmlTables` (I12, S23);
 * bila renderer itu belum ada, tabel memakai fallback struktural minimum dan
 * figur/derivation dicatat ke log render.
 */
import {
  TABLE_BLOCK_TYPES,
  type Cell,
  type Chapter,
  type Colophon,
  type ControlBlock,
  type ControlSheetData,
  type CoverData,
  type FrontPage,
  type HtmlBlockRenderer,
  type Inline,
  type NormBlock,
  type ParaFormat,
  type PartSpec,
  type RenderContext,
  type RoleFormat,
  type RoleKey,
  type RunProps,
  type SignatureBlock,
  type TableBlock,
  type TocEntry,
  type TocSpec,
} from "../../../contract";
import { datumRulePlaced, explicitCoverApparatus, spinePlaced } from "../../front/apparatus";
import {
  chapterLabelText,
  colophonTexts,
  controlBlockRowsText,
  controlSheetBlockHeading,
  controlSheetKickerText,
  defaultPartLabelText,
  kickerSuppressed,
  tocKickerText,
  WRAPPER_TEXT,
  type ControlSheetBlockKind,
  // Row 123 (C40 FIX CP-04/05/06/09/14/15): shared Rev A helpers (row 122 for DOCX, additive row 123 ones).
  COVER_KICKER_REV_A,
  completedVerificationChainTable,
  controlRowsWithClassificationLine,
  controlSheetDistributionHeads,
  controlSheetTemplateData,
  controlSheetTextTable,
  isFullWrapperTier,
  normalizedIssueStampText,
  verificationSummaryText,
  // Wave 165 row 165A (C188 F113-3/F113-4): HALAMAN field marker and the method statement built from the layers.
  CONTROL_FIELD_SHEETS_FIELD,
  defaultMethodStatementText,
} from "../../front/texts";
import { DEFAULT_LOGO_WIDTH_MM } from "../../docx/wrapper/media";
import { railK2ReserveOf } from "../../docx/blocks/rail";
import { coverTitleIndentTw, coverTitleLineTw } from "../../docx/wrapper/formats";
import { backCoverPlaced } from "../../docx/wrapper/pages";
import { filledSignature } from "../../docx/wrapper/render";
import { isTocSectionRole, TOC_ROLE_PARENT, TOC_SECTION_SIZE_STEP_HALFPT, tocEntryRoles, tocOutline, tocSectionIndentTw, tocSectionSize } from "../../docx/wrapper/toc-refs";
import { htmlTables } from "../tables";
import { HTML_BLOCK_CLASSES as C } from "./classes";
import { childBlock, contentOf, el, isObj, language, paramBool, paramList, paramNum, paramStr, reportBad } from "./common";
import { assetDataUri, datumRuleHtml, DECORATIVE_IMG_ATTRS, isDevice, renderDevice, sealBandHtml, spineText } from "./device";
import { attr, escapeHtml, finite, num } from "./escape";
import { DEFAULT_MD_ROLES, hasInline, inlineHtml, inlinePlain } from "./inline";
import { baseRun, semanticTransform } from "./semantic";
import { blockScope, paraDecl, roleFormat, wrapperScope } from "./style";
import {
  renderAside,
  renderAssumptionInline,
  renderList,
  renderMonoBlock,
  renderParagraph,
  renderSpacer,
  requiredParamMm,
} from "./text";

/** Kunci lebar Datum Rule pembungkus (sama dengan DOCX `datumRuleWidthMm` dan HTML device): absen = BY_CONSTRUCTION_FAILED. */
const WRAPPER_DATUM_RULE_KEYS = ["cover.datumRule.widthMm", "grid.fullSpanMm"] as const;

const OWN_TEXT: Readonly<Record<string, HtmlBlockRenderer>> = {
  paragraph: renderParagraph,
  list: renderList,
  aside: renderAside,
  monoBlock: renderMonoBlock,
  assumptionInline: renderAssumptionInline,
  spacer: renderSpacer,
};

const TABLE_TYPES = new Set<string>(TABLE_BLOCK_TYPES);

function twToMm(tw: number): number {
  return (tw * 25.4) / 1440;
}

// ── Tabel fallback (hanya bila S23 belum mendaftarkan renderer) ──────────

function cellInner(cell: Cell): string {
  if (Array.isArray(cell.paragraphs)) {
    return cell.paragraphs.map((p) => `<p class="${C.paragraph}">${inlineHtml(p)}</p>`).join("");
  }
  if (Array.isArray(cell.runs)) return `<p class="${C.paragraph}">${inlineHtml({ runs: cell.runs })}</p>`;
  if (typeof cell.text === "string") return `<p class="${C.paragraph}">${inlineHtml({ text: cell.text })}</p>`;
  return "";
}

function fallbackTable(t: TableBlock, address: string | null): string {
  const rows = (Array.isArray(t.rows) ? t.rows : []).map((row) => {
    const tag = row.kind === "header" ? "th" : "td";
    const cells = (Array.isArray(row.cells) ? row.cells : [])
      .filter((c) => isObj(c) && c.vMerge !== "continue")
      .map((c) => {
        const span = finite(c.gridSpan, 1, 20);
        return `<${tag}${span && span > 1 ? attr("colspan", span) : ""}>${cellInner(c)}</${tag}>`;
      });
    return `<tr${attr("data-kind", row.kind)}>${cells.join("")}</tr>`;
  });
  return `<table class="${C.fallbackTable}"${attr("data-address", address ?? undefined)}><tbody>${rows.join("")}</tbody></table>`;
}

/** Render TableBlock lewat S23 bila tersedia, selain itu fallback. */
function tableHtml(parent: NormBlock, ctx: RenderContext, t: TableBlock, index: number, address: string | null): string {
  const r = htmlTables[t.type];
  if (r) return r(childBlock(parent, t.type, t, index, address), ctx);
  ctx.log({
    level: "warn",
    message: `engine/html/blocks: renderer HTML ${t.type} (S23) belum ada; tabel fallback dipakai`,
    code: "RENDER_FALLBACK_TABLE",
    address: address ?? parent.blockId,
  });
  return fallbackTable(t, address);
}

// ── Unsur halaman depan ──────────────────────────────────────────────────

/**
 * Wave 165 row 165A (C188 F113-3): column shares of a control block / signature block without `colsTw`, the DOCX
 * grids of `docx/wrapper/render.ts` (`controlBlockXml` [1814, 3175, 1474, 2948], `signatureXml` [3118, 3175, 3118]
 * or equal) as percentages of the 166 mm text span, so the PDF prints the same 4 x 2 grid with a gap between the
 * pairs and three signature columns across the span. Before: no colgroup, auto widths (05 PDF: PENYUSUN value and
 * DATUM GEODETIK label abutting at 0 pt; three signature columns inside the left 48 mm).
 */
const CONTROL_BLOCK_GRID_TW = [1814, 3175, 1474, 2948] as const;
const SIGNATURE_GRID_TW_3 = [3118, 3175, 3118] as const;
function shareColgroup(grid: readonly number[]): string {
  const total = grid.reduce((a, b) => a + b, 0);
  return `<colgroup>${grid.map((w) => `<col${attr("style", `width:${num(Math.round((w / total) * 1e6) / 1e4)}%`)}>`).join("")}</colgroup>`;
}

function controlBlockHtml(ctx: RenderContext, cb: ControlBlock, address: string | null): string {
  if (!Array.isArray(cb.rows)) return "";
  const cols = Array.isArray(cb.colsTw) ? cb.colsTw.map((w) => finite(w, 0, 31680)) : [];
  const colgroup = cols.length
    ? `<colgroup>${cols.map((w) => `<col${attr("style", w !== undefined ? `width:${num(twToMm(w))}mm` : undefined)}>`).join("")}</colgroup>`
    : shareColgroup(CONTROL_BLOCK_GRID_TW);
  const rows = cb.rows
    .filter(Array.isArray)
    .map((row) => {
      const cells = row.slice(0, 4).map((cellInline, i) => {
        const label = i % 2 === 0;
        const role: RoleKey = label ? "cover.controlLabel" : "cover.controlValue";
        return el(ctx, label ? "th" : "td", { classes: [label ? C.controlLabel : C.controlValue], role, attrs: label ? [["scope", "row"]] : [] }, inlineHtml(cellInline));
      });
      return `<tr>${cells.join("")}</tr>`;
    });
  return `<table class="${C.controlBlock}"${attr("data-address", address ?? undefined)}>${colgroup}<tbody>${rows.join("")}</tbody></table>`;
}

function colophonHtml(ctx: RenderContext, c: Colophon, address: string | null): string {
  const left = el(ctx, "span", { classes: [C.colophonLeft], role: "cover.colophonLeft" }, inlineHtml(c.left));
  const right = el(ctx, "span", { classes: [C.colophonRight], role: "cover.colophonRight" }, inlineHtml(c.right));
  return `<div class="${C.colophon}"${attr("data-address", address ?? undefined)}>${left}${right}</div>`;
}

/**
 * C22 / CS-06 (R-68, opt-in): selalu tiga kolom tanda tangan, sumber yang sama dengan DOCX `signatureXml`
 * (`filledSignature` engine A C09: peran dipetakan per label tabel teks, kolom sisa berlabel bawaan dengan
 * pemegang kosong, `colsTw` kiriman dibuang). Label peran yang bukan Inline diperlakukan label tak dikenal
 * (pemegangnya tetap). Absen/false = blok apa adanya.
 */
function effectiveSignature(ctx: RenderContext, s: SignatureBlock): SignatureBlock {
  if (!paramBool(ctx, "controlSheet.signatures.fillRoles", false)) return s;
  const roles = (Array.isArray(s.roles) ? s.roles : []).filter(isObj).map((r) => (hasInline(r.role) ? r : { ...r, role: { runs: [] } }));
  return filledSignature({ ...s, roles }, language(ctx));
}

function signatureHtml(ctx: RenderContext, s: SignatureBlock, address: string | null, blockId?: string): string {
  const roles = Array.isArray(s.roles) ? s.roles.filter(isObj) : [];
  const cols = Array.isArray(s.colsTw) ? s.colsTw.map((w) => finite(w, 0, 31680)) : [];
  const colgroup = cols.length
    ? `<colgroup>${cols.map((w) => `<col${attr("style", w !== undefined ? `width:${num(twToMm(w))}mm` : undefined)}>`).join("")}</colgroup>`
    : roles.length > 0
      ? shareColgroup(roles.length === 3 ? SIGNATURE_GRID_TW_3 : roles.map(() => 1))
      : "";
  const head = roles.map((r) => el(ctx, "th", { classes: [C.signatureRole], role: "controlTable.header", attrs: [["scope", "col"]] }, inlineHtml(r.role))).join("");
  const space = roles.map(() => el(ctx, "td", { classes: [C.signatureSpace], role: "signature.space", format: s.signRowFormat }, "&nbsp;")).join("");
  const holder = roles.map((r) => el(ctx, "td", { classes: [C.signatureHolder], role: "controlTable.cell" }, inlineHtml(r.holder))).join("");
  const anyDate = roles.some((r) => hasInline(r.date));
  const date = anyDate ? `<tr>${roles.map((r) => el(ctx, "td", { classes: [C.signatureDate], role: "controlTable.cell" }, inlineHtml(r.date))).join("")}</tr>` : "";
  // Wave 165 row 165A (C188 F113-4): one signature line per column (DOCX `signatureXml` top border of the holder row,
  // `color.wrapper.rule`), drawn per cell short of the 4 mm column gap so the three lines stay separate.
  const rule = paramStr(ctx, "color.wrapper.rule", "C4BEB4").replace(/^#/, "");
  const ruleStyle = /^[0-9A-Fa-f]{6}$/.test(rule) ? `--st-sign-rule:#${rule.toUpperCase()}` : undefined;
  return `<table class="${C.signature}"${attr("style", ruleStyle)}${attr("data-address", address ?? undefined)}${attr("data-block", blockId)}>${colgroup}<thead><tr>${head}</tr></thead><tbody><tr>${space}</tr><tr>${holder}</tr>${date}</tbody></table>`;
}

/** Satu unsur `body[]` halaman depan / pembatas bagian. */
function frontItemHtml(parent: NormBlock, ctx: RenderContext, item: unknown, index: number, address: string | null): string {
  if (!isObj(item) || typeof item.type !== "string") {
    reportBad(ctx, parent, `body[${index}] tanpa type`);
    return "";
  }
  const type = item.type;
  if (type === "device") return isDevice(item) ? renderDevice(childBlock(parent, type, item, index, null), ctx, item) : "";
  if (type === "controlBlock") return controlBlockHtml(ctx, item as unknown as ControlBlock, address);
  if (type === "colophon") return colophonHtml(ctx, item as unknown as Colophon, address);
  if (type === "signatureBlock") return signatureHtml(ctx, effectiveSignature(ctx, item as unknown as SignatureBlock), address);
  const own = OWN_TEXT[type];
  // ENG-01: paragraf pembungkus = DOCX `roleParagraphXml` (rantai pembungkus); unsur lain
  // didelegasikan DOCX ke renderer blok (`delegateBlock`; spacer = paragraf tanpa peran),
  // jadi dirender dengan rantai blok isi.
  if (own) return own(childBlock(parent, type, item, index, type === "spacer" ? null : address), type === "paragraph" ? ctx : blockScope(ctx));
  if (TABLE_TYPES.has(type)) return tableHtml(parent, ctx, item as unknown as TableBlock, index, address);
  const other = htmlTables[type as keyof typeof htmlTables];
  if (other) return other(childBlock(parent, type, item, index, address), ctx);
  ctx.log({
    level: "warn",
    message: `engine/html/blocks: renderer HTML ${type} belum ada; unsur body[${index}] dilewati`,
    code: "RENDER_RENDERER_MISSING",
    address: address ?? parent.blockId,
  });
  return "";
}

function bodyHtml(parent: NormBlock, ctx: RenderContext, body: unknown, addressPrefix: string | null): string {
  if (!Array.isArray(body)) return "";
  let n = 0;
  return body
    .map((item, i) => {
      const addressed = isObj(item) && item.type !== "spacer" && item.type !== "device";
      if (addressed) n += 1;
      const address = addressed && addressPrefix ? `${addressPrefix}/${n}` : null;
      return frontItemHtml(parent, ctx, item, i, address);
    })
    .join("");
}

function frontAddressPrefix(block: NormBlock, kind: string): string {
  return block.address && block.address.startsWith("F:") ? block.address.split("/")[0] : `F:${kind}`;
}

function unit(block: NormBlock, kind: string, cls: string, inner: string, tag = "section", id?: string): string {
  return `<${tag} class="${cls}"${attr("id", id)}${attr("data-wrapper", kind)}${attr("data-address", block.address ?? undefined)}${attr("data-block", block.blockId)}>${inner}</${tag}>`;
}

/**
 * Jangkar internal sasaran daftar isi (FIX-H4): sama dengan id kepala bab/lampiran
 * `text.ts` (`st-ch-<kunci>`, `st-app-<kunci>`), kepala section `st-sec-<nomor>` (FIX-T2)
 * dan id pembatas bagian `st-part-<id>`.
 * HTML tidak berhalaman tetap (nomor halaman tidak relevan), jadi entri menjadi tautan.
 */
function tocAnchorId(prefix: "st-ch" | "st-app" | "st-part" | "st-sec", key: string): string | undefined {
  const k = key.replace(/[^A-Za-z0-9_-]/g, "");
  return k ? `${prefix}-${k}` : undefined;
}

// ── Sampul ───────────────────────────────────────────────────────────────

const COVER_ORDER_DEFAULT = [
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
] as const;

const runText = (t: string): Inline => ({ runs: [{ t }] });

/** Blok kendali sampul auto (FIX-2 O-3): teks = DOCX `autoControlBlock` lewat sumber bersama engine/front/texts. */
function autoControlBlock(ctx: RenderContext): ControlBlock | undefined {
  const meta = ctx.snapshot?.doc?.meta;
  if (!meta) return undefined;
  // Row 123 (C40 FIX CP-05, ID p.47 butir 10): VERIFIKASI = last layer of the control-sheet chain and its result,
  // DATUM GEODETIK = template data R-83 (inside controlBlockRowsText). HALAMAN is left out of the HTML: the sheet
  // total is only known after Chromium paginates (CSS counter(pages) prints 0 outside page-margin boxes, probe
  // p1 in implementation/52), so no sheet count is invented; row 122's DOCX prints it as a NUMPAGES field.
  const cs = ctx.snapshot?.doc?.front?.controlSheet?.data as ControlSheetData | undefined;
  const verification = verificationSummaryText(cs?.verificationChain);
  // Wave 165 row 165A (C188 F113-3): HALAMAN is printed as in the DOCX. Its value is a NUMPAGES field span; the PDF
  // print (services/render/pdf.ts) fills it with the printed page count, the DOCX NUMPAGES meaning.
  const rows = controlBlockRowsText(meta, ctx.tpl?.params ?? {}, language(ctx), { sheets: CONTROL_FIELD_SHEETS_FIELD, ...(verification ? { verification } : {}) });
  const cell = (t: string): Inline => (t === CONTROL_FIELD_SHEETS_FIELD ? { runs: [{ field: "NUMPAGES" }] } : runText(t));
  return rows ? { type: "controlBlock", rows: rows.map((r) => [cell(r[0]), cell(r[1]), cell(r[2]), cell(r[3])]) } : undefined;
}

/** Kolofon sampul auto (FIX-2 O-3): entitas + NIB | cap terbit, sama dengan DOCX `autoColophon`. */
function autoColophon(ctx: RenderContext): Colophon | undefined {
  const meta = ctx.snapshot?.doc?.meta;
  if (!meta) return undefined;
  const c = colophonTexts(meta, ctx.tpl?.params ?? {});
  return { type: "colophon", left: runText(c.left), right: runText(c.right) };
}

/** Row 123 (C40 FIX CP-15, DT-28c ID p.14): "Klasifikasi : <K>" under the document number (helper shared with DOCX row 122). */
function withClassificationLine(ctx: RenderContext, cb: ControlBlock): ControlBlock {
  const meta = ctx.snapshot?.doc?.meta;
  if (!meta || !Array.isArray(cb.rows)) return cb;
  const given = cb.rows.filter(Array.isArray);
  const rows = given.map((r) => [r[0], r[1], r[2], r[3]] as [Inline, Inline, Inline, Inline]);
  // Wave 165 row 165A (F56-1): the helper re-flows the pairs with the Klasifikasi field under the number, so the rows
  // are four cells each (= DOCX); an unchanged block keeps its own rows and cell counts.
  const out = controlRowsWithClassificationLine(rows, meta, ctx.tpl?.params ?? {}, language(ctx));
  const changed = out.length !== given.length || out.some((r, i) => r.some((c, j) => c !== rows[i]?.[j]));
  return changed ? { ...cb, rows: out as ControlBlock["rows"] } : cb;
}

/** Row 123 (C40 FIX CP-14, ID p.1, p.37 Tabel 6.2, p.49): a colophon right text that is an issue stamp is re-derived from meta. */
function withIssueStamp(ctx: RenderContext, c: Colophon): Colophon {
  const meta = ctx.snapshot?.doc?.meta;
  if (!meta || !isObj(c.right) || !("text" in c.right) || typeof c.right.text !== "string") return c;
  const t = normalizedIssueStampText(c.right.text, meta, ctx.tpl?.params ?? {}, language(ctx));
  return t === undefined || t === c.right.text ? c : { ...c, right: { ...c.right, text: t } };
}

/**
 * Row 123 (C40 FIX CP-04, ID p.47 butir 6): the cover kicker prints 7,4 pt Cond 600 seal capitals tracked +0,20 em,
 * whatever the `wrapper.kicker` role (shared with the divider kicker) carries. Before: 7.0 pt amber #B45309.
 */
function coverKickerRun(ctx: RenderContext): RunProps {
  const seal = paramStr(ctx, "color.wrapper.seal", "6E1420").replace(/^#/, "");
  return {
    szHalfPt: COVER_KICKER_REV_A.sizePt * 2,
    b: true,
    caps: true,
    color: /^[0-9A-Fa-f]{6}$/.test(seal) ? seal.toUpperCase() : "6E1420",
    spacingTw: Math.round(COVER_KICKER_REV_A.sizePt * COVER_KICKER_REV_A.trackEm * 20 * 10) / 10,
  };
}

/**
 * Row 122c (C96 O1; replaces row 123's raise to the Plex Cond line box): the cover title leading is the DOCX
 * rule `coverTitleLineTw` (Manual Rev A ID p.1 cover 24 pt on 28 pt; p.47 butir 7, p.90 Tabel A.2), so HTML and
 * DOCX print the same line pitch. The wrapper role format already carries it; this only covers a role format
 * without a line height (template-only fallback).
 */
function coverTitleLineFormat(ctx: RenderContext, base: ParaFormat | undefined): ParaFormat | undefined {
  const rf = roleFormat(ctx, "cover.titleFirst");
  const sz = rf.run?.szHalfPt;
  if (typeof sz !== "number" || typeof rf.para?.lineTw === "number") return base;
  return { ...(base ?? {}), lineTw: coverTitleLineTw(sz), lineRule: "exact" };
}

function findLogoKey(ctx: RenderContext): string | undefined {
  const docAssets = ctx.snapshot?.doc?.assets ?? {};
  const tplAssets = ctx.tpl?.assets ?? {};
  if (docAssets.logo) return "logo";
  if (tplAssets.logo?.kind === "raster") return "logo";
  return Object.keys(tplAssets).find((k) => /logo/i.test(k) && tplAssets[k]?.kind === "raster");
}

/** String punggung bangkitan templat (sampul dan pembatas; peran `cover.identityString` seperti DOCX `spineXml`). */
function spineStringHtml(ctx: RenderContext, inner: string, extra: readonly string[] = []): string {
  const rot = paramNum(ctx, "device.spine.rotationDeg", 90) === 90 ? "90" : "0";
  return el(ctx, "div", { classes: [C.device, C.spine, ...extra], role: "cover.identityString", attrs: [["data-rotate", rot]] }, inner);
}

/** Sampul auto; `orderOverride` (FIX-SERAH, D-295) = subset butir aparatus untuk sampul explicit. */
function coverAuto(block: NormBlock, ctx: RenderContext, data: Partial<CoverData>, orderOverride?: readonly string[]): string {
  const order = orderOverride ?? paramList(ctx, "cover.elementOrder", COVER_ORDER_DEFAULT);
  let logoDone = false;
  const parts = order.map((item) => {
    switch (item) {
      case "pita segel":
        return sealBandHtml(ctx, {});
      case "logo": {
        if (logoDone) return "";
        logoDone = true;
        const key = findLogoKey(ctx);
        if (!key) return "";
        const uri = assetDataUri(ctx, key, block);
        // Row 123 (C40 FIX CP-02, ID p.47 butir 2 "Logo, lebar 44 sampai 46 mm"): the logo is placed at the DOCX cover
        // width (44 mm, `DEFAULT_LOGO_WIDTH_MM`). Before, the <img> had no size and printed at its pixel width (2390 px
        // = 421.6 mm in Chromium 1234), which pushed the cover onto two sheets and shrank every printed page.
        return uri
          ? el(ctx, "div", { classes: [C.device, C.logo], role: "cover.logo" }, `<img${attr("src", uri)}${DECORATIVE_IMG_ATTRS}${attr("style", `width:${num(DEFAULT_LOGO_WIDTH_MM)}mm;height:auto`)}>`)
          : "";
      }
      case "baris alamat di atas garis rambut": {
        // Wave 165 row 165A (C188 F113-3, ID p.49 Tabel 8.1): the template address line `cover.addressLine` when the
        // cover data has none, as the DOCX `autoCoverItems` does (05 PDF printed no address, the 05 DOCX did).
        const tplAddr = paramStr(ctx, "cover.addressLine", "").trim();
        const addr: Inline | undefined = hasInline(data.addressLine) ? data.addressLine : tplAddr !== "" ? runText(tplAddr) : undefined;
        return (
          (addr ? el(ctx, "p", { classes: [C.paragraph, C.coverAddress], role: "cover.addressLine" }, inlineHtml(addr)) : "") +
          el(ctx, "div", { classes: [C.device], role: "cover.hairline" }, `<hr class="${C.hairline}">`)
        );
      }
      case "ruang putih":
        return el(ctx, "p", { classes: [C.spacer], role: "spacer.generic", attrs: [["aria-hidden", "true"]] }, "&nbsp;");
      case "Datum Rule 166 mm":
        // Butir urutan sampul (kosakata registri `cover.elementOrder`); lebar = turunan, bukan label.
        // FIX-F C2: penempatan `sampul` dihormati seperti DOCX `autoCoverItems` (engine/front/apparatus).
        if (!datumRulePlaced(ctx.tpl?.params ?? {}, "sampul")) return "";
        return datumRuleHtml(ctx, "wrapper.datumRule", requiredParamMm(ctx, block, WRAPPER_DATUM_RULE_KEYS, "lebar Datum Rule pembungkus"));
      case "kicker jenis dokumen": {
        const text = paramStr(ctx, "cover.kicker.text", "");
        const k = hasInline(data.kicker) ? inlineHtml(data.kicker) : escapeHtml(text);
        return k ? el(ctx, "p", { classes: [C.paragraph, C.coverKicker], role: "wrapper.kicker", run: coverKickerRun(ctx) }, k) : "";
      }
      case "judul": {
        const lines = Array.isArray(data.titleLines) ? data.titleLines.filter(hasInline) : [];
        if (lines.length === 0) {
          const title = ctx.snapshot?.doc?.meta?.title;
          if (title) lines.push({ text: title });
        }
        // C22 / CV-20 (R-70, opt-in): jorokan kanan judul (`coverTitleIndentTw`, sumber yang sama dengan DOCX
        // `roleFormat` C11) dipasang pada blok h1; baris judul = span inline yang margin kanannya tidak membatasi
        // lebar baris, jadi jorokan peran pada span dibuang. Absen/null = keluaran sekarang.
        const indentTw = coverTitleIndentTw(ctx.tpl?.params ?? {});
        const lineFormat: ParaFormat | undefined = coverTitleLineFormat(ctx, indentTw === undefined ? undefined : { indRightTw: undefined });
        const html = lines
          .map((line, i) => el(ctx, "span", { classes: [`${C.coverTitle}-line`], role: i === lines.length - 1 && i > 0 ? "cover.titleLast" : "cover.titleFirst", format: lineFormat }, inlineHtml(line)))
          .join("<br>");
        const h1Style = indentTw === undefined ? "" : attr("style", paraDecl({ indRightTw: indentTw }).join(";"));
        return html ? `<h1 class="${C.heading} ${C.coverTitle}"${h1Style}>${html}</h1>` : "";
      }
      case "standfirst":
        return hasInline(data.standfirst) ? el(ctx, "p", { classes: [C.paragraph, C.coverStandfirst], role: "cover.standfirst" }, inlineHtml(data.standfirst)) : "";
      case "baris cakupan": {
        const text = paramStr(ctx, "cover.scopeLine", "");
        const k = hasInline(data.scopeLine) ? inlineHtml(data.scopeLine) : escapeHtml(text);
        return k ? el(ctx, "p", { classes: [C.paragraph, C.coverScope], role: "cover.scopeLine" }, k) : "";
      }
      case "blok kendali": {
        const cb = isObj(data.control) ? data.control : autoControlBlock(ctx);
        return cb ? controlBlockHtml(ctx, withClassificationLine(ctx, cb), null) : "";
      }
      case "kolofon": {
        const c = isObj(data.colophon) ? data.colophon : autoColophon(ctx);
        return c ? colophonHtml(ctx, withIssueStamp(ctx, c), null) : "";
      }
      case "string punggung": {
        // FIX-F C2: kenop USER "Tampilkan string punggung" (`device.spine.enabled`) + penempatan, seperti DOCX.
        if (!spinePlaced(ctx.tpl?.params ?? {}, "margin luar sampul")) return "";
        const k = hasInline(data.identityString) ? inlineHtml(data.identityString) : escapeHtml(spineText(ctx));
        return k ? spineStringHtml(ctx, k, [C.coverIdentity]) : "";
      }
      default:
        return "";
    }
  });
  return parts.join("");
}

/**
 * Sampul explicit (FIX-SERAH, D-295): badan apa adanya + aparatus templat (D-139)
 * yang tidak dibawa badan konten-saja, sama dengan perakit DOCX (engine/front/apparatus).
 */
function explicitCoverHtml(block: NormBlock, ctx: RenderContext, fp: FrontPage): string {
  // Row 123 (CP-14, CP-15): issue stamp and classification line also on an explicit body's colophon/control block (= DOCX row 122).
  const items = Array.isArray(fp.body)
    ? fp.body.map((it) => (isObj(it) && it.type === "colophon" ? withIssueStamp(ctx, it as unknown as Colophon) : isObj(it) && it.type === "controlBlock" ? withClassificationLine(ctx, it as unknown as ControlBlock) : it))
    : fp.body;
  const body = bodyHtml(block, ctx, items, frontAddressPrefix(block, "cover"));
  if (!Array.isArray(fp.body)) return body;
  const app = explicitCoverApparatus(ctx.tpl?.params ?? {}, fp.body);
  return (app.before.length > 0 ? coverAuto(block, ctx, {}, app.before) : "") + body + (app.after.length > 0 ? coverAuto(block, ctx, {}, app.after) : "");
}

export const renderCover: HtmlBlockRenderer = (block, base) => {
  const ctx = wrapperScope(base);
  const fp = contentOf<FrontPage>(ctx, block);
  if (!fp) return "";
  const inner =
    fp.mode === "explicit"
      ? explicitCoverHtml(block, ctx, fp)
      : coverAuto(block, ctx, isObj(fp.data) ? (fp.data as Partial<CoverData>) : {});
  return unit(block, "cover", C.cover, inner);
};

// ── Sampul belakang (C22 / CV-19) ────────────────────────────────────────

/**
 * Sampul belakang = DOCX `renderBackCover` (engine A C12): halaman pembungkus yang hanya memuat string punggung
 * berputar (perangkat yang sama dengan sampul dan pembatas, peran `cover.identityString`); manual tidak meminta
 * teks lain (DT-13f ID:2718-2723, EN:2766, EN:2778-2783). Predikat penempatan = DOCX `backCoverPlaced`. Unit
 * `F:backCover` ditambahkan perakit (`assemble/back-cover.ts`) hanya bila ada unit sampul dan lingkup DOCUMENT.
 */
export const renderBackCover: HtmlBlockRenderer = (block, base) => {
  const ctx = wrapperScope(base);
  let inner = "";
  if (backCoverPlaced(ctx.tpl?.params ?? {})) {
    const s = spineText(ctx);
    if (s) inner = spineStringHtml(ctx, escapeHtml(s), [C.coverIdentity]);
  } else {
    ctx.log({
      level: "warn",
      message: 'engine/html/blocks: sampul belakang tanpa penempatan "sampul belakang" di device.spine.placements; string punggung dilewati',
      code: "BY_CONSTRUCTION_FAILED",
      address: block.address ?? block.blockId,
    });
  }
  return unit(block, "backCover", C.cover, inner);
};

// ── Lembar kendali ───────────────────────────────────────────────────────

/** Inline bertulisan (padanan DOCX `hasText`): bentuk Inline sah dan teks polos tidak kosong. */
function hasText(v: unknown): v is Inline {
  return hasInline(v) && inlinePlain(v).trim() !== "";
}

/**
 * Row 123 (C40 FIX CP-06, ID p.48): TERBIT/SERAH control sheet parts absent from the document payload come from
 * template data (same rule as DOCX row 122 `withControlSheetTemplateData`): the verification chain completed to the
 * P4K-02 layers with empty result cells, the method statement R-81, the distribution R-82. Document parts win.
 */
function withControlSheetTemplateData(ctx: RenderContext, data: Partial<ControlSheetData>): Partial<ControlSheetData> {
  if (!isFullWrapperTier(ctx.snapshot?.doc?.meta)) return data;
  const params = ctx.tpl?.params ?? {};
  const t = controlSheetTemplateData(params);
  const out: Partial<ControlSheetData> = { ...data };
  if (isObj(out.verificationChain)) out.verificationChain = completedVerificationChainTable(out.verificationChain, t.layers);
  // Wave 165 row 165A (C188 F113-4, ID p.48): no document/template method statement -> the one built from the layers (= DOCX).
  const method = t.method ?? defaultMethodStatementText(t.layers, language(ctx));
  if (!hasText(out.methodStatement) && method) out.methodStatement = runText(method);
  if (!isObj(out.distribution) && t.distribution.length > 0) out.distribution = controlSheetTextTable(controlSheetDistributionHeads(params, language(ctx)), t.distribution);
  return out;
}

/**
 * Row 123 (C40 FIX CP-06/CP-09, ID p.10 DT-02, p.48): three signature columns from template data P4K-05/P4K-06 on
 * the TERBIT/SERAH control sheet when the document sends no signature block (a document `front.signature` is placed
 * in the control-sheet unit by normalize and rendered by `renderSignatureBlock`). Order: cover, control sheet with
 * signatures, contents.
 */
function templateSignatureHtml(ctx: RenderContext): string {
  const doc = ctx.snapshot?.doc;
  if (!isFullWrapperTier(doc?.meta) || doc?.front?.signature) return "";
  const roles = controlSheetTemplateData(ctx.tpl?.params ?? {}).signatures;
  if (roles.length === 0) return "";
  const s: SignatureBlock = { type: "signatureBlock", roles: roles.map((r) => ({ role: runText(r.role), holder: runText(r.holder) })) } as SignatureBlock;
  return signatureHtml(ctx, effectiveSignature(ctx, s), null);
}

export const renderControlSheet: HtmlBlockRenderer = (block, base) => {
  const ctx = wrapperScope(base);
  const fp = contentOf<FrontPage>(ctx, block);
  if (!fp) return "";
  const prefix = frontAddressPrefix(block, "controlSheet");
  if (fp.mode === "explicit") {
    // Row 123 (CP-09): an explicit body without a signature block still gets the template signatures (= DOCX row 122).
    const hasSig = Array.isArray(fp.body) && fp.body.some((it) => isObj(it) && it.type === "signatureBlock");
    return unit(block, "controlSheet", C.controlSheet, bodyHtml(block, ctx, fp.body, prefix) + (hasSig ? "" : templateSignatureHtml(ctx)));
  }
  const d = withControlSheetTemplateData(ctx, (isObj(fp.data) ? fp.data : {}) as Partial<ControlSheetData>);
  const lang = language(ctx);
  // FIX-2 (F-055): teks bawaan = DOCX `autoControlSheetItems` lewat sumber bersama engine/front/texts:
  // kicker "Lembar Kendali", judul = meta.title, judul blok "A · Riwayat revisi" berhuruf urut hanya untuk blok yang ada.
  let h = 0;
  const heading = (kind: ControlSheetBlockKind) =>
    el(ctx, "h3", { classes: [C.heading, C.blockHeading], role: "controlSheet.blockHeading" }, escapeHtml(controlSheetBlockHeading(h++, kind, lang)));
  const parts: string[] = [sealBandHtml(ctx, {})];
  parts.push(el(ctx, "p", { classes: [C.paragraph, C.frontKicker], role: "front.kicker" }, hasInline(d.kicker) ? inlineHtml(d.kicker) : escapeHtml(controlSheetKickerText(lang))));
  const metaTitle = ctx.snapshot?.doc?.meta?.title;
  const title = hasInline(d.title) ? inlineHtml(d.title) : typeof metaTitle === "string" ? escapeHtml(metaTitle) : "";
  if (title) parts.push(el(ctx, "h2", { classes: [C.heading, C.frontTitle], role: "front.pageTitle" }, title));
  // C22 / CS-12 (R-67, opt-in): subjudul tabel teks sesudah judul, peran `cover.standfirst` (= DOCX
  // `autoControlSheetItems` C08). Absen/false = tanpa paragraf.
  if (paramBool(ctx, "controlSheet.subtitle.enabled", false)) {
    parts.push(el(ctx, "p", { classes: [C.paragraph, C.coverStandfirst], role: "cover.standfirst" }, escapeHtml(WRAPPER_TEXT.controlSubtitle[lang])));
  }
  let n = 0;
  const next = () => `${prefix}/${++n}`;
  if (isObj(d.revisionHistory)) parts.push(heading("revision"), tableHtml(block, ctx, d.revisionHistory, 0, next()));
  if (isObj(d.verificationChain)) parts.push(heading("verification"), tableHtml(block, ctx, d.verificationChain, 1, next()));
  if (hasText(d.methodStatement)) {
    parts.push(heading("method"), el(ctx, "p", { classes: [C.paragraph, C.methodStatement], role: "controlSheet.methodStatement", address: next() }, inlineHtml(d.methodStatement, DEFAULT_MD_ROLES, semanticTransform(ctx, "controlSheet.methodStatement", baseRun(ctx, "controlSheet.methodStatement")))));
  }
  if (isObj(d.distribution)) parts.push(heading("distribution"), tableHtml(block, ctx, d.distribution, 3, next()));
  const sig = templateSignatureHtml(ctx);
  if (sig) parts.push(sig);
  return unit(block, "controlSheet", C.controlSheet, parts.join(""));
};

// ── Daftar isi ───────────────────────────────────────────────────────────

/** Label bagian efektif (FIX-SERAH, D-295): label konten berteks, selain itu label bawaan mesin (sama dengan DOCX). */
function partLabelOf(ctx: RenderContext, label: unknown, id: unknown): Inline {
  return hasText(label) ? label : { text: defaultPartLabelText(String(id), language(ctx)) };
}

/** Teks polos kicker konten seperti DOCX `inlinePlain` (penanda md-lite dibuang). */
function plainKicker(k: Inline): string {
  return "runs" in k ? inlinePlain(k) : k.text.replace(/\*\*|\*|`/g, "");
}

/**
 * Label bab/lampiran di daftar isi dan daftar bab pembatas (FIX-2, F-055): sama dengan DOCX
 * `chapterLabel` = teks kicker konten bila ada, selain itu "Bab n" / "Lampiran X" (engine/front/texts).
 */
function chapterLabelOf(ctx: RenderContext, c: Chapter, key: string, appendix: boolean): string {
  // IMPL-W4: kicker kosong eksplisit (penomoran sumber; nomor ada di judul) = label kosong (sama dengan DOCX).
  if (kickerSuppressed(c.kicker)) return "";
  return hasText(c.kicker) ? plainKicker(c.kicker) : chapterLabelText(key, appendix, language(ctx));
}

/** Entri TOC turunan + jangkar sasarannya (FIX-H4); tingkat boleh `section` (FIX-T2). */
type TocRowHtml = Omit<TocEntry, "level"> & { level: TocEntry["level"] | "section"; anchor?: string };

/**
 * Entri daftar isi turunan struktur = kerangka DOCX `tocOutline` (C14: bab tanpa bagian,
 * bagian + babnya, lampiran; section tingkat 2 sesudah bab/lampirannya, tingkat = `toc.levels`).
 * Jangkar section = id kepala section `text.ts` (`st-sec-<nomor, titik jadi tanda hubung>`).
 */
function chapterTitleEntries(ctx: RenderContext): TocRowHtml[] {
  if (!ctx.snapshot?.doc) return [];
  return tocOutline(ctx).map((node): TocRowHtml => {
    switch (node.level) {
      case "part": {
        // FIX-SERAH (D-295): label bawaan sama dengan pembatas bagian bila konten tanpa label (compose v2).
        const p = node.part;
        return { level: "part", label: partLabelOf(ctx, p.label, p.id), title: p.title, page: "", anchor: typeof p.id === "string" ? tocAnchorId("st-part", p.id) : undefined };
      }
      case "section":
        return { level: "section", label: { runs: [{ t: node.number }] }, title: node.section.title, page: "", anchor: tocAnchorId("st-sec", (node.number || node.address).replace(/\./g, "-")) };
      default: {
        const appendix = node.level === "appendix";
        return {
          level: node.level,
          label: { runs: [{ t: chapterLabelOf(ctx, node.chapter, node.key, appendix) }] },
          title: node.chapter.title,
          page: "",
          anchor: tocAnchorId(appendix ? "st-app" : "st-ch", node.key),
        };
      }
    }
  });
}

/**
 * Sel entri daftar isi dengan peran tingkatnya (FIX-TL, padanan DOCX `entryRoles` + `roleFormat`).
 * Peran turunan (`toc.section*`, `toc.appendix*`) mewarisi sub-objek templat peran bab yang
 * tidak disetelnya sendiri. Section lalu diturunkan seperti DOCX: run 1 pt lebih kecil (ukuran
 * bab - 1 pt, atau relatif `1em - 1pt` bila bab tanpa ukuran) dan indentasi tingkat 2
 * (`tocSectionIndentTw`) pada label dan judul. Indentasi ditulis di pembungkus isi karena
 * `margin-left` tidak berlaku pada sel tabel.
 */
function tocCellHtml(ctx: RenderContext, role: RoleKey, cls: string, inner: string, col: number): string {
  const parentRole = TOC_ROLE_PARENT[role];
  if (!parentRole) return el(ctx, "td", { classes: [cls], role }, inner);
  // ENG-01: `own` = sub-objek yang DITULIS templat untuk peran ini; `parent` = format EFEKTIF
  // peran bab (benchmark <- katalog <- templat), sama dengan DOCX `roleFormat` FIX-TL.
  const own: RoleFormat = ctx.tpl?.roleFormats?.[role] ?? {};
  const parent = roleFormat(ctx, parentRole);
  if (!isTocSectionRole(role)) {
    return el(ctx, "td", { classes: [cls], role, format: own.para ? undefined : parent.para, run: own.run ? undefined : parent.run }, inner);
  }
  const para = own.para ?? parent.para;
  const parentRun = parent.run;
  const derivedSz = tocSectionSize(parentRun?.szHalfPt);
  const run = own.run ? undefined : parentRun ? { ...parentRun, ...(derivedSz !== undefined ? { szHalfPt: derivedSz } : {}) } : undefined;
  const wrap: string[] = [];
  if (col !== 2) {
    const indentTw = own.para ? (own.para.indLeftTw ?? 0) : tocSectionIndentTw(ctx.tpl?.params) + (parent.para?.indLeftTw ?? 0);
    if (indentTw > 0) wrap.push("display:block", `padding-left:${num(indentTw / 20)}pt`);
  }
  if (!own.run && derivedSz === undefined) wrap.push(`font-size:calc(1em - ${num(TOC_SECTION_SIZE_STEP_HALFPT / 2)}pt)`);
  const body = wrap.length > 0 ? `<span style="${wrap.join(";")}">${inner}</span>` : inner;
  return el(ctx, "td", { classes: [cls], role, format: { ...(own.para ? {} : para), indLeftTw: undefined }, run }, body);
}

export const renderToc: HtmlBlockRenderer = (block, base) => {
  const ctx = wrapperScope(base);
  const t = contentOf<TocSpec>(ctx, block);
  if (!t) return "";
  const parts: string[] = [];
  parts.push(isDevice(t.sealBand) ? renderDevice(childBlock(block, "device", t.sealBand, 0, null), ctx, t.sealBand) : sealBandHtml(ctx, {}));
  // FIX-2 (F-055): sama dengan DOCX renderToc (C6): kicker bawaan "Daftar Isi" / "Contents" (engine/front/texts),
  // judul hanya bila ada (kenop render.toc.title, RQ-8; tanpa judul bawaan), entri, lalu catatan di bawah tabel.
  parts.push(el(ctx, "p", { classes: [C.paragraph, C.frontKicker], role: "front.kicker" }, hasInline(t.kicker) ? inlineHtml(t.kicker) : escapeHtml(tocKickerText(language(ctx)))));
  if (hasText(t.title)) parts.push(el(ctx, "h2", { classes: [C.heading, C.tocTitle], role: "toc.title" }, inlineHtml(t.title)));
  // Entri konten bila ada (mode apa pun), selain itu turunan struktur (DOCX: `entries` kosong -> deriveTocEntries).
  const given: TocRowHtml[] = Array.isArray(t.entries) ? t.entries.filter(isObj) : [];
  const entries = given.length > 0 ? given : chapterTitleEntries(ctx);
  const rows = entries.map((e) => {
    // FIX-TL: peran per tingkat = sumber bersama DOCX (`tocEntryRoles`); section = toc.section*,
    // lampiran = toc.appendix* hanya bila templat menyetelnya (selain itu peran bab, keluaran lama).
    const roles = tocEntryRoles(e.level, ctx.tpl?.roleFormats);
    const title = e.anchor ? `<a class="${C.tocLink}" href="#${e.anchor}">${inlineHtml(e.title)}</a>` : inlineHtml(e.title);
    return `<tr class="${C.tocRow}"${attr("data-level", e.level)}>${tocCellHtml(ctx, roles[0], C.tocLabel, inlineHtml(e.label), 0)}${tocCellHtml(ctx, roles[1], C.tocEntryTitle, title, 1)}${tocCellHtml(ctx, roles[2], C.tocPage, escapeHtml(typeof e.page === "string" ? e.page : ""), 2)}</tr>`;
  });
  parts.push(`<table class="${C.tocTable}"><tbody>${rows.join("")}</tbody></table>`);
  if (hasText(t.note)) parts.push(el(ctx, "p", { classes: [C.paragraph, C.tocNote], role: "toc.note" }, inlineHtml(t.note)));
  return unit(block, "toc", C.toc, parts.join(""), "nav");
};

// ── Pembatas bagian ──────────────────────────────────────────────────────

/**
 * Lede pembatas bagian pada moda rel K2 (A + `framePr`, FIX-T2/D-350; padanan DOCX `partLedeXml`
 * dan `k2Format` text.ts FIX-R1): margin kanan PERAN yang sama dengan cadangan rel dibuang.
 * `table3col` (Manual 000) dan moda B: undefined (format peran apa adanya).
 */
function partLedeK2Format(ctx: RenderContext): ParaFormat | undefined {
  const reserve = railK2ReserveOf((k) => ctx.tpl?.params?.[k]);
  return reserve !== undefined && roleFormat(ctx, "part.lede").para?.indRightTw === reserve ? { indRightTw: undefined } : undefined;
}

export const renderPartDivider: HtmlBlockRenderer = (block, base) => {
  const ctx = wrapperScope(base);
  const p = contentOf<PartSpec>(ctx, block);
  if (!p) return "";
  const partAnchor = typeof p.id === "string" ? tocAnchorId("st-part", p.id) : undefined;
  if (Array.isArray(p.body) && p.body.length > 0) return unit(block, "part", C.part, bodyHtml(block, ctx, p.body, null), "section", partAnchor);
  const parts: string[] = [sealBandHtml(ctx, {})];
  const label = partLabelOf(ctx, p.label, p.id);
  parts.push(el(ctx, "p", { classes: [C.paragraph, C.partKicker], role: "wrapper.kicker" }, inlineHtml(label)));
  // FIX-F C2: Datum Rule pembatas hanya bila penempatan `pembatas` (DOCX `autoPartBody`).
  if (datumRulePlaced(ctx.tpl?.params ?? {}, "pembatas")) {
    parts.push(datumRuleHtml(ctx, "wrapper.datumRule", requiredParamMm(ctx, block, WRAPPER_DATUM_RULE_KEYS, "lebar Datum Rule pembungkus")));
  }
  if (hasInline(p.title)) parts.push(el(ctx, "h2", { classes: [C.heading, C.partTitle], role: "part.title" }, inlineHtml(p.title)));
  if (hasInline(p.lede)) parts.push(el(ctx, "p", { classes: [C.paragraph, C.partLede], role: "part.lede", format: partLedeK2Format(ctx) }, inlineHtml(p.lede)));
  const keys = Array.isArray(p.chapterKeys) ? p.chapterKeys.filter((k) => typeof k === "string") : [];
  if (p.showChapterList !== false && keys.length > 0) {
    const chapters = Array.isArray(ctx.snapshot?.doc?.chapters) ? ctx.snapshot.doc.chapters : [];
    const apps = Array.isArray(ctx.snapshot?.doc?.appendices) ? ctx.snapshot.doc.appendices : [];
    // FIX-2 (F-055): label = DOCX partChapterList/chapterLabel ("Bab 1" atau teks kicker); kunci tak dikenal dilewati (DOCX ADDRESS_NOT_FOUND).
    const rows = keys.flatMap((k) => {
      const ci = chapters.findIndex((c, i) => (c.key ?? String(i + 1)) === k);
      const ai = ci >= 0 ? -1 : apps.findIndex((a, i) => (a.key ?? String.fromCharCode(65 + i)) === k);
      const ch = ci >= 0 ? chapters[ci] : ai >= 0 ? apps[ai] : undefined;
      if (!ch) {
        ctx.log({ level: "warn", message: `engine/html/blocks: chapterKeys "${k}" pada bagian ${String(p.id)} tidak menunjuk bab mana pun`, code: "ADDRESS_NOT_FOUND", address: block.address ?? block.blockId });
        return [];
      }
      const label = chapterLabelOf(ctx, ch, k, ci < 0);
      return [`<tr>${el(ctx, "td", { classes: [C.partChapterNo], role: "part.chapterNo" }, escapeHtml(label))}${el(ctx, "td", { classes: [C.partChapterTitle], role: "part.chapterTitle" }, inlineHtml(ch.title))}</tr>`];
    });
    parts.push(`<table class="${C.partChapters}"><tbody>${rows.join("")}</tbody></table>`);
  }
  // FIX-F C2: string punggung pembatas bila badan tidak dikirim dan penempatan `pembatas`, sama dengan DOCX
  // renderPartDivider (`!part.body`: badan larik kosong memakai badan bawaan tetapi tanpa string punggung).
  if (!p.body && spinePlaced(ctx.tpl?.params ?? {}, "pembatas")) {
    const s = spineText(ctx);
    if (s) parts.push(spineStringHtml(ctx, escapeHtml(s)));
  }
  return unit(block, "part", C.part, parts.join(""), "section", partAnchor);
};

// ── Blok tanda tangan ────────────────────────────────────────────────────

export const renderSignatureBlock: HtmlBlockRenderer = (block, base) => {
  const ctx = wrapperScope(base);
  const sent = contentOf<SignatureBlock>(ctx, block, "signatureBlock");
  if (!sent) return "";
  // CS-06: dengan opt-in, blok tanpa peran menjadi tiga kolom bawaan (= DOCX); tanpa opt-in tetap ditolak.
  const s = effectiveSignature(ctx, sent);
  if (!Array.isArray(s.roles) || s.roles.length === 0) return reportBad(ctx, block, "roles kosong");
  return signatureHtml(ctx, s, block.address, block.blockId);
};
