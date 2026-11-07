/**
 * Template preview with the sample content, and the guarded template check (row 67;
 * masterplan/01_specs_studio_templates.md §5.4 with U.4, and §5.2 for `studio_template_check`).
 *
 * `previewTemplate`: renders the Swarm sample (`./sample-render`) with a stored version
 * (`{slug, version?}`) or with an unsaved definition (`{template, base?}`). An unsaved definition goes
 * through the row 66 check chain first (`prepareCandidate`: schema, form lock P1-P9, §3.2, §3.3,
 * Studio's fold), so a definition that breaks the form lock is never rendered. Formats are `docx`,
 * `html`, `pdf` (U.4; default `pdf`). The files are written under `store/tmp/preview/<uuid>/` with names
 * without underscore (`GSP Pratinjau Templat.<ext>`) and recorded as `output_file.kind = 'preview'`
 * rows. With `lint` (default true) the per-check list of that render is attached; it is information,
 * not a guard verdict, and no version is saved.
 *
 * `checkTemplateWithGuard`: the form check plus one guard run (`op: "check"`); saves nothing.
 *
 * Row 70a (security M1, decision C90): a preview is a render. It is charged to the same per-agent render rate
 * limiter as R04/R08/R12/R16/R17 (`checkRenderRate`, env STUDIO_RENDER_RATE_LIMIT, default 30 per 60 s) and runs
 * through the same admission queue as R17 (`renderGate()`, RENDER_QUEUE_FULL). A refused call answers RATE_LIMITED
 * or RENDER_QUEUE_FULL before any ingest, render or write, so nothing is kept. After a preview is kept, the store
 * keeps at most PREVIEW_KEEP_MAX previews; older preview files and their output_file rows are removed
 * (`prunePreviewOutputs`, preview rows and `tmp/preview/` only).
 */
import { randomUUID } from "node:crypto";
import type { StudioCaller, StudioOutputFormat, StudioTemplateV2, StudioTier } from "../../contract";
import { localStudioCaller } from "../../contract/auth";
import { STUDIO_TIERS } from "../../contract/enums";
import { StudioEngineError } from "../../contract/errors";
import type { ReqCtx } from "../../http/context";
import { checkRenderRate } from "../../http/render-guard";
import { studioStore, withStudioTx } from "../_swarm-store";
import { assertRenderCapacity, renderGate } from "../render/admission";
import { FORMAT_MIME } from "../render/naming";
import { templateTierOf } from "./form-lock";
import { ensureBuiltinTemplates, getTemplate, getTemplateV2, parseTemplateV2, resolveTemplate } from "./index";
import { templatesLog } from "./log";
import { DATUM_CANONICAL_SLUG, isPlainObject, sha256Hex } from "./profile";
import { renderSample, sampleLanguageOf, sampleSha256, sideFromCandidate, sideFromVersion, swarmSampleDocument, type RenderSide } from "./sample-render";
import { assertInputLimits, installedTemplateGuard, prepareCandidate, templateErrorCode, type TemplateGuard, type TemplateGuardOutcome } from "./service";

export const PREVIEW_FORMATS = ["docx", "html", "pdf"] as const;
export type PreviewFormat = (typeof PREVIEW_FORMATS)[number];
export const PREVIEW_RENDER_TIMEOUT_MS = 60_000;
/** File base name of preview outputs (no underscore: lint DATUM-38 checks name and parent folder). */
export const PREVIEW_FILE_BASE = "GSP Pratinjau Templat";
/**
 * Row 70a: previews kept per store (oldest removed first). 20 covers an agent's iteration loop (spec §5.2: iterate
 * through preview, compare the last few) with room to spare, and bounds the disk at about 20 x 4.6 MB = 92 MB
 * (row 70 probe: 4 594 054 B per docx+html+pdf preview) instead of growing until the store reopens.
 */
export const PREVIEW_KEEP_MAX = 20;

