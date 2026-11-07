/**
 * Kerangka dokumen HTML (S21; I10 `htmlShell`): `<!DOCTYPE>`, `<head>` dengan
 * CSS fon + token + perabot halaman, `<body>` berkelas moda rel.
 *
 * Masukan badan berasal dari perakit S24 (D-45): unit alir
 * `<section class="st-unit st-unit-<kind>" data-unit data-unit-key
 * [data-header] [data-footer]>`. Untuk setiap unit, `htmlShell`:
 * - menyusun halaman `@page` bernama (`st-u-<i>`) dengan kotak margin running
 *   head (kiri entitas/jenis, tengah "BAB n · judul" dari kepala bab S22,
 *   kanan klasifikasi) dan blok register "LEMBAR counter(page) DARI
 *   counter(pages)" sesuai mode `data-header`/`data-footer`;
 * - menyisipkan salinan perabot `.st-screen` (tampil hanya di layar) tepat
 *   setelah tag pembuka unit.
 * Lembar `.page` (mode berhalaman, `pageSheet`) memakai halaman `st-sheet`
 * bermargin nol; perabotnya ada di markup lembar itu sendiri.
 *
 * Tanpa skrip dan tanpa URL: CSS fon yang masuk diperiksa (hanya `data:`),
 * nilai teks masuk CSS lewat `cssString` dan masuk HTML lewat `esc`.
 */
import type { DocMeta, ResolvedTemplate } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { PARAMS_BY_KEY } from "../../../params";
import { railModeFor } from "../../tokens";
import { normalizeHex } from "../../tokens/color";
import { classificationLineText, classificationMarkText, datumRuleLeadMm, wrapperLangOf } from "../../front/texts";
import { sheetNumberingFromChapter1 } from "../../docx/package/section";
import { PARAM_RAIL_RESERVE_COLUMN, railK2ReserveOf } from "../../docx/blocks/rail";
import { buildTokenCss, fontStack, typeSpec } from "./css";
import { cssString } from "./fonts";
import { esc, registerCellParts, registerFieldValue, registerHtml, runningHeadHtml, runningHeadText, type RunningHeadText } from "./markup";
import { classificationColour, colour, mm, num, P, pageGeometry, pt, r4, record } from "./params";

/** Jenis unit berpalet pembungkus (R-09 `render.section.wrapper`). */
const WRAPPER_KINDS = new Set(["cover", "controlSheet", "part"]);

type HeaderMode = "runningHead" | "none";
type FooterMode = "registerBlock" | "none";

export interface ShellUnit {
  index: number;
  kind: string;
  key?: string;
  header: HeaderMode;
  footer: FooterMode;
  center: string;
  wrapper: boolean;
  /** Posisi akhir tag pembuka di `bodyHtml`. */
  openEnd: number;
  /**
   * Row 123 (CP-11): wrapper unit before the first chapter of a document numbered from Bab 1 (ID edition, or R-80
   * "bab1"): its pages set the sheet counter to 0 and carry no register block, so Bab 1 prints LEMBAR 1.
   */
  beforeSheetOne?: boolean;
  /**
   * Wave 165 row 165A (C188 F113-7): an interior unit before Bab 1 (the contents) keeps its register block but prints
   * no sheet number (ID p.48: numbering starts at Bab 1; the original printed the register from p3 to the end).
   */
  sheetless?: boolean;
}

const ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[2];
  return out;
}

