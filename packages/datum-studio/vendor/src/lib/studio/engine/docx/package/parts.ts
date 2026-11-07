/**
 * Bagian XML paket inti yang dibangkitkan dari templat dan meta (S14, I03):
 * styles.xml minimal, settings.xml, docProps/core.xml, docProps/app.xml,
 * [Content_Types].xml, berkas .rels, fontTable.xml.
 *
 * Nilai bawaan = parameter renderer kontrak R-01..R-07 (src/lib/studio/params/render.ts);
 * pola target = BM.docx (research/07 §9).
 */
import type { DocMeta, FaceRole, ResolvedTemplate, RunProps } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { PARAMS_BY_KEY } from "../../../params";
import { normalizeHex } from "../../tokens/color";
import { escapeXml, paramBool, paramNumber, paramObject, paramString, R_NS, rPrXml, W_NS, XML_DECL } from "./xml";

/** R-30: gaya paragraf Header/Footer; tab diskalakan ke bentang efektif oleh engine/tokens (SR-60). */
const HF_STYLES_PARAM = "render.docx.headerFooterStyles";

interface HfStyleParam {
  basedOn?: unknown;
  tabs?: unknown;
  spacingAfterTw?: unknown;
  lineTw?: unknown;
  lineRule?: unknown;
}

function finiteInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
}

/**
 * pPr gaya Header/Footer dari R-30 efektif (M1 D-245): `tabs[{posTw,val}]`,
 * `spacingAfterTw`, `lineTw`, `lineRule`, `basedOn`. Nilai absen di templat = bawaan
 * registri R-30 (A4 = 4680/9360, nilai yang dulu ditulis literal); entri gaya tidak
 * terbaca sama sekali = BY_CONSTRUCTION_FAILED.
 */
function hfStyleParam(tpl: ResolvedTemplate, id: "Header" | "Footer"): HfStyleParam {
  const fromTpl = paramObject(tpl.params, HF_STYLES_PARAM)?.[id];
  const def = PARAMS_BY_KEY.get(HF_STYLES_PARAM)?.default;
  const fromDef = def !== null && typeof def === "object" && !Array.isArray(def) ? (def as Record<string, unknown>)[id] : undefined;
  const s = fromTpl ?? fromDef;
  if (s === null || typeof s !== "object" || Array.isArray(s)) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Gaya ${id} tidak terbaca: ${HF_STYLES_PARAM}.${id} wajib ada di parameter templat`, {
      key: HF_STYLES_PARAM,
      style: id,
    });
  }
  return s as HfStyleParam;
}

function hfStylePPr(s: HfStyleParam): string {
  const tabs = Array.isArray(s.tabs)
    ? s.tabs
        .map((t) => (t !== null && typeof t === "object" ? (t as { posTw?: unknown; val?: unknown }) : {}))
        .filter((t) => finiteInt(t.posTw) !== undefined && typeof t.val === "string")
        .map((t) => `<w:tab w:val="${escapeXml(t.val as string)}" w:pos="${finiteInt(t.posTw)}"/>`)
        .join("")
    : "";
  const after = finiteInt(s.spacingAfterTw);
  const line = finiteInt(s.lineTw);
  const rule = typeof s.lineRule === "string" ? s.lineRule : undefined;
  const spacing =
    after !== undefined || line !== undefined || rule !== undefined
      ? `<w:spacing${after !== undefined ? ` w:after="${after}"` : ""}${line !== undefined ? ` w:line="${line}"` : ""}${rule !== undefined ? ` w:lineRule="${escapeXml(rule)}"` : ""}/>`
      : "";
  return `<w:pPr>${tabs ? `<w:tabs>${tabs}</w:tabs>` : ""}${spacing}</w:pPr>`;
}

// ── Relasi dan tipe isi ─────────────────────────────────────────────────

export const REL = {
  officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  coreProps: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  extendedProps: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
  customXml: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml",
  numbering: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
  styles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
  settings: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings",
  webSettings: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings",
  fontTable: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable",
  theme: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
  header: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
  footer: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
  image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
  font: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font",
} as const;

export const CT = {
  rels: "application/vnd.openxmlformats-package.relationships+xml",
  xml: "application/xml",
  document: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  styles: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
  settings: "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
  webSettings: "application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml",
  fontTable: "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
  numbering: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
  header: "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
  footer: "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",
  core: "application/vnd.openxmlformats-package.core-properties+xml",
  app: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  customXmlProps: "application/vnd.openxmlformats-officedocument.customXmlProperties+xml",
  odttf: "application/vnd.openxmlformats-officedocument.obfuscatedFont",
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  emf: "image/x-emf",
} as const;

export interface Relationship {
  id: string;
  type: string;
  target: string;
  targetMode?: "External";
}

export function relsXml(rels: readonly Relationship[]): string {
  const body = rels
    .map(
      (r) =>
        `<Relationship Id="${escapeXml(r.id)}" Type="${escapeXml(r.type)}" Target="${escapeXml(r.target)}"` +
        (r.targetMode ? ` TargetMode="${r.targetMode}"` : "") +
        "/>",
    )
    .join("");
  return `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
}

