/**
 * Ingest v2 (SR-12; blueprint 05 §2.4, §2.7, §2.8; register 03 §4.5, §7, §11.1, §14;
 * D-98/D-134 gerbang kepercayaan, D-138 `ingest.inlineFormat`, D-153 pembuatan
 * dokumen, D-160 opsi harness + pid, D-166 KC-8, D-172 `classifySchemaV2Errors`).
 *
 * Dua masukan, satu jalur:
 *  - `studio.doc/v2` (agen) -> skema v2 -> gerbang kepercayaan -> pipeline;
 *  - `studio.doc/v1` -> skema v1 -> gerbang kepercayaan -> templat + kerangka ->
 *    adaptor SR-09 (`adaptV1`, kebijakan `ingest.inlineFormat`, `allow` hanya
 *    tepercaya) -> skema v2 hasil adaptasi -> pipeline. REPORT `SCHEMA_V1_ADAPTED`
 *    lewat `x.adaptReportV1` (dibaca lint SR-18).
 *
 * Pipeline (urutan §11.1): templat terpatok + kerangka (SR-06, implisit bila versi
 * lama) -> meta bawaan (compose `defaultMeta`, §7.2) -> P3-20 -> register (DATUM-11)
 * -> aset (rencana tanpa tulis) -> struktur + gabung ke dokumen kosong berkerangka
 * (`emptyResolvedDoc` + `mergeSubmission`, §7.1 butir 3) -> `composeV2` (snapshot
 * norm/v2 berpid + baris M14-M17) -> by-construction (gate ingest yang sama) ->
 * kelengkapan (SR-11). Isi kosong BUKAN galat: kiriman parsial diterima dengan
 * kelengkapan INCOMPLETE (D-131); hanya render penuh yang ditolak (`renderRefused`).
 *
 * Simpan: v1 teradaptasi -> dokumen BARU (KD-12, `missionDocKey = null`) lewat
 * repositori struktur SR-10 (repository.ts `persistAdaptedV1`); v2 -> layanan
 * kiriman SR-13 `submitDocumentV2` (pemilik pembuatan/upsert dokumen misi, kunci
 * advisory, revisi n+1), sesudah gerbang ingest lulus.
 *
 * Dokumen yang ADA (FIX-S2, SR-55b N1 + M2 sisa): kiriman v2 bertarget
 * (`target.documentId`) atau upsert ke dokumen misi yang sudah ada TIDAK digabung ke
 * kerangka kosong di sini. Ingest hanya menjalankan cek isi kiriman (skema, batas,
 * templat TERSEMAT dokumen + D-98, register, aset); gabung, gerbang by-construction,
 * dan kelengkapan berjalan SATU kali atas dokumen TERGABUNG dengan kerangka templat
 * tersemat di layanan kiriman (sama dengan R12/R13): dryRun lewat `dryRunDocumentV2`
 * (transaksi READ ONLY), simpan lewat `submitDocumentV2` (di dalam kunci).
 */
import {
  type AdaptReportV1,
  type AnyNormSnapshot,
  type CompletenessReportV2,
  type DocMeta,
  type IngestResult,
  type LintIssue,
  type LintReport,
  type NormDocSnapshotV2,
  type ParamMap,
  type PidAllocator,
  type RegisterEntry,
  type ResolvedTemplate,
  type StudioDocV1,
  type StudioDocV2,
  type StudioIngestRequest,
  type StudioReleaseStatus,
  type StudioTier,
  type SubmitResultV2,
  type ValidationIssue,
} from "../../contract";
import type { StudioCaller } from "../../contract/auth";
import { StudioEngineError } from "../../contract/errors";
import type { SubmitWarningV2 } from "../../contract/types/v2/contract";
import { normalizeRegisterEntry } from "../../engine/bind";
import { CONTRACT_RECORD_SECTION_TYPE } from "../../registry/contracts";
import { checkOverrideRights } from "../../engine/tokens";
import { ALL_PARAMS } from "../../params";
import { adaptV1, effectiveInlinePolicy, type AdaptV1Result } from "../adapt-v1";
import {
  composeV2,
  defaultMeta,
  emptyResolvedDoc,
  mergeSubmission,
  seededPidAllocator,
  type ComposeResult,
  type ComposeWarning,
  type SkeletonInput,
} from "../compose";
import { computeCompleteness, type CompletenessInput, type CompletenessSlotInput } from "../completeness";
import { implicitSkeleton, resolveSkeletonSlots, resolveSlotsForVersion, skeletonSha256 } from "../skeleton";
import type { StructureRows } from "../structure/types";
import { assertTemplateUsable, resolveTemplate, resolveTemplateVersion } from "../templates";
import { archivedTemplateSlug, TEMPLATE_ARCHIVED_CODE, templateArchivedMessage } from "./archived";
import { loadAssetIndex, type IngestAssetSource } from "./assets";
import { ASSET_NOT_FOUND_KEYWORD, ASSET_TYPE_KEYWORD, composeAssetsOf, planV2Assets, storePlannedAssets, type V2AssetPlan } from "./assets-v2";
import type { DocV2Targeting } from "../submit/targeting";
import { resolveDocTarget } from "../submit/target";
import { fillerOf } from "../submit/meta";
import { inlineFormatPolicyOf } from "../inline-format/policy";
import {
  checkContractSource,
  contractCheckError,
  evaluateByConstruction,
  resolveContractTargetRefs,
  typeCodeIssue,
  v1FigureSizeIssues,
  withChartCustomPointer,
} from "./by-construction";
import { type IngestEnforcement } from "./gate";
import { ASSET_TOO_LARGE_KEYWORD } from "./assets";
import { ingestLog } from "./log";
import { effectiveTier, jakartaDate } from "./meta";
import { joinPointer, sha256Hex, stableStringify } from "./util";
import { limitIssues, validateAgainst, validateV2Against } from "./validate";

/** Kunci `x` laporan adaptor v1 (seam SR-18 `ADAPT_REPORT_X_KEY`; hanya server yang menulisnya). */
export const ADAPT_REPORT_X_KEY = "adaptReportV1";
/** Kode log/temuan saat `x.adaptReportV1` kiriman klien dibuang. */
export const ADAPT_REPORT_FORGED_STRIPPED = "ADAPT_REPORT_STRIPPED";

export type IngestSchemaId = "studio.doc/v1" | "studio.doc/v2";

/** Opsi ingest v2 (diturunkan dari `IngestOptions` index.ts). */
export interface V2Options {
  dryRun: boolean;
  enforcement?: IngestEnforcement;
  trustedHarness?: boolean;
  assetSources?: readonly IngestAssetSource[];
  assetIndexPath?: string;
  template?: ResolvedTemplate;
  /**
   * Kerangka siap pakai (harness/CLI tanpa DB, draf templat R08); absen = SR-06
   * `resolveSlotsForVersion`. Bila diisi, nilai efektif per slot dihitung murni dari
   * `template.params` (preset -> templat, sudah dilipat) ditimpa parameter slot kerangka
   * (FIX-Y), sehingga compose memakai kenop slot kerangka ini.
   */
  skeleton?: SkeletonInput;
  /**
   * IP-64 (FIX-S, D-235): amplop transport penargetan R04 (`target.documentId` +
   * `baseRevisionNo`), diteruskan eksplisit ke `submitDocumentV2`; bukan isi SID01.
   */
  submitTargeting?: DocV2Targeting;
}