function hasClass(attrs: Record<string, string>, cls: string): boolean {
  return (attrs.class ?? "").split(/\s+/).includes(cls);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Teks polos dari potongan HTML yang sudah di-escape (tag dibuang, entitas diurai, spasi dipadatkan). */
export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
      if (e[0] === "#") {
        const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return NAMED_ENTITIES[e] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Teks elemen pertama berkelas `cls` di potongan (tag penutup = tag pembuka yang sama, tanpa sarang sejenis). */
function firstText(slice: string, cls: string): string {
  const re = new RegExp(`<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bclass="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>`, "g");
  const m = re.exec(slice);
  if (!m) return "";
  const start = m.index + m[0].length;
  const end = slice.indexOf(`</${m[1]}`, start);
  return htmlToText(slice.slice(start, end < 0 ? undefined : end));
}

/** Mode seksi templat (`render.section.wrapper|interior`) untuk `inherit`/absen. */
function templateModes(tpl: ResolvedTemplate, wrapper: boolean): { header: string; footer: string } {
  const s = record(tpl.params[wrapper ? P.sectionWrapper : P.sectionInterior]);
  const h = record(s?.header)?.mode;
  const f = record(s?.footer)?.mode;
  return {
    header: typeof h === "string" ? h : wrapper ? "empty" : "runningHead",
    footer: typeof f === "string" ? f : wrapper ? "empty" : "registerBlock",
  };
}

/** Pindai unit `.st-unit` (S24) di badan. Mode `custom` diperlakukan kosong (isi kustom tidak dirender di HTML). */
export function scanUnits(tpl: ResolvedTemplate, bodyHtml: string): ShellUnit[] {
  // P4S-10 blok register dimatikan -> tidak ada register di unit mana pun.
  const registerOn = tpl.params[P.registerEnabled] !== false;
  const opens: Array<{ attrs: Record<string, string>; start: number; end: number }> = [];
  for (const m of bodyHtml.matchAll(/<section\b[^>]*>/g)) {
    const attrs = attrsOf(m[0]);
    if (hasClass(attrs, "st-unit")) opens.push({ attrs, start: m.index, end: m.index + m[0].length });
  }
  return opens.map((o, i) => {
    const kind = o.attrs["data-unit"] ?? "";
    const wrapper = WRAPPER_KINDS.has(kind);
    const tm = templateModes(tpl, wrapper);
    const hRaw = o.attrs["data-header"] && o.attrs["data-header"] !== "inherit" ? o.attrs["data-header"] : tm.header;
    const fRaw = o.attrs["data-footer"] && o.attrs["data-footer"] !== "inherit" ? o.attrs["data-footer"] : tm.footer;
    const slice = bodyHtml.slice(o.end, i + 1 < opens.length ? opens[i + 1].start : undefined);
    const center = [firstText(slice, "st-chapter-kicker"), firstText(slice, "st-chapter-title")].filter(Boolean).join(" · ");
    return {
      index: i,
      kind,
      key: o.attrs["data-unit-key"] ? htmlToText(o.attrs["data-unit-key"]) : undefined,
      header: hRaw === "runningHead" ? "runningHead" : "none",
      footer: registerOn && fRaw === "registerBlock" ? "registerBlock" : "none",
      center,
      wrapper,
      openEnd: o.end,
    };
  });
}

/** Unit kinds that open the numbered body (Bab 1, or an appendix when the document has no chapter). */
const BODY_UNIT_KINDS = new Set(["chapter", "appendix"]);

/**
 * Row 123 (C40 FIX CP-11, ID p.48 "Sampul, lembar kendali, dan pembatas tidak bernomor. Penomoran lembar dimulai dari
 * halaman pertama Bab 1"; EN p.50 counts from the cover): same predicate as DOCX row 122 (`sheetNumberingFromChapter1`
 * with the document language). Units before the first chapter unit drop their register block (no sheet number on a
 * wrapper page) and reset the page counter; "DARI N" stays `counter(pages)`, the document total, as DOCX NUMPAGES.
 */
export function withSheetRestart(tpl: ResolvedTemplate, meta: DocMeta, units: readonly ShellUnit[]): ShellUnit[] {
  const first = units.findIndex((u) => BODY_UNIT_KINDS.has(u.kind));
  if (first <= 0 || !sheetNumberingFromChapter1(tpl.params, wrapperLangOf(meta))) return [...units];
  // Wave 165 row 165A (F113-7): the register of an interior unit before Bab 1 (contents) stays, without its sheet cell.
  return units.map((u, i) =>
    i < first ? (!u.wrapper && u.footer === "registerBlock" ? { ...u, beforeSheetOne: true, sheetless: true } : { ...u, footer: "none", beforeSheetOne: true }) : u,
  );
}

/** Wave 165 row 165A (F113-6): marker around the register "N" that the PDF print replaces with the numbered-sheet total. */
export const SHEET_TOTAL_MARK = { open: "/*st-N*/", close: "/*/st-N*/" } as const;
/**
 * Row 165I (C196, verification/24 M1): opening tag of the Studio-owned page-furniture `<style>` (the only block that
 * carries SHEET_TOTAL_MARK). services/render/pdf.ts substitutes the sheet total only inside this block, and only
 * outside CSS strings, so document text (escaped into attributes, text nodes or quoted CSS strings) stays inert.
 */
export const PAGES_STYLE_OPEN = '<style data-studio="pages">';

/**
 * Wave 165 row 165A (C188 F113-6, ID p.48 numbering from Bab 1): Chromium's `counter(pages)` is the document total
 * (LEMBAR 4 DARI 7 on case 01 with 3 unnumbered sheets). The PDF print (services/render/pdf.ts) prints once with this
 * style switched on (`media="all"`): the units before Bab 1 are hidden, so its page count is the number of numbered
 * sheets N; the final print replaces the marked `counter(pages)` with N. Inert (`media="not all"`) everywhere else.
 */
export function numberedPassStyle(units: readonly ShellUnit[]): string {
  const keys = units.filter((u) => u.beforeSheetOne && u.key !== undefined).map((u) => `.st-unit[data-unit-key=${cssString(u.key as string)}]`);
  return keys.length === 0 ? "" : `<style data-studio="pdf-numbered-pass" media="not all">${keys.join(",")}{display:none !important}</style>\n`;
}

const DATUM_RULE_SVG_RE = /<svg class="st-datum-rule"[^>]*\bviewBox="0 0 ([0-9.]+) [0-9.]+"[^>]*>[\s\S]*?<\/svg>/g;
const LEAD_LINE_RE = /(<line data-st-lead="1" x1="0" y1="[^"]*" x2=")([^"]*)(")/;

/**
 * Row 123 (C40 FIX CP-23, ID p.53 DT-13f; DATUM tokens `datum_rule_progress_gauge` fill = page / pages): the lead
 * segment of every Datum Rule is set to width x sheet / sheets. The sheet of a rule is the first sheet of its unit,
 * counted as the unit's position (every unit opens a new sheet), and the total is the unit count: the HTML is built
 * before Chromium paginates, so a unit that runs over several sheets is counted once (an estimate that grows with
 * the page and is exact when every unit is one sheet). Exact page numbers need a second, paginated pass (carried to
 * rows 42/43). Rules outside a unit keep their lead.
 */
export function withDatumRuleLeads(bodyHtml: string, units: readonly ShellUnit[]): string {
  if (units.length === 0) return bodyHtml;
  return bodyHtml.replace(DATUM_RULE_SVG_RE, (svg: string, w: string, offset: number) => {
    let idx = -1;
    for (const u of units) if (u.openEnd <= offset) idx = u.index;
    if (idx < 0) return svg;
    const lead = datumRuleLeadMm(Number(w), idx + 1, units.length);
    return svg.replace(LEAD_LINE_RE, (_m, a: string, _x: string, c: string) => `${a}${r4(lead)}${c}`);
  });
}

/** Jumlah lembar galai/berhalaman: elemen `.page` + unit `.st-unit` (keduanya menaikkan penghitung `st-sheet`). */
export function countSheets(bodyHtml: string): number {
  let n = 0;
  for (const m of bodyHtml.matchAll(/<[a-zA-Z][a-zA-Z0-9]*\b[^>]*\bclass="([^"]*)"[^>]*>/g)) {
    const cls = m[1].split(/\s+/);
    if (cls.includes("page") || cls.includes("st-unit")) n++;
  }
  return n;
}

/** Jumlah sitasi rel (S22 `.st-rail`, RL `.r`) untuk moda rel `auto` (KT-07). */
export function countRailCitations(bodyHtml: string): number {
  let n = 0;
  for (const m of bodyHtml.matchAll(/\bclass="([^"]*)"/g)) {
    const cls = m[1].split(/\s+/);
    if (cls.includes("st-rail") || cls.includes("r")) n++;
  }
  return n;
}