export function contentTypesXml(defaults: ReadonlyMap<string, string>, overrides: ReadonlyMap<string, string>): string {
  const d = [...defaults.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ext, ct]) => `<Default Extension="${escapeXml(ext)}" ContentType="${escapeXml(ct)}"/>`)
    .join("");
  const o = [...overrides.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, ct]) => `<Override PartName="${escapeXml(p)}" ContentType="${escapeXml(ct)}"/>`)
    .join("");
  return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${d}${o}</Types>`;
}

// ── styles.xml minimal ──────────────────────────────────────────────────

interface DocDefaultsParam {
  szHalfPt?: number;
  spacingAfterTw?: number;
  lineTw?: number;
  lineRule?: "auto" | "exact" | "atLeast";
  lang?: string;
}

interface NormalStyleParam extends DocDefaultsParam {
  faceRole?: FaceRole;
  face?: string;
  color?: string;
}

/** R-06 bawaan kontrak (research/07:896). */
const R06_DEFAULT: DocDefaultsParam = { szHalfPt: 19, spacingAfterTw: 0, lineTw: 270, lineRule: "exact", lang: "id-ID" };
/** R-07 bawaan kontrak (research/07:897). */
const R07_DEFAULT: NormalStyleParam = {
  faceRole: "serif",
  szHalfPt: 19,
  color: "2B3640",
  spacingAfterTw: 0,
  lineTw: 270,
  lineRule: "exact",
  lang: "id-ID",
};

// Swarm patch (row 27, C13 H2): lineRule comes from template params; enum-check and escape it,
// and write w:after / w:line only for finite numbers, so a template cannot inject OOXML here.
const LINE_RULES: ReadonlySet<unknown> = new Set(["auto", "exact", "atLeast"]);

function spacingAttr(p: DocDefaultsParam): string {
  const parts: string[] = [];
  const after = finiteInt(p.spacingAfterTw);
  const line = finiteInt(p.lineTw);
  if (after !== undefined) parts.push(`w:after="${after}"`);
  if (line !== undefined) {
    const rule = LINE_RULES.has(p.lineRule) ? (p.lineRule as string) : "auto";
    parts.push(`w:line="${line}"`, `w:lineRule="${escapeXml(rule)}"`);
  }
  return parts.length ? `<w:spacing ${parts.join(" ")}/>` : "";
}

function langEl(lang: string | undefined): string {
  return lang ? `<w:lang w:val="${escapeXml(lang)}" w:eastAsia="en-US" w:bidi="ar-SA"/>` : "";
}

/**
 * styles.xml minimal: docDefaults (R-06), Normal (R-07), gaya bawaan wajib
 * (DefaultParagraphFont, TableNormal, NoList) dan Header/Footer (dirujuk
 * `w:pStyle` di 29+29 bagian BM, research/07:886). Isi badan memakai format
 * langsung; tidak ada gaya bernama lain.
 */
export function stylesXml(tpl: ResolvedTemplate): string {
  const dd: DocDefaultsParam = { ...R06_DEFAULT, ...(paramObject(tpl.params, "render.docx.docDefaults") as DocDefaultsParam | undefined) };
  const nm: NormalStyleParam = { ...R07_DEFAULT, ...(paramObject(tpl.params, "render.docx.normalStyle") as NormalStyleParam | undefined) };
  const ddSz = dd.szHalfPt !== undefined ? Math.round(dd.szHalfPt) : 22;

  const normalRun: RunProps = { szHalfPt: nm.szHalfPt, color: nm.color };
  if (nm.face) normalRun.face = nm.face;
  else if (nm.faceRole) normalRun.faceRole = nm.faceRole;
  // rPrXml menulis lang tanpa eastAsia/bidi; Normal BM: lang val saja (research/07:897).
  const normalRPr = rPrXml(normalRun, tpl.params, nm.lang);

  // M1 (D-245): tab/spasi dari R-30 efektif (tab diskalakan ke bentang kertas), bukan literal A4.
  const hfStyle = (id: "Header" | "Footer", name: string, link: string) => {
    const s = hfStyleParam(tpl, id);
    const basedOn = typeof s.basedOn === "string" && s.basedOn.length > 0 ? s.basedOn : "Normal";
    return (
      `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${escapeXml(basedOn)}"/><w:link w:val="${link}"/>` +
      `<w:uiPriority w:val="99"/><w:unhideWhenUsed/>${hfStylePPr(s)}</w:style>`
    );
  };
  const hfChar = (id: string, name: string, link: string) =>
    `<w:style w:type="character" w:customStyle="1" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="DefaultParagraphFont"/>` +
    `<w:link w:val="${link}"/><w:uiPriority w:val="99"/></w:style>`;

  return (
    XML_DECL +
    `<w:styles xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="${R_NS}" xmlns:w="${W_NS}" ` +
    `xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/>` +
    `<w:sz w:val="${ddSz}"/><w:szCs w:val="${ddSz}"/>${langEl(dd.lang)}</w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr>${spacingAttr(dd)}</w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>` +
    `<w:pPr>${spacingAttr(nm)}</w:pPr>${normalRPr}</w:style>` +
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/>` +
    `<w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>` +
    `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/>` +
    `<w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/>` +
    `<w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
    `<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/>` +
    `<w:semiHidden/><w:unhideWhenUsed/></w:style>` +
    hfStyle("Header", "header", "HeaderChar") +
    hfChar("HeaderChar", "Header Char", "Header") +
    hfStyle("Footer", "footer", "FooterChar") +
    hfChar("FooterChar", "Footer Char", "Footer") +
    `</w:styles>`
  );
}

