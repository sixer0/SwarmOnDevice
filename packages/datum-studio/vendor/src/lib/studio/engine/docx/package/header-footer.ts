/**
 * Kepala dan kaki halaman per seksi (S14): mode `empty`, `runningHead`
 * (BM header5.xml), `registerBlock` (BM footer5.xml, field PAGE/NUMPAGES),
 * `custom`. Satu pasang bagian header/footer per unit (BM: 29 + 29 bagian,
 * semua referensi `default`, research/07 §6.2).
 *
 * Format langsung per paragraf/run (bukan gaya bernama selain pStyle
 * Header/Footer yang dirujuk BM). Nilai bawaan = ukuran BM; teks bawaan =
 * P4A-01 (runningHead.fields) dan P4S-11 (device.registerBlock.cells).
 */
import type {
  Borders,
  Cell,
  ControlSheetData,
  CoverData,
  HeaderFooterSpec,
  Inline,
  NormUnit,
  ParaFormat,
  RenderContext,
  Run,
  RunProps,
  TableBlock,
} from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { chapterLabelText, classificationLineText, classificationMarkText, kickerSuppressed, registerWordsText, wrapperLangOf } from "../../front/texts";
import { fitRunningHeadText } from "../../front/running-head-fit";
import { measureFont, type FitFont } from "../../chart/core/textfit";
import { normalizeHex } from "../../tokens/color";
import { PARAMS_BY_KEY } from "../../../params";
import { REL, type Relationship } from "./parts";
import { mmToTw, resolveUnitSetup, sectPrXml, sheetNumberingFromChapter1, textWidthTw, type ResolvedSectionSetup } from "./section";
import {
  escapeXml,
  facesInXml,
  HDR_FTR_NS,
  hfRunsXml,
  inlinePlain,
  inlineRuns,
  paramBool,
  paramString,
  pPrXml,
  rPrXml,
  simpleTableXml,
  type SimpleCell,
  XML_DECL,
} from "./xml";

// ── Nilai bawaan terukur BM (research/07 §6.2) ──────────────────────────

const INK900 = "101418";
const INK400 = "6B7783";
const INK200 = "C3CBD1";
/** Swarm patch (row 49a, C104 H1): cadangan warna klasifikasi = seal (Rev A DT-28d, manual_id.txt:667). */
const SEAL = "6E1420";

/** header1.xml/footer1.xml: satu paragraf kosong line 40 exact. */
export const EMPTY_HF_FORMAT: ParaFormat = { spacingBeforeTw: 0, spacingAfterTw: 0, lineTw: 40, lineRule: "exact" };

/** header5.xml: run kiri (abu, tidak tebal) dan kanan (tinta, tebal), Cond 6,5 pt kapital renggang 0,6 pt. */
export const RUNNING_HEAD_LEFT_RUN: RunProps = { faceRole: "condensed", b: false, i: false, caps: true, color: INK400, szHalfPt: 13, spacingTw: 12 };
export const RUNNING_HEAD_RIGHT_RUN: RunProps = { ...RUNNING_HEAD_LEFT_RUN, b: true, color: INK900 };

/** footer5.xml: label abu Mono 6 pt, nilai tebal tinta. */
export const REGISTER_LABEL_RUN: RunProps = { faceRole: "mono", b: false, i: false, color: INK400, szHalfPt: 12 };
export const REGISTER_VALUE_RUN: RunProps = { ...REGISTER_LABEL_RUN, b: true, color: INK900 };
/** Lebar sel blok register pada blok teks 9411 tw (166 mm). */
export const REGISTER_COLS_TW = [2948, 2381, 2381, 1701] as const;
const REGISTER_PARA: ParaFormat = { spacingBeforeTw: 0, spacingAfterTw: 0, lineTw: 168, lineRule: "exact" };
/** Paragraf penutup footer setelah tabel register (line 20 exact). */
const FOOTER_TAIL_FORMAT: ParaFormat = { spacingBeforeTw: 0, spacingAfterTw: 0, lineTw: 20, lineRule: "exact" };

/** R-72 (C14, GF-22): warna garis bawah kepala halaman; absen/tidak sah = INK200 (keluaran sebelum ronde). */
const PARAM_RUNNING_HEAD_RULE = "runningHead.ruleColour";
/** R-73 (C14, GF-22): warna garis atas sel blok register; absen/tidak sah = INK900. */
const PARAM_REGISTER_TOP_RULE = "device.registerBlock.topRuleColour";

function runningHeadFormat(textW: number, p: RenderContext["tpl"]["params"]): ParaFormat {
  return {
    spacingBeforeTw: 0,
    spacingAfterTw: 0,
    lineTw: 180,
    lineRule: "exact",
    tabs: [{ posTw: textW, val: "right" }],
    borders: { bottom: { val: "single", sz: 5, space: 1, color: normalizeHex(p[PARAM_RUNNING_HEAD_RULE]) ?? INK200 } },
  };
}

/**
 * RH-03 (C25 F1): R-72 hex sah yang BERBEDA dari bawaan registri, selain itu undefined. Format kepala halaman
 * dari preset (`render.section.interior.header.format`, mis. `datum-gsp`) menimpa garis bawaan di atas; hanya
 * nilai opt-in ini yang mewarnai ulang garis bawah preset. Absen/bawaan/tidak sah = presedensi lama (byte sama).
 */