/** Hasil ingest (kontrak `IngestResult` + medan v2). `snapshot` dapat norm/v1 (jalur lama) atau norm/v2. */
export interface IngestResultV2 extends Omit<IngestResult, "snapshot"> {
  snapshot?: AnyNormSnapshot;
  /** Skema kiriman asal (KD-10). */
  schemaId?: IngestSchemaId;
  completeness?: CompletenessReportV2;
  /** Laporan adaptor (LD-03) untuk kiriman v1. */
  adaptReport?: AdaptReportV1;
  /** Respons layanan kiriman SR-13 (simpan v2). */
  submit?: SubmitResultV2;
  warnings?: ComposeWarning[];
  /**
   * DC-08: peringatan kontrak non-penahan (CW-01 `CONTRACT_REF_PID_RETIRED`, KD-46), hanya bila
   * tidak kosong. Diisi dry-run dokumen baru (I55 di luar tx) dan dokumen yang ada
   * (`SubmitResultV2.warnings` dry-run kiriman); dibaca R08 cabang dokumen (FIX-R40-2).
   */
  contractWarnings?: SubmitWarningV2[];
}

export interface V2Context {
  caller: StudioCaller;
  opts: V2Options;
  cid: string;
  dryRun: boolean;
  trusted: boolean;
  /** Prefiks pointer dokumen di badan permintaan ("" atau "/document"). */
  ptr: string;
  agentId?: string;
  /** Temuan REPORT gerbang kepercayaan (penanda dibuang). */
  notices: LintIssue[];
  /** Penanda dibuang (untuk log/hasil). */
  stripped: string[];
  reject: (code: StudioEngineError["code"], message: string, issues: ValidationIssue[], lint?: IngestResult["lint"]) => IngestResultV2;
}

interface Pinned {
  tpl: ResolvedTemplate;
  tier: StudioTier;
  skeleton: SkeletonInput;
  slotParams?: Record<string, ParamMap>;
}

// ── Galat ────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Galat 4xx layanan (compose/aset/adaptor) -> isu berpointer badan permintaan. */
export function issuesFromEngineError(e: StudioEngineError, ptr: string): ValidationIssue[] {
  if (Array.isArray(e.details)) {
    return (e.details as unknown[]).filter(isRecord).map((d) => ({
      pointer: typeof d.pointer === "string" ? (d.pointer.startsWith(ptr) ? d.pointer : ptr + d.pointer) : ptr,
      keyword: typeof d.keyword === "string" ? d.keyword : e.code,
      message: typeof d.message === "string" ? d.message : e.message,
      ...(typeof d.checkId === "string" ? { checkId: d.checkId } : {}),
    }));
  }
  const d = isRecord(e.details) ? e.details : {};
  const p = typeof d.pointer === "string" ? d.pointer : "";
  return [{ pointer: p.startsWith(ptr) && ptr !== "" ? p : ptr + p, keyword: e.code, message: e.message, checkId: e.code }];
}

function isClientError(e: unknown): e is StudioEngineError {
  return e instanceof StudioEngineError && e.httpStatus >= 400 && e.httpStatus < 500;
}

/**
 * DC-08: galat layanan ber-`details` register (EC25-EC28). dryRun -> satu isu ber-checkId kode
 * galat + pointer + `details` utuh (R08); simpan -> galat ASLI dilempar (details register utuh,
 * bukan daftar isu).
 */
function rejectWithDetails(ctx: V2Context, e: StudioEngineError, lint: LintReport | null = null): IngestResultV2 {
  const base = issuesFromEngineError(e, ctx.ptr);
  const issues: Array<ValidationIssue & { details?: Record<string, unknown> }> = isRecord(e.details) ? base.map((x) => ({ ...x, details: e.details as Record<string, unknown> })) : base;
  if (ctx.dryRun) return ctx.reject(e.code, e.message, issues, lint);
  ingestLog({ level: "warn", message: `ingest ditolak: ${e.message}`, correlationId: ctx.cid, code: e.code, context: { dryRun: false, issues: issues.length } });
  throw e;
}

/**
 * D-376 (DC-08): `StudioTemplate.contractKind` (MX08) templat terpatok, hanya bila kerangka
 * memuat slot `contractRecord` (dokumen lain: tanpa kueri baru). Templat di memori (draf R08 /
 * harness, `opts.template`) tidak dibaca dari DB: compose dan gerbang memakai C58 per slug.
 */
async function templateContractKind(ctx: V2Context, pinned: Pinned): Promise<string | undefined> {
  if (ctx.opts.template) return undefined;
  if (!pinned.skeleton.skeleton.slots.some((s) => s.sectionType === CONTRACT_RECORD_SECTION_TYPE)) return undefined;
  // Swarm patch (row 109, site 6 of 01_specs_studio.md §1.2): store read instead of Prisma.
  const { readWith } = await import("../_swarm-store");
  try {
    const row = await readWith(undefined, (q) => q.get<{ contract_kind: string | null }>("SELECT contract_kind FROM template WHERE id = ?", [pinned.tpl.templateId]));
    return row?.contract_kind ?? undefined;
  } catch (e) {
    ingestLog({ level: "error", message: "baca contractKind templat gagal", correlationId: ctx.cid, code: "TEMPLATE_CONTRACT_KIND_FAILED", stack_trace: e instanceof Error ? e.stack : undefined, context: { templateId: pinned.tpl.templateId } });
    throw e;
  }
}

// ── Templat + kerangka ───────────────────────────────────────────────────

/**
 * Patokan dokumen yang ADA yang ditulis kiriman (R04 D-232 bertarget, atau upsert misi):
 * versi templat revisi terbaru + tier dokumen (SR-55 M2; FIX-S2 juga untuk upsert misi).
 */
interface DocPin {
  documentId: string;
  templateVersionId: string;
  slug: string;
  versionNo: number;
  tier: StudioTier;
}