// ── Latar halaman (C13, GF-19) ──────────────────────────────────────────

/** R-71: latar halaman DOCX opt-in; absen/false = tanpa latar (keluaran sebelum ronde). */
const PARAM_PAGE_BACKGROUND = "render.docx.pageBackground";
/** Warna latar = kertas badan (DT-05); satu warna per dokumen, jadi kertas pembungkus FBFAF7 tidak dapat berbeda. */
const PARAM_INTERIOR_PAPER = "color.interior.paper";

/**
 * Warna latar halaman bila R-71 aktif dan `color.interior.paper` hex sah, selain itu `undefined`.
 * Satu sumber untuk `w:background` (document.xml) dan `w:displayBackgroundShape` (settings.xml):
 * LibreOffice 24.2 hanya menghormati latar bila keduanya ada (research/36 §1), jadi keduanya
 * ditulis bersama atau tidak sama sekali.
 */
export function pageBackgroundColour(tpl: ResolvedTemplate): string | undefined {
  return paramBool(tpl.params, PARAM_PAGE_BACKGROUND) === true ? normalizeHex(tpl.params[PARAM_INTERIOR_PAPER]) : undefined;
}

/**
 * Sisipkan `<w:background w:color>` sebagai anak pertama `w:document`, tepat sebelum `w:body`
 * (urutan CT_Document: background, body). Tanpa warna, atau dokumen sudah berlatar = apa adanya.
 */
export function withPageBackground(documentXml: string, colour: string | undefined): string {
  if (colour === undefined || documentXml.includes("<w:background")) return documentXml;
  const at = documentXml.search(/<w:body[\s>/]/);
  if (at < 0) return documentXml;
  return `${documentXml.slice(0, at)}<w:background w:color="${escapeXml(colour)}"/>${documentXml.slice(at)}`;
}

// ── settings.xml ────────────────────────────────────────────────────────

const RSIDS = ["00034616", "0006063C", "0015074B", "0029639D", "00326F90", "00AA1D8D", "00B47730", "00CB0664", "00FC693F"];