function runningHeadRuleOverride(p: RenderContext["tpl"]["params"]): string | undefined {
  const v = normalizeHex(p[PARAM_RUNNING_HEAD_RULE]);
  return v !== undefined && v !== normalizeHex(PARAMS_BY_KEY.get(PARAM_RUNNING_HEAD_RULE)?.default) ? v : undefined;
}

// ── Utilitas teks ───────────────────────────────────────────────────────

const ROMAN_MONTHS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

/** Tanggal DATUM `DD-<bulan Romawi>-YYYY` (BM: 2026-10-08 -> "08-X-2026"). */
export function datumDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? `${m[3]}-${ROMAN_MONTHS[mo - 1]}-${m[1]}` : iso;
}

function chapterTitleFor(ctx: RenderContext, unit: NormUnit): { label: string; title: string } | undefined {
  const doc = ctx.snapshot.doc;
  const lang = doc.meta.language === "EN" ? "EN" : "ID";
  if (unit.kind === "chapter" || unit.kind === "appendix") {
    const list = unit.kind === "chapter" ? doc.chapters : (doc.appendices ?? []);
    const idx = list.findIndex((c, i) => (c.key ?? (unit.kind === "chapter" ? String(i + 1) : String.fromCharCode(65 + i))) === unit.key);
    const ch = idx >= 0 ? list[idx] : undefined;
    // IMPL-W4: kicker kosong eksplisit (penomoran sumber) = judul bab sudah memuat nomornya; tanpa "Bab n".
    // S06 (B-10): kata bab/lampiran dari tabel teks bersama `front/texts.ts`.
    return { label: ch && kickerSuppressed(ch.kicker) ? "" : chapterLabelText(unit.key, unit.kind === "appendix", lang), title: ch ? (ch.runningHeadTitle ?? inlinePlain(ch.title)) : "" };
  }
  if (unit.kind === "part") {
    const part = (doc.parts ?? []).find((p) => p.id === unit.key);
    return part ? { label: inlinePlain(part.label), title: inlinePlain(part.title) } : undefined;
  }
  return undefined;
}

/**
 * Teks kiri bawaan P4A-01: [entitas, jenis dokumen, BAB n, judul bab] dipisah " · ".
 * G-FIX (G-06): dengan `maxWidthMm`, teks dipas ke lebar itu pada huruf kepala halaman
 * (`RUNNING_HEAD_LEFT_RUN`): jenis dokumen/judul dipendekkan lebih dulu, lalu judul bab;
 * entitas dan label bab utuh. Teks yang sudah muat tidak berubah.
 */
export function defaultRunningHeadLeft(ctx: RenderContext, unit: NormUnit, maxWidthMm?: number): string {
  const p = ctx.tpl.params;
  const meta = ctx.snapshot.doc.meta;
  const entity = paramString(p, "org.entityName") ?? "PT Gemilang Satria Perkasa";
  const docLabel = paramString(p, "runningHead.docLabel") ?? meta.subject ?? meta.title;
  const ch = chapterTitleFor(ctx, unit);
  const segments = [
    { text: entity },
    { text: docLabel ?? "", shrinkOrder: 1 },
    { text: ch?.label ?? "" },
    { text: ch?.title ?? "", shrinkOrder: 2 },
  ];
  if (maxWidthMm === undefined) return segments.filter((s) => s.text.length > 0).map((s) => s.text).join(" · ");
  return fitRunningHeadText(segments, maxWidthMm, fitFontOf(RUNNING_HEAD_LEFT_RUN));
}

const MM_PER_TW = 25.4 / 1440;
/**
 * Jarak minimum teks kiri ke klasifikasi kanan saat teks dipas: sama dengan `.runhead{gap:4mm}` HTML
 * (`html/base/css.ts`); juga menyerap selisih tabel lebar SemiBold vs run kanan Bold dan pembulatan renderer.
 */
const RUNNING_HEAD_GAP_MM = 4;

/** Gaya ukur `textfit` untuk run kepala halaman (ukuran, kapital, renggang, tebal, wajah). */
function fitFontOf(r: RunProps): FitFont {
  return {
    pt: (r.szHalfPt ?? 13) / 2,
    face: r.faceRole === "mono" ? "data" : "struct",
    bold: r.b === true,
    caps: r.caps === true,
    trackMm: ((r.spacingTw ?? 0) / 20) * (25.4 / 72),
  };
}

// ── Mode ────────────────────────────────────────────────────────────────

function emptyBody(spec: { format?: ParaFormat }, pStyle: string): string {
  return `<w:p>${pPrXml({ ...EMPTY_HF_FORMAT, ...(spec.format ?? {}) }, pStyle)}</w:p>`;
}