async function docPinOf(documentId: string, ctx: V2Context): Promise<DocPin> {
  // Swarm patch (row 109, site 6): store reads instead of Prisma.
  const { readWith, findDocumentById, findRevisionByNo, findTemplateVersionById } = await import("../_swarm-store");
  const { doc, rev, tvRow } = await readWith(undefined, (q) => {
    const d = findDocumentById(q, documentId);
    const r = d ? findRevisionByNo(q, d.id, d.currentRevisionNo) : null;
    return { doc: d, rev: r, tvRow: r ? findTemplateVersionById(q, r.templateVersionId) : null };
  });
  if (!doc) throw new StudioEngineError("DOCUMENT_NOT_FOUND", `Dokumen tidak ditemukan: ${documentId}`, { documentId });
  if (!rev) {
    ingestLog({ level: "error", message: "revisi terbaru dokumen target tidak ditemukan", correlationId: ctx.cid, code: "TARGET_REVISION_MISSING", context: { documentId, revisionNo: doc.currentRevisionNo } });
    throw new Error(`revisi terbaru ${doc.currentRevisionNo} dokumen ${documentId} tidak ditemukan`);
  }
  const tv = tvRow;
  if (!tv) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi templat terpatok dokumen tidak ditemukan: ${rev.templateVersionId}`, { templateVersionId: rev.templateVersionId });
  return { documentId: doc.id, templateVersionId: rev.templateVersionId, slug: tv.template.slug, versionNo: tv.versionNo, tier: doc.tier as StudioTier };
}

/**
 * FIX-S2 (SR-55b N1 + M2 sisa): dokumen yang ADA yang akan ditulis kiriman v2, atau
 * `undefined` bila kiriman MEMBUAT dokumen. Sumber: `target.documentId` (D-232), selain itu
 * upsert misi (`mission.folder` + `docKey`, bawaan slug templat; aturan sama dengan layanan
 * kiriman `resolveDocTarget`). Templat di memori (harness/draf R08: `opts.template` /
 * `opts.skeleton`) tidak dicocokkan ke dokumen misi tersimpan.
 *
 * Pencarian di luar kunci hanya memilih JALUR cek ingest; layanan kiriman tetap pemegang
 * keputusan di dalam kunci (dokumen yang muncul/hilang di antaranya digerbang di sana).
 */
async function existingDocPin(doc: StudioDocV2, ctx: V2Context): Promise<{ pin: DocPin; via: "target" | "mission" } | undefined> {
  const targetId = ctx.opts.submitTargeting?.target?.documentId;
  if (typeof targetId === "string" && targetId.length > 0) return { pin: await docPinOf(targetId, ctx), via: "target" };
  if (ctx.opts.template || ctx.opts.skeleton) return undefined;
  let target: ReturnType<typeof resolveDocTarget>;
  try {
    target = resolveDocTarget(doc.mission, doc.docKey, doc.template.slug);
  } catch (e) {
    // Target misi tidak sah: galatnya diputus layanan kiriman saat simpan (perilaku sama dengan sebelumnya).
    ingestLog({ level: "info", message: "target misi kiriman tidak sah; diputus layanan kiriman", correlationId: ctx.cid, code: "MISSION_TARGET_DEFERRED", context: { reason: e instanceof Error ? e.message : String(e) } });
    return undefined;
  }
  if (!target || target.kind !== "mission" || !target.docKey) return undefined;
  // Swarm patch (row 109, site 6): store read instead of Prisma.
  const { readWith, findDocumentByMission } = await import("../_swarm-store");
  const missionTarget = target;
  const found = await readWith(undefined, (q) => findDocumentByMission(q, missionTarget.folder, missionTarget.docKey as string));
  return found ? { pin: await docPinOf(found.id, ctx), via: "mission" } : undefined;
}

/**
 * FIX-Y (D-272): nilai efektif per slot aktif untuk kerangka siap pakai, resolusi murni
 * jalur cepat SR-06 (`tpl.params` = preset -> templat + turunan; lalu parameter slot +
 * turunan dihitung ulang). Setara jalur berlapis untuk kunci slot (cakupan slot/section,
 * bukan kenop fase lapis); kunci slot yang tidak dapat diterapkan dicatat, tidak menggagalkan.
 */
function pureSlotParams(ctx: V2Context, tpl: ResolvedTemplate, skeleton: SkeletonInput, tier: StudioTier): Record<string, ParamMap> {
  const { slots, issues } = resolveSkeletonSlots({ params: tpl.params, roleFormats: tpl.roleFormats }, skeleton.skeleton.slots, undefined, { tier });
  if (issues.length > 0) {
    ingestLog({
      level: "warn",
      message: "parameter slot kerangka siap pakai tidak diterapkan",
      correlationId: ctx.cid,
      code: "SLOT_PARAM_SKIPPED",
      context: { templateVersionId: skeleton.templateVersionId, issues: issues.slice(0, 20).map((i) => ({ key: i.key, code: i.code, pointer: i.pointer ?? null })) },
    });
  }
  const out: Record<string, ParamMap> = {};
  for (const [k, s] of slots) out[k] = s.params;
  return out;
}

async function pinTemplate(
  ctx: V2Context,
  template: { slug: string; version?: number },
  meta: { tier?: StudioTier } | undefined,
  docPin?: DocPin,
): Promise<Pinned | IngestResultV2> {
  let tpl: ResolvedTemplate;
  try {
    // SR-55 M2: kiriman bertarget digerbang terhadap versi templat TERSEMAT dokumen (sama dengan
    // pipeline kiriman dan render), bukan versi terbaru slug yang dikirim.
    tpl = ctx.opts.template ?? (docPin ? await resolveTemplateVersion(docPin.templateVersionId) : await resolveTemplate(template.slug, template.version));
  } catch (e) {
    if (e instanceof StudioEngineError && e.code === "TEMPLATE_NOT_FOUND") {
      return ctx.reject("TEMPLATE_NOT_FOUND", `Templat ${template.slug} tidak ditemukan`, [
        { pointer: `${ctx.ptr}/template`, keyword: "reference", message: e.message },
      ]);
    }
    ingestLog({ level: "error", message: "resolveTemplate gagal", correlationId: ctx.cid, code: "TEMPLATE_RESOLVE_FAILED", stack_trace: e instanceof Error ? e.stack : undefined, context: { templateSlug: template.slug } });
    throw e;
  }
  // D-98: templat terbatas hanya untuk ADMIN/harness; dilempar juga pada dryRun (otorisasi 403).
  try {
    assertTemplateUsable(tpl, { kind: ctx.caller.kind, requester: ctx.caller.requester, agentId: ctx.agentId }, {
      trustedHarness: ctx.opts.trustedHarness === true,
      slug: template.slug,
      purpose: ctx.dryRun ? "validate" : "ingest",
      correlationId: ctx.cid,
    });
  } catch (e) {
    ingestLog({ level: "warn", message: "templat terbatas ditolak (v2)", correlationId: ctx.cid, code: "TEMPLATE_RESTRICTED_DENIED", context: { templateSlug: template.slug, callerKind: ctx.caller.kind, agentId: ctx.agentId ?? null } });
    throw e;
  }
  // Swarm patch (row 69a, C78; templates spec §4): a NEW document (no pin) on an archived template is refused.
  // An existing document (docPin) keeps its pinned version; an in-memory template (opts.template) has no store row.
  if (!docPin && !ctx.opts.template) {
    const archived = await archivedTemplateSlug(tpl, ctx.cid);
    if (archived !== null) {
      ingestLog({ level: "warn", message: "dokumen baru pada templat terarsip ditolak", correlationId: ctx.cid, code: TEMPLATE_ARCHIVED_CODE, context: { templateSlug: archived, templateId: tpl.templateId, versionNo: tpl.versionNo, dryRun: ctx.dryRun, callerKind: ctx.caller.kind, agentId: ctx.agentId ?? null } });
      return ctx.reject(TEMPLATE_ARCHIVED_CODE, templateArchivedMessage(archived), [
        { pointer: `${ctx.ptr}/template`, keyword: TEMPLATE_ARCHIVED_CODE, message: templateArchivedMessage(archived) },
      ]);
    }
  }
  if (docPin && (template.slug !== docPin.slug || (template.version !== undefined && template.version !== docPin.versionNo))) {
    // Pesan dan detail sama dengan `mergeSubmission` (compose checkTemplate).
    throw new StudioEngineError(
      "TEMPLATE_MISMATCH",
      `Dokumen memakai templat ${docPin.slug} versi ${docPin.versionNo}; kirim tanpa template atau dengan templat yang sama`,
      { pinned: { slug: docPin.slug, versionNo: docPin.versionNo }, sent: template },
    );
  }
  const tier = docPin ? docPin.tier : effectiveTier(meta, tpl.params);
  if (ctx.opts.skeleton) return { tpl, tier, skeleton: ctx.opts.skeleton, slotParams: pureSlotParams(ctx, tpl, ctx.opts.skeleton, tier) };
  try {
    const r = await resolveSlotsForVersion(tpl.versionId, { tier });
    const slotParams: Record<string, ParamMap> = {};
    for (const [k, s] of r.slots) slotParams[k] = s.params;
    return {
      tpl,
      tier,
      skeleton: { templateVersionId: r.templateVersionId, skeleton: r.skeleton, skeletonSha256: r.skeletonSha256, implicit: r.implicit },
      slotParams,
    };
  } catch (e) {
    // Templat di memori (harness/draf validate) tanpa baris DB: kerangka implisit dari sectionPlan (§6.3).
    if (!ctx.opts.template) {
      ingestLog({ level: "error", message: "resolusi kerangka gagal", correlationId: ctx.cid, code: "SKELETON_RESOLVE_FAILED", stack_trace: e instanceof Error ? e.stack : undefined, context: { templateVersionId: tpl.versionId } });
      throw e;
    }
    const skel = implicitSkeleton(tpl.sectionPlan, tier);
    ingestLog({
      level: "info",
      message: "kerangka implisit dipakai untuk templat di memori",
      correlationId: ctx.cid,
      code: "SKELETON_IMPLICIT_FALLBACK",
      context: { templateVersionId: tpl.versionId, reason: e instanceof Error ? e.message : String(e) },
    });
    return { tpl, tier, skeleton: { templateVersionId: tpl.versionId, skeleton: skel, skeletonSha256: skeletonSha256(skel), implicit: true } };
  }
}

// ── Pembantu isi ─────────────────────────────────────────────────────────

/** Register ternormalisasi sebelum gabung (DATUM-11 untuk entri cacat). */
function normalizeRegister(reg: Record<string, RegisterEntry> | undefined, ptr: string): { register?: Record<string, RegisterEntry>; issues: ValidationIssue[] } {
  if (!reg) return { issues: [] };
  const out: Record<string, RegisterEntry> = {};
  const issues: ValidationIssue[] = [];
  for (const [k, e] of Object.entries(reg)) {
    try {
      out[k] = normalizeRegisterEntry(k, e);
    } catch (err) {
      issues.push({
        pointer: `${ptr}/register/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        keyword: "byConstruction",
        message: `DATUM-11: ${err instanceof Error ? err.message : String(err)}`,
        checkId: "DATUM-11",
      });
    }
  }
  return { register: out, issues };
}

