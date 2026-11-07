/**
 * Modul engine/docx/assemble (I09, 01_specs.md §8.2), diisi S20: perakit DOCX;
 * sadar slot sejak SR-16 (blueprint 05 §2.9, register 03 §4.6, §13.4, §15.1).
 *
 * Alur: rencana unit (`planUnits` v1/v2, KS-06) -> penomoran artefak SELURUH
 * dokumen per bab (§4.1: Tabel C.n, Gambar C.n, Turunan D-C.n) -> saring
 * lingkup render (`ctx.scope`: DOCUMENT/CHAPTER/SLOT) -> RenderContext per unit
 * (v2: nilai efektif slot `ctx.slots` menimpa parameter/peran templat) -> render
 * tiap blok lewat `DOCX_RENDERERS` (dispatcher D01: S16 blocks, S17 tables, S18
 * wrapper, S19 figures) -> satu seksi Word per unit (`buildSectionPackage` S14,
 * rId mulai `FIRST_FREE_REL_ID`; paragraf pemegang sectPr peran U11 di akhir
 * unit, sectPr unit terakhir di akhir body; penanda draf R-39 di kepala/kaki
 * setiap seksi pada render draf) -> media (figur S19: nama/rId `fig-*`/
 * `rIdFig*` dipertahankan lewat mergeFigureMedia/figureMediaRelId, D-47;
 * lainnya dedup + rId numerik) -> `wp:docPr` 1..n -> rencana fon tertanam (S15)
 * -> ZIP deterministik (`buildDocxPackage` S14, mtime = fixedDate). Opsional
 * `svgFor`: prepareFigureStore S19 sebelum render.
 *
 * Jalur v1 (`studio.norm/v1`, tanpa `scope`/`slots`): rencana unit, konteks, dan
 * keluaran sama dengan sebelum SR-16 (unit = `snapshot.units`, satu konteks).
 *
 * Unit v2: placeholder slot wajib kosong (draf) dirender sebagai paragraf
 * `placeholderText` slot (R-43); tanda tangan ditempatkan menurut kenop slot
 * `slot.placement` (R-42; lihat `units.ts`); daftar isi memakai mode efektif
 * slot `render.toc.mode` (D-165 KT-11: GSP DATUM medan, Manual 000 entri statis
 * dari isi slot MIXED).
 *
 * Determinisme: tanpa jam/acak; urutan = urutan unit lalu ordinal; nama media
 * dan rId berurutan kemunculan; `wp:docPr/@id` dinomori ulang 1..n.
 *
 * Batas tanggung jawab: perakit TIDAK menyintesis judul bab/seksi; blok
 * struktural (`cover`, `controlSheet`, `toc`, `partDivider`, `signatureBlock`,
 * `chapter`, `section`, `appendix`) datang dari normalisasi/compose dan
 * dirender pemilik masing-masing (pengecualian v2: blok `mode: "auto"` slot
 * AUTO/MIXED tanpa isi, `units.ts`). Fragmen tidak boleh memuat `w:sectPr`
 * (batas seksi milik perakit).
 */
import type {
  AnyNormSnapshot,
  DocxBlockRenderer,
  DocxFragment,
  NormBlock,
  NormDocSnapshot,
  RenderContext,
  ResolvedTemplate,
  Run,
} from "../../../contract";
import { isNormSnapshotV2 } from "../../../contract";
import { DOCX_RENDERERS } from "../../../contract/dispatch";
import { FIGURE_BLOCK_TYPES, TABLE_BLOCK_TYPES } from "../../../contract/enums";
import { StudioEngineError } from "../../../contract/errors";
import { resolveRoleFormat } from "../../tokens";
import { prepareFigureStore, type PrepareFigureStoreOptions } from "../figures";
import { planEmbeddedFonts } from "../fonts";
import { controlSheetIncludesSignature } from "../wrapper";
import {
  buildDocxPackage,
  buildSectionPackage,
  facesInXml,
  FIRST_FREE_REL_ID,
  sectionBreakParagraphXml,
  type SectionPackagePart,
} from "../package";
import { draftMarkerOf } from "../package/header-footer";
import { bindBlockRuns } from "./bind";
import { MediaCollector, renumberDrawingIds } from "./media";
import { computeNumbering } from "./numbering";
import { planUnits, scopePlans, tocModeFor, type UnitPlan } from "./units";
import { documentXml, sectionHolderPPrInner } from "./xml";
import { pPrInner } from "../blocks/props";
import { assertRailK2, resolveRailLayout } from "../blocks/rail";
import { paragraph } from "../blocks/xml";

