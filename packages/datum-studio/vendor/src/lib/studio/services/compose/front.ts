/**
 * Payload slot tak-berulang v2 -> struktur halaman depan internal v1 (SR-08;
 * register §4.4, §14.2 arah balik). Medan absen pada slot MIXED dibangkitkan
 * dari `meta` (KD-18); label, kicker, judul tabel, dan tata letak milik mesin.
 */
import type {
  ControlSheetData,
  ControlSheetPayloadV2,
  CoverData,
  CoverPayloadV2,
  DistributionEntryV2,
  DocMeta,
  FrontPage,
  Inline,
  ParamMap,
  RevisionEntryV2,
  SignatureBlock,
  SignaturePayloadV2,
  TableBlock,
  TableV2,
  TemplateSlotDef,
  TocPayloadV2,
  TocSpec,
  VerificationEntryV2,
} from "../../contract";
import {
  classificationMarkText,
  CONTROL_FIELD_LABELS,
  CONTROL_SHEET_COLUMN_LABELS,
  CONTROL_SHEET_STATUS_TEXT,
  controlSheetColumnHeads,
  controlSheetLabelText,
  coverPreparerUnit,
  FRONT_PAYLOAD_LABELS,
  wrapperLangOf,
  type ControlSheetTableKind,
  type WrapperLang,
} from "../../engine/front/texts";
import { table, type BlockCtx } from "./blocks";
import { mapInline, mapInlineOpt, type InlineCtx } from "./inline";

/** Tabel teks daftar bertipe; kepala kolom = teks keluaran mesin (`engine/front/texts.ts`), bukan kiriman agen. */
function textTable(head: readonly string[], rows: string[][], roles: Array<"text" | "id" | "numeral">): TableV2 {
  return {
    type: "registerTable",
    columns: roles.map((role) => ({ role })),
    rows: [{ kind: "header", cells: head.map((t) => ({ text: t })) }, ...rows.map((r) => ({ cells: r.map((t) => ({ text: t })) }))],
  };
}

/** Daftar bertipe atau TableV2 konten-saja (KD-19) -> TableBlock internal. */
function listOrTable<T>(v: T[] | TableV2 | undefined, toTable: (rows: T[]) => TableV2, ctx: BlockCtx): TableBlock | undefined {
  if (v === undefined) return undefined;
  return table(Array.isArray(v) ? toTable(v) : v, undefined, ctx);
}

/** Label medan klasifikasi blok kendali sampul semua bahasa (tabel teks yang sama dengan klien MCP). */
const CLASSIFICATION_LABELS: ReadonlySet<string> = new Set(Object.values(FRONT_PAYLOAD_LABELS.classification));

/**
 * G-FIX1 (D-606) butir (g): nilai teks di sebelah label klasifikasi (pasangan label/nilai sel 0-1 dan 2-3) dicetak
 * kapital lewat helper penandaan bersama; sel lain, nilai berbentuk runs, dan nilai yang sudah kapital apa adanya.
 */
function markClassificationPairs(row: [Inline, Inline, Inline, Inline]): [Inline, Inline, Inline, Inline] {
  const out: [Inline, Inline, Inline, Inline] = [...row];
  for (const i of [0, 2]) {
    const label = out[i];
    const value = out[i + 1];
    if (label && value && "text" in label && CLASSIFICATION_LABELS.has(label.text.trim()) && "text" in value) out[i + 1] = { ...value, text: classificationMarkText(value.text) };
  }
  return out;
}

/** Label medan penyusun blok kendali sampul semua bahasa (Penyusun / Prepared by; tabel teks yang sama dengan klien MCP). */
const PREPARER_LABELS: ReadonlySet<string> = new Set(Object.values(CONTROL_FIELD_LABELS.PENYUSUN));

/**
 * C27 (CV-15, research/38 §3.5 dan risiko K-6; D-627 Q2, D-635 (4)): pada blok kendali eksplisit (klien MCP mengirimnya
 * bila meta.number ada), nilai teks di sebelah label penyusun dicetak sebagai unit templat R-79. Hanya keluaran compose
 * yang berubah; muatan tersimpan tetap `meta.author`, sehingga pembacaan balik meta klien MCP (`write-meta.ts`
 * `serverClientMeta`) dan blok tanda tangan / riwayat revisi tidak menerima unit.
 */