/** Isi chart v1 `{artifactId}` tanpa `code`: `code` dari artefak R09 (permintaan SR-09). */
async function fillChartCodes(doc: StudioDocV2, ctx: V2Context): Promise<ValidationIssue[]> {
  const missing: Array<{ block: Record<string, unknown>; pointer: string }> = [];
  const walk = (node: unknown, ptr: string): void => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${ptr}/${i}`));
    if (!isRecord(node)) return;
    if (node.type === "chart" && typeof node.artifactId === "string" && node.code === undefined) missing.push({ block: node, pointer: ptr });
    for (const [k, v] of Object.entries(node)) if (k !== "x" && k !== "assets" && v !== null && typeof v === "object") walk(v, `${ptr}/${k}`);
  };
  walk(doc.sections ?? {}, `${ctx.ptr}/sections`);
  if (missing.length === 0) return [];
  const ids = [...new Set(missing.map((m) => m.block.artifactId as string))];
  const kinds = new Map<string, { kind: string; spec: unknown }>();
  // Swarm patch (row 109, site 6; store spec M07 DROP): standalone artifacts do not exist in the
  // DATUM Studio store, so every `artifactId` is unknown and gets the validation issue below
  // (empty map, no error log).
  void ids;
  const issues: ValidationIssue[] = [];
  for (const m of missing) {
    const id = m.block.artifactId as string;
    const a = kinds.get(id);
    const spec = isRecord(a?.spec) ? a.spec : null;
    if (!a || a.kind !== "CHART" || !spec) {
      issues.push({ pointer: `${m.pointer}/artifactId`, keyword: "reference", message: `Artefak chart ${id} tidak ditemukan atau bukan CHART`, checkId: "ARTIFACT_NOT_FOUND" });
      continue;
    }
    const code = isRecord(spec.composite) ? "composite" : typeof spec.kind === "string" ? spec.kind : null;
    if (code) m.block.code = code;
    else issues.push({ pointer: `${m.pointer}/artifactId`, keyword: "reference", message: `Artefak chart ${id} tidak memuat kind`, checkId: "ARTIFACT_NOT_FOUND" });
  }
  return issues;
}

/** Masukan kelengkapan dari kerangka + baris compose (revisi 1, dokumen baru). */
export function completenessInputOf(
  skeleton: SkeletonInput,
  snapshot: NormDocSnapshotV2,
  rows: StructureRows,
  doc: { docId: string; docNumber: string; missionFolder?: string | null; docKey?: string | null },
  revisionNo: number,
): CompletenessInput {
  const defs = new Map(skeleton.skeleton.slots.map((s) => [s.slotKey, s]));
  const rowOf = new Map(rows.sections.map((r) => [r.slotKey, r]));
  const ordered = [...snapshot.skeleton.slots].sort((a, b) => (a.position || 1e6) - (b.position || 1e6));
  const slots: CompletenessSlotInput[] = ordered.map((s) => {
    const def = defs.get(s.slotKey);
    const row = rowOf.get(s.slotKey);
    const input: CompletenessSlotInput = {
      slotKey: s.slotKey,
      sectionType: s.sectionType,
      label: s.label,
      required: s.required,
      repeatable: s.repeatable,
      minItems: def?.minItems ?? null,
      maxItems: def?.maxItems ?? null,
      contentMode: s.contentMode,
      active: s.active,
      row: row
        ? { filled: row.filled, payload: row.payload, lastFilledBy: row.lastFilledBy, lastFilledAt: row.lastFilledAt, lastFilledRevisionNo: row.lastFilledRevisionNo }
        : null,
    };
    if (s.repeatable) {
      input.chapters = rows.chapters
        .filter((c) => c.slotKey === s.slotKey)
        .map((c) => ({ key: c.chapterKey, pid: c.pid, by: c.lastFilledBy, at: c.lastFilledAt, revisionNo: c.lastFilledRevisionNo }));
    }
    return input;
  });
  return { revisionNo, slots, doc };
}

/** Cap pengisi revisi 1: slot terisi dan setiap bab dicap penulis kiriman. */
export function stampRevisionOne(rows: StructureRows, by: string, at: string): StructureRows {
  const stamp = { lastFilledBy: by, lastFilledAt: at, lastFilledRevisionNo: 1 };
  const none = { lastFilledBy: null, lastFilledAt: null, lastFilledRevisionNo: null };
  const filledSlots = new Set(rows.sections.filter((s) => s.filled).map((s) => s.slotKey));
  for (const c of rows.chapters) filledSlots.add(c.slotKey);
  return {
    sections: rows.sections.map((s) => ({ ...s, ...(filledSlots.has(s.slotKey) ? stamp : none) })),
    chapters: rows.chapters.map((c) => ({ ...c, ...stamp })),
    subsections: rows.subsections.map((s) => ({ ...s })),
    blocks: rows.blocks.map((b) => ({ ...b })),
  };
}

/** Penulis kiriman untuk cap pengisi/`author` bawaan. */
function authorOf(ctx: V2Context): string {
  return ctx.agentId && ctx.agentId.trim() !== "" ? ctx.agentId : ctx.caller.requester;
}

// ── Pipeline bersama ─────────────────────────────────────────────────────

interface PipelineInput {
  /** Kiriman v2 (sudah lolos skema, penanda dibuang). */
  doc: StudioDocV2;
  origin: IngestSchemaId;
  pinned: Pinned;
  adapt?: AdaptV1Result;
  /** Masukan mentah untuk `inputSha256` (dokumen asal). */
  inputSha256: string;
}

/** Hasil siap simpan (dipakai repository.ts `persistAdaptedV1`). */
export interface PreparedV2 {
  doc: StudioDocV2;
  pinned: Pinned;
  compose: ComposeResult;
  /** Ulangi compose dengan nomor dokumen sekuens (snapshot bergantung meta). */
  recompose: (docNumber: string) => ComposeResult;
  rows: StructureRows;
  lint: NonNullable<IngestResult["lint"]>;
  releaseStatus: StudioReleaseStatus;
  assets: V2AssetPlan;
  meta: DocMeta;
  author: string;
  at: string;
  inputSha256: string;
  /**
   * DC-WIRE2 (D-389, 05 §6.5): contractKind templat yang sudah dibaca pipeline (MX08);
   * absen = non-kontrak. Diteruskan ke kelengkapan saat persist (repository.ts).
   */
  contractKind?: string;
}

async function runPipeline(ctx: V2Context, p: PipelineInput): Promise<{ prepared: PreparedV2; result: IngestResultV2 } | IngestResultV2> {
  const { pinned } = p;
  const { tpl, tier, skeleton } = pinned;
  const doc: StudioDocV2 = structuredClone(p.doc);
  const author = authorOf(ctx);
  // SR-55 M4: cap pengisi = identitas pemanggil terverifikasi, bukan `agentId` badan.
  const filler = fillerOf(ctx.caller);
  const at = new Date().toISOString();

  // Meta bawaan (§7.2, satu sumber: compose defaultMeta).
  if (typeof doc.meta?.title !== "string" || doc.meta.title.trim() === "") {
    return ctx.reject("META_REQUIRED_FOR_CREATE", "Dokumen baru wajib memuat meta.title", [{ pointer: `${ctx.ptr}/meta/title`, keyword: "required", message: "meta.title wajib saat membuat dokumen" }]);
  }
  const issueDate = jakartaDate();
  const meta = defaultMeta(doc.meta, tpl.params, { author, issueDate });

  const hard: ValidationIssue[] = [];
  const intrinsic: LintIssue[] = [];
  const enforcementOpt: IngestEnforcement | undefined = ctx.trusted ? ctx.opts.enforcement : undefined;

  // Register + aset: cek isi kiriman (bersama jalur dokumen yang ada).
  const pf = await preflightContent(ctx, doc, p.adapt?.assetPaths, hard);
  if (!("assets" in pf)) return pf;
  const { assets, missingAsset } = pf;

  // P3-20 (mode report D-34 -> temuan status rilis).
  const enforcementEarly = enforcementOpt === "report" || (isRecord(doc.x) && (doc.x.benchmark !== undefined || doc.x.enforcement !== undefined)) ? "report" : "reject";
  const tc = typeCodeIssue(meta, doc.template.slug, tpl, ctx.ptr);
  if (tc) {
    if (enforcementEarly === "report") intrinsic.push({ checkId: "P3-20", status: "FAIL", detail: tc.message, pointer: tc.pointer });
    else hard.push(tc);
  }
  if (hard.length > 0) return ctx.reject("SCHEMA_INVALID", "Dokumen tidak konsisten secara struktur", hard);
  if (missingAsset.length > 0) return ctx.reject("ASSET_NOT_FOUND", "Rujukan aset tidak dikenal", missingAsset);

  // Struktur + gabung ke dokumen kosong berkerangka (§7.1 butir 3; validateStructure di dalam merge).
  const pids: PidAllocator = ctx.dryRun ? seededPidAllocator(`ingest:${p.inputSha256}`) : await randomAllocator();
  const empty = emptyResolvedDoc({
    template: { slug: doc.template.slug, version: tpl.versionNo },
    meta,
    ...(doc.mission ? { mission: doc.mission } : {}),
    ...(doc.docKey !== undefined ? { docKey: doc.docKey } : {}),
    ...(doc.structure ? { structure: doc.structure } : {}),
  });
  const knownAssetSha = new Set(assets.bySha.keys());
  const composeAssets = composeAssetsOf(assets);
  // D-376 (DC-08): jenis kontrak templat (MX08) ke compose + gerbang; absen = C58 per slug.
  const contractKind = await templateContractKind(ctx, pinned);
  const contractPointer = (slotKey: string) => joinPointer(`${ctx.ptr}/sections`, slotKey);
  // DC-08 §5.6 langkah 6b SEBELUM compose (compose kontrak mengandaikan payload lolos I54).
  const contractPre = checkContractSource(doc, skeleton.skeleton.slots, { contractKind, contractPointer });
  const contractPreErr = contractCheckError(contractPre);
  if (contractPreErr) {
    return contractPreErr.code === "SCHEMA_INVALID" ? ctx.reject(contractPreErr.code, contractPreErr.message, contractPre.issues) : rejectWithDetails(ctx, contractPreErr);
  }
  let compose: ComposeResult;
  let recompose: (docNumber: string) => ComposeResult;
  try {
    const merged = mergeSubmission(empty, { ...doc, template: { slug: doc.template.slug, version: tpl.versionNo } }, {
      skeleton,
      tier,
      pids,
      knownAssetSha,
      resolveAsset: (key) => {
        const ref = assets.refs.get(key);
        if (!ref) throw new StudioEngineError("ASSET_NOT_FOUND", `Aset "${key}" tidak dapat diresolusi`, { asset: key, pointer: `/assets/${key}` });
        return ref;
      },
    });
    const run = (source: typeof merged.doc): ComposeResult => {
      const r = composeV2({
        source,
        skeleton,
        tier,
        params: tpl.params,
        ...(pinned.slotParams ? { slotParams: pinned.slotParams } : {}),
        assets: composeAssets,
        ...(contractKind !== undefined ? { contractKind } : {}),
      });
      if (p.adapt?.internal) {
        // KD-26: `allow` tepercaya -> snapshot internal = dokumen v1 asli (meta terlengkapi).
        const internal: StudioDocV1 = { ...structuredClone(p.adapt.internal), meta: { ...p.adapt.internal.meta, ...source.meta } };
        r.snapshot = { ...r.snapshot, doc: internal };
        r.snapshotSha256 = sha256Hex(stableStringify(r.snapshot));
      }
      return r;
    };
    compose = run(merged.doc);
    recompose = (docNumber: string) => run({ ...merged.doc, meta: { ...merged.doc.meta, docNumber } });
  } catch (e0) {
    // EC28 (D-374): compose tidak membawa pointer blok chart.custom; dilengkapi dari kiriman (DC-08).
    const e = withChartCustomPointer(e0, doc, `${ctx.ptr}/sections`);
    if (isClientError(e) && e.code === "CHART_CUSTOM_FORM_UNSUPPORTED") return rejectWithDetails(ctx, e);
    if (isClientError(e)) return ctx.reject(e.code, e.message, issuesFromEngineError(e, ctx.ptr));
    ingestLog({ level: "error", message: "compose v2 gagal", correlationId: ctx.cid, code: "COMPOSE_FAILED", stack_trace: e instanceof Error ? e.stack : undefined, context: { templateSlug: doc.template.slug } });
    throw e;
  }
  const snapshot = compose.snapshot;

  // Kelengkapan (revisi 1 dokumen baru; kiriman parsial diterima) -> masukan gerbang (D-131).
  const rows = stampRevisionOne(compose.rows, filler, at);
  // DC-WIRE (D-386, 05 §6.5): contractKind yang sudah dibaca di atas; absen = non-kontrak.
  const completeness = computeCompleteness({
    ...completenessInputOf(skeleton, snapshot, rows, {
      docId: "",
      docNumber: meta.docNumber ?? "(nomor dari sekuens)",
      missionFolder: doc.mission?.folder ?? null,
      docKey: doc.docKey ?? null,
    }, 1),
    ...(contractKind !== undefined ? { contractKind } : {}),
  });

  // By-construction: gerbang BERSAMA (SR-55 H1; satu fungsi dengan R12/R13/R16/R06/R14).
  const gate = evaluateByConstruction({
    snapshot,
    tpl,
    tier,
    complete: completeness.status === "COMPLETE",
    ...(enforcementOpt ? { enforcement: enforcementOpt } : {}),
    intrinsic,
    notices: ctx.notices,
    registerPointer: `${ctx.ptr}/register`,
    ...(contractKind !== undefined ? { contractKind } : {}),
    contractPointer,
    correlationId: ctx.cid,
  });
  // DC-08 (register 05 §5.6): 6b I54 (400 ber-checkId / 422 EC27) -> 9a I55 (EC25/EC26, baca saja) -> 9.
  const contractErr = contractCheckError(gate.contract);
  if (contractErr) {
    return contractErr.code === "SCHEMA_INVALID"
      ? ctx.reject(contractErr.code, contractErr.message, gate.contract.issues, gate.lint)
      : rejectWithDetails(ctx, contractErr, gate.lint);
  }
  let contractWarnings: SubmitWarningV2[] = [];
  if (gate.contract.targets.some((t) => (t.payload.refs ?? []).length > 0)) {
    try {
      const { createPrismaContractRefReader } = await import("../contracts/prisma-reader");
      contractWarnings = (await resolveContractTargetRefs(gate.contract.targets, createPrismaContractRefReader({ correlationId: ctx.cid }))).warnings;
    } catch (e) {
      if (isClientError(e)) return rejectWithDetails(ctx, e, gate.lint);
      ingestLog({ level: "error", message: "resolusi rujukan kontrak gagal", correlationId: ctx.cid, code: "CONTRACT_REFS_FAILED", stack_trace: e instanceof Error ? e.stack : undefined, context: { templateSlug: doc.template.slug } });
      throw e;
    }
  }
  if (gate.blocking.length > 0) return ctx.reject("BY_CONSTRUCTION_FAILED", `${gate.blocking.length} pelanggaran by-construction`, gate.blocking, gate.lint);
  if (gate.downgraded.length > 0) {
    ingestLog({ level: "warn", message: "penahan by-construction diturunkan (D-34)", correlationId: ctx.cid, code: "D34_DOWNGRADED", context: { checks: gate.downgraded.map((d) => `${d.checkId}@${d.address ?? d.pointer ?? ""}`) } });
  }
  const releaseStatus: StudioReleaseStatus = gate.lint.releaseStatus === "FAIL" ? "FAIL" : "PENDING";

  const result: IngestResultV2 = {
    valid: true,
    issues: [],
    lint: gate.lint,
    document: null,
    revision: null,
    outputs: [],
    job: null,
    releaseStatus,
    snapshot,
    schemaId: p.origin,
    completeness,
    ...(p.adapt ? { adaptReport: p.adapt.report } : {}),
    ...(compose.warnings.length > 0 ? { warnings: compose.warnings } : {}),
    ...(contractWarnings.length > 0 ? { contractWarnings } : {}),
  };
  return {
    prepared: { doc, pinned, compose, recompose, rows, lint: gate.lint, releaseStatus, assets, meta, author, at, inputSha256: p.inputSha256, ...(contractKind !== undefined ? { contractKind } : {}) },
    result,
  };
}

/** Hasil cek isi kiriman yang tidak bergantung dokumen tersimpan. */
interface ContentPreflight {
  assets: V2AssetPlan;
  /** Rujukan aset tak dikenal (pembuatan: ditolak 422; dokumen yang ada: dinilai layanan kiriman). */
  missingAsset: ValidationIssue[];
}

/**
 * Cek yang hanya menilai ISI KIRIMAN, tanpa konteks dokumen tersimpan (dipakai pembuatan dan
 * jalur dokumen yang ada): register ternormalisasi (DATUM-11 entri cacat) dan rencana aset
 * (batas 413, jenis 415, sumber harness). Mengubah `doc` (register ternormalisasi, aset dari
 * sumber); isu keras ditambahkan ke `hard` pemanggil.
 */
async function preflightContent(
  ctx: V2Context,
  doc: StudioDocV2,
  assetPaths: AdaptV1Result["assetPaths"] | undefined,
  hard: ValidationIssue[],
): Promise<ContentPreflight | IngestResultV2> {
  // Register (DATUM-11) sebelum gabung agar sumber tersimpan sudah ternormalisasi.
  const reg = normalizeRegister(doc.register, ctx.ptr);
  hard.push(...reg.issues);
  if (reg.register) doc.register = reg.register;

  // Aset (rencana, tanpa tulis).
  let sources: IngestAssetSource[] = [...(ctx.opts.assetSources ?? [])];
  if (ctx.opts.assetIndexPath) {
    try {
      sources = sources.concat(loadAssetIndex(ctx.opts.assetIndexPath));
    } catch (e) {
      ingestLog({ level: "error", message: "indeks aset tidak terbaca", correlationId: ctx.cid, code: "ASSET_INDEX_UNREADABLE", stack_trace: e instanceof Error ? e.stack : undefined });
      hard.push({ pointer: `${ctx.ptr}/assets`, keyword: "asset", message: `Indeks aset tidak terbaca: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const lookupSha = async (sha: string) => {
    try {
      const { findAssetBySha } = await import("../images/asset-store");
      const row = await findAssetBySha(sha);
      return row ? { mime: row.mime, widthPx: row.widthPx, heightPx: row.heightPx, relPath: row.relPath } : null;
    } catch (e) {
      ingestLog({ level: "warn", message: "pencarian aset M13 gagal; dianggap tidak ada", correlationId: ctx.cid, code: "ASSET_LOOKUP_FAILED", stack_trace: e instanceof Error ? e.stack : undefined });
      return null;
    }
  };
  const assets = await planV2Assets({ doc, pointerPrefix: ctx.ptr, sources, assetPaths, lookupSha, correlationId: ctx.cid });
  if (assets.issues.some((i) => i.keyword === ASSET_TOO_LARGE_KEYWORD)) return ctx.reject("ASSET_TOO_LARGE", "Aset dokumen melewati batas ukuran/piksel", assets.issues);
  if (assets.issues.some((i) => i.keyword === ASSET_TYPE_KEYWORD)) return ctx.reject("ASSET_TYPE_UNSUPPORTED", "Aset harus PNG atau JPEG", assets.issues);
  const missingAsset = assets.issues.filter((i) => i.keyword === ASSET_NOT_FOUND_KEYWORD);
  hard.push(...assets.issues.filter((i) => i.keyword !== ASSET_NOT_FOUND_KEYWORD));
  if (Object.keys(assets.added).length > 0) doc.assets = { ...(doc.assets ?? {}), ...assets.added };
  return { assets, missingAsset };
}

