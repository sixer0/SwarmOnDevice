/**
 * Serialisasi OOXML tingkat rendah untuk paket inti (S14): escape, rPr, pPr,
 * run kepala/kaki halaman, sel tabel sederhana. Format langsung per
 * paragraf/run (bukan gaya bernama), mengikuti BM.docx dan DatumDocx.
 * Urutan anak elemen mengikuti skema ECMA-376 (CT_RPr, CT_PPr, CT_TcPr, CT_TblPr).
 *
 * Penyaji run isi dokumen milik S16 (`runsXml`); `hfRun*` di sini untuk
 * bagian paket (header/footer). Sejak IP-15 (D-51) modul ini juga menjadi satu
 * sumber serialisasi keluarga tabel S17 (`tables/ooxml.ts` hanya mengikat
 * ragam `BODY_FLAVOR`); perbedaan keluaran kedua pemakai dinyatakan sebagai
 * `XmlFlavor`, bukan salinan kode.
 */
import type {
  BorderSpec,
  Borders,
  FaceRole,
  Inline,
  ParaFormat,
  ParamMap,
  Run,
  RunProps,
  Shading,
} from "../../../contract";

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const XML_DECL = "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n";

/** Namespace bagian header/footer (subset document.xml base, cukup untuk teks, tabel, field). */
export const HDR_FTR_NS =
  `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
  `xmlns:r="${R_NS}" xmlns:w="${W_NS}" ` +
  `xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ` +
  `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" mc:Ignorable="w14"`;

// Karakter kendali C0 kecuali TAB/LF/CR tidak sah di XML 1.0.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function escapeEntities(s: string, apos: boolean): string {
  const out = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return apos ? out.replace(/'/g, "&apos;") : out;
}

export function escapeXml(s: string): string {
  return escapeEntities(s.replace(INVALID_XML_CHARS, ""), false);
}

function isInvalidXmlCode(code: number): boolean {
  if (code < 0x20) return code !== 0x09 && code !== 0x0a && code !== 0x0d;
  return code === 0xfffe || code === 0xffff;
}

/**
 * Buang karakter tak sah XML 1.0 aturan ketat (blok teks S16): kontrol C0
 * selain TAB/LF/CR, nonkarakter FFFE/FFFF, dan surrogate tunggal (pasangan
 * surrogate utuh dipertahankan).
 */
export function stripInvalidXmlChars(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    if (isInvalidXmlCode(code)) continue;
    out += s[i];
  }
  return out;
}

/**
 * Escape aturan ketat (blok teks S16, IP-38/INT-W): `stripInvalidXmlChars`
 * lalu `& < > " '` (`'` -> `&apos;`). `escapeXml` (bawaan paket) tidak
 * meng-escape `'` dan tidak membuang surrogate tunggal.
 */
export function escapeXmlStrict(s: string): string {
  return escapeEntities(stripInvalidXmlChars(s), true);
}

/**
 * Ragam serialisasi. `PACKAGE_FLAVOR` (bawaan) = perilaku paket S14
 * (header/footer, styles): `w:szCs` ikut `w:sz`, spasi 0 ditulis, border
 * `none` apa adanya. `BODY_FLAVOR` = perilaku tabel S17 (pola BM badan):
 * tanpa `w:szCs`, spasi 0 dilewati, border `none` dinormalisasi ke
 * `sz=0 space=0 color=auto`. `BLOCK_FLAVOR` = format langsung blok teks S16
 * (`blocks/props.ts`). Medan opsional bernilai undefined = perilaku lama.
 */
