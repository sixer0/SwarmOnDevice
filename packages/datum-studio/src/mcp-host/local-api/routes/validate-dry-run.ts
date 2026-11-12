/**
 * Glue dry-run R08 `POST /api/studio/validate` bersama (dipindah apa adanya dari `validate/route.ts`,
 * DC-23 per D-378): satu sumber untuk R08 dan R23 `POST /api/studio/drafts/check` agar dry-run
 * blok draf tidak menyimpang dari R08. Perilaku dan respons R08 tidak berubah.
 *
 * Isi: kode galat yang tetap HTTP (`HARD_CODES`/`isUserError`), medan draf tingkat atas
 * (`roleFormats` IP-10, `draftTemplate` FIX-V), pratinjau v2 (`buildPreviewV2`/`attachPreview`),
 * dan kiriman v2 SR-20/FIX-V (`validateV2Submission`, `validatePartialV2`, `submitPreviewOf`).
 * Berkas route Next hanya boleh mengekspor handler, jadi fungsi ini tinggal di `_shared`.
 */
import {
  STUDIO_ERROR_HTTP,
  type CompletenessReportV2,
  isNormSnapshotV2,
  type NormDocSnapshotV2,
  type ResolvedTemplate,
  type RoleFormatMap,
  type StudioCaller,
  type StudioChapterV2,
  type StudioErrorCode,
  type StudioIngestRequest,
  type StudioSlotV2,
  type StudioTier,
  type SubmitWarningV2,
  type ValidateResponse,
  type ValidationIssue,
} from "@/lib/studio/contract";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import { normalizeControlSheetKeys } from "@/lib/studio/contract/schema/v2/verification-entry";
import { ingestDocument, type IngestResultV2 } from "@/lib/studio/services/ingest";
import { dryRunChapter, dryRunSlot, type SubmitDryRunResult } from "@/lib/studio/services/submit";
import { validateRoleFormats } from "@/lib/studio/services/templates";
import { apiLog, isRecord, type ReqCtx } from "@/lib/studio/http";
import { issuesFromError } from "./error-issues";

// Swarm port (row 31): two paths of R08 are not offered by the host.
// - `?preview=html` (HTML preview): the clone runs it through services/render `renderGate` (not vendored);
//   no kept MCP tool asks for it (doc-tools.ts:342, write-client-run.ts:139, studio-report.ts dry runs post
//   without `preview`). The response carries `previewError: PREVIEW_UNAVAILABLE` instead.
// - `draftTemplate` (ADMIN template draft preview, template-draft.ts): template drafts are the row 63/68
//   template tools' job (spec §5.3); here the field is refused as an issue.
export const DRAFT_POINTER = "/draftTemplate";
type IngestSkeleton = NonNullable<NonNullable<Parameters<typeof ingestDocument>[2]>["skeleton"]>;
export type DraftTemplateResolved = { slug: string; tier: string; tpl: ResolvedTemplate; skeleton: IngestSkeleton; slots: undefined };
async function resolveDraftTemplate(_raw: unknown, _caller: StudioCaller, _meta: unknown, _ctx: ReqCtx): Promise<{ ok: false; issues: ValidationIssue[] } | { ok: true; draft: DraftTemplateResolved }> {
  return { ok: false, issues: [{ pointer: DRAFT_POINTER, keyword: "not", message: "draftTemplate is not available in DATUM Studio for Swarm; use the template tools" }] };
}
const PREVIEW_UNAVAILABLE = { code: "PREVIEW_UNAVAILABLE", message: "HTML preview is not available through the DATUM Studio host; validation still ran" };
import { asCompletenessReport, validateV2, type V2SubmissionSchema } from "@/app/api/studio/validate/_shared/v2-kit";

/**
 * Galat yang tetap menjadi respons HTTP (bukan `valid:false`). FORBIDDEN (D-98,
 * INT-R): templat terbatas oleh pemanggil tidak tepercaya adalah kegagalan
 * otorisasi, bukan ketidaksahan masukan -> 403.
 */
export const HARD_CODES: ReadonlySet<StudioErrorCode> = new Set<StudioErrorCode>(["UNAUTHORIZED", "FORBIDDEN", "PAYLOAD_TOO_LARGE", "JSON_MALFORMED"]);