async function randomAllocator(): Promise<PidAllocator> {
  const { createTrackingAllocator, randomPid } = await import("../structure/pid");
  return createTrackingAllocator([], randomPid);
}

// ── Entri v2 ─────────────────────────────────────────────────────────────

/** Buang `x.adaptReportV1` dari kiriman klien (kunci milik server). */
function stripForgedAdaptReport(doc: StudioDocV2, ctx: V2Context): StudioDocV2 {
  if (!isRecord(doc.x) || !Object.prototype.hasOwnProperty.call(doc.x, ADAPT_REPORT_X_KEY)) return doc;
  const x = { ...doc.x };
  delete x[ADAPT_REPORT_X_KEY];
  ingestLog({ level: "warn", message: "x.adaptReportV1 kiriman klien dibuang", correlationId: ctx.cid, code: ADAPT_REPORT_FORGED_STRIPPED, context: { callerKind: ctx.caller.kind, agentId: ctx.agentId ?? null } });
  const next = { ...doc };
  if (Object.keys(x).length > 0) next.x = x;
  else delete next.x;
  return next;
}

/** Kiriman `studio.doc/v2` (penanda kepercayaan sudah dibuang pemanggil). */
export async function ingestDocV2(raw: unknown, ctx: V2Context): Promise<IngestResultV2> {
  const schemaIssues = validateV2Against("studio.doc/v2", raw, ctx.ptr);
  if (schemaIssues.length > 0) return ctx.reject("SCHEMA_INVALID", "Kiriman tidak sesuai studio.doc/v2", schemaIssues);
  const limits = limitIssues(raw, ctx.ptr);
  if (limits.length > 0) return ctx.reject("SCHEMA_INVALID", "Dokumen melampaui batas masukan", limits);
  const doc = stripForgedAdaptReport(raw as StudioDocV2, ctx);
  // SR-55 M2 + FIX-S2 (N1): dokumen yang ADA (bertarget atau upsert misi) digerbang atas versi
  // templat TERSEMAT dan atas dokumen TERGABUNG (layanan kiriman), bukan kerangka kosong.
  const existing = await existingDocPin(doc, ctx);
  const pinned = await pinTemplate(ctx, doc.template, doc.meta, existing?.pin);
  if (!("tpl" in pinned)) return pinned;
  if (existing) return ingestIntoExisting(ctx, doc, pinned, existing.pin, existing.via);
  const out = await runPipeline(ctx, { doc, origin: "studio.doc/v2", pinned, inputSha256: sha256Hex(stableStringify(doc)) });
  if (!("prepared" in out)) return out;
  if (ctx.dryRun) return out.result;
  return persistV2ViaSubmit(ctx, out.prepared, () => out.result);
}