/** R-72 (GF-22): warna garis bawah kepala halaman. */
const P_RUNNING_HEAD_RULE = "runningHead.ruleColour";
/** R-73 (GF-22): warna garis atas blok register. */
const P_REGISTER_TOP_RULE = "device.registerBlock.topRuleColour";

/**
 * Warna garis opt-in: hex sah (dinormalkan) yang BERBEDA dari bawaan registri, selain itu undefined. Profil
 * DATUM-kanonik membawa bawaan setiap kunci, jadi bawaan eksplisit harus = absen agar HTML tetap byte-sama
 * (garis HTML bawaan mengikuti token `--rule-hair-c` / `--ink900`, bukan konstanta DOCX INK200/INK900).
 */
function ruleColourOverride(tpl: ResolvedTemplate, key: string): string | undefined {
  const v = normalizeHex(tpl.params[key]);
  return v !== undefined && v !== normalizeHex(PARAMS_BY_KEY.get(key)?.default) ? v : undefined;
}

const BOXES = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] as const;
type Box = (typeof BOXES)[number];

/** Isi kotak register: sel ber-{n} di tengah, sel terakhir di kanan, sisanya digabung di kiri. */
function registerBoxes(tpl: ResolvedTemplate, meta: DocMeta, markTotal = false): Partial<Record<Box, string>> {
  const cells = registerCellParts(tpl, meta.language).map((parts) =>
    parts
      .map((part) => {
        if ("text" in part) return cssString(part.text);
        if (part.field === "n") return "counter(page)";
        // Wave 165 row 165A (F113-6): marked so the PDF print can put the numbered-sheet total in its place.
        if (part.field === "N") return markTotal ? `${SHEET_TOTAL_MARK.open}counter(pages)${SHEET_TOTAL_MARK.close}` : "counter(pages)";
        return cssString(registerFieldValue(meta, part.field, tpl));
      })
      .join(" "),
  );
  const parts = registerCellParts(tpl, meta.language);
  if (cells.length === 0) return {};
  const last = cells.length - 1;
  const centerIdx = parts.findIndex((c, i) => i !== last && c.some((x) => "field" in x && x.field === "n"));
  const left = cells.filter((_, i) => i !== last && i !== centerIdx);
  const out: Partial<Record<Box, string>> = {};
  // Pemisah antarsel di kotak gabungan: spasi em (P4S-12 `separator` untuk sel DOCX; HTML memakai jarak kolom).
  if (left.length > 0) out["bottom-left"] = left.join(' "\\2003" ');
  if (centerIdx >= 0) out["bottom-center"] = cells[centerIdx];
  if (cells.length > 1 || centerIdx < 0) out["bottom-right"] = cells[last];
  return out;
}