function runningHeadBody(
  spec: { left?: Inline; right?: Inline; format?: ParaFormat },
  ctx: RenderContext,
  unit: NormUnit,
  setup: ResolvedSectionSetup,
  pStyle: string,
): string {
  const p = ctx.tpl.params;
  let fmt: ParaFormat = { ...runningHeadFormat(textWidthTw(setup), p), ...(spec.format ?? {}) };
  // RH-03: warna opt-in R-72 menang atas garis bawah preset; ukuran/jenis/jarak garis tetap dari preset.
  // Hanya mewarnai ulang garis yang ada (param warna, bukan sakelar garis).
  const ruleOverride = runningHeadRuleOverride(p);
  if (ruleOverride && fmt.borders?.bottom) {
    fmt = { ...fmt, borders: { ...fmt.borders, bottom: { ...fmt.borders.bottom, color: ruleOverride } } };
  }
  const right: Inline = spec.right ?? { text: classificationMarkText(ctx.snapshot.doc.meta.classification) };
  // Swarm patch (row 49a, C104 H1): the right slot is the classification (DT-28c), printed seal bold (DT-28d), as the
  // HTML engine's `.runhead .cls` / @page top-right box; was ink900 #101418.
  const rightRun = classificationRun(RUNNING_HEAD_RIGHT_RUN, p);
  let leftRuns: Run[];
  if (spec.left) {
    leftRuns = inlineRuns(spec.left);
  } else {
    // G-FIX (G-06): anggaran teks kiri = tab kanan - klasifikasi (utuh) - jarak aman.
    const tabTw = fmt.tabs?.find((t) => t.val === "right")?.posTw ?? textWidthTw(setup);
    const rightMm = measureFont(inlinePlain(right), fitFontOf(RUNNING_HEAD_RIGHT_RUN));
    leftRuns = [{ t: defaultRunningHeadLeft(ctx, unit, tabTw * MM_PER_TW - rightMm - RUNNING_HEAD_GAP_MM) }];
  }
  let rightXml: string;
  if ("text" in right) {
    // Pola BM: tab dan teks kanan dalam satu run.
    const t = inlinePlain(right);
    rightXml = `<w:r>${rPrXml(rightRun, p)}<w:tab/><w:t>${escapeXml(t)}</w:t></w:r>`;
  } else {
    rightXml = hfRunsXml([{ tab: true }, ...right.runs], rightRun, p);
  }
  return `<w:p>${pPrXml(fmt, pStyle)}${hfRunsXml(leftRuns, RUNNING_HEAD_LEFT_RUN, p)}${rightXml}</w:p>`;
}

/** Bagi lebar total proporsional terhadap pola BM; sisa pembulatan ke kolom pertama. */
export function scaleCols(pattern: readonly number[], total: number): number[] {
  const sum = pattern.reduce((a, b) => a + b, 0);
  const out = pattern.map((w) => Math.floor((w * total) / sum));
  out[0] += total - out.reduce((a, b) => a + b, 0);
  return out;
}

/** Cadangan P4S-11 bila param `device.registerBlock.cells` kosong/tidak sah (sama dengan registri dan engine/html). */
export const REGISTER_CELLS_FALLBACK: readonly string[] = ["GSP · {nomor}", "REV · {tanggal}", "LEMBAR {n} DARI {N}", "{kelas}"];
/**
 * Sel pertama bawaan registri P4S-11 memuat literal "GSP"; selama registri
 * belum memakai `{org}`, pola persis ini dibaca sebagai "{org} · {nomor}" agar
 * `org.shortName` (render.ts r27) tetap berlaku.
 */
const REGISTER_ORG_CELL_LEGACY = "GSP · {nomor}";
/** Cadangan P4S-12: spasi tak-putus U+00A0 (BM footer5.xml). */
const REGISTER_SEPARATOR_FALLBACK = "\u00A0";

type RegisterField = "org" | "nomor" | "rev" | "tanggal" | "n" | "N" | "kelas";
type RegisterSegment = { text: string; bold: boolean; seal?: true } | { field: "PAGE" | "NUMPAGES"; bold: boolean };

const REGISTER_PLACEHOLDER = /\{(org|nomor|rev|tanggal|n|N|kelas)\}/g;

/**
 * Nama medan P4S-13 (`device.registerBlock.boldFields`, enum SR-05 KT-6) dan
 * alias pendek (paritas engine/html `FIELD_ALIASES`) -> medan pola register.
 */
const REGISTER_BOLD_ALIASES: Readonly<Record<string, RegisterField>> = {
  "nomor dokumen": "nomor",
  nomor: "nomor",
  revisi: "rev",
  rev: "rev",
  tanggal: "tanggal",
  "nomor lembar": "n",
  lembar: "n",
  "jumlah lembar": "N",
  klasifikasi: "kelas",
  kelas: "kelas",
  organisasi: "org",
  org: "org",
};

/**
 * Medan bertinta tebal blok register dari P4S-13 (IP-44, D-151): nilai BM
 * (nomor dokumen, revisi, nomor lembar, jumlah lembar, klasifikasi) disematkan
 * preset, bukan di mesin. Entri tak dikenal diabaikan; param absen/tidak sah =
 * tanpa medan tebal (registri selalu mengisi bawaan).
 */
export function registerBoldFields(p: RenderContext["tpl"]["params"]): ReadonlySet<RegisterField> {
  const raw = p["device.registerBlock.boldFields"];
  const out = new Set<RegisterField>();
  if (!Array.isArray(raw)) return out;
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const f = REGISTER_BOLD_ALIASES[v.trim().toLowerCase()];
    if (f) out.add(f);
  }
  return out;
}

/** Pola sel dari `device.registerBlock.cells` (P4S-11); entri non-string/kosong diabaikan. */
export function registerCellPatterns(p: RenderContext["tpl"]["params"]): string[] {
  const raw = p["device.registerBlock.cells"];
  const cells = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string" && c.length > 0) : [];
  return (cells.length > 0 ? cells : [...REGISTER_CELLS_FALLBACK]).map((c) =>
    c === REGISTER_ORG_CELL_LEGACY ? "{org} · {nomor}" : c,
  );
}