export { computeNumbering, resolveChapterKeys, type NumberingIssue, type NumberingResult } from "./numbering";
export { MediaCollector, renumberDrawingIds } from "./media";
export {
  planUnits,
  placeholderTextFor,
  scopePlans,
  tocModeFor,
  PARAM_SLOT_PLACEMENT,
  PARAM_SLOT_PLACEHOLDER_TEXT,
  PARAM_TOC_MODE,
  type PlanUnitsOptions,
  type UnitPlan,
} from "./units";
export { documentXml, sectionHolderPPrInner } from "./xml";
export { bindBlockRuns, BOUND_RUN_TYPES } from "./bind";

/** R-11 (KS-06): satu seksi per unit (bawaan true). */
export const PARAM_BREAK_PER_UNIT = "render.section.breakPerUnit";

/** R-18: `template` = spacer sesudah blok diambil dari peran templat (RT-01, D-119). */
export const PARAM_SPACER_AUTO_MODE = "render.spacer.autoMode";

const AFTER_BLOCK_TYPES: ReadonlySet<string> = new Set([
  ...TABLE_BLOCK_TYPES,
  ...FIGURE_BLOCK_TYPES,
  "aside",
  "derivation",
  "monoBlock",
]);

/**
 * Spacer otomatis (R-18 `template`, RT-01/D-119): dokumen konten-saja tidak
 * membawa paragraf spacer; jarak sesudah blok berbentuk tabel/figur/kotak
 * (`spacer.afterBlock`) dan sesudah daftar (`spacer.afterList`) milik templat,
 * berulang identik di setiap bab. Hanya aktif bila templat MENULIS `para`
 * peran itu (profil kanonik tanpa peran eksplisit tidak berubah), hanya di
 * unit interior (bab/lampiran), dan tidak bila blok berikutnya sudah spacer
 * eksplisit (dokumen lama yang membawa spacer tetap dirender sama).
 */
export function autoSpacerRole(
  ctx: RenderContext,
  unitKind: string,
  block: NormBlock,
  next: NormBlock | undefined,
  fragmentXml: string,
): "spacer.afterBlock" | "spacer.afterList" | undefined {
  if (ctx.tpl.params[PARAM_SPACER_AUTO_MODE] !== "template") return undefined;
  if (unitKind !== "chapter" && unitKind !== "appendix") return undefined;
  if (next?.type === "spacer") return undefined;
  let role: "spacer.afterBlock" | "spacer.afterList" | undefined;
  if (block.type === "list") role = "spacer.afterList";
  else if (AFTER_BLOCK_TYPES.has(block.type)) role = "spacer.afterBlock";
  // Paragraf ber-rel (renderer table3col) berakhir sebagai tabel Word.
  else if ((block.type === "paragraph" || block.type === "assumptionInline") && /<\/w:tbl>$/.test(fragmentXml)) role = "spacer.afterBlock";
  if (!role || !ctx.tpl.roleFormats[role]?.para) return undefined;
  return role;
}

/**
 * Opsi perakitan di luar kontrak §8.2. Bila `svgFor` diberikan, perakit
 * memanggil `prepareFigureStore` (S19, D-47) SEBELUM merender blok: PNG 300 dpi
 * per figur chart/diagram/symbolSheet; entri hasil persiapan menang,
 * `ctx.figures` pemanggil menjadi cadangan. Tanpa `svgFor`, `ctx.figures`
 * dianggap sudah disiapkan orkestrator (S51).
 */