/** FIX-V (IP-51): ringkasan kiriman yang AKAN terjadi (dry-run; tidak ada yang ditulis). */
export interface SubmitPreview {
  /** null = dokumen AKAN dibuat oleh kiriman ini. */
  documentId: string | null;
  docNumber: string;
  created: boolean;
  unchanged: boolean;
  rebased: boolean;
  /** Revisi yang AKAN ditulis (atau revisi saat ini bila `unchanged`). */
  revisionNo: number;
  changeScope: string;
  chapter?: { slotKey: string; chapterKey: string; pid: string };
  slot?: { slotKey: string; address: string; pid?: string };
  /** AM-08 (KD-46): peringatan kontrak non-penahan kiriman yang akan terjadi; hanya bila tidak kosong. */
  warnings?: SubmitWarningV2[];
}

export type ValidateBody = ValidateResponse & {
  previewError?: { code: string; message: string };
  /** SR-20: pratinjau kelengkapan kiriman v2 (§8.4); tidak menyimpan. */
  completenessPreview?: CompletenessReportV2;
  /** FIX-V: dry-run kiriman bab/slot v2. */
  submitPreview?: SubmitPreview;
  /**
   * FIX-R40-2 (KD-46, CW-01): peringatan kontrak non-penahan dry-run `studio.doc/v2` (dokumen baru
   * dan dokumen yang ada); hanya bila tidak kosong. Bab/slot membawanya di `submitPreview.warnings` (AM-08).
   */
  warnings?: SubmitWarningV2[];
};

export function isUserError(err: unknown): err is StudioEngineError {
  return err instanceof StudioEngineError && !HARD_CODES.has(err.code) && STUDIO_ERROR_HTTP[err.code] < 500;
}

// ── IP-10: roleFormats draf ─────────────────────────────────────────────

export type DraftRoles = { present: false } | { present: true; roleFormats: RoleFormatMap; issues: ValidationIssue[] };

export function draftRoleFormats(b: Record<string, unknown>): DraftRoles {
  if (b.roleFormats === undefined || b.roleFormats === null) return { present: false };
  const r = validateRoleFormats(b.roleFormats, "/roleFormats");
  const issues: ValidationIssue[] = r.issues.map((i) => ({ pointer: i.pointer ?? "/roleFormats", keyword: i.code, message: i.message }));
  return { present: true, roleFormats: r.roleFormats, issues };
}

/** Badan tanpa medan draf tingkat atas (`roleFormats` IP-10, `draftTemplate` FIX-V; bukan bagian kiriman). */
export function withoutDraftFields(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) if (k !== "roleFormats" && k !== "draftTemplate") out[k] = v;
  return out;
}

/**
 * FIX-V: HTML pratinjau snapshot norm/v2 (perakit sadar slot). Templat/slot dari draf bila
 * diberikan, selain itu versi templat terpatok snapshot (`skeleton.templateVersionId`).
 */
export async function buildPreviewV2(
  snapshot: NormDocSnapshotV2,
  ctx: ReqCtx,
  opts: { tpl?: ResolvedTemplate; slots?: DraftTemplateResolved["slots"]; draft: boolean },
): Promise<string> {
  void snapshot;
  void ctx;
  void opts;
  throw new StudioEngineError("RENDER_FAILED", PREVIEW_UNAVAILABLE.message);
}

/** Rakit pratinjau lewat antrean render berbatas (FIX-1 S87 M-03); gagal -> `previewError`, validasi tetap. */
export async function attachPreview(out: ValidateBody, build: () => Promise<string>, ctx: ReqCtx): Promise<void> {
  void build;
  apiLog({ ...ctx, level: "info", message: "preview requested; not available in the host", code: PREVIEW_UNAVAILABLE.code });
  out.previewError = { ...PREVIEW_UNAVAILABLE };
}

// ── SR-20: kiriman v2 ───────────────────────────────────────────────────

/** Pointer isu dry-run ingest (relatif kiriman v2 tingkat atas) -> relatif badan permintaan. */
export function rebaseIssues(issues: readonly ValidationIssue[], prefix: string): ValidationIssue[] {
  return prefix ? issues.map((i) => ({ ...i, pointer: prefix + i.pointer })) : [...issues];
}