/** IMPL-W5 D2: label nomor dokumen di blok kendali sampul (ID/EN). */
const DISPLAY_NUMBER_LABEL = /^(?:nomor(?:\s+dokumen)?|no\.?(?:\s+dokumen)?|document\s+(?:number|no\.?)|doc(?:ument)?\.?\s*no\.?)$/i;
const cellPlain = (c: Cell | undefined): string =>
  c === undefined ? "" : typeof c.text === "string" ? c.text : Array.isArray(c.runs) ? c.runs.map((r) => ("t" in r ? r.t : "")).join("") : (c.paragraphs ?? []).map((p) => ((p as { runs?: Run[] }).runs ?? []).map((r) => ("t" in r ? r.t : "")).join("")).join(" ");

/**
 * IMPL-W5 D2 (D-557): nomor dokumen yang DICETAK sampul (blok kendali "Nomor dokumen"/"Document number"), bila ada.
 * Kaki halaman mengikuti nomor tampilan dokumen (meta.number agen), bukan nomor unik server; tanpa blok kendali
 * (dokumen lama, mode explicit benchmark) -> undefined (cadangan meta.docNumber, perilaku lama).
 */
export function displayDocNumber(ctx: RenderContext): string | undefined {
  const cover = ctx.snapshot.doc.front?.cover?.data as CoverData | undefined;
  for (const row of cover?.control?.rows ?? []) {
    for (let i = 0; i + 1 < row.length; i += 2) {
      if (!DISPLAY_NUMBER_LABEL.test(inlinePlain(row[i]).trim())) continue;
      const v = inlinePlain(row[i + 1]).trim();
      if (v !== "") return v;
    }
  }
  return undefined;
}

/**
 * IMPL-W5 D2: revisi terkini = baris terakhir riwayat revisi lembar kendali (model revisi dokumen itu sendiri, sama
 * dengan lembar kendali), kata "Rev"/"Revisi"/"Revision" di depan dibuang karena pola sel sudah mencetak "REV".
 * Tanpa riwayat -> undefined (cadangan meta.rev).
 */
export function displayRev(ctx: RenderContext): string | undefined {
  const cs = ctx.snapshot.doc.front?.controlSheet?.data as ControlSheetData | undefined;
  const rows = (cs?.revisionHistory?.rows ?? []).filter((r) => r.kind !== "header");
  const v = cellPlain(rows[rows.length - 1]?.cells[0]).replace(/^\s*rev(?:isi|ision)?\.?\s*/i, "").trim();
  return v !== "" ? v : undefined;
}

/**
 * Sel blok register bawaan dari pola templat (RQ-6, permintaan RT-01):
 * - pola `device.registerBlock.cells` (P4S-11) dengan medan `{org}` (org.shortName),
 *   `{nomor}`, `{rev}`, `{tanggal}`, `{n}` (PAGE), `{N}` (NUMPAGES), `{kelas}`;
 * - setiap spasi ASCII pada teks literal diganti `device.registerBlock.separator`
 *   (P4S-12, bawaan NBSP) sehingga "GSP · ", "REV ", "LEMBAR ", " DARI " = BM;
 * - sel berawalan "REV" tanpa `{rev}` mendapat huruf revisi setelah "REV"
 *   (aturan sama dengan engine/html registerCellParts; BM "REV A · 08-X-2026");
 * - medan yang tercantum di `device.registerBlock.boldFields` (P4S-13, IP-44)
 *   bertinta tebal (REGISTER_VALUE_RUN, termasuk medan PAGE `{n}` / NUMPAGES
 *   `{N}`), medan lain ikut run label abu; dengan nilai BM tersemat preset
 *   hasilnya = BM footer5.xml. Teks bersebelahan dengan format sama digabung
 *   menjadi satu run, sehingga struktur run identik BM.
 * Nilai medan tidak diubah (spasi di nomor dokumen/klasifikasi tetap).
 */
function registerDefaultCells(ctx: RenderContext): Run[][] {
  const p = ctx.tpl.params;
  const meta = ctx.snapshot.doc.meta;
  const lang = meta.language === "EN" ? "EN" : "ID";
  const sep = paramString(p, "device.registerBlock.separator") ?? REGISTER_SEPARATOR_FALLBACK;
  const org = paramString(p, "org.shortName") ?? "GSP";
  const bold = registerBoldFields(p);
  // Kata label LEMBAR/DARI dilokalkan lewat tabel bersama `front/texts.ts` (S06 B-11; "SHEET n OF N" untuk EN).
  const literal = (s: string): string => registerWordsText(s, lang).replace(/ /g, sep);
  const value = (f: Exclude<RegisterField, "n" | "N">): string => {
    switch (f) {
      case "org":
        return org;
      case "nomor":
        return displayDocNumber(ctx) ?? meta.docNumber ?? "";
      case "rev":
        return displayRev(ctx) ?? meta.rev;
      case "tanggal":
        return datumDate(meta.issueDate);
      case "kelas":
        return classificationMarkText(meta.classification);
    }
  };
  return registerCellPatterns(p).map((c0) => {
    const c = /^REV\b/.test(c0) && !c0.includes("{rev}") ? c0.replace(/^REV\b/, "REV {rev}") : c0;
    const segs: RegisterSegment[] = [];
    const pushText = (text: string, bold: boolean): void => {
      if (text.length === 0) return;
      const prev = segs[segs.length - 1];
      if (prev && "text" in prev && !prev.seal && prev.bold === bold) prev.text += text;
      else segs.push({ text, bold });
    };
    let last = 0;
    for (const m of c.matchAll(REGISTER_PLACEHOLDER)) {
      pushText(literal(c.slice(last, m.index)), false);
      const f = m[1] as RegisterField;
      if (f === "n") segs.push({ field: "PAGE", bold: bold.has("n") });
      else if (f === "N") segs.push({ field: "NUMPAGES", bold: bold.has("N") });
      // Swarm patch (row 49a, C104 H1): {kelas} is its own run, seal and bold at every level (DT-28d), whatever P4S-13 lists.
      else if (f === "kelas") segs.push({ text: value(f), bold: true, seal: true });
      else pushText(value(f), bold.has(f));
      last = m.index + m[0].length;
    }
    pushText(literal(c.slice(last)), false);
    return segs.map((s): Run =>
      "field" in s
        ? { field: s.field, ...(s.bold ? REGISTER_VALUE_RUN : REGISTER_LABEL_RUN) }
        : { t: s.text, ...(s.seal ? classificationRun(REGISTER_VALUE_RUN, p) : s.bold ? REGISTER_VALUE_RUN : REGISTER_LABEL_RUN) },
    );
  });
}