function preparerPairs(row: [Inline, Inline, Inline, Inline], unit: string): [Inline, Inline, Inline, Inline] {
  const out: [Inline, Inline, Inline, Inline] = [...row];
  for (const i of [0, 2]) {
    const label = out[i];
    const value = out[i + 1];
    if (label && value && "text" in label && PREPARER_LABELS.has(label.text.trim()) && "text" in value) out[i + 1] = { ...value, text: unit };
  }
  return out;
}

/** `params` = parameter slot sampul; dibaca hanya R-79 (kunci compose, C-5). */
export function coverFront(payload: CoverPayloadV2 | undefined, meta: DocMeta, ctx: InlineCtx, params?: ParamMap): FrontPage {
  const p = payload ?? ({ type: "cover" } as CoverPayloadV2);
  const data: CoverData = {
    titleLines: p.titleLines && p.titleLines.length > 0 ? p.titleLines.map((t) => mapInline(t, ctx)) : [{ text: meta.title }],
  };
  const set = <K extends keyof CoverData>(k: K, v: CoverData[K] | undefined) => {
    if (v !== undefined) data[k] = v;
  };
  set("kicker", mapInlineOpt(p.tagline, ctx));
  set("standfirst", mapInlineOpt(p.standfirst, ctx));
  set("scopeLine", mapInlineOpt(p.scopeLine, ctx));
  set("addressLine", mapInlineOpt(p.addressLine, ctx));
  set("identityString", mapInlineOpt(p.identityString, ctx));
  if (p.control) {
    const unit = params ? coverPreparerUnit(params) : undefined;
    data.control = {
      type: "controlBlock",
      rows: p.control.map((r) => {
        const row = markClassificationPairs(r.map((c) => mapInline(c, ctx)) as [Inline, Inline, Inline, Inline]);
        return unit !== undefined ? preparerPairs(row, unit) : row;
      }),
    };
  }
  if (p.colophon) data.colophon = { type: "colophon", left: mapInline(p.colophon.left, ctx), right: mapInline(p.colophon.right, ctx) };
  return { mode: "auto", data };
}

/**
 * `language` = bahasa dokumen (`meta.language`, S14, D-597 D-5): kepala kolom dari tabel teks; label slot yang sama
 * dengan kicker bawaan ID diterjemahkan (`controlSheetLabelText`), label lain menang. Bawaan ID =
 * perilaku sebelum S14.
 */
export function controlSheetFront(payload: ControlSheetPayloadV2 | undefined, slot: TemplateSlotDef, ctx: BlockCtx, language?: DocMeta["language"]): FrontPage {
  const p = payload ?? ({ type: "controlSheet" } as ControlSheetPayloadV2);
  const lang = wrapperLangOf({ language });
  const label = controlSheetLabelText(slot.label, lang);
  const data: ControlSheetData = {
    // Kicker = label slot (DF-59); judul bawaan = label slot bila agen tidak mengirim.
    kicker: { text: label },
    title: p.title ? mapInline(p.title, ctx) : { text: label },
  };
  const manual = ctx.params["controlSheet.columns.form"] === "manual";
  const rh = listOrTable<RevisionEntryV2>(
    p.revisionHistory,
    manual
      ? (rows) => manualTable("revision", lang, rows.map((r, i) => [r.rev, r.date, r.by, r.what, revisionStatusText(i === rows.length - 1, lang)]))
      : (rows) => textTable(controlSheetColumnHeads("revision", lang), rows.map((r) => [r.rev, r.date, r.what, r.by]), ["id", "text", "text", "text"]),
    ctx,
  );
  if (rh) data.revisionHistory = rh;
  const vc = listOrTable<VerificationEntryV2>(
    p.verificationChain,
    manual
      ? (rows) => manualTable("verification", lang, rows.map((r) => [r.layer, "", "", ""]))
      : (rows) => textTable(controlSheetColumnHeads("verification", lang), rows.map((r) => [r.layer, r.role, r.name, r.date ?? ""]), ["id", "text", "text", "text"]),
    ctx,
  );
  if (vc) data.verificationChain = vc;
  if (p.methodStatement) data.methodStatement = mapInline(p.methodStatement, ctx);
  const ds = listOrTable<DistributionEntryV2>(
    p.distribution,
    manual
      ? (rows) => manualTable("distribution", lang, rows.map((r) => [r.copy, r.holder, "", ""]))
      : (rows) => textTable(controlSheetColumnHeads("distribution", lang), rows.map((r) => [r.copy, r.holder]), ["id", "text"]),
    ctx,
  );
  if (ds) data.distribution = ds;
  return { mode: "auto", data };
}