function boxDecl(box: Box, content: string | undefined, styles: Record<"top" | "bottom" | "class", string>, pre = false): string {
  if (content === undefined) return `@${box}{content:none}`;
  const base = box.startsWith("top") ? styles.top : styles.bottom;
  const extra = box === "top-right" || box === "bottom-right" ? styles.class : "";
  const align = box.endsWith("left") ? "left" : box.endsWith("right") ? "right" : "center";
  return `@${box}{content:${content};${base}${extra}${pre ? "white-space:pre;" : ""}text-align:${align}}`;
}

/** R-76 (CL-02 NOTA): baris klasifikasi di bawah nomor dokumen; absen/false = tanpa baris. */
const P_CLASSIFICATION_LINE = "render.nota.classificationLine";
/** Wave 165 row 165A for 165D (F113-12): the R-76 foot line is retired (see `classificationLine`). */
const FOOT_CLASSIFICATION_LINE_RETIRED = true;
/** Warna nilai klasifikasi (DT-28d, segel): token `color.wrapper.seal`, sama dengan DOCX C16 (cadangan INK900). */
const P_CLASSIFICATION_COLOUR = "color.wrapper.seal";

interface ClassificationLine {
  /** "Klasifikasi : " / "Classification: " (label + pemisah, tabel teks bersama). */
  label: string;
  /** Nilai kapital (`classificationMarkText`). */
  value: string;
  /** Indeks sel register berpola `{nomor}`. */
  cell: number;
  /** Kotak margin @page yang memuat sel itu (aturan `registerBoxes`). */
  box: Box;
}