/** R-76 (C16, CL-02 NOTA): baris klasifikasi di bawah nomor dokumen; absen/false = tanpa baris. */
const PARAM_CLASSIFICATION_LINE = "render.nota.classificationLine";
/** Warna teks klasifikasi (DT-28d, segel 6E1420): token `color.wrapper.seal` "Pita segel dan klasifikasi". */
const PARAM_CLASSIFICATION_COLOUR = "color.wrapper.seal";
/** Kode log C16: register tanpa sel `{nomor}` (dicatat sekali per dokumen). */
const CLASSIFICATION_LINE_NO_NUMBER = "CLASSIFICATION_LINE_NO_NUMBER";
/**
 * Swarm patch (row 49a, C104 H1): run teks klasifikasi = `base` tebal bertinta `color.wrapper.seal` (Rev A DT-28d,
 * manual_id.txt:667-669: seal #6E1420, tebal, bukan alert); nilai tidak sah = SEAL. Dipakai kepala halaman kanan,
 * medan register `{kelas}` dan baris klasifikasi NOTA (C16).
 */
function classificationRun(base: RunProps, p: RenderContext["tpl"]["params"]): RunProps {
  return { ...base, b: true, color: normalizeHex(p[PARAM_CLASSIFICATION_COLOUR]) ?? SEAL };
}

/** Margin kiri sel register: sel pertama rata tepi blok teks, sel lain 141 tw (BM footer5.xml). */
const registerCellLeftTw = (i: number): number => (i === 0 ? 0 : 141);

/**
 * C16 (CL-02 NOTA, DT-28c ID:611-612, EN:647-648): "Klasifikasi : <K>" / "Classification: <K>"
 * tepat di bawah nomor dokumen. NOTA tidak punya sampul/blok kendali; nomornya hanya dicetak
 * di sel register yang berpola `{nomor}` (kaki setiap halaman interior). Baris menjadi paragraf
 * sesudah tabel register, menjorok ke tepi teks sel bernomor itu, sehingga sel register tetap
 * "GSP · <nomor>" saja. Label abu (run label register), nilai kapital tebal berwarna segel.
 * Sel eksplisit (`spec.cells`) atau pola tanpa `{nomor}` = tidak ada nomor untuk diikuti: dilewati, dicatat
 * sekali per dokumen (`warned` = himpunan kode per dokumen dari `buildSectionPackage`; absen = tiap panggilan).
 */
function classificationLineXml(
  ctx: RenderContext,
  unit: NormUnit,
  grid: readonly number[],
  explicitCells: boolean,
  pStyle: string,
  warned?: Set<string>,
): string {
  const p = ctx.tpl.params;
  const numberCell = explicitCells ? -1 : registerCellPatterns(p).findIndex((c) => c.includes("{nomor}"));
  if (numberCell < 0 || numberCell >= grid.length) {
    if (warned?.has(CLASSIFICATION_LINE_NO_NUMBER)) return "";
    warned?.add(CLASSIFICATION_LINE_NO_NUMBER);
    ctx.log({
      level: "warn",
      code: CLASSIFICATION_LINE_NO_NUMBER,
      address: unit.key,
      message: `${PARAM_CLASSIFICATION_LINE}: blok register tanpa sel nomor dokumen ({nomor}); baris klasifikasi tidak dicetak`,
    });
    return "";
  }
  const meta = ctx.snapshot.doc.meta;
  const value = classificationMarkText(meta.classification);
  const full = classificationLineText(meta.classification, wrapperLangOf(meta));
  const label = full.slice(0, full.length - value.length);
  const indent = grid.slice(0, numberCell).reduce((a, b) => a + b, 0) + registerCellLeftTw(numberCell);
  const fmt: ParaFormat = { ...REGISTER_PARA, jc: "left", ...(indent > 0 ? { indLeftTw: indent } : {}) };
  const valueRun = classificationRun(REGISTER_VALUE_RUN, p);
  return `<w:p>${pPrXml(fmt, pStyle)}${hfRunsXml([{ t: label }], REGISTER_LABEL_RUN, p)}${hfRunsXml([{ t: value }], valueRun, p)}</w:p>`;
}