/** FIX-V (IP-51): ringkasan respons kiriman yang AKAN terjadi. */
export function submitPreviewOf(r: SubmitDryRunResult): SubmitPreview {
  const res = r.result;
  return {
    documentId: res.document.id === "" ? null : res.document.id,
    docNumber: res.document.docNumber,
    created: res.created,
    unchanged: res.unchanged,
    rebased: res.rebased,
    revisionNo: res.revision.revisionNo,
    changeScope: res.revision.changeScope,
    ...(res.chapter ? { chapter: { slotKey: res.chapter.slotKey, chapterKey: res.chapter.chapterKey, pid: res.chapter.pid } } : {}),
    ...(res.slot ? { slot: { slotKey: res.slot.slotKey, address: res.slot.address, ...(res.slot.pid ? { pid: res.slot.pid } : {}) } } : {}),
    ...(res.warnings && res.warnings.length > 0 ? { warnings: [...res.warnings] } : {}),
  };
}

/**
 * FIX-V (IP-51): bab/slot v2 sah skema -> dry-run kiriman parsial SR-13 (tanpa tulis, tanpa
 * build). Galat 4xx layanan = `valid:false` (isu sama dengan kiriman nyata); 403 tetap HTTP.
 */
export async function validatePartialV2(
  schemaId: "studio.chapter/v2" | "studio.slot/v2",
  spec: Record<string, unknown>,
  caller: StudioCaller,
  wantPreview: boolean,
  prefix: string,
  ctx: ReqCtx,
): Promise<ValidateBody> {
  let dry: SubmitDryRunResult;
  try {
    dry = schemaId === "studio.chapter/v2" ? await dryRunChapter(caller, spec as unknown as StudioChapterV2) : await dryRunSlot(caller, spec as unknown as StudioSlotV2);
  } catch (err) {
    if (!isUserError(err)) throw err;
    apiLog({ ...ctx, level: "info", message: `v2 partial dry-run rejected (${schemaId}): ${err.message}`, code: err.code });
    return { valid: false, issues: rebaseIssues(issuesFromError(err), prefix), lint: null };
  }
  const out: ValidateBody = {
    valid: true,
    issues: [],
    lint: dry.lint,
    completenessPreview: dry.result.completeness,
    submitPreview: submitPreviewOf(dry),
  };
  apiLog({
    ...ctx,
    level: "info",
    message: `v2 partial dry-run (${schemaId})`,
    code: "PARTIAL_DRY_RUN",
    context: { created: dry.result.created, unchanged: dry.result.unchanged, completeness: dry.result.completeness.status },
  });
  if (wantPreview) {
    const snapshot = dry.snapshot;
    if (!snapshot) out.previewError = { code: "PREVIEW_UNAVAILABLE", message: "submission is identical to the current revision; nothing new to preview" };
    else {
      const draft = dry.result.completeness.status !== "COMPLETE";
      const versionId = snapshot.skeleton.templateVersionId;
      void versionId;
      void draft;
      await attachPreview(out, async () => "", ctx);
    }
  }
  return out;
}

/**
 * Validasi kiriman v2: skema (DISPLAY_FIELD/V1_FIELD lewat pemeta kontrak), lalu
 * dry-run ingest SR-12 (dokumen: struktur, by-construction, lint, pratinjau kelengkapan)
 * atau dry-run kiriman parsial SR-13 (bab/slot, FIX-V). `prefix` = pointer kiriman di
 * dalam badan ("" tingkat atas, "/spec" bentuk skema). `draftRaw` = medan
 * `draftTemplate` (hanya `studio.doc/v2`).
 */