/**
 * settings.xml dalam urutan skema CT_Settings (Word membuang elemen yang salah
 * urut, catatan DatumDocx DHS-RB-05). R-01 compatibilityMode, R-02
 * defaultTabStop, R-03 updateFields, R-04 embedTrueTypeFonts, R-05
 * saveSubsetFonts. Sisa elemen = basis BM (research/07 §9.3). C13 (R-71):
 * `w:displayBackgroundShape` sesudah `w:zoom` bila latar halaman aktif.
 */
export function settingsXml(tpl: ResolvedTemplate): string {
  const p = tpl.params;
  const compat = paramNumber(p, "render.docx.compatibilityMode") ?? 15;
  const tab = paramNumber(p, "render.docx.defaultTabStopTw") ?? 720;
  const updateFields = paramBool(p, "render.docx.updateFieldsOnOpen") ?? true;
  const embed = paramBool(p, "render.docx.embedTrueTypeFonts") ?? true;
  const subset = paramBool(p, "render.docx.saveSubsetFonts") ?? false;
  const cs = (name: string, val: string | number) =>
    `<w:compatSetting w:name="${name}" w:uri="http://schemas.microsoft.com/office/word" w:val="${val}"/>`;

  return (
    XML_DECL +
    `<w:settings xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" ` +
    `xmlns:r="${R_NS}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" ` +
    `xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="${W_NS}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ` +
    `xmlns:sl="http://schemas.openxmlformats.org/schemaLibrary/2006/main" mc:Ignorable="w14">` +
    `<w:zoom w:val="bestFit"/>` +
    (pageBackgroundColour(tpl) !== undefined ? `<w:displayBackgroundShape/>` : "") +
    (embed ? `<w:embedTrueTypeFonts/>` : "") +
    (subset ? `<w:saveSubsetFonts/>` : `<w:saveSubsetFonts w:val="false"/>`) +
    `<w:proofState w:spelling="clean" w:grammar="clean"/>` +
    `<w:defaultTabStop w:val="${Math.round(tab)}"/>` +
    `<w:characterSpacingControl w:val="doNotCompress"/>` +
    (updateFields ? `<w:updateFields w:val="true"/>` : "") +
    `<w:compat><w:useFELayout/>${cs("compatibilityMode", Math.round(compat))}${cs("overrideTableStyleFontSizeAndJustification", 1)}` +
    `${cs("enableOpenTypeFeatures", 1)}${cs("doNotFlipMirrorIndents", 1)}</w:compat>` +
    `<w:rsids><w:rsidRoot w:val="00B47730"/>${RSIDS.map((r) => `<w:rsid w:val="${r}"/>`).join("")}</w:rsids>` +
    `<m:mathPr><m:mathFont m:val="Cambria Math"/><m:brkBin m:val="before"/><m:brkBinSub m:val="--"/><m:smallFrac m:val="0"/>` +
    `<m:dispDef/><m:lMargin m:val="0"/><m:rMargin m:val="0"/><m:defJc m:val="centerGroup"/><m:wrapIndent m:val="1440"/>` +
    `<m:intLim m:val="subSup"/><m:naryLim m:val="undOvr"/></m:mathPr>` +
    `<w:themeFontLang w:val="en-US" w:eastAsia="ja-JP"/>` +
    `<w:clrSchemeMapping w:bg1="light1" w:t1="dark1" w:bg2="light2" w:t2="dark2" w:accent1="accent1" w:accent2="accent2" ` +
    `w:accent3="accent3" w:accent4="accent4" w:accent5="accent5" w:accent6="accent6" w:hyperlink="hyperlink" w:followedHyperlink="followedHyperlink"/>` +
    `<w:doNotAutoCompressPictures/>` +
    `<w:shapeDefaults><o:shapedefaults v:ext="edit" spidmax="1027"/><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout></w:shapeDefaults>` +
    `<w:decimalSymbol w:val="."/><w:listSeparator w:val=","/>` +
    `<w14:docId w14:val="24062061"/><w14:defaultImageDpi w14:val="300"/>` +
    `</w:settings>`
  );
}

// ── docProps ────────────────────────────────────────────────────────────

/** Cap waktu W3CDTF deterministik dari issueDate (tengah malam UTC). */
export function w3cdtf(issueDate: string): string {
  return `${issueDate}T00:00:00Z`;
}