/**
 * C22 / CL-02 NOTA (R-76, opt-in) = DOCX `classificationLineXml` (engine C C16): "Klasifikasi : <K>" /
 * "Classification: <K>" (`classificationLineText`, bahasa pembungkus dokumen) di bawah sel register yang memuat
 * `{nomor}`; sel register sendiri tidak berubah (RB-02/RB-03/RB-04). Tanpa sel `{nomor}` = tidak ada nomor untuk
 * diikuti: tanpa baris (DOCX mencatat `CLASSIFICATION_LINE_NO_NUMBER`; kerangka HTML tidak punya kanal log).
 */
function classificationLine(tpl: ResolvedTemplate, meta: DocMeta): ClassificationLine | undefined {
  // Wave 165 row 165A for row 165D (C188 F113-12, file request 165D -> 165A): no Klasifikasi line in the foot any
  // more (it belongs under the number in the cover control block, F56-1); = DOCX registerBody. R-76 stays accepted.
  if (FOOT_CLASSIFICATION_LINE_RETIRED || tpl.params[P_CLASSIFICATION_LINE] !== true) return undefined;
  const parts = registerCellParts(tpl, meta.language);
  const cell = parts.findIndex((c) => c.some((x) => "field" in x && x.field === "nomor"));
  if (cell < 0) return undefined;
  const value = classificationMarkText(meta.classification);
  const full = classificationLineText(meta.classification, wrapperLangOf(meta));
  const last = parts.length - 1;
  const centerIdx = parts.findIndex((c, i) => i !== last && c.some((x) => "field" in x && x.field === "n"));
  const box: Box = cell === centerIdx ? "bottom-center" : cell === last ? "bottom-right" : "bottom-left";
  return { label: full.slice(0, full.length - value.length), value, cell, box };
}

/**
 * CSS baris klasifikasi layar (hanya bila opt-in): tepat di bawah tepi bawah `.reg`, grid kolom yang sama
 * dengan `.reg` (4 kolom, sel mengalir) sehingga baris jatuh di bawah sel bernomor; jorokan = padding sel
 * `.reg > div` (2,5 mm; sel 1 rata tepi, = DOCX `registerCellLeftTw` 0 / 141 tw).
 */
function classificationLineCss(tpl: ResolvedTemplate, line: ClassificationLine): string {
  const seal = colour(tpl, P_CLASSIFICATION_COLOUR, "101418");
  return [
    `.reg-cls{position:absolute;left:var(--m-inner);right:var(--m-outer);top:calc(100% - var(--ftr));display:none;grid-template-columns:1fr 1fr 1fr auto;` +
      `font-family:var(--ff-registerBlock);font-size:var(--fs-registerBlock);font-weight:var(--fw-registerBlock);letter-spacing:.02em;color:var(--fc-registerBlock);white-space:pre}`,
    `.reg-cls > div{grid-column:${(line.cell % 4) + 1};padding-left:${line.cell === 0 ? "0" : "2.5mm"}}`,
    `.reg-cls b{color:${seal};font-weight:600}`,
    `@media screen{.st-unit > .reg-cls.st-screen{display:grid}}`,
  ].join("\n");
}

function classificationLineHtml(line: ClassificationLine): string {
  return `<div class="reg-cls st-screen"><div>${esc(line.label)}<b>${esc(line.value)}</b></div></div>`;
}