export interface XmlFlavor {
  readonly szCs: boolean;
  readonly omitZeroSpacing: boolean;
  readonly normalizeNoneBorder: boolean;
  /** Urutan atribut `w:rFonts`: `csFirst` (bawaan: ascii, hAnsi, cs, eastAsia) atau `eastAsiaFirst` (ascii, hAnsi, eastAsia, cs). */
  readonly rFontsOrder?: "csFirst" | "eastAsiaFirst";
  /** `caps: false` ditulis `<w:caps w:val="0"/>` (bawaan: dilewati). */
  readonly capsOffExplicit?: boolean;
  /** `w:lineRule` hanya bila `lineRule` diberikan (bawaan: "auto" bila `lineTw` ada). */
  readonly lineRuleNoDefault?: boolean;
  /** `<w:spacing/>` tetap ditulis bila salah satu before/after/line/lineRule terdefinisi walau atributnya kosong. */
  readonly emptySpacingWhenLineRule?: boolean;
  /** Bilangan atribut `w:pPr` (spacing, ind, tab pos, outlineLvl) dibulatkan. */
  readonly roundParaNumbers?: boolean;
  /** `w:pBdr` memuat `insideH`/`insideV` dan ditulis bila objek `borders` punya kunci apa pun. */
  readonly paraBordersInside?: boolean;
}
export const PACKAGE_FLAVOR: XmlFlavor = { szCs: true, omitZeroSpacing: false, normalizeNoneBorder: false };
export const BODY_FLAVOR: XmlFlavor = { szCs: false, omitZeroSpacing: true, normalizeNoneBorder: true };
export const BLOCK_FLAVOR: XmlFlavor = {
  szCs: false,
  omitZeroSpacing: true,
  normalizeNoneBorder: false,
  rFontsOrder: "eastAsiaFirst",
  capsOffExplicit: true,
  lineRuleNoDefault: true,
  emptySpacingWhenLineRule: true,
  roundParaNumbers: true,
  paraBordersInside: true,
};

/** Atribut `k="v"` ber-escape; nilai undefined dilewati. */
export function attrs(a: Record<string, string | number | undefined>): string {
  let out = "";
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    out += ` ${k}="${escapeXml(String(v))}"`;
  }
  return out;
}

/** Bilangan bulat untuk atribut OOXML (twip, half-point, 1/8 pt, EMU). */
export function int(n: number): string {
  return String(Math.round(n));
}

/**
 * Elemen kosong `<tag a="v" .../>` aturan ketat (blok teks S16): nilai lewat
 * `escapeXmlStrict`, bilangan dibulatkan; atribut `undefined` dilewati.
 */
export function el(tag: string, a: Readonly<Record<string, string | number | undefined>> = {}): string {
  let out = "";
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    out += ` ${k}="${escapeXmlStrict(typeof v === "number" ? int(v) : v)}"`;
  }
  return `<${tag}${out}/>`;
}

// ── Parameter templat ────────────────────────────────────────────────────