type ManualColumn = keyof typeof CONTROL_SHEET_COLUMN_LABELS;

/**
 * C10 (CS-11, register research/38 §3.2): pengenal kolom bentuk manual = bawaan registri
 * `controlSheet.revisionHistory.columns`, `controlSheet.verificationChain.columns`, `controlSheet.distribution.columns`
 * (`params/page.ts`; ID:29, ID:39, ID:58; EN:29, EN:38, EN:62). Nilai templat parameter kolom itu TIDAK dibaca compose
 * (tidak masuk `COMPOSE_PARAM_KEYS`); hanya opt-in R-69 `controlSheet.columns.form` yang dibaca (C-5).
 */
const MANUAL_COLUMNS = {
  revision: ["REV", "TANGGAL", "PENYUSUN", "PERUBAHAN", "STATUS"],
  verification: ["LAPIS", "METODE", "OBJEK", "HASIL"],
  distribution: ["SALINAN", "PEMEGANG", "MEDIA", "KEMBALI"],
} as const satisfies Readonly<Record<ControlSheetTableKind, readonly ManualColumn[]>>;

/** Kepala kolom bentuk manual tabel `kind` dalam bahasa `lang` (tabel teks mesin, C07). */
export function manualControlSheetColumnHeads(kind: ControlSheetTableKind, lang: WrapperLang): string[] {
  return MANUAL_COLUMNS[kind].map((c) => CONTROL_SHEET_COLUMN_LABELS[c][lang]);
}

/** Kolom pertama = kode (REV/LAPIS/SALINAN), sisanya teks. */
function manualTable(kind: ControlSheetTableKind, lang: WrapperLang, rows: string[][]): TableV2 {
  const heads = manualControlSheetColumnHeads(kind, lang);
  return textTable(heads, rows, heads.map((_, i) => (i === 0 ? "id" : "text")));
}

/**
 * STATUS turunan (bukan muatan; register research/38 §3.2): baris revisi terakhir = berlaku (ID:31, EN:31), baris
 * sebelumnya = diganti. Tidak bercabang per tier: tabel teks hanya punya dua nilai dan slot lembar kendali hanya aktif
 * pada tier yang memuatnya (kerangka), jadi tier tidak mengubah teks STATUS.
 */
function revisionStatusText(latest: boolean, lang: WrapperLang): string {
  return CONTROL_SHEET_STATUS_TEXT[latest ? "current" : "superseded"][lang];
}

export function signatureBlock(payload: SignaturePayloadV2, ctx: InlineCtx): SignatureBlock {
  return {
    type: "signatureBlock",
    roles: payload.roles.map((r) => {
      const role: SignatureBlock["roles"][number] = { role: mapInline(r.role, ctx), holder: mapInline(r.holder, ctx) };
      if (r.date) role.date = mapInline(r.date, ctx);
      return role;
    }),
  };
}

/** Teks kenop templat (string tak kosong) atau undefined (null/absen = teks bawaan templat). */
function knobText(params: ParamMap | undefined, key: string): Inline | undefined {
  const v = params?.[key];
  return typeof v === "string" && v.trim() !== "" ? { text: v } : undefined;
}

/**
 * AUTO / MIXED tanpa entri: daftar isi medan (dihitung saat render penuh); MIXED + entri: statis.
 * Judul/catatan = kenop templat `render.toc.title` / `render.toc.note` (DF-58, RQ-8), bukan kiriman agen.
 */
export function tocSpec(payload: TocPayloadV2 | undefined, ctx: InlineCtx, params?: ParamMap): TocSpec {
  const entries = payload?.entries;
  const out: TocSpec =
    !entries || entries.length === 0
      ? { mode: "field" }
      : {
          mode: "static",
          entries: entries.map((e) => ({ level: e.level, label: e.label ? mapInline(e.label, ctx) : { text: "" }, title: mapInline(e.title, ctx), page: e.page })),
        };
  const title = knobText(params, "render.toc.title");
  if (title) out.title = title;
  const note = knobText(params, "render.toc.note");
  if (note) out.note = note;
  return out;
}
