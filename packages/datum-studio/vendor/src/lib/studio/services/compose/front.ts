/**
 * Payload slot tak-berulang v2 -> struktur halaman depan internal v1 (SR-08;
 * register §4.4, §14.2 arah balik). Medan absen pada slot MIXED dibangkitkan
 * dari `meta` (KD-18); label, kicker, judul tabel, dan tata letak milik mesin.
 */
import type {
  ControlSheetData,
  ChapterV2,
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
  colophonClassificationText,
  CONTROL_FIELD_LABELS,
  CONTROL_SHEET_COLUMN_LABELS,
  CONTROL_SHEET_DRAFT_STATUS_TEXT,
  CONTROL_SHEET_STATUS_TEXT,
  controlSheetColumnHeads,
  controlSheetDraftRemarkText,
  controlSheetLabelText,
  coverPreparerUnit,
  FRONT_PAYLOAD_LABELS,
  templateMethodStatementText,
  wrapperLangOf,
  type ControlSheetTableKind,
  type WrapperLang,
} from "../../engine/front/texts";
import { diagramLabelsUnchecked, LABELS_UNCHECKED_TEXT } from "../../engine/lint/structure/checks-d";
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
  if (p.colophon) {
    // Swarm 1.3.3 row 87 (ST-12, replay R12): a classification named in a written colophon is re-derived from the
    // document field, so it equals the cover strip (`coverClassificationOf`, same fallback). One place for HTML,
    // DOCX and PDF (via HTML): every renderer reads `data.colophon` from this snapshot.
    const own = (v: Inline): Inline =>
      "text" in v
        ? { ...v, text: colophonClassificationText(v.text, meta, params ?? {}) }
        : { ...v, runs: v.runs.map((r) => ("t" in r ? { ...r, t: colophonClassificationText(r.t, meta, params ?? {}) } : r)) };
    data.colophon = { type: "colophon", left: own(mapInline(p.colophon.left, ctx)), right: own(mapInline(p.colophon.right, ctx)) };
  }
  return { mode: "auto", data };
}

/**
 * `language` = bahasa dokumen (`meta.language`, S14, D-597 D-5): kepala kolom dari tabel teks; label slot yang sama
 * dengan kicker bawaan ID diterjemahkan (`controlSheetLabelText`), label lain menang. Bawaan ID =
 * perilaku sebelum S14.
 */
export function controlSheetFront(
  payload: ControlSheetPayloadV2 | undefined,
  slot: TemplateSlotDef,
  ctx: BlockCtx,
  language?: DocMeta["language"],
  /** Swarm 1.3.3 row 63: number of figures with unchecked labels (`uncheckedFigureCount`); 0 or absent = sheet as before. */
  uncheckedFigures = 0,
  /** Swarm 1.3.3 row 150: the document's tier (`meta.tier`), for the template method statement the remark follows. */
  tier?: DocMeta["tier"],
): FrontPage {
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
      ? (rows) => manualTable("revision", lang, rows.map((r, i) => [r.rev, r.date, r.by, r.what, revisionStatusText(i === rows.length - 1, lang, uncheckedFigures > 0)]))
      : (rows) => textTable(controlSheetColumnHeads("revision", lang), rows.map((r) => [r.rev, r.date, r.what, r.by]), ["id", "text", "text", "text"]),
    ctx,
  );
  if (rh) data.revisionHistory = rh;
  // Row 207 (HB-2): the manual columns (LAPIS/METODE/OBJEK/HASIL) print method/object/result; also in the machine
  // form when any entry carries them (they were dropped before). Machine form without them = unchanged.
  const vc = listOrTable<VerificationEntryV2>(
    p.verificationChain,
    (rows) =>
      manual || rows.some(hasManualVerificationKeys)
        ? manualTable("verification", lang, rows.map(manualVerificationRow))
        : textTable(controlSheetColumnHeads("verification", lang), rows.map((r) => [r.layer, r.role ?? "", r.name ?? "", r.date ?? ""]), ["id", "text", "text", "text"]),
    ctx,
  );
  if (vc) data.verificationChain = vc;
  if (p.methodStatement) data.methodStatement = mapInline(p.methodStatement, ctx);
  // Swarm 1.3.3 row 63 (ST-9 item 2): while a figure waits for a person to check its labels the sheet says so, once, in
  // the one free-text place of the sheet (the method statement); nothing is printed otherwise.
  // Row 150: the remark is added AFTER the method statement, never in its place: the author's text, else the template's
  // (R-81 or the one built from the layers, which the renderers would print for a TERBIT/SERAH sheet without a statement).
  if (uncheckedFigures > 0) {
    const method = hasInlineText(data.methodStatement) ? data.methodStatement : ((m) => (m ? { text: m } : undefined))(templateMethodStatementText(ctx.params, tier === undefined ? undefined : { tier }, lang));
    data.methodStatement = withDraftRemark(method, controlSheetDraftRemarkText(LABELS_UNCHECKED_TEXT[lang], uncheckedFigures, lang));
  }
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