export function paramString(p: ParamMap, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function paramNumber(p: ParamMap, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function paramBool(p: ParamMap, key: string): boolean | undefined {
  const v = p[key];
  return typeof v === "boolean" ? v : undefined;
}

export function paramObject(p: ParamMap, key: string): Record<string, unknown> | undefined {
  const v = p[key];
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// ── Wajah fon ────────────────────────────────────────────────────────────

/** Peta peran wajah -> nama keluarga apa adanya (research/05:13, research/07 §9.4). */
export const DEFAULT_FACES: Readonly<Record<FaceRole, string>> = {
  serif: "IBM Plex Serif",
  condensed: "IBM Plex Sans Cond",
  mono: "IBM Plex Mono",
  workbookUi: "IBM Plex Sans",
  symbolGlyph: "DejaVu Sans",
};

/** Nama wajah untuk run: `face` eksplisit > param `type.face.<role>` > DEFAULT_FACES. */
export function resolveFace(props: RunProps, params?: ParamMap): string | undefined {
  if (props.face) return props.face;
  if (!props.faceRole) return undefined;
  const v = params && paramString(params, `type.face.${props.faceRole}`);
  return v !== undefined && v.trim().length > 0 ? v : DEFAULT_FACES[props.faceRole];
}

// ── rPr / pPr ────────────────────────────────────────────────────────────

/** Elemen on/off `w:<tag>`: true = `<w:tag/>`, false = `w:val="0"`, undefined = "". */
export function onOff(tag: string, v: boolean | undefined): string {
  if (v === undefined) return "";
  return v ? `<w:${tag}/>` : `<w:${tag} w:val="0"/>`;
}

/** `w:rPr` (urutan CT_RPr). Mengembalikan "" bila tidak ada properti. */
export function rPrXml(props: RunProps, params?: ParamMap, lang?: string, flavor: XmlFlavor = PACKAGE_FLAVOR): string {
  const inner = rPrInnerXml(props, resolveFace(props, params), lang, flavor);
  return inner ? `<w:rPr>${inner}</w:rPr>` : "";
}

/**
 * Isi `w:rPr` (tanpa pembungkus) dengan wajah yang sudah ditetapkan pemanggil
 * (paket: `resolveFace`; blok S16: peta wajah `FaceMap`). "" bila kosong.
 */
export function rPrInnerXml(props: RunProps, face: string | undefined, lang?: string, flavor: XmlFlavor = PACKAGE_FLAVOR): string {
  let inner = "";
  if (face) {
    const fonts =
      flavor.rFontsOrder === "eastAsiaFirst"
        ? { "w:ascii": face, "w:hAnsi": face, "w:eastAsia": face, "w:cs": face }
        : { "w:ascii": face, "w:hAnsi": face, "w:cs": face, "w:eastAsia": face };
    inner += `<w:rFonts${attrs(fonts)}/>`;
  }
  inner += onOff("b", props.b);
  inner += onOff("i", props.i);
  if (props.caps) inner += "<w:caps/>";
  else if (props.caps === false && flavor.capsOffExplicit) inner += `<w:caps w:val="0"/>`;
  if (props.color) inner += `<w:color w:val="${escapeXml(props.color)}"/>`;
  if (props.spacingTw !== undefined && !(flavor.omitZeroSpacing && props.spacingTw === 0)) {
    inner += `<w:spacing w:val="${Math.round(props.spacingTw)}"/>`;
  }
  if (props.szHalfPt !== undefined) {
    const sz = Math.round(props.szHalfPt);
    // BODY_FLAVOR: hanya w:sz (BM tidak menulis szCs di badan; teks skrip kompleks tidak dipakai).
    inner += flavor.szCs ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : `<w:sz w:val="${sz}"/>`;
  }
  if (props.u) inner += `<w:u w:val="${props.u}"/>`;
  if (props.vertAlign) inner += `<w:vertAlign w:val="${props.vertAlign}"/>`;
  if (lang) inner += `<w:lang w:val="${escapeXml(lang)}"/>`;
  return inner;
}

export function borderXml(tag: string, b: BorderSpec | undefined, flavor: XmlFlavor = PACKAGE_FLAVOR): string {
  if (!b) return "";
  if (flavor.normalizeNoneBorder && b.val === "none") return `<w:${tag} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`;
  return `<w:${tag}${attrs({ "w:val": b.val, "w:sz": Math.round(b.sz), "w:space": b.space ?? 0, "w:color": b.color })}/>`;
}

/** Sisi border urutan CT_TcBorders / CT_PBdr (top, left, bottom, right); "" bila kosong. */
export function sideBordersXml(b: Omit<Borders, "insideH" | "insideV"> | undefined, flavor: XmlFlavor = PACKAGE_FLAVOR): string {
  if (!b) return "";
  return borderXml("top", b.top, flavor) + borderXml("left", b.left, flavor) + borderXml("bottom", b.bottom, flavor) + borderXml("right", b.right, flavor);
}

export function shadingXml(s: Shading | undefined): string {
  return s ? `<w:shd w:val="${s.val}" w:color="auto" w:fill="${escapeXml(s.fill)}"/>` : "";
}

/** Sisipan `w:pPr` di luar `ParaFormat`. */
export interface PPrExtras {
  /** `<w:framePr .../>` jadi (chip rel moda A, Garis A); disisipkan setelah `pageBreakBefore` (posisi CT_PPrBase). */
  readonly framePr?: string;
}

/** Isi `w:pPr` (tanpa pembungkus) urutan CT_PPr. `pStyle` opsional (Header/Footer). */
export function pPrInner(f: ParaFormat | undefined, pStyle?: string, flavor: XmlFlavor = PACKAGE_FLAVOR, extras?: PPrExtras): string {
  let inner = pStyle ? `<w:pStyle w:val="${escapeXml(pStyle)}"/>` : "";
  if (!f) return inner;
  const num = (n: number | undefined): number | undefined =>
    n !== undefined && flavor.roundParaNumbers ? Math.round(n) : n;
  inner += onOff("keepNext", f.keepNext);
  inner += onOff("keepLines", f.keepLines);
  inner += onOff("pageBreakBefore", f.pageBreakBefore);
  if (extras?.framePr) inner += extras.framePr;
  inner += onOff("widowControl", f.widowControl);
  if (flavor.paraBordersInside) {
    if (f.borders && Object.keys(f.borders).length > 0) {
      // ParaFormat.borders tanpa insideH/insideV di tipe; objek masukan bisa membawanya (perilaku S16).
      const b: Borders = f.borders;
      inner += `<w:pBdr>${sideBordersXml(b, flavor)}${borderXml("insideH", b.insideH, flavor)}${borderXml("insideV", b.insideV, flavor)}</w:pBdr>`;
    }
  } else {
    const bdr = sideBordersXml(f.borders, flavor);
    if (bdr) inner += `<w:pBdr>${bdr}</w:pBdr>`;
  }
  inner += shadingXml(f.shading);
  if (f.tabs && f.tabs.length > 0) {
    inner += "<w:tabs>";
    for (const t of f.tabs) {
      inner += `<w:tab${attrs({ "w:val": t.val, "w:leader": t.leader, "w:pos": Math.round(t.posTw) })}/>`;
    }
    inner += "</w:tabs>";
  }
  const sp = attrs({
    "w:before": num(f.spacingBeforeTw),
    "w:after": num(f.spacingAfterTw),
    "w:line": num(f.lineTw),
    "w:lineRule": f.lineTw !== undefined ? (flavor.lineRuleNoDefault ? f.lineRule : (f.lineRule ?? "auto")) : undefined,
  });
  const spAny =
    flavor.emptySpacingWhenLineRule &&
    (f.spacingBeforeTw !== undefined || f.spacingAfterTw !== undefined || f.lineTw !== undefined || f.lineRule !== undefined);
  if (sp || spAny) inner += `<w:spacing${sp}/>`;
  const ind = attrs({
    "w:left": num(f.indLeftTw),
    "w:right": num(f.indRightTw),
    "w:hanging": num(f.indHangingTw),
    "w:firstLine": f.indHangingTw === undefined ? num(f.indFirstLineTw) : undefined,
  });
  if (ind) inner += `<w:ind${ind}/>`;
  if (f.jc) inner += `<w:jc w:val="${f.jc}"/>`;
  if (f.outlineLvl !== undefined) inner += `<w:outlineLvl w:val="${num(f.outlineLvl)}"/>`;
  return inner;
}

export function pPrXml(f: ParaFormat | undefined, pStyle?: string, flavor: XmlFlavor = PACKAGE_FLAVOR): string {
  const inner = pPrInner(f, pStyle, flavor);
  return inner ? `<w:pPr>${inner}</w:pPr>` : "";
}

// ── Run ──────────────────────────────────────────────────────────────────

/** RunProps milik run (diskriminan isi dibuang). */
export function runOwnProps(r: Run): RunProps {
  // Buang diskriminan isi; sisanya RunProps.
  const rest: Record<string, unknown> = { ...r };
  delete rest.t;
  delete rest.tab;
  delete rest.br;
  delete rest.field;
  return rest as RunProps;
}

/**
 * Gabung run dasar dengan properti run sendiri: atribut run menimpa dasar,
 * wajah mengikuti face XOR faceRole (§3.2, RQ-1): run yang membawa `faceRole`
 * tanpa `face` tidak mewarisi `base.face` (peran run menggantikan wajah
 * dasar); `face` hasil gabungan selalu menang atas `faceRole`.
 */
export function mergeRunProps(base: RunProps, own: RunProps): RunProps {
  const props: RunProps = { ...base, ...own };
  if (own.faceRole && !own.face) delete props.face;
  if (props.face) delete props.faceRole;
  return props;
}

/** Ragam `w:t`. Bawaan (semua undefined) = perilaku paket. */
export interface TextOptions {
  /** TAB literal di dalam teks juga memicu `xml:space="preserve"` (pembungkus S18). */
  readonly preserveOnTab?: boolean;
  /** Aturan ketat blok S16: buang karakter tak sah dulu (uji preserve pada teks bersih), escape `escapeXmlStrict`. */
  readonly strict?: boolean;
}
export const WRAPPER_TEXT: TextOptions = { preserveOnTab: true };
export const STRICT_TEXT: TextOptions = { strict: true };

/** `<w:t>` dengan `xml:space="preserve"` hanya bila spasi tepi/ganda (atau TAB, `preserveOnTab`) perlu dipertahankan. */
export function textXml(t: string, opts: TextOptions = {}): string {
  const text = opts.strict ? stripInvalidXmlChars(t) : t;
  const preserve = (opts.preserveOnTab ? /^\s|\s$|\s{2}|\t/ : /^\s|\s$|\s{2}/).test(text);
  const body = opts.strict ? escapeXmlStrict(text) : escapeXml(text);
  return `<w:t${preserve ? ' xml:space="preserve"' : ""}>${body}</w:t>`;
}

function textEl(t: string): string {
  return textXml(t);
}

/**
 * Run kepala/kaki halaman. Field PAGE/NUMPAGES ditulis `w:fldSimple` dengan
 * nilai cache "1" (pola BM footer5.xml, research/07:869-876).
 */
export function hfRunXml(r: Run, base: RunProps, params?: ParamMap): string {
  const props = mergeRunProps(base, runOwnProps(r));
  const rPr = rPrXml(props, params);
  if ("field" in r) {
    return `<w:fldSimple w:instr=" ${r.field} "><w:r>${rPr}<w:t>1</w:t></w:r></w:fldSimple>`;
  }
  if ("tab" in r) return `<w:r>${rPr}<w:tab/></w:r>`;
  if ("br" in r) return `<w:r>${rPr}<w:br/></w:r>`;
  return `<w:r>${rPr}${textEl(r.t)}</w:r>`;
}

export function hfRunsXml(runs: readonly Run[], base: RunProps, params?: ParamMap): string {
  return runs.map((r) => hfRunXml(r, base, params)).join("");
}

/**
 * Run isi dokumen (keluarga tabel S17, IP-15): gabungan face XOR faceRole
 * (`mergeRunProps`), teks kosong = "" (tanpa `w:r`), field
 * PAGE/NUMPAGES = `w:fldSimple` bernilai cache "1".
 */
export function contentRunXml(r: Run, base: RunProps, params: ParamMap, flavor: XmlFlavor = BODY_FLAVOR): string {
  const props = mergeRunProps(base, runOwnProps(r));
  const rPr = rPrXml(props, params, undefined, flavor);
  if ("field" in r) return `<w:fldSimple w:instr=" ${r.field} "><w:r>${rPr}<w:t>1</w:t></w:r></w:fldSimple>`;
  if ("tab" in r) return `<w:r>${rPr}<w:tab/></w:r>`;
  if ("br" in r) return `<w:r>${rPr}<w:br/></w:r>`;
  if (r.t.length === 0) return "";
  return `<w:r>${rPr}${textEl(r.t)}</w:r>`;
}

export function contentRunsXml(runs: readonly Run[], base: RunProps, params: ParamMap, flavor: XmlFlavor = BODY_FLAVOR): string {
  return runs.map((r) => contentRunXml(r, base, params, flavor)).join("");
}

/** Paragraf isi; pPr kosong + run kosong = `<w:p/>` (KT-19). */
export function contentParagraphXml(format: ParaFormat | undefined, runsInner: string, flavor: XmlFlavor = BODY_FLAVOR): string {
  return paragraphFromInnerXml(pPrInner(format, undefined, flavor), runsInner);
}

/**
 * Paragraf dari isi `w:pPr` (tanpa pembungkus) dan isi run. Bawaan: pPr dan
 * isi kosong = `<w:p/>`; `compactEmpty: false` (pembungkus S18) selalu
 * `<w:p>...</w:p>`.
 */
export function paragraphFromInnerXml(pPrInnerXml: string, content: string, opts: { readonly compactEmpty?: boolean } = {}): string {
  const pPr = pPrInnerXml ? `<w:pPr>${pPrInnerXml}</w:pPr>` : "";
  if (opts.compactEmpty !== false && !pPr && !content) return "<w:p/>";
  return `<w:p>${pPr}${content}</w:p>`;
}

/** Hapus penanda md-lite (`**`, `*`, `` ` ``, `_`) untuk teks polos kepala halaman. */
export function stripMdLite(text: string): string {
  return text.replace(/\*\*|`/g, "").replace(/(^|[\s(])[*_](\S[^*_]*?)[*_](?=$|[\s).,;:])/g, "$1$2");
}

/** Inline -> teks polos (runs: gabungan `t`, tab = spasi). */
export function inlinePlain(i: Inline | undefined): string {
  if (!i) return "";
  if ("text" in i) return stripMdLite(i.text);
  return i.runs.map((r) => ("t" in r ? r.t : "tab" in r ? " " : "")).join("");
}

/** Inline -> Run[] dengan RunProps dasar per run (teks md-lite dipolos). */
export function inlineRuns(i: Inline): Run[] {
  if ("text" in i) return [{ t: stripMdLite(i.text) }];
  return i.runs;
}

// ── Tabel sederhana (blok register, header/footer kustom) ─────────────────

export interface SimpleCell {
  widthTw: number;
  paragraphsXml: string;
  borders?: Omit<Borders, "insideH" | "insideV">;
  marginsTw?: { top?: number; left?: number; bottom?: number; right?: number };
  shading?: Shading;
  gridSpan?: number;
  /** Gabung vertikal (pembungkus S18): `restart` = `w:val="restart"`, `continue` = `<w:vMerge/>`. */
  vMerge?: "restart" | "continue";
  vAlign?: "top" | "center" | "bottom";
}

/** Baris tabel sederhana: `cantSplit` bawaan true (false = tanpa `w:cantSplit`), `repeatHeader` = `w:tblHeader`. */
export interface SimpleRow {
  cells: readonly SimpleCell[];
  cantSplit?: boolean;
  repeatHeader?: boolean;
}

/** `w:tc` urutan CT_TcPr: tcW, gridSpan, vMerge, tcBorders, shd, tcMar, vAlign. */
export function tcXml(c: SimpleCell): string {
  let pr = `<w:tcW w:w="${Math.round(c.widthTw)}" w:type="dxa"/>`;
  if (c.gridSpan && c.gridSpan > 1) pr += `<w:gridSpan w:val="${c.gridSpan}"/>`;
  if (c.vMerge) pr += c.vMerge === "restart" ? `<w:vMerge w:val="restart"/>` : `<w:vMerge/>`;
  const bx = sideBordersXml(c.borders);
  if (bx) pr += `<w:tcBorders>${bx}</w:tcBorders>`;
  pr += shadingXml(c.shading);
  if (c.marginsTw) {
    const m = c.marginsTw;
    const mx = (["top", "left", "bottom", "right"] as const)
      .filter((k) => m[k] !== undefined)
      .map((k) => `<w:${k} w:w="${Math.round(m[k] as number)}" w:type="dxa"/>`)
      .join("");
    if (mx) pr += `<w:tcMar>${mx}</w:tcMar>`;
  }
  if (c.vAlign) pr += `<w:vAlign w:val="${c.vAlign}"/>`;
  return `<w:tc><w:tcPr>${pr}</w:tcPr>${c.paragraphsXml || "<w:p/>"}</w:tc>`;
}

const NONE_BORDER = `w:val="none" w:sz="0" w:space="0" w:color="auto"`;

/** Tabel satu-tingkat berlebar tetap, tanpa garis tabel bawaan (TP-01..03, R-17). */
export function simpleTableXml(gridTw: readonly number[], rows: ReadonlyArray<readonly SimpleCell[]>, indentTw = 0): string {
  return simpleTableRowsXml(gridTw, rows.map((cells) => ({ cells })), { indentTw });
}

export interface SimpleTableOptions {
  readonly indentTw?: number;
  /** `w:tblW` = jumlah lebar kolom yang masing-masing dibulatkan (pembungkus S18); bawaan = pembulatan jumlah. */
  readonly widthFromRoundedCols?: boolean;
}

/** Seperti `simpleTableXml` dengan opsi per baris (`SimpleRow`) dan cara hitung `w:tblW`. */
export function simpleTableRowsXml(gridTw: readonly number[], rows: readonly SimpleRow[], opts: SimpleTableOptions = {}): string {
  const total = opts.widthFromRoundedCols
    ? gridTw.reduce((a, b) => a + Math.round(b), 0)
    : Math.round(gridTw.reduce((a, b) => a + b, 0));
  const tblBorders = ["top", "left", "bottom", "right", "insideH", "insideV"].map((k) => `<w:${k} ${NONE_BORDER}/>`).join("");
  const tblPr =
    `<w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblInd w:w="${Math.round(opts.indentTw ?? 0)}" w:type="dxa"/>` +
    `<w:tblBorders>${tblBorders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>` +
    `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`;
  const grid = `<w:tblGrid>${gridTw.map((w) => `<w:gridCol w:w="${Math.round(w)}"/>`).join("")}</w:tblGrid>`;
  const trs = rows
    .map((r) => {
      let trPr = "";
      if (r.cantSplit !== false) trPr += "<w:cantSplit/>";
      if (r.repeatHeader) trPr += "<w:tblHeader/>";
      return `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ""}${r.cells.map(tcXml).join("")}</w:tr>`;
    })
    .join("");
  return `<w:tbl>${tblPr}${grid}${trs}</w:tbl>`;
}

/** Daftar nama wajah (`w:rFonts w:ascii`) unik terurut di potongan XML; untuk rencana fon S15. */
export function facesInXml(xml: string): string[] {
  const out = new Set<string>();
  const re = /<w:rFonts\b[^>]*\bw:ascii="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    // &amp; terakhir agar "&amp;quot;" tidak ter-unescape dua kali.
    out.add(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  }
  return [...out].sort();
}