function el(tag: string, v: string | undefined): string {
  return v ? `<${tag}>${escapeXml(v)}</${tag}>` : `<${tag}/>`;
}

/**
 * docProps/core.xml. Tanpa jam dinding: created = modified = issueDate
 * (determinisme, D-xx `fixedDate`). Pencipta = meta.author.
 */
export function corePropsXml(meta: DocMeta): string {
  const ts = w3cdtf(meta.issueDate);
  const lang = meta.language === "EN" ? "en-US" : "id-ID";
  const desc = [meta.docNumber, `REV ${meta.rev}`, meta.classification].filter(Boolean).join(" · ");
  return (
    XML_DECL +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    el("dc:title", meta.title) +
    el("dc:subject", meta.subject) +
    el("dc:creator", meta.author) +
    el("cp:keywords", meta.docNumber) +
    el("dc:description", desc) +
    el("dc:language", lang) +
    el("cp:lastModifiedBy", meta.author) +
    `<cp:revision>1</cp:revision>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${ts}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${ts}</dcterms:modified>` +
    el("cp:category", meta.typeCode) +
    el("cp:contentStatus", meta.tier) +
    `</cp:coreProperties>`
  );
}

/** docProps/app.xml minimal (tanpa statistik halaman: dihitung pembaca). */
export function appPropsXml(tpl: ResolvedTemplate): string {
  const company = paramString(tpl.params, "org.entityName");
  return (
    XML_DECL +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Template>Normal.dotm</Template><TotalTime>0</TotalTime><Application>GSP Agent HQ Studio</Application>` +
    `<DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>` +
    (company ? `<Company>${escapeXml(company)}</Company>` : "<Company/>") +
    `<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>` +
    `</Properties>`
  );
}

// ── fontTable.xml ───────────────────────────────────────────────────────

export interface FontTableEmbed {
  face: string;
  slot: "regular" | "bold" | "italic" | "boldItalic";
  relId: string;
  guid: string;
}

const SLOT_TAG: Record<FontTableEmbed["slot"], string> = {
  regular: "embedRegular",
  bold: "embedBold",
  italic: "embedItalic",
  boldItalic: "embedBoldItalic",
};
const SLOT_ORDER: ReadonlyArray<FontTableEmbed["slot"]> = ["regular", "bold", "italic", "boldItalic"];

/**
 * fontTable.xml: entri basis tanpa tanam (8, research/07 §9.4) + satu entri
 * per keluarga tertanam (`charset 00`, `family auto`, `pitch variable`, tanpa
 * panose/sig, pola BM) dengan `w:embed*` urut skema CT_Font. Keluarga yang
 * namanya sudah ada di basis tidak ditulis ganda: entri basis diganti.
 */
export function fontTableXml(baseEntries: readonly string[], embeds: readonly FontTableEmbed[]): string {
  const families: string[] = [];
  const byFace = new Map<string, FontTableEmbed[]>();
  for (const e of embeds) {
    if (!byFace.has(e.face)) {
      byFace.set(e.face, []);
      families.push(e.face);
    }
    (byFace.get(e.face) as FontTableEmbed[]).push(e);
  }
  const nameOf = (x: string) => /w:name="([^"]*)"/.exec(x)?.[1];
  const kept = baseEntries.filter((x) => {
    const n = nameOf(x);
    return n === undefined || !byFace.has(n.replace(/&amp;/g, "&"));
  });
  const embedded = families.map((face) => {
    const list = byFace.get(face) as FontTableEmbed[];
    const slots = SLOT_ORDER.map((s) => list.find((e) => e.slot === s))
      .filter((e): e is FontTableEmbed => e !== undefined)
      .map((e) => `<w:${SLOT_TAG[e.slot]} r:id="${escapeXml(e.relId)}" w:fontKey="${escapeXml(e.guid)}"/>`)
      .join("");
    return `<w:font w:name="${escapeXml(face)}"><w:charset w:val="00"/><w:family w:val="auto"/><w:pitch w:val="variable"/>${slots}</w:font>`;
  });
  return (
    XML_DECL +
    `<w:fonts xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="${R_NS}" xmlns:w="${W_NS}" ` +
    `xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14">` +
    kept.join("") +
    embedded.join("") +
    `</w:fonts>`
  );
}