const FORMAT_OF: Record<PreviewFormat, StudioOutputFormat> = { docx: "DOCX", html: "HTML", pdf: "PDF" };
const EXT_OF: Record<string, string> = { DOCX: "docx", HTML: "html", PDF: "pdf" };

export interface TemplatePreviewInput {
  /** A stored version. */
  slug?: string;
  version?: number;
  /** Or an unsaved `studio.template/v2`, measured against `base` (default: from scratch on datum-kanonik). */
  template?: unknown;
  base?: { slug: string; version?: number };
  formats?: readonly string[];
  lint?: boolean;
  /**
   * Render tier (spec §6 `tier`; NOTA may be asked for). Default = the guard's lint tier (U.1 step 4):
   * SERAH when the template's `artifact.tier` is SERAH, else TERBIT. Builtins resolve `artifact.tier`
   * NOTA, and a NOTA render drops the cover and releases lint groups A-D, so it is never the default.
   */
  tier?: string;
}

export interface TemplatePreviewOptions {
  /** Who asks (the MCP session's agent, `localStudioCaller`); the render rate bucket is per agent. Default: anonymous internal agent. */
  caller?: StudioCaller;
}

export interface TemplatePreviewFile {
  outputId: string;
  format: StudioOutputFormat;
  fileName: string;
  relPath: string;
  bytes: number;
  sha256: string;
  mime: string;
}

export interface TemplatePreviewResult {
  previewId: string;
  template: { slug: string | null; versionNo: number | null; versionId: string | null; unsaved: boolean; changedKeys?: number };
  tier: StudioTier;
  language: "ID" | "EN";
  sampleSha256: string;
  files: TemplatePreviewFile[];
  failed: StudioOutputFormat[];
  errors: Array<{ code: string; format?: string }>;
  lint: { tier: string; releaseStatus: string; checks: Array<{ id: string; status: string; detail?: string }> } | null;
  durationMs: number;
}

function schemaIssue(pointer: string, message: string): never {
  throw new StudioEngineError("SCHEMA_INVALID", message, { issues: [{ pointer, keyword: "enum", message }] });
}

function previewFormats(raw: readonly string[] | undefined): StudioOutputFormat[] {
  const list = raw === undefined ? ["pdf"] : raw;
  if (!Array.isArray(list) || list.length === 0 || list.length > PREVIEW_FORMATS.length) schemaIssue("/formats", `formats: 1 to 3 of ${PREVIEW_FORMATS.join(", ")}`);
  const out = new Set<StudioOutputFormat>();
  for (const f of list) {
    if (!(PREVIEW_FORMATS as readonly string[]).includes(f)) schemaIssue("/formats", `format ${String(f)} is not supported; supported: ${PREVIEW_FORMATS.join(", ")}`);
    out.add(FORMAT_OF[f as PreviewFormat]);
  }
  return [...out];
}

function tierOf(v: unknown): StudioTier | null {
  return typeof v === "string" && (STUDIO_TIERS as readonly string[]).includes(v) ? (v as StudioTier) : null;
}