/** Badan kiriman ke layanan SR-13 (`agentId` amplop dibawa bila badan tidak memuatnya). */
function submitBodyOf(ctx: V2Context, doc: StudioDocV2): StudioDocV2 {
  return { ...doc, ...(ctx.agentId && !doc.agentId ? { agentId: ctx.agentId } : {}) };
}

/** Status rilis dari laporan gerbang (FAIL bila lint FAIL, selain itu PENDING). */
function releaseStatusOf(lint: LintReport | null): StudioReleaseStatus {
  return lint?.releaseStatus === "FAIL" ? "FAIL" : "PENDING";
}

/** Tempel temuan REPORT gerbang kepercayaan ingest ke laporan lint (pola sama dengan `evaluateByConstruction`). */
function withNotices(lint: LintReport, notices: readonly LintIssue[]): LintReport {
  for (const n of notices) {
    lint.checks.push(n);
    lint.banner = lint.banner ? `${lint.banner} ${n.detail ?? n.checkId}` : (n.detail ?? n.checkId);
  }
  return lint;
}

function isNormV2Snapshot(v: unknown): v is NormDocSnapshotV2 {
  return isRecord(v) && v.schema === "studio.norm/v2" && isRecord(v.doc);
}

/**
 * FIX-S2 (SR-55b N1 + M2 sisa): kiriman v2 ke dokumen yang ADA. Tidak ada compose/gerbang
 * atas kiriman parsial yang digabung ke kerangka KOSONG (sumber 422 palsu, mis. turunan yang
 * merujuk kunci register yang tersimpan di dokumen tetapi tidak dikirim ulang). Di sini hanya
 * cek isi kiriman; gabung + gerbang by-construction + kelengkapan dijalankan SATU kali oleh
 * layanan kiriman atas dokumen TERGABUNG dengan kerangka templat tersemat (sama dengan
 * R12/R13): dryRun = `dryRunDocumentV2` (READ ONLY, tanpa kunci), simpan = `submitDocumentV2`.
 */