/** CSS halaman dinamis: properti dokumen, halaman `@page` per unit, kotak margin. */
export function pageFurnitureCss(tpl: ResolvedTemplate, meta: DocMeta, units: readonly ShellUnit[], sheets: number): string {
  const g = pageGeometry(tpl);
  const p = tpl.params;
  const rh = typeSpec(tpl, "runningHead");
  const rb = typeSpec(tpl, "registerBlock");
  const track = num(p, P.trackMicro) ?? 0.09;
  const classInk = classificationColour(tpl, meta);
  const styles = {
    // Running head: tepi atas teks pada `--hdr` dari tepi lembar (acuan RL 13 mm).
    top:
      `vertical-align:top;padding-top:${mm(g.headerMm)};font-family:${fontStack(tpl, rh.role)};font-size:${pt(rh.sizePt ?? 6.8)};` +
      `font-weight:${rh.weight};letter-spacing:${r4(track)}em;text-transform:${rh.upper ? "uppercase" : "none"};` +
      `color:${rh.colour ?? colour(tpl, "ink400", "6B7783")};`,
    // Register: kotak 8,5 mm (RL) yang tepi bawahnya `--ftr` dari tepi bawah lembar.
    bottom:
      `vertical-align:top;padding-top:${mm(Math.max(0, g.bottom - g.footerMm - 8.5) + 1.55)};font-family:${fontStack(tpl, rb.role)};` +
      `font-size:${pt(rb.sizePt ?? 6.2)};font-weight:${rb.weight};letter-spacing:.02em;color:${rb.colour ?? colour(tpl, "ink400", "6B7783")};`,
    class: `color:${classInk};font-weight:600;`,
  };
  const docRh = runningHeadText(tpl, meta);
  const line = classificationLine(tpl, meta);
  const reg = registerBoxes(tpl, meta, units.some((u) => u.beforeSheetOne));
  // CL-02 NOTA (cetak): baris kedua di kotak margin yang memuat nomor.
  if (line && reg[line.box] !== undefined) reg[line.box] = `${reg[line.box]} "\\A" ${cssString(line.label + line.value)}`;
  const headBoxes = (t: RunningHeadText): Partial<Record<Box, string>> => ({
    "top-left": t.left ? cssString(t.left) : undefined,
    "top-center": t.center ? cssString(t.center) : undefined,
    "top-right": t.right ? cssString(t.right) : undefined,
  });
  const pageRule = (name: string, head: Partial<Record<Box, string>>, foot: Partial<Record<Box, string>>, bg: string, extra = "") =>
    `@page${name ? ` ${name}` : ""}{background:${bg};${extra}` + BOXES.map((b) => boxDecl(b, head[b] ?? foot[b], styles, line !== undefined && foot === reg && b === line.box)).join("") + `}`;

  const interiorBg = colour(tpl, "color.interior.paper", "FCFCFB");
  const wrapperBg = colour(tpl, "color.wrapper.paper", "FBFAF7");
  const docModes = templateModes(tpl, false);
  const registerOn = p[P.registerEnabled] !== false;
  const out: string[] = [
    `:root{--st-sheets:${cssString(String(sheets))};--class-ink:${classInk}}`,
    // Halaman bawaan (isi di luar unit): mode seksi interior templat.
    pageRule("", docModes.header === "runningHead" ? headBoxes(docRh) : {}, registerOn && docModes.footer === "registerBlock" ? reg : {}, interiorBg),
    `@page st-sheet{background:${interiorBg};${BOXES.map((b) => `@${b}{content:none}`).join("")}}`,
  ];
  for (const u of units) {
    const name = `st-u-${u.index}`;
    const head = u.header === "runningHead" ? headBoxes({ ...docRh, center: u.center }) : {};
    // Wave 165 row 165A (F113-7): a sheetless unit (contents before Bab 1) prints the register without the sheet cell.
    const foot = u.footer === "registerBlock" ? (u.sheetless ? { ...reg, "bottom-center": undefined } : reg) : {};
    // Row 123 (CP-11): `counter-set:page 0` on every page of the units before Bab 1, so the first Bab 1 page counts 1
    // (Chromium 1234 probe p6: a counter-set on a named page holds on each of its pages and the count continues after).
    out.push(pageRule(name, head, foot, u.wrapper ? wrapperBg : interiorBg, u.beforeSheetOne ? "counter-set:page 0;" : ""));
    if (u.key !== undefined) out.push(`.st-unit[data-unit-key=${cssString(u.key)}]{page:${name}}`);
  }
  // C22 / GF-22 (R-72, R-73, opt-in): warna garis bawah kepala halaman dan garis atas blok register (perabot
  // layar `.runhead` / `.reg`), nilai sama dengan DOCX `runningHeadFormat` / `registerBody` (engine C C14).
  const headRule = ruleColourOverride(tpl, P_RUNNING_HEAD_RULE);
  if (headRule) out.push(`.runhead{border-bottom-color:#${headRule}}`);
  const regRule = ruleColourOverride(tpl, P_REGISTER_TOP_RULE);
  if (regRule) out.push(`.reg{border-top-color:#${regRule}}`);
  if (line) out.push(classificationLineCss(tpl, line));
  return out.join("\n");
}