const hasManualVerificationKeys = (r: VerificationEntryV2): boolean => [r.method, r.object, r.result].some((v) => typeof v === "string" && v.trim() !== "");

/**
 * Row 207 (HB-2): one verification entry in the manual columns LAPIS, METODE, OBJEK, HASIL. METODE = method, OBJEK =
 * object, HASIL = result. The documented sign-off keys are mapped onto the same columns so nothing the agent sent is
 * dropped: METODE = role when method is absent, HASIL = name (and date, "name · date") when result is absent. No
 * value is invented: a column with no source stays empty.
 */
export function manualVerificationRow(r: VerificationEntryV2): string[] {
  const signOff = [r.name, r.date].filter((v): v is string => typeof v === "string" && v.trim() !== "").join(" · ");
  return [r.layer, r.method ?? r.role ?? "", r.object ?? "", r.result ?? signOff];
}

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
function revisionStatusText(latest: boolean, lang: WrapperLang, draft = false): string {
  if (latest && draft) return CONTROL_SHEET_DRAFT_STATUS_TEXT[lang];
  return CONTROL_SHEET_STATUS_TEXT[latest ? "current" : "superseded"][lang];
}

/** `remark` appended to the method statement (a new paragraph run after the author's text; alone when there is none). */
function hasInlineText(v: Inline | undefined): v is Inline {
  if (v === undefined) return false;
  return "text" in v ? v.text.trim() !== "" : v.runs.some((r) => "t" in r && r.t.trim() !== "");
}

function withDraftRemark(existing: Inline | undefined, remark: string): Inline {
  if (existing === undefined) return { text: remark };
  if ("text" in existing) return existing.text.trim() === "" ? { text: remark } : { text: `${existing.text} ${remark}` };
  return { runs: [...existing.runs, { t: ` ${remark}` }] };
}

/**
 * Swarm 1.3.3 row 63: figures of the merged source whose labels no person has checked (diagram blocks with
 * `labels_verified` not true; a block that only refers to an artefact has no flag here and counts, as in D09).
 * Chapters of every slot, introductions and section blocks, as `collectSourcePids` walks them.
 */
export function uncheckedFigureCount(sections: Readonly<Record<string, unknown>> | undefined): number {
  let n = 0;
  const count = (b: { type?: string; spec?: unknown; artifactId?: unknown }): void => {
    if (b.type !== "diagram") return;
    if (b.spec === undefined && b.artifactId !== undefined) n++;
    else if (diagramLabelsUnchecked(b.spec)) n++;
  };
  for (const payload of Object.values(sections ?? {})) {
    for (const c of (payload as { chapters?: ChapterV2[] } | undefined)?.chapters ?? []) {
      for (const b of c.intro ?? []) count(b as never);
      for (const sec of c.sections ?? []) for (const b of sec.blocks ?? []) count(b as never);
    }
  }
  return n;
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