async function ingestIntoExisting(ctx: V2Context, doc0: StudioDocV2, pinned: Pinned, pin: DocPin, via: "target" | "mission"): Promise<IngestResultV2> {
  const doc: StudioDocV2 = structuredClone(doc0);
  const hard: ValidationIssue[] = [];
  const pf = await preflightContent(ctx, doc, undefined, hard);
  if (!("assets" in pf)) return pf;
  if (hard.length > 0) return ctx.reject("SCHEMA_INVALID", "Dokumen tidak konsisten secara struktur", hard);
  ingestLog({
    level: "info",
    message: "kiriman ke dokumen yang ada: gerbang atas dokumen tergabung (layanan kiriman)",
    correlationId: ctx.cid,
    code: "EXISTING_DOC_MERGED_GATE",
    context: {
      documentId: pin.documentId,
      via,
      templateVersionId: pin.templateVersionId,
      dryRun: ctx.dryRun,
      // Rujukan aset yang tidak dikirim ulang dapat menunjuk aset dokumen tersimpan: diputus layanan kiriman.
      deferredAssetRefs: pf.missingAsset.length,
    },
  });
  const body = submitBodyOf(ctx, doc);
  if (ctx.dryRun) {
    const { dryRunDocumentV2 } = await import("../submit");
    let dry: Awaited<ReturnType<typeof dryRunDocumentV2>>;
    try {
      dry = await dryRunDocumentV2(ctx.caller, body, ctx.opts.submitTargeting);
    } catch (e) {
      if (isClientError(e)) return ctx.reject(e.code, e.message, issuesFromEngineError(e, ctx.ptr));
      ingestLog({ level: "error", message: "dry-run kiriman ke dokumen yang ada gagal", correlationId: ctx.cid, code: "EXISTING_DOC_DRY_RUN_FAILED", stack_trace: e instanceof Error ? e.stack : undefined, context: { documentId: pin.documentId } });
      throw e;
    }
    // `unchanged`: tidak ada snapshot/lint baru (kiriman identik dengan revisi terkini).
    const lint = dry.lint ? withNotices(dry.lint, ctx.notices) : null;
    return {
      valid: true,
      issues: [],
      lint,
      document: null,
      revision: null,
      outputs: [],
      job: null,
      releaseStatus: releaseStatusOf(lint),
      ...(dry.snapshot ? { snapshot: dry.snapshot } : {}),
      schemaId: "studio.doc/v2",
      completeness: dry.result.completeness,
      ...(dry.result.warnings && dry.result.warnings.length > 0 ? { contractWarnings: [...dry.result.warnings] } : {}),
    };
  }
  return persistV2ViaSubmit(ctx, { doc, assets: pf.assets }, (submit, revSnapshot) => {
    // Laporan lint = gerbang bersama atas snapshot revisi yang DITULIS (masukan sama dengan
    // gerbang di dalam transaksi; tanpa lempar), ditambah temuan kepercayaan ingest.
    const snapshot = isNormV2Snapshot(revSnapshot) ? revSnapshot : undefined;
    const lint = snapshot
      ? evaluateByConstruction({ snapshot, tpl: pinned.tpl, tier: pin.tier, complete: submit.completeness.status === "COMPLETE", notices: ctx.notices, correlationId: ctx.cid }).lint
      : null;
    return {
      valid: true,
      issues: [],
      lint,
      document: null,
      revision: null,
      outputs: [],
      job: null,
      releaseStatus: releaseStatusOf(lint),
      ...(snapshot ? { snapshot } : {}),
      schemaId: "studio.doc/v2",
    };
  });
}

/**
 * Simpan v2 lewat layanan kiriman SR-13 (pemilik pembuatan/upsert dokumen misi,
 * kunci advisory, revisi n+1). Aset dari sumber harness/path disimpan dulu
 * (SR-19, idempoten); aset base64 disimpan SR-13. `base` membentuk hasil dasar dari
 * respons kiriman + snapshot revisi yang ditulis (dibaca ulang).
 */