/** Sisipkan salinan perabot layar (`.st-screen`) setelah tag pembuka tiap unit. */
export function withScreenFurniture(tpl: ResolvedTemplate, meta: DocMeta, bodyHtml: string, units: readonly ShellUnit[]): string {
  if (units.length === 0) return bodyHtml;
  const docRh = runningHeadText(tpl, meta);
  const line = classificationLine(tpl, meta);
  // CL-02 NOTA (layar): baris tepat sesudah register (absen = tanpa elemen).
  const reg = registerHtml(tpl, meta, "st-screen") + (line ? classificationLineHtml(line) : "");
  const pieces: string[] = [];
  let at = 0;
  for (const u of units) {
    pieces.push(bodyHtml.slice(at, u.openEnd));
    if (u.header === "runningHead") pieces.push(runningHeadHtml({ ...docRh, center: u.center }, "st-screen"));
    if (u.footer === "registerBlock") pieces.push(reg);
    at = u.openEnd;
  }
  pieces.push(bodyHtml.slice(at));
  return pieces.join("");
}

/** Tolak CSS fon yang bukan `@font-face` data: (KT-11: tanpa rujukan eksternal, tanpa keluar dari `<style>`). */
export function assertFontsCss(css: string): void {
  const issues: string[] = [];
  if (/<\/?style\b|<script\b|<!--/i.test(css)) issues.push("tag HTML di dalam CSS fon");
  if (/@import\b/i.test(css)) issues.push("@import");
  if (/expression\s*\(|javascript:/i.test(css)) issues.push("ekspresi/javascript");
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")\s]{0,40})/gi)) {
    if (!/^data:(font\/ttf|application\/font-sfnt)[;,]/i.test(m[2])) issues.push(`url bukan data: fon (${m[2].slice(0, 30)})`);
  }
  if (issues.length > 0) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "fontsCss tidak mandiri", { issues: [...new Set(issues)].sort() });
  }
}

/**
 * K2 rev B (FIX-R1, padanan DOCX `assertRailK2`): pada moda A dengan perender `framePr`
 * prosa tanpa rel selebar teks penuh; hanya inang (`.st-railhost`, grid kolom teks + rel)
 * yang menyempit. Menimpa batas `max-width:var(--col)` moda A lama. Tidak dipancarkan
 * untuk `table3col` (Manual 000) maupun moda B.
 */
const RAIL_K2_CSS =
  "body.st-rail-k2.st-rail-a :is(.st-p,.st-list,.st-aside,.st-monoblock,.st-asm,.st-section-heading):not(.st-railhost *){max-width:none}";

/**
 * C22b / GF-24 (R-75 `render.rail.reserveColumn`, opt-in; padanan DOCX C20 engine E): pada moda K2 kolom rel
 * dicadangkan di setiap unit interior (bukan WRAPPER_KINDS DOCX cover/controlSheet/toc/part), jadi unsur yang DOCX
 * persempit (`plainHostVariant`/`withReservedColumn`: paragraf, daftar, asumsi, register sumber, placeholder slot,
 * kicker/judul bab, kepala section) kembali selebar kolom teks `--col` meski tanpa chip; spesifisitas lebih tinggi
 * dari `RAIL_K2_CSS`. Tidak dipersempit, sama dengan DOCX: aside/monoBlock, isi tabel/figur, inang chip (grid kolom
 * teks + rel sendiri), pembuka lampiran (DOCX `wrapper/pages.ts`). Caption/SUMBER tabel <= kolom teks ikut lewat
 * penanda `data-rail-reserve` (tables/table.ts, predikat DOCX `apparatusReserveTw`); figur sudah membatasi caption
 * selebar figur (`max-width` figur).
 */