export async function validateV2Submission(
  schemaId: V2SubmissionSchema,
  spec: unknown,
  agentId: unknown,
  caller: StudioCaller,
  wantPreview: boolean,
  prefix: string,
  ctx: ReqCtx,
  draftRaw?: unknown,
): Promise<ValidateBody> {
  if (draftRaw !== undefined && schemaId !== "studio.doc/v2") return draftTemplateMisplaced();
  // Row 207 (HB-2): same verificationChain key mapping / refusal as the R13 route, so the dry run agrees with the write.
  const keyIssues = normalizeControlSheetKeys(spec, prefix).issues;
  const schemaIssues = keyIssues.length > 0 ? keyIssues : validateV2(schemaId, spec, prefix);
  if (schemaIssues.length > 0) {
    apiLog({
      ...ctx,
      level: "info",
      message: `v2 schema rejected (${schemaId})`,
      code: "SCHEMA_INVALID",
      context: { issues: schemaIssues.length, displayField: schemaIssues.filter((i) => i.checkId === "DISPLAY_FIELD").length },
    });
    return { valid: false, issues: schemaIssues, lint: null };
  }
  const withAgent = isRecord(spec) && typeof agentId === "string" && spec.agentId === undefined ? { ...spec, agentId } : spec;
  if (schemaId !== "studio.doc/v2") return validatePartialV2(schemaId, withAgent as Record<string, unknown>, caller, wantPreview, prefix, ctx);

  // FIX-V (M5): draf templat editor -> templat + kerangka ingest dryRun.
  let draft: DraftTemplateResolved | undefined;
  if (draftRaw !== undefined) {
    const r = await resolveDraftTemplate(draftRaw, caller, isRecord(spec) ? spec.meta : undefined, ctx);
    if (!r.ok) {
      apiLog({ ...ctx, level: "info", message: "draft template rejected", code: "DRAFT_TEMPLATE_INVALID", context: { issues: r.issues.length } });
      return { valid: false, issues: r.issues, lint: null };
    }
    draft = r.draft;
  }

  // Kiriman v2 tingkat atas apa adanya (ingest dispatch `$schema`, pointer relatif kiriman).
  const ingestReq = withAgent as unknown as StudioIngestRequest;
  let result: IngestResultV2;
  try {
    result = await ingestDocument(ingestReq, caller, { dryRun: true, ...(draft ? { template: draft.tpl, skeleton: draft.skeleton } : {}) });
  } catch (err) {
    if (!isUserError(err)) throw err;
    apiLog({ ...ctx, level: "info", message: `v2 dry-run rejected: ${err.message}`, code: err.code });
    return { valid: false, issues: rebaseIssues(issuesFromError(err), prefix), lint: null };
  }
  const out: ValidateBody = { valid: result.valid, issues: rebaseIssues(result.issues ?? [], prefix), lint: result.lint ?? null };
  // FIX-R40-2: CW-01 dry-run dokumen (pointer relatif kiriman -> relatif badan, seperti isu).
  if (result.contractWarnings && result.contractWarnings.length > 0) {
    out.warnings = prefix ? result.contractWarnings.map((w) => ({ ...w, pointer: prefix + w.pointer })) : [...result.contractWarnings];
  }
  // Pratinjau kelengkapan hasil dry-run SR-12, dibaca dengan pengaman bentuk.
  const preview = asCompletenessReport(result.completeness);
  if (preview) out.completenessPreview = preview;
  if (draft) {
    apiLog({
      ...ctx,
      level: "info",
      message: "dry-run with draft template",
      code: "DRAFT_TEMPLATE",
      context: { slug: draft.slug, slots: draft.skeleton.skeleton.slots.length, tier: draft.tier, valid: out.valid },
    });
  }
  if (wantPreview && result.valid) {
    const snapshot = result.snapshot;
    if (typeof result.previewHtml === "string") out.previewHtml = result.previewHtml;
    else if (snapshot && isNormSnapshotV2(snapshot)) {
      // Pratinjau templat (draf) tanpa penanda draf; kiriman dokumen belum lengkap bertanda draf.
      const draftMark = !draft && preview?.status !== "COMPLETE";
      const opts = draft ? { tpl: draft.tpl, slots: draft.slots, draft: false } : { draft: draftMark };
      await attachPreview(out, () => buildPreviewV2(snapshot, ctx, opts), ctx);
    } else out.previewError = { code: "PREVIEW_UNAVAILABLE", message: "HTML preview is not available for this v2 submission" };
  }
  return out;
}

export function v2RoleFormatsIssue(): ValidateBody {
  return { valid: false, issues: [{ pointer: "/roleFormats", keyword: "not", message: "roleFormats only applies to studio.doc/v1 documents" }], lint: null };
}

export function draftTemplateMisplaced(): ValidateBody {
  return { valid: false, issues: [{ pointer: DRAFT_POINTER, keyword: "not", message: "draftTemplate only applies to studio.doc/v2 documents" }], lint: null };
}