export interface AssembleDocxOptions {
  svgFor?: PrepareFigureStoreOptions["svgFor"];
  rasterize?: PrepareFigureStoreOptions["rasterize"];
  figureTypes?: PrepareFigureStoreOptions["types"];
}

/** Ringkasan satu seksi terakit (diagnosis SR-15/SR-55). */
export interface AssembledUnitInfo {
  key: string;
  kind: string;
  slotKey?: string;
  placeholder?: boolean;
}

/** Rincian perakitan (untuk uji S72 dan diagnosis S98). */
export interface AssembleDocxDetail {
  bytes: Uint8Array;
  facesUsed: string[];
  sectionCount: number;
  blockCount: number;
  mediaCount: number;
  drawingCount: number;
  /** blockId -> label artefak final. */
  numbering: Record<string, string>;
  documentXml: string;
  /** Delta SR-16: render draf (penanda R-39 ditulis). */
  draft: boolean;
  /** Delta SR-16: unit terakit (urutan seksi; satu seksi per unit bila R-11 true). */
  units: AssembledUnitInfo[];
}

function where(b: NormBlock): string {
  return b.address ? `${b.address} (${b.blockId})` : `${b.type} ${b.blockId}`;
}

function rIdNumber(id: string): number {
  const m = /^rId(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/** Seksi tunggal bila R-11 false: unit bab/lampiran pertama, selain itu unit pertama. */
function singleSectionIndex(sections: readonly SectionPackagePart[]): number {
  const i = sections.findIndex((s) => s.unitKind === "chapter" || s.unitKind === "appendix");
  return i >= 0 ? i : 0;
}

/** Templat efektif slot: nilai efektif `ResolvedSlot` menimpa parameter/peran dokumen. */
function slotTemplate(ctx: RenderContext, slotKey: string | undefined, cache: Map<string, ResolvedTemplate>): ResolvedTemplate {
  if (!slotKey) return ctx.tpl;
  const slot = ctx.slots?.get(slotKey);
  if (!slot) return ctx.tpl;
  let tpl = cache.get(slotKey);
  if (!tpl) {
    tpl = {
      ...ctx.tpl,
      params: { ...ctx.tpl.params, ...slot.params },
      roleFormats: { ...ctx.tpl.roleFormats, ...slot.roleFormats },
    };
    cache.set(slotKey, tpl);
  }
  return tpl;
}

/** Konteks render unit: templat slot + `doc.front.signature` menurut penempatan tanda tangan. */
function unitContext(base: RenderContext, plan: UnitPlan, cache: Map<string, ResolvedTemplate>): RenderContext {
  const tpl = slotTemplate(base, plan.slotKey, cache);
  let snapshot = base.snapshot;
  if (plan.signature !== undefined) {
    const front = { ...(snapshot.doc.front ?? {}) };
    if (plan.signature === null) delete front.signature;
    else front.signature = plan.signature;
    snapshot = { ...snapshot, doc: { ...snapshot.doc, front } };
  }
  return tpl === base.tpl && snapshot === base.snapshot ? base : { ...base, tpl, snapshot };
}

/** Paragraf isi lewat renderer kontrak `paragraph` (peran badan templat). */
function asParagraph(block: NormBlock, content: Record<string, unknown>, ctx: RenderContext): DocxFragment {
  const render = DOCX_RENDERERS.paragraph;
  if (typeof render !== "function") throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "Renderer DOCX paragraph belum tersedia");
  return render({ ...block, type: "paragraph", content: { type: "paragraph", ...content } }, ctx);
}

function inlineRunsOf(v: unknown): Run[] {
  if (!v || typeof v !== "object") return [];
  const o = v as { runs?: unknown; text?: unknown };
  if (Array.isArray(o.runs)) return o.runs as Run[];
  return typeof o.text === "string" ? [{ t: o.text }] : [];
}

/**
 * Renderer DOCX blok struktural v2 yang belum ada di dispatch kontrak (compose
 * SR-08; padanan HTML `engine/html/assemble/slots.ts` SR-17). Dipakai HANYA bila
 * `DOCX_RENDERERS` tidak memuat jenisnya (renderer kontrak, mis. RQ-7, menang):
 * - `slotPlaceholder`: paragraf teks placeholder slot kosong (R-43, draf);
 * - `sourceRegisterEntry`: paragraf "[n] sitasi · jenis · URL · diakses" (URL teks, KT-11);
 * - `ruleIndex`: penanda saja (indeks aturan otomatis belum dibangun di DOCX; dicatat);
 * - `contractItem`: proyeksi butir tanpa XML (DC-13; baris tabel butir `contractRecord`).
 */
export const SLOT_BLOCK_RENDERERS: Readonly<Record<string, DocxBlockRenderer>> = {
  slotPlaceholder: (b, ctx) => {
    const text = (b.content as { text?: unknown } | null)?.text;
    return asParagraph(b, { text: typeof text === "string" ? text : "" }, ctx);
  },
  sourceRegisterEntry: (b, ctx) => {
    const c = (b.content ?? {}) as Record<string, unknown>;
    const n = b.address ? /\/(\d+)$/.exec(b.address)?.[1] : undefined;
    const runs: Run[] = [...(n ? [{ t: `[${n}] ` }] : []), ...inlineRunsOf(c.citation)];
    for (const k of ["kind", "url", "accessed"] as const) if (typeof c[k] === "string" && c[k] !== "") runs.push({ t: ` · ${c[k] as string}` });
    return asParagraph(b, { runs }, ctx);
  },
  ruleIndex: (b, ctx) => {
    ctx.log({ level: "warn", code: "RULE_INDEX_MARKER_ONLY", address: b.address ?? undefined, message: `ruleIndex (${b.address ?? b.blockId}): indeks aturan otomatis belum dibangun di DOCX; seksi dirender kosong` });
    return { xml: "" };
  },
  // DC-13 (register 05 §5.7): butir `F:<slotKey>/<n>` = proyeksi alamat/pid; dirender sebagai
  // baris ke-n tabel butir blok `contractRecord` (`blocks/contract-record.ts`), bukan di sini.
  contractItem: () => ({ xml: "" }),
};

/** Perakitan lengkap dengan rincian. `assembleDocx` = bentuk kontrak §8.2. */
export async function assembleDocxDetailed(ctx: RenderContext, opts: AssembleDocxOptions = {}): Promise<AssembleDocxDetail> {
  const any = ctx.snapshot as unknown as AnyNormSnapshot;
  const v2 = isNormSnapshotV2(any);
  const draft = ctx.draft ?? (ctx.scope !== undefined && ctx.scope.kind !== "DOCUMENT");
  if (v2 && !ctx.slots) {
    ctx.log({
      level: "info",
      code: "SLOT_PARAMS_ABSENT",
      message: "Snapshot studio.norm/v2 tanpa nilai efektif slot (RenderContext.slots); parameter dokumen dipakai untuk semua unit",
    });
  }
  const allPlans = planUnits(ctx.snapshot, { draft, slots: ctx.slots, params: ctx.tpl.params, scope: ctx.scope, log: ctx.log });
  const allUnits = allPlans.map((p) => p.unit);
  const blocksByUnit = new Map(allPlans.map((p) => [p.unit.key, p.blocks] as const));

  // Penomoran SELURUH dokumen per bab (sebelum saring lingkup); label snapshot menang, selisih dicatat.
  const num = computeNumbering(allUnits, blocksByUnit, ctx.snapshot.numbering ?? {});
  for (const mm of num.mismatches) {
    ctx.log({
      level: "warn",
      code: "NUMBERING_MISMATCH",
      address: mm.address ?? undefined,
      message: `Label artefak snapshot "${mm.existing}" berbeda dari hasil hitung "${mm.computed}" (blok ${mm.blockId}); label snapshot dipakai`,
    });
  }
  const plans = scopePlans(allPlans, ctx.scope, num.chapterKeys);
  const numbering: Record<string, string> = { ...(ctx.snapshot.numbering ?? {}) };
  for (const [id, label] of num.labels) numbering[id] = label;
  // v2: unit terencana (termasuk sintetis) menjadi `snapshot.units` konteks render
  // (renderer pembungkus mencari setup unit menurut kunci).
  const snapshot: NormDocSnapshot = v2 ? { ...ctx.snapshot, numbering, units: allUnits } : { ...ctx.snapshot, numbering };
  let figures = ctx.figures;
  if (opts.svgFor) {
    const prepared = await prepareFigureStore(snapshot, {
      svgFor: opts.svgFor,
      rasterize: opts.rasterize,
      tpl: ctx.tpl,
      types: opts.figureTypes,
      log: ctx.log,
      fixedDate: ctx.fixedDate,
    });
    const fallback = ctx.figures;
    figures = { get: (label) => prepared.get(label) ?? fallback?.get(label) };
  }
  const rctx: RenderContext = { ...ctx, snapshot, figures };
  const tplCache = new Map<string, ResolvedTemplate>();
  const unitCtxs = plans.map((p) => unitContext(rctx, p, tplCache));

  const marker = draft ? draftMarkerOf(ctx.tpl.params) : undefined;
  if (draft && !marker) {
    ctx.log({ level: "warn", code: "DRAFT_MARKER_ABSENT", message: "Render draf tanpa penanda: render.draft.marker tidak sah atau teks kosong" });
  }

  // Seksi: satu pasang header/footer + sectPr per unit, rId mulai FIRST_FREE_REL_ID.
  const sectionPkg = buildSectionPackage(rctx, {
    firstRelId: FIRST_FREE_REL_ID,
    units: plans.map((p) => p.unit),
    contextFor: (_unit, i) => unitCtxs[i],
    draftMarker: marker,
  });
  if (sectionPkg.sections.length !== plans.length) {
    throw new StudioEngineError(
      "BY_CONSTRUCTION_FAILED",
      `Jumlah seksi paket (${sectionPkg.sections.length}) tidak sama dengan jumlah unit (${plans.length})`,
    );
  }
  const breakPerUnit = ctx.tpl.params[PARAM_BREAK_PER_UNIT] !== false;
  const keep = breakPerUnit
    ? sectionPkg.sections
    : [sectionPkg.sections[singleSectionIndex(sectionPkg.sections)]];
  const keepPaths = new Set(keep.flatMap((s) => [s.headerPath, s.footerPath]));
  const keepRels = new Set(keep.flatMap((s) => [s.headerRId, s.footerRId]));
  const sectionParts = sectionPkg.parts.filter((p) => keepPaths.has(p.path));
  const sectionRels = sectionPkg.relationships.filter((r) => keepRels.has(r.id));

  const maxSectionRel = Math.max(FIRST_FREE_REL_ID - 1, ...sectionPkg.relationships.map((r) => rIdNumber(r.id)));
  const media = new MediaCollector(maxSectionRel + 1);

  const faces = new Set<string>();
  let body = "";
  let blockCount = 0;

  // IP-03 (D-66), jalur v1: tanda tangan dokumen dirender DI DALAM lembar kendali bila
  // ada; blok `signatureBlock` hasil normalisasi (F:signature) tidak ditempatkan dua
  // kali. Jalur v2: penempatan dari kenop slot, sudah diselesaikan `planUnits`.
  const signatureInControlSheet = !v2 && controlSheetIncludesSignature(ctx.snapshot.doc);

  const renderBlock = (block: NormBlock, uctx: RenderContext): string => {
    const at = where(block);
    const contract = DOCX_RENDERERS[block.type];
    const render = typeof contract === "function" ? contract : v2 ? SLOT_BLOCK_RENDERERS[block.type] : undefined;
    if (typeof render !== "function") {
      const message = `Renderer DOCX untuk jenis blok "${block.type}" belum tersedia (${at})`;
      ctx.log({ level: "error", code: "BY_CONSTRUCTION_FAILED", address: block.address ?? undefined, message });
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", message, { blockId: block.blockId, type: block.type });
    }
    let fragment;
    try {
      fragment = render(block, uctx);
    } catch (e) {
      ctx.log({
        level: "error",
        code: e instanceof StudioEngineError ? e.code : "RENDER_BLOCK_FAILED",
        address: block.address ?? undefined,
        message: `Render DOCX gagal untuk ${at}: ${e instanceof Error ? e.message : String(e)}`,
      });
      throw e;
    }
    if (!fragment || typeof fragment.xml !== "string") {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Renderer "${block.type}" tidak mengembalikan DocxFragment (${at})`);
    }
    if (/<w:(?:sectPr|body|document)\b/.test(fragment.xml)) {
      throw new StudioEngineError(
        "BY_CONSTRUCTION_FAILED",
        `Fragmen "${block.type}" memuat w:sectPr/w:body/w:document (${at}); batas seksi milik perakit`,
      );
    }
    const xml = media.bind(fragment, at);
    for (const f of fragment.facesUsed ?? []) if (f) faces.add(f);
    blockCount += 1;
    return xml;
  };

  // G-RAIL-3 rev B (K2, FIX-R1): unit alir badan diperiksa sesudah dirender; unit muka
  // (sampul, lembar kendali, daftar isi, pembatas bagian) bukan prosa badan.
  // FIX-TQ (D-359, review SR-56e E5): pelanggaran pada snapshot `studio.norm/v1` dilaporkan
  // (log warn + contoh), render dilanjutkan. Kontrak v1 mengizinkan `format` eksplisit di
  // konten (mis. Manual 000 rev 1), satu-satunya jalur data yang dapat memicu gerbang, dan
  // revisi lama tetap dapat dirender ulang (D-06). Snapshot v2 konten-saja (D-139) tidak
  // membawa format tampilan, jadi pelanggaran di sana = cacat mesin -> tetap gagal keras.
  const railGateSkip = new Set(["cover", "controlSheet", "toc", "part"]);
  let railHosts = 0;
  let railChips = 0;
  let railChecked = 0;
  let railReported = 0;

  plans.forEach((plan, i) => {
    const uctx = unitCtxs[i];
    const unitStart = body.length;
    if (plan.placeholder) {
      ctx.log({
        level: "info",
        code: "SLOT_PLACEHOLDER",
        address: plan.unit.key,
        message: `Slot ${plan.slotKey ?? plan.unit.key} kosong: placeholder draf dirender`,
      });
    }
    for (const [bi, block] of plan.blocks.entries()) {
      if (signatureInControlSheet && block.type === "signatureBlock" && block.address === "F:signature") {
        ctx.log({
          level: "info",
          code: "SIGNATURE_IN_CONTROL_SHEET",
          address: block.address,
          message: `Blok tanda tangan ${block.blockId} tidak ditempatkan terpisah: sudah dirender di dalam lembar kendali`,
        });
        continue;
      }
      const label = num.labels.get(block.blockId);
      let input: NormBlock = label !== undefined && label !== block.artifactLabel ? { ...block, artifactLabel: label } : block;
      // v2 (D-165 KT-11): mode daftar isi = kenop slot `render.toc.mode`; entri statis isi slot MIXED dipertahankan.
      if (v2 && block.type === "toc" && plan.slotKey && input.content && typeof input.content === "object") {
        const mode = tocModeFor({ slots: ctx.slots, params: ctx.tpl.params }, plan.slotKey);
        if (mode && (input.content as { mode?: unknown }).mode !== mode) input = { ...input, content: { ...input.content, mode } };
      }
      // Figur/turunan: glif simbol sebaris diikat ke `symbolGlyphByRole` templat (R-37)
      // sebelum render; tabel menerapkannya sendiri (RQ-2, D-152); wajah lewat RQ-1.
      input = bindBlockRuns(input, uctx.tpl.params);
      const xml = renderBlock(input, uctx);
      body += xml;
      const spacer = autoSpacerRole(uctx, plan.unit.kind, block, plan.blocks[bi + 1], xml);
      if (spacer) body += paragraph(pPrInner(resolveRoleFormat(uctx.tpl, spacer).para ?? {}), "");
    }
    if (!railGateSkip.has(plan.unit.kind)) {
      const params = uctx.tpl.params;
      let gate: ReturnType<typeof assertRailK2>;
      try {
        gate = assertRailK2(body.slice(unitStart), resolveRailLayout((k) => params[k], () => 0), plan.unit.key);
      } catch (e) {
        if (v2 || !(e instanceof StudioEngineError) || e.code !== "BY_CONSTRUCTION_FAILED") throw e;
        railReported += 1;
        const d = (e.details ?? {}) as { narrowed?: unknown; orphans?: unknown };
        const sample = [...(Array.isArray(d.narrowed) ? d.narrowed : []), ...(Array.isArray(d.orphans) ? d.orphans : [])]
          .map((t) => JSON.stringify(String(t).slice(0, 60)))
          .join(", ");
        ctx.log({
          level: "warn",
          code: "RAIL_K2_LEGACY_V1",
          address: plan.unit.key,
          message: `${e.message} [snapshot studio.norm/v1: format eksplisit konten lama; dilaporkan, render dilanjutkan]${sample ? ` contoh: ${sample}` : ""}`,
        });
      }
      if (gate) {
        railChecked += 1;
        railHosts += gate.hosts;
        railChips += gate.chips;
      }
    }
    const last = i === plans.length - 1;
    if (breakPerUnit && !last) {
      const holder = resolveRoleFormat(uctx.tpl, "unit.sectionHolder");
      body += sectionBreakParagraphXml(sectionPkg.sections[i].sectPr, sectionHolderPPrInner(holder.para, holder.run, uctx.tpl.params));
    }
  });
  body += keep[keep.length - 1].sectPr;
  if (railChecked > 0) {
    ctx.log({ level: "info", message: `G-RAIL-3 rev B (K2) lulus: ${railChecked} unit, ${railHosts} inang, ${railChips} chip, nol prosa tanpa chip menyempit` });
  }
  if (railReported > 0) {
    ctx.log({ level: "warn", code: "RAIL_K2_LEGACY_V1", message: `G-RAIL-3 rev B (K2): ${railReported} unit snapshot v1 dilaporkan (tidak gagal keras); rincian per unit di entri sebelumnya` });
  }

  const drawings = renumberDrawingIds(body);
  const docXml = documentXml(drawings.xml);
  const mediaOut = media.finish();

  for (const f of facesInXml(docXml)) faces.add(f);
  for (const p of sectionParts) for (const f of facesInXml(p.data)) faces.add(f);
  const facesUsed = [...faces].sort();

  const bytes = buildDocxPackage({
    tpl: ctx.tpl,
    meta: ctx.snapshot.doc.meta,
    fixedDate: ctx.fixedDate,
    documentXml: docXml,
    parts: [...sectionParts, ...mediaOut.parts],
    relationships: [...sectionRels, ...mediaOut.relationships],
    fonts: planEmbeddedFonts(ctx.tpl, new Set(facesUsed)),
  });

  ctx.log({
    level: "info",
    message: `DOCX dirakit${draft ? " (draf)" : ""}: ${keep.length} seksi, ${blockCount} blok, ${mediaOut.parts.length} media, ${drawings.count} gambar, ${bytes.length} byte`,
  });

  const keptKeys = new Set(keep.map((s) => s.unitKey));
  return {
    bytes,
    facesUsed,
    sectionCount: keep.length,
    blockCount,
    mediaCount: mediaOut.parts.length,
    drawingCount: drawings.count,
    numbering,
    documentXml: docXml,
    draft,
    units: plans
      .filter((p) => keptKeys.has(p.unit.key))
      .map((p) => ({ key: p.unit.key, kind: p.unit.kind, slotKey: p.slotKey, placeholder: p.placeholder })),
  };
}

/** Memakai DOCX_RENDERERS dari contract/dispatch (D01). */
export async function assembleDocx(ctx: RenderContext): Promise<{ bytes: Uint8Array; facesUsed: string[] }> {
  const d = await assembleDocxDetailed(ctx);
  return { bytes: d.bytes, facesUsed: d.facesUsed };
}