/** The base definition (read with `includeAdvanced`, as row 66 requires for a full template) and its contract kind. */
async function storedDefinition(slug: string, version: number | undefined): Promise<{ definition: StudioTemplateV2; contractKind: string | null; slug: string; versionNo: number; versionId: string }> {
  const d = await getTemplateV2(slug, version, { includeAdvanced: true });
  if (!d.definition) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Templat ${slug} tidak punya definisi studio.template/v2`);
  return { definition: d.definition, contractKind: d.template.contractKind ?? null, slug: d.template.slug, versionNo: d.version.versionNo, versionId: d.version.id };
}

interface PreparedSide {
  side: RenderSide;
  template: TemplatePreviewResult["template"];
  defaultTier: StudioTier;
  candidate?: ReturnType<typeof prepareCandidate>;
  reference?: { slug: string; versionNo: number; versionId: string };
}

/** Unsaved definition -> form check (row 66 chain) -> render side hosted by the base (or datum-kanonik). */
async function sideOfDefinition(template: unknown, base: TemplatePreviewInput["base"]): Promise<PreparedSide> {
  const definition = parseTemplateV2(template, "/template");
  const ref = base ? await storedDefinition(base.slug, base.version) : await storedDefinition(DATUM_CANONICAL_SLUG, undefined);
  const cand = prepareCandidate(definition, base ? ref.definition : null, base ? null : ref.definition, base ? ref.contractKind : null);
  const host = await resolveTemplate(ref.slug, ref.versionNo);
  return {
    side: await sideFromCandidate(cand, host),
    template: { slug: null, versionNo: null, versionId: null, unsaved: true, changedKeys: cand.changedKeys },
    defaultTier: cand.tier === "SERAH" ? "SERAH" : "TERBIT",
    candidate: cand,
    reference: { slug: ref.slug, versionNo: ref.versionNo, versionId: ref.versionId },
  };
}

async function sideOfStored(slug: string, version: number | undefined): Promise<PreparedSide> {
  const d = await getTemplate(slug, version);
  const side = await sideFromVersion(d.version.id);
  return {
    side,
    template: { slug: d.template.slug, versionNo: d.version.versionNo, versionId: d.version.id, unsaved: false },
    defaultTier: tierOf(side.tpl.params["artifact.tier"]) === "SERAH" ? "SERAH" : "TERBIT",
  };
}

/**
 * Row 70a: charge one render to the caller's render bucket (the R17 limiter). Refused -> RATE_LIMITED (429) with
 * `retryAfterSec`, as the HTTP render routes answer; the limiter logs the refusal itself.
 */
function chargePreviewRender(caller: StudioCaller, correlationId: string): void {
  const ctx: ReqCtx = { correlationId, route: "mcp:studio_template_preview", method: "MCP", source: "studio.templates.preview" };
  const limited = checkRenderRate(caller, ctx);
  if (!limited) return;
  const retryAfterSec = Number(limited.headers.get("Retry-After"));
  throw new StudioEngineError("RATE_LIMITED", "Too many render requests; retry later", Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? { retryAfterSec } : {});
}

/** Render the sample with a stored version or an unsaved definition and keep the files as preview outputs. */
export async function previewTemplate(input: TemplatePreviewInput, opts: TemplatePreviewOptions = {}): Promise<TemplatePreviewResult> {
  const cid = randomUUID();
  const t0 = Date.now();
  try {
    assertInputLimits(input);
    if (!isPlainObject(input as unknown)) schemaIssue("", "Badan permintaan harus objek");
    if ((input.slug === undefined) === (input.template === undefined)) schemaIssue("", "isi tepat satu dari slug atau template");
    const formats = previewFormats(input.formats);
    const lint = input.lint !== false;
    if (input.tier !== undefined && !tierOf(input.tier)) schemaIssue("/tier", `tier harus salah satu dari ${STUDIO_TIERS.join(", ")}`);
    // Row 70a: rate limit, then admission, before any ingest, render or write (a refusal keeps nothing).
    chargePreviewRender(opts.caller ?? localStudioCaller(null), cid);
    assertRenderCapacity();
    return await renderGate().run(() => renderAndKeep(input, formats, lint, cid, t0));
  } catch (err) {
    const contract = err instanceof StudioEngineError;
    templatesLog({
      level: contract ? "warn" : "error",
      message: "Pratinjau templat gagal",
      code: contract ? (templateErrorCode(err) ?? err.code) : "TEMPLATE_PREVIEW_FAILED",
      correlationId: cid,
      ...(contract ? {} : { stack_trace: err instanceof Error ? err.stack : undefined }),
      context: { slug: isPlainObject(input) ? (input.slug ?? null) : null, unsaved: isPlainObject(input) && input.template !== undefined, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

/** The admitted part of a preview: prepare, render, keep the files, then cap the kept previews. */
async function renderAndKeep(input: TemplatePreviewInput, formats: StudioOutputFormat[], lint: boolean, cid: string, t0: number): Promise<TemplatePreviewResult> {
  await ensureBuiltinTemplates();
  const prepared = input.template !== undefined ? await sideOfDefinition(input.template, input.base) : await sideOfStored(String(input.slug), input.version);
  const tier = tierOf(input.tier) ?? prepared.defaultTier;
  const language = sampleLanguageOf(prepared.side.tpl.params);
  const doc = swarmSampleDocument({ slug: prepared.template.slug ?? prepared.reference?.slug ?? DATUM_CANONICAL_SLUG, tier, slots: prepared.side.skeleton.skeleton.slots, language });
  // The render lint needs the HTML and its layout (U.1 step 3); only the requested files are kept.
  const renderFormats = lint && !formats.includes("HTML") ? [...formats, "HTML" as StudioOutputFormat] : formats;
  const out = await renderSample(prepared.side, doc, { tier, formats: renderFormats, timeoutMs: PREVIEW_RENDER_TIMEOUT_MS, correlationId: cid, jobId: `preview-${cid}` });
  if (!out.render) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", "Contoh pratinjau ditolak templat ini", { issues: (out.ingest.issues ?? []).slice(0, 20) });
  }
  const previewId = randomUUID();
  const files = await keepFiles(previewId, out.render.files.filter((f) => f.role === "PRIMARY" && formats.includes(f.format)), prepared.template.versionId, out.render.lint?.releaseStatus);
  const result: TemplatePreviewResult = {
    previewId,
    template: prepared.template,
    tier,
    language,
    sampleSha256: sampleSha256(doc),
    files,
    failed: out.render.failed.filter((f) => formats.includes(f)),
    errors: out.render.errors.map((e) => ({ code: e.code, ...(e.format ? { format: e.format } : {}) })),
    lint: lint && out.render.lint ? { tier: out.render.lint.tier, releaseStatus: out.render.lint.releaseStatus, checks: out.render.lint.checks.map((c) => ({ id: c.checkId, status: c.status, ...(c.detail ? { detail: c.detail.slice(0, 300) } : {}) })) } : null,
    durationMs: Date.now() - t0,
  };
  templatesLog({
    level: "info",
    message: "Pratinjau templat dirender",
    code: "TEMPLATE_PREVIEW_RENDERED",
    correlationId: cid,
    context: { previewId, template: prepared.template, tier, language, formats, files: files.length, failed: result.failed, releaseStatus: result.lint?.releaseStatus ?? null, durationMs: result.durationMs },
  });
  await capKeptPreviews(cid);
  return result;
}

/** Row 70a: keep at most PREVIEW_KEEP_MAX previews; a failed clean-up is logged and does not fail the preview. */
async function capKeptPreviews(cid: string): Promise<void> {
  try {
    const r = await studioStore().prunePreviewOutputs(PREVIEW_KEEP_MAX, { correlationId: cid });
    if (r.removedRows > 0) templatesLog({ level: "info", message: "Pratinjau lama dihapus", code: "TEMPLATE_PREVIEW_PRUNED", correlationId: cid, context: { keep: PREVIEW_KEEP_MAX, ...r } });
  } catch (err) {
    templatesLog({ level: "warn", message: "Pratinjau lama gagal dihapus", code: "TEMPLATE_PREVIEW_PRUNE_FAILED", correlationId: cid, stack_trace: err instanceof Error ? err.stack : undefined, context: { keep: PREVIEW_KEEP_MAX, error: err instanceof Error ? err.message : String(err) } });
  }
}

/** Files first, then rows (store §6.5): `tmp/preview/<uuid>/GSP Pratinjau Templat.<ext>`, kind 'preview'. */
async function keepFiles(
  previewId: string,
  files: ReadonlyArray<{ format: StudioOutputFormat; data: Uint8Array | string }>,
  templateVersionId: string | null,
  releaseStatus: string | undefined,
): Promise<TemplatePreviewFile[]> {
  const store = studioStore();
  const written = files.map((f) => {
    const bytes = typeof f.data === "string" ? new TextEncoder().encode(f.data) : f.data;
    const fileName = `${PREVIEW_FILE_BASE}.${EXT_OF[f.format]}`;
    const relPath = `tmp/preview/${previewId}/${fileName}`;
    store.writeOutputBytes(relPath, bytes);
    return { format: f.format, fileName, relPath, bytes: bytes.length, sha256: sha256Hex(bytes), mime: FORMAT_MIME[f.format] };
  });
  const verdict = releaseStatus === "PASS" || releaseStatus === "FAIL" || releaseStatus === "NOT_RUN" ? releaseStatus : "PENDING";
  return withStudioTx(async (tx) => {
    const out: TemplatePreviewFile[] = [];
    for (const w of written) {
      const row = await store.putOutput(tx, { kind: "preview", format: w.format as "DOCX" | "HTML" | "PDF", role: "PRIMARY", relPath: w.relPath, fileName: w.fileName, bytes: w.bytes, sha256: w.sha256, mime: w.mime, templateVersionId, lintVerdict: verdict });
      out.push({ outputId: row.id, ...w });
    }
    return out;
  });
}

// ── Guarded check (studio_template_check, spec §5.2: "unless guard:false") ─

export interface GuardedTemplateCheck {
  valid: boolean;
  code?: string;
  issues: unknown[];
  changedKeys?: number;
  guard: { verdict: TemplateGuardOutcome["verdict"]; report?: unknown; reason?: string } | null;
}

/** Form check + one guard run (`op: "check"`) against `base` or datum-kanonik. Saves nothing. */
export async function checkTemplateWithGuard(input: { template: unknown; base?: { slug: string; version?: number } }, guard: TemplateGuard | null = installedTemplateGuard()): Promise<GuardedTemplateCheck> {
  assertInputLimits(input);
  await ensureBuiltinTemplates();
  let prepared: PreparedSide;
  try {
    prepared = await sideOfDefinition(input?.template, input?.base);
  } catch (err) {
    if (!(err instanceof StudioEngineError) || err.code === "TEMPLATE_NOT_FOUND") throw err;
    const d = (err.details ?? {}) as { issues?: unknown[] };
    return { valid: false, code: templateErrorCode(err), issues: Array.isArray(d.issues) ? d.issues : [{ message: err.message }], guard: null };
  }
  const cand = prepared.candidate!;
  if (!guard) return { valid: false, code: "GUARD_UNAVAILABLE", issues: [{ message: "template guard not installed", reason: "GUARD_NOT_CONFIGURED" }], changedKeys: cand.changedKeys, guard: { verdict: "unavailable", reason: "GUARD_NOT_CONFIGURED" } };
  const out = await guard({
    op: "check",
    slug: prepared.reference!.slug,
    lintTier: cand.tier === "SERAH" ? "SERAH" : "TERBIT",
    reference: prepared.reference!,
    candidate: { definition: cand.definition, payload: cand.payload, skeleton: cand.skeleton, skeletonSha256: cand.skeletonSha256 },
    correlationId: randomUUID(),
  });
  if (out.verdict === "pass" || out.verdict === "warn") return { valid: true, issues: [], changedKeys: cand.changedKeys, guard: { verdict: out.verdict, report: out.report } };
  if (out.verdict === "reject") return { valid: false, code: "GUARD_REJECTED", issues: [], changedKeys: cand.changedKeys, guard: { verdict: "reject", report: out.report } };
  return { valid: false, code: "GUARD_UNAVAILABLE", issues: [], changedKeys: cand.changedKeys, guard: { verdict: "unavailable", reason: "reason" in out ? out.reason : "GUARD_INVALID_OUTCOME" } };
}