function registerBody(
  spec: { cells?: Inline[] },
  ctx: RenderContext,
  unit: NormUnit,
  setup: ResolvedSectionSetup,
  pStyle: string,
  warned?: Set<string>,
): string {
  const p = ctx.tpl.params;
  const explicitCells = spec.cells !== undefined && spec.cells.length > 0;
  const cellRuns: Run[][] = explicitCells ? (spec.cells as Inline[]).map((c) => inlineRuns(c)) : registerDefaultCells(ctx);
  const n = cellRuns.length;
  const textW = textWidthTw(setup);
  const grid = n === REGISTER_COLS_TW.length ? scaleCols(REGISTER_COLS_TW, textW) : scaleCols(new Array<number>(n).fill(1), textW);
  const topRule = normalizeHex(p[PARAM_REGISTER_TOP_RULE]) ?? INK900;
  const cells: SimpleCell[] = cellRuns.map((runs, i) => {
    const last = i === n - 1;
    const borders: Omit<Borders, "insideH" | "insideV"> = {
      top: { val: "single", sz: 8, space: 0, color: topRule },
      bottom: { val: "single", sz: 5, space: 0, color: INK200 },
      ...(last ? {} : { right: { val: "single", sz: 5, space: 0, color: INK200 } }),
    };
    const para = `<w:p>${pPrXml({ ...REGISTER_PARA, jc: last ? "right" : "left" })}${hfRunsXml(runs, REGISTER_LABEL_RUN, p)}</w:p>`;
    return { widthTw: grid[i], paragraphsXml: para, borders, marginsTw: { top: 90, left: registerCellLeftTw(i), bottom: 79, right: 141 } };
  });
  // Wave 165 row 165A for row 165D (C188 F113-12; file request 165D -> 165A): the R-76 line is no longer printed in
  // the foot. Its place is under the number in the cover control block (F56-1); a NOTA has no cover and keeps its
  // classification in the head (right) and the register's last cell (DT-28c). The param stays accepted
  // (`classificationLineXml` is kept for a later caller; before: appended here when R-76 was true).
  return simpleTableXml(grid, [cells]) + `<w:p>${pPrXml(FOOTER_TAIL_FORMAT, pStyle)}</w:p>`;
}

function cellParagraphs(c: Cell, ctx: RenderContext): string {
  const p = ctx.tpl.params;
  if (c.paragraphs) {
    return c.paragraphs
      .map((cp) => `<w:p>${pPrXml(cp.format)}${hfRunsXml(inlineRuns(cp), {}, p)}</w:p>`)
      .join("");
  }
  const runs: Run[] = c.runs ?? (c.text !== undefined ? [{ t: c.text }] : []);
  return `<w:p>${hfRunsXml(runs, {}, p)}</w:p>`;
}

/**
 * Tabel header/footer kustom: satu tingkat, lebar kolom `widthTw`/`widthMm`
 * atau bagi rata blok teks. Tabel bersarang dan caption/source tidak
 * didukung di kepala/kaki halaman (dicatat ke log, diabaikan).
 */
function customTableXml(t: TableBlock, ctx: RenderContext, unit: NormUnit, setup: ResolvedSectionSetup): string {
  const textW = t.layout?.widthTw ?? textWidthTw(setup);
  const known = t.columns.map((c) => c.widthTw ?? (c.widthMm !== undefined ? mmToTw(c.widthMm) : undefined));
  const fixed = known.reduce<number>((a, w) => a + (w ?? 0), 0);
  const nUnknown = known.filter((w) => w === undefined).length;
  const share = nUnknown > 0 ? Math.max(0, Math.floor((textW - fixed) / nUnknown)) : 0;
  const grid = known.map((w) => w ?? share);
  if (t.caption || t.source) {
    ctx.log({ level: "warn", message: "caption/source tabel kepala/kaki halaman diabaikan", address: unit.key });
  }
  const rows = t.rows.map((r) => {
    let col = 0;
    return r.cells.map((c) => {
      const span = c.gridSpan ?? 1;
      const width = c.widthTw ?? grid.slice(col, col + span).reduce((a, b) => a + b, 0);
      col += span;
      if (c.nested) ctx.log({ level: "warn", message: "tabel bersarang di kepala/kaki halaman diabaikan", address: unit.key });
      return {
        widthTw: width,
        paragraphsXml: cellParagraphs(c, ctx),
        borders: c.borders,
        marginsTw: c.marginsTw,
        shading: c.shading,
        gridSpan: span,
        vAlign: c.vAlign,
      } satisfies SimpleCell;
    });
  });
  return simpleTableXml(grid, rows, t.layout?.indentTw ?? 0);
}

function customBody(
  spec: Extract<HeaderFooterSpec, { mode: "custom" }>,
  ctx: RenderContext,
  unit: NormUnit,
  setup: ResolvedSectionSetup,
  pStyle: string,
): string {
  const p = ctx.tpl.params;
  let xml = (spec.paragraphs ?? []).map((para) => `<w:p>${pPrXml(para.format, pStyle)}${hfRunsXml(para.runs, {}, p)}</w:p>`).join("");
  if (spec.table) {
    xml += customTableXml(spec.table, ctx, unit, setup) + `<w:p>${pPrXml(FOOTER_TAIL_FORMAT, pStyle)}</w:p>`;
  }
  return xml || emptyBody({}, pStyle);
}

/**
 * Bagian `word/headerN.xml` / `word/footerN.xml` lengkap (deklarasi XML +
 * akar `w:hdr`/`w:ftr`). `inherit` diselesaikan dari param templat
 * `render.section.wrapper|interior` sesuai jenis unit.
 */