const RAIL_RESERVE_CSS = [
  "body.st-rail-k2.st-rail-a .st-unit:not(.st-unit-cover,.st-unit-controlSheet,.st-unit-toc,.st-unit-part) " +
    ":is(.st-p,.st-list,.st-asm,.st-srcreg-entry,.st-placeholder,.st-chapter-kicker,.st-chapter-title,.st-section-heading)" +
    ":not(.st-railhost *,.st-aside *,.st-monoblock *,.st-table *,.st-figure *,.st-appendix-head *){max-width:var(--col)}",
  "body.st-rail-k2.st-rail-a .st-table[data-rail-reserve] > :is(.st-caption,.st-source){max-width:var(--col)}",
].join("\n");

export interface HtmlShellInput {
  tpl: ResolvedTemplate;
  meta: DocMeta;
  bodyHtml: string;
  fontsCss: string;
  previewLabel?: boolean;
}

/** Dokumen HTML lengkap; deterministik untuk masukan yang sama. */
export function buildHtmlShell(i: HtmlShellInput): string {
  const { tpl, meta } = i;
  assertFontsCss(i.fontsCss);
  // Row 123 (CP-23): Datum Rule leads first (the body changes length), then the unit scan used by the furniture.
  const bodyHtml = withDatumRuleLeads(i.bodyHtml, scanUnits(tpl, i.bodyHtml));
  const units = withSheetRestart(tpl, meta, scanUnits(tpl, bodyHtml));
  const sheets = countSheets(bodyHtml);
  // P4S-07 rel dimatikan -> moda B (tanpa kolom rel); selain itu KT-07 via S11.
  const rail = tpl.params[P.railEnabled] === false ? "B" : railModeFor(tpl, countRailCitations(bodyHtml));
  const body = withScreenFurniture(tpl, meta, bodyHtml, units);
  const en = meta.language === "EN";
  const label = i.previewLabel
    ? `<div class="st-preview-label" role="note">${esc(en ? "Preview · not an issued document" : "Pratinjau · bukan dokumen terbit")}</div>`
    : "";
  const title = `${i.previewLabel ? (en ? "[PREVIEW] " : "[PRATINJAU] ") : ""}${meta.title}`;
  const docNo = meta.docNumber?.trim();
  const metaTags = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="generator" content="GSP Studio engine/html/base">`,
    docNo ? `<meta name="studio:doc-number" content="${esc(docNo)}">` : "",
    `<meta name="studio:revision" content="${esc(meta.rev)}">`,
    `<meta name="studio:classification" content="${esc(meta.classification)}">`,
    `<meta name="studio:issue-date" content="${esc(meta.issueDate)}">`,
  ].join("");
  const k2 = rail === "A" && railK2ReserveOf((k) => tpl.params[k]) !== undefined;
  const flags = ["st-doc", `st-rail-${rail === "B" ? "b" : "a"}`, k2 ? "st-rail-k2" : "", i.previewLabel ? "st-preview" : ""].filter(Boolean);
  // C22b / GF-24: kolom rel tercadang hanya di samping K2 (= DOCX `resolveRailLayout` reserveColumn); absen/false = tanpa aturan.
  const reserve = k2 && tpl.params[PARAM_RAIL_RESERVE_COLUMN] === true;
  return (
    `<!DOCTYPE html>\n` +
    `<html lang="${en ? "en" : "id"}"><head>${metaTags}<title>${esc(title)}</title>\n` +
    `<style data-studio="fonts">\n${i.fontsCss}\n</style>\n` +
    `<style data-studio="tokens">\n${buildTokenCss(tpl)}</style>\n` +
    `${PAGES_STYLE_OPEN}\n${pageFurnitureCss(tpl, meta, units, sheets)}${k2 ? `\n${RAIL_K2_CSS}` : ""}${reserve ? `\n${RAIL_RESERVE_CSS}` : ""}\n</style>\n` +
    numberedPassStyle(units) +
    `</head>\n<body class="${flags.join(" ")}" data-rail-mode="${rail}">${label}\n${body}\n</body></html>\n`
  );
}

/** Kotak margin `@page` yang disusun perabot halaman. */
export const SHELL_MARGIN_BOXES: readonly string[] = BOXES;