async function persistV2ViaSubmit(
  ctx: V2Context,
  prep: Pick<PreparedV2, "doc" | "assets">,
  base: (submit: SubmitResultV2, revisionSnapshot: unknown) => IngestResultV2,
): Promise<IngestResultV2> {
  try {
    await storePlannedAssets(ctx.caller, prep.assets, { missionFolder: prep.doc.mission?.folder ?? null, correlationId: ctx.cid, skipDataBase64: true });
    const { submitDocumentV2 } = await import("../submit");
    const submit = await submitDocumentV2(ctx.caller, submitBodyOf(ctx, prep.doc), ctx.opts.submitTargeting);
    // Swarm patch (row 109, site 6): store reads instead of Prisma.
    const { readWith, findDocumentById, findRevisionByNo } = await import("../_swarm-store");
    const { documentSummary, revisionSummary } = await import("../revisions/rows");
    const { docRow, revRow } = await readWith(undefined, (q) => {
      const d = findDocumentById(q, submit.document.id);
      return { docRow: d, revRow: d ? findRevisionByNo(q, d.id, submit.revision.revisionNo) : null };
    });
    ingestLog({
      level: "info",
      message: "dokumen v2 diterima lewat layanan kiriman",
      correlationId: ctx.cid,
      context: { documentId: submit.document.id, revisionNo: submit.revision.revisionNo, created: submit.created, unchanged: submit.unchanged, completeness: submit.completeness.status },
    });
    const b = base(submit, revRow?.snapshot ?? null);
    return {
      ...b,
      document: docRow ? documentSummary(docRow, b.releaseStatus) : null,
      revision: revRow ? revisionSummary(revRow) : null,
      completeness: submit.completeness,
      submit,
    };
  } catch (e) {
    const code = e instanceof StudioEngineError ? e.code : "INGEST_PERSIST_FAILED";
    ingestLog({
      level: isClientError(e) ? "warn" : "error",
      message: `penyimpanan ingest v2 gagal: ${e instanceof Error ? e.message : String(e)}`,
      correlationId: ctx.cid,
      code,
      stack_trace: e instanceof Error ? e.stack : undefined,
      context: { templateSlug: prep.doc.template.slug, missionFolder: prep.doc.mission?.folder ?? null },
    });
    throw e;
  }
}

// ── Entri v1 (adaptor) ───────────────────────────────────────────────────

/**
 * Kebijakan `ingest.inlineFormat` templat (R-38, D-138, D-253): pengurai tunggal kini di
 * modul daun `services/inline-format/policy` (SR-55b N5); diekspor ulang di sini agar
 * pemakai lama modul ini tetap jalan.
 */
export { inlineFormatPolicyOf };

/**
 * Kiriman `studio.doc/v1` lewat adaptor SR-09 (§2.8 butir 1). `req.document`
 * sudah lolos skema v1 dan penanda kepercayaan sudah dibuang.
 */
export async function ingestDocV1Adapted(req: StudioIngestRequest, ctx: V2Context): Promise<IngestResultV2> {
  const d = req.document;
  const pinned = await pinTemplate(ctx, d.template, d.meta);
  if (!("tpl" in pinned)) return pinned;

  // Kebijakan R-38 (kelas K, cakupan dokumen); `allow` hanya tepercaya (adaptor menegakkan).
  const policy = inlineFormatPolicyOf(pinned.tpl.params);
  const eff = effectiveInlinePolicy(policy, ctx.trusted);
  if (policy === "allow" && eff !== "allow") {
    ingestLog({ level: "warn", message: "ingest.inlineFormat allow dari pemanggil tidak tepercaya dijalankan sebagai strip", correlationId: ctx.cid, code: "INLINE_FORMAT_ALLOW_DOWNGRADED", context: { callerKind: ctx.caller.kind } });
  }
  // `overrides` v1 hanya bermakna untuk `allow` tepercaya (KD-26); hak kelas K/T tetap diperiksa.
  if (eff === "allow" && d.overrides && Object.keys(d.overrides).length > 0) {
    const rights = checkOverrideRights(d.overrides, ctx.caller.kind, ALL_PARAMS);
    if (rights.length > 0) {
      return ctx.reject(rights[0].code, rights[0].message, rights.map((r) => ({ pointer: `${ctx.ptr}${r.pointer ?? `/overrides/${r.key}`}`, keyword: r.code, message: r.message })));
    }
  }
  // D-271: ukuran figur v1 terhadap grid turunan templat terpatok, sebelum adaptor membuang medan ukuran.
  const sizeIssues = v1FigureSizeIssues(d, pinned.tpl.params, ctx.ptr);
  if (sizeIssues.length > 0) return ctx.reject("BY_CONSTRUCTION_FAILED", `${sizeIssues.length} pelanggaran by-construction`, sizeIssues);
  const tocMixed = pinned.skeleton.skeleton.slots.some((s) => s.sectionType === "toc" && s.contentMode === "MIXED");
  let adapt: AdaptV1Result;
  try {
    adapt = adaptV1(req, policy, ctx.trusted, { tocMixed });
  } catch (e) {
    if (isClientError(e)) return ctx.reject(e.code, e.message, issuesFromEngineError(e, ""));
    ingestLog({ level: "error", message: "adaptor v1 gagal", correlationId: ctx.cid, code: "ADAPT_V1_FAILED", stack_trace: e instanceof Error ? e.stack : undefined, context: { templateSlug: d.template.slug } });
    throw e;
  }
  const doc = adapt.doc;
  const chartIssues = await fillChartCodes(doc, ctx);
  if (chartIssues.length > 0) return ctx.reject("SCHEMA_INVALID", "Chart v1 merujuk artefak yang tidak dapat dipakai", chartIssues);
  // Hasil adaptasi wajib lolos skema v2 (cacat adaptor = galat yang dicatat, bukan diam).
  const v2Issues = validateV2Against("studio.doc/v2", doc, ctx.ptr);
  if (v2Issues.length > 0) {
    ingestLog({ level: "error", message: "hasil adaptasi v1 tidak lolos studio.doc/v2", correlationId: ctx.cid, code: "ADAPT_V1_SCHEMA_INVALID", context: { issues: v2Issues.slice(0, 20) } });
    return ctx.reject("SCHEMA_INVALID", "Dokumen v1 tidak dapat diadaptasi ke studio.doc/v2", v2Issues);
  }
  // LD-03/LD-04 membaca laporan dari `x.adaptReportV1` (seam SR-18).
  doc.x = { ...(doc.x ?? {}), [ADAPT_REPORT_X_KEY]: adapt.report };
  ingestLog({
    level: "info",
    message: "kiriman v1 diadaptasi ke v2 (SCHEMA_V1_ADAPTED)",
    correlationId: ctx.cid,
    code: "SCHEMA_V1_ADAPTED",
    context: { policy: adapt.report.policy, stripped: Object.keys(adapt.report.stripped).length, dropped: adapt.report.dropped, assetPaths: Object.keys(adapt.assetPaths ?? {}).length },
  });

  const out = await runPipeline(ctx, { doc, origin: "studio.doc/v1", pinned, adapt, inputSha256: sha256Hex(stableStringify(d)) });
  if (!("prepared" in out)) return out;
  if (ctx.dryRun) return out.result;
  const { persistAdaptedV1 } = await import("./repository");
  return persistAdaptedV1(ctx, out.prepared, out.result, req.agentId);
}

/** Skema v1 dokumen (dipakai dispatcher sebelum adaptasi). */
export function validateDocV1(doc: unknown, ptr: string): ValidationIssue[] {
  const s = validateAgainst("studio.doc/v1", doc, ptr);
  return s.length > 0 ? s : limitIssues(doc, ptr);
}