export function headerFooterXml(
  spec: HeaderFooterSpec,
  ctx: RenderContext,
  unit: NormUnit,
  kind: "hdr" | "ftr",
  trailingXml = "",
  /** Kode peringatan yang sudah dicatat di dokumen ini (dibagi antar unit oleh `buildSectionPackage`). */
  warned?: Set<string>,
): string {
  const setup = resolveUnitSetup(unit, ctx.tpl);
  const eff = spec.mode === "inherit" ? (kind === "hdr" ? setup.header : setup.footer) : spec;
  const pStyle = kind === "hdr" ? "Header" : "Footer";
  let body: string;
  switch (eff.mode) {
    case "empty":
      body = emptyBody(eff, pStyle);
      break;
    case "runningHead":
      body = runningHeadBody(eff, ctx, unit, setup, pStyle);
      break;
    case "registerBlock":
      body = registerBody(eff, ctx, unit, setup, pStyle, warned);
      break;
    case "custom":
      body = customBody(eff, ctx, unit, setup, pStyle);
      break;
    default: {
      const never: never = eff;
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `mode header/footer tidak dikenal: ${JSON.stringify(never)}`);
    }
  }
  const root = kind === "hdr" ? "w:hdr" : "w:ftr";
  return `${XML_DECL}<${root} ${HDR_FTR_NS}>${body}${trailingXml}</${root}>`;
}

// ── Penanda draf (SR-16, R-39 `render.draft.marker`) ────────────────────

/** Penanda draf efektif: `{text, placement}` dari R-39; `undefined` bila param tidak sah/teks kosong. */
export function draftMarkerOf(p: RenderContext["tpl"]["params"]): { text: string; placement: "header" | "footer" } | undefined {
  const v = p["render.draft.marker"];
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (text.length === 0) return undefined;
  return { text, placement: o.placement === "footer" ? "footer" : "header" };
}

/**
 * Paragraf penanda draf di kepala/kaki halaman: rata kanan, tebal, kapital,
 * tinta peran kepala berjalan kanan (tanpa spasi sebelum/sesudah).
 */
export function draftMarkerParagraphXml(text: string, ctx: RenderContext, kind: "hdr" | "ftr"): string {
  const fmt: ParaFormat = { spacingBeforeTw: 0, spacingAfterTw: 0, jc: "right" };
  const run: RunProps = { ...RUNNING_HEAD_RIGHT_RUN };
  return `<w:p>${pPrXml(fmt, kind === "hdr" ? "Header" : "Footer")}<w:r>${rPrXml(run, ctx.tpl.params)}<w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

// ── Rakitan seksi (antarmuka untuk S20) ─────────────────────────────────

export interface SectionPackagePart {
  unitKey: string;
  unitKind: NormUnit["kind"];
  setup: ResolvedSectionSetup;
  headerRId: string;
  footerRId: string;
  headerPath: string;
  footerPath: string;
  /** `w:sectPr` unit ini; S20 menaruhnya di paragraf pemegang (K-12) atau akhir body. */
  sectPr: string;
}

export interface SectionPackage {
  sections: SectionPackagePart[];
  /** Bagian header/footer untuk `DocxPackageInput.parts`. */
  parts: Array<{ path: string; data: string; contentType: string }>;
  /** Relasi untuk `DocxPackageInput.relationships`. */
  relationships: Relationship[];
  /** Wajah fon yang dipakai header/footer (masukan planEmbeddedFonts S15). */
  facesUsed: string[];
}

/**
 * Wave 165 row 165A (C188 F113-6): bookmark at the end of the last unit before Bab 1 (its section-break paragraph,
 * `docx/assemble/index.ts`). The wrapper sections are not renumbered, so `PAGEREF _StSheet0` = the number of sheets
 * before Bab 1 (cover, control sheet, contents), and `NUMPAGES - PAGEREF _StSheet0` = the numbered sheets.
 */
export const SHEET_ZERO_BOOKMARK = { id: 900000, name: "_StSheet0" } as const;

export function sheetZeroBookmarkXml(): string {
  return `<w:bookmarkStart w:id="${SHEET_ZERO_BOOKMARK.id}" w:name="${SHEET_ZERO_BOOKMARK.name}"/><w:bookmarkEnd w:id="${SHEET_ZERO_BOOKMARK.id}"/>`;
}

/** True when the unit at `index` is the last unit before the first chapter of a document numbered from Bab 1. */
export function isSheetZeroUnit(ctx: RenderContext, units: readonly NormUnit[], index: number): boolean {
  const firstChapter = units.findIndex((u) => u.kind === "chapter");
  return firstChapter > 0 && index === firstChapter - 1 && sheetNumberingFromChapter1(ctx.tpl.params, ctx.snapshot.doc.meta.language === "EN" ? "EN" : "ID");
}

const NUMPAGES_SIMPLE_RE = /<w:fldSimple w:instr=" NUMPAGES "><w:r>(<w:rPr>[\s\S]*?<\/w:rPr>|)<w:t>([^<]*)<\/w:t><\/w:r><\/w:fldSimple>/g;

/**
 * Wave 165 row 165A (F113-6): every simple NUMPAGES field of a register footer becomes
 * `{ = { NUMPAGES } - { PAGEREF _StSheet0 } }` (complex fields, same run format, outer cached result kept). Before: the
 * plain NUMPAGES = document total (LEMBAR 1 DARI 7 on case 01 with three unnumbered sheets).
 */
export function withNumberedSheetTotal(footerXml: string): string {
  return footerXml.replace(NUMPAGES_SIMPLE_RE, (_m, rPr: string, cached: string) => {
    const r = (inner: string) => `<w:r>${rPr}${inner}</w:r>`;
    const instr = (t: string) => r(`<w:instrText xml:space="preserve">${t}</w:instrText>`);
    const ch = (t: "begin" | "separate" | "end") => r(`<w:fldChar w:fldCharType="${t}"/>`);
    return (
      ch("begin") + instr(" = ") +
      // Nested fields carry no cached text, so a reader of the cached cell text still sees "LEMBAR n DARI N" only.
      ch("begin") + instr(" NUMPAGES ") + ch("end") +
      instr(" - ") +
      ch("begin") + instr(` PAGEREF ${SHEET_ZERO_BOOKMARK.name} `) + ch("end") +
      ch("separate") + r(`<w:t>${cached}</w:t>`) + ch("end")
    );
  });
}

/**
 * Satu seksi per unit ternormalisasi (KS-06, R-11): pasangan header/footer
 * `word/header{n}.xml`/`word/footer{n}.xml` (n = 1..jumlah unit), relasi
 * `rId{first+2(n-1)}` dan `rId{first+2(n-1)+1}`, plus sectPr. BM = 29 unit.
 */
export interface BuildSectionPackageOptions {
  firstRelId?: number;
  /** Unit terencana (perakit sadar slot SR-16); bawaan `ctx.snapshot.units` (jalur v1). */
  units?: readonly NormUnit[];
  /** RenderContext per unit (nilai efektif slot); bawaan `ctx` untuk semua unit. */
  contextFor?: (unit: NormUnit, index: number) => RenderContext;
  /** Penanda draf (R-39) yang ditambahkan ke kepala atau kaki setiap seksi. */
  draftMarker?: { text: string; placement: "header" | "footer" };
}

export function buildSectionPackage(ctx: RenderContext, opts: BuildSectionPackageOptions = {}): SectionPackage {
  const first = opts.firstRelId ?? 9;
  if (!Number.isInteger(first) || first < 1) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `firstRelId tidak sah: ${first}`);
  }
  const units = opts.units ?? ctx.snapshot.units;
  if (units.length === 0) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "snapshot tanpa unit: minimal satu seksi");
  }
  const sections: SectionPackagePart[] = [];
  const parts: SectionPackage["parts"] = [];
  const relationships: Relationship[] = [];
  const faces = new Set<string>();
  const marker = opts.draftMarker;
  // C26 (RB-08c, R-80 "bab1"): halaman pertama Bab 1 = lembar 1. Seksi pembungkus sebelumnya tetap
  // tanpa medan PAGE; kaki register tetap PAGE lalu NUMPAGES (CR-4). "DARI N" = jumlah halaman dokumen,
  // bukan dihitung dari Bab 1 (SECTIONPAGES = per seksi, salah). LibreOffice 24.2 menambah satu halaman
  // kosong otomatis ke NUMPAGES bila Bab 1 jatuh di halaman fisik genap (laporan engine C, C26).
  const firstChapter = units.findIndex((u) => u.kind === "chapter");
  // Peringatan yang sama untuk setiap unit (mis. C16 tanpa `{nomor}`) dicatat sekali per dokumen.
  const warned = new Set<string>();
  units.forEach((unit, i) => {
    const n = i + 1;
    const uctx = opts.contextFor ? opts.contextFor(unit, i) : ctx;
    const setup = resolveUnitSetup(unit, uctx.tpl);
    const headerRId = `rId${first + 2 * i}`;
    const footerRId = `rId${first + 2 * i + 1}`;
    const headerPath = `word/header${n}.xml`;
    const footerPath = `word/footer${n}.xml`;
    const hdrTail = marker?.placement === "header" ? draftMarkerParagraphXml(marker.text, uctx, "hdr") : "";
    const ftrTail = marker?.placement === "footer" ? draftMarkerParagraphXml(marker.text, uctx, "ftr") : "";
    const hdr = headerFooterXml(setup.header, uctx, unit, "hdr", hdrTail, warned);
    const ftr0 = headerFooterXml(setup.footer, uctx, unit, "ftr", ftrTail, warned);
    // Wave 165 row 165A (C188 F113-6): with sheets numbered from Bab 1, "DARI N" = NUMPAGES minus the sheets before
    // Bab 1 (= PDF numbered pass), as a Word formula over the NUMPAGES field (DT-13g keeps the field).
    const restart = firstChapter > 0 && sheetNumberingFromChapter1(uctx.tpl.params, uctx.snapshot.doc.meta.language === "EN" ? "EN" : "ID");
    const ftr = restart && i >= firstChapter ? withNumberedSheetTotal(ftr0) : ftr0;
    for (const f of [...facesInXml(hdr), ...facesInXml(ftr)]) faces.add(f);
    parts.push(
      { path: headerPath, data: hdr, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml" },
      { path: footerPath, data: ftr, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml" },
    );
    relationships.push(
      { id: headerRId, type: REL.header, target: `header${n}.xml` },
      { id: footerRId, type: REL.footer, target: `footer${n}.xml` },
    );
    sections.push({
      unitKey: unit.key,
      unitKind: unit.kind,
      setup,
      headerRId,
      footerRId,
      headerPath,
      footerPath,
      sectPr: sectPrXml(
        setup,
        { headerRId, footerRId },
        i === firstChapter && sheetNumberingFromChapter1(uctx.tpl.params, uctx.snapshot.doc.meta.language === "EN" ? "EN" : "ID") ? { pgNumStart: 1 } : {},
      ),
    });
  });
  return { sections, parts, relationships, facesUsed: [...faces].sort() };
}
