/**
 * R08 `/api/studio/validate` (S55, 01_specs.md §6.2): dry-run TANPA tulis DB
 * maupun berkas.
 *
 * POST `StudioIngestRequest` atau `{ schemaId, spec }` (+ `?preview=html`)
 *   -> 200 `{ valid, issues, lint, previewHtml?, previewError? }`.
 * - Dokumen (`document`, atau `schemaId = studio.doc/v1`): ingest S48 dengan
 *   `dryRun: true` (skema, by-construction, normalisasi, lint ingest).
 * - Skema lain (chart/diagram/image/html): validasi skema saja, `lint: null`.
 * - Tidak sah = 200 `valid:false` (422 tidak dipakai); 400 hanya untuk JSON
 *   rusak; 413 badan terlalu besar; 403 FORBIDDEN templat terbatas (D-98).
 * - Pratinjau HTML (hanya dokumen sah): dari ingest bila tersedia, selain itu
 *   dirakit dari snapshot dry-run (S24 mode pratinjau, tanpa figur raster)
 *   tanpa menyentuh penyimpanan. Gagal pratinjau tidak menggagalkan validasi
 *   (`previewError`).
 * - IP-10 (F-028): medan opsional `roleFormats` (peta peran -> RoleFormat,
 *   format draf editor templat) di tingkat atas badan. Divalidasi seperti
 *   simpan versi (`validateRoleFormats` S49; tidak sah = `valid:false` dengan
 *   pointer `/roleFormats/...`), lalu ditimpakan per peran di atas
 *   `roleFormats` templat dokumen yang diresolusi dari DB; templat hasil itu
 *   dipakai dry-run ingest dan pratinjau. Tidak ada yang disimpan. Hanya
 *   berlaku untuk dokumen (`studio.doc/v1`).
 * - SR-20 (register 03 §12 R08): kiriman v2 `studio.doc/v2`,
 *   `studio.chapter/v2`, `studio.slot/v2`, baik di tingkat atas badan
 *   (`$schema`) maupun bentuk `{ schemaId, spec }`. Langkah: skema v2 (ajv +
 *   pemeta kontrak `classifySchemaV2Errors`: issue `checkId` DISPLAY_FIELD /
 *   V1_FIELD) -> bila sah dan `studio.doc/v2`, dry-run ingest SR-12 dengan
 *   kiriman tingkat atas apa adanya (struktur, by-construction, lint ingest;
 *   tanpa simpan, tanpa kunci) -> 200 `{ valid, issues, lint,
 *   completenessPreview?, previewHtml? }`. `completenessPreview` = medan
 *   `completeness` hasil dry-run. Pointer isu relatif badan permintaan
 *   (`/spec/...` untuk bentuk `{ schemaId, spec }`). `$schema` tingkat atas lain =
 *   `valid:false` pointer `/$schema`.
 * - FIX-V (IP-51, celah D-207): bab/slot v2 sah skema -> dry-run kiriman parsial
 *   layanan SR-13 (`dryRunChapter`/`dryRunSlot`: target, templat tersemat, gabung,
 *   cek dasar, compose, kelengkapan, gerbang by-construction BERSAMA) dalam transaksi
 *   READ ONLY tanpa kunci: tanpa baris baru, tanpa build (D-247). 200 `{ valid, issues,
 *   lint, completenessPreview (kelengkapan PASCA-GABUNG), submitPreview }`; pelanggaran
 *   (mis. 422 `BY_CONSTRUCTION_FAILED`, `SCOPE_CONFLICT`, `DOCUMENT_NOT_FOUND`) =
 *   `valid:false` dengan isu yang sama dengan kiriman nyata. `?preview=html` merakit
 *   HTML pratinjau snapshot pasca-gabung (penanda draf bila belum lengkap).
 * - FIX-V (FIX-U M5): medan opsional tingkat atas `draftTemplate` `{ template:
 *   StudioTemplateV2, base?: { slug, version? } }` untuk `studio.doc/v2` (pratinjau editor
 *   templat): draf diresolusi tanpa simpan (`_shared/template-draft`) lalu diteruskan ke
 *   ingest dryRun sebagai `template` + `skeleton`; HTML pratinjau norm/v2 dirakit perakit
 *   sadar slot (`_shared/preview-v2`) dengan nilai efektif per slot draf. Di luar
 *   `studio.doc/v2` = `valid:false` pointer `/draftTemplate`.
 * - Snapshot norm/v2 dari kiriman v1 (adaptor SR-09) kini juga mendapat HTML pratinjau
 *   v2 (sebelumnya `PREVIEW_UNAVAILABLE`).
 * - D-280 S2-03 (FIX-S2): SETIAP panggilan dihitung pembatas laju R08
 *   (`_shared/validate-rate`, pola dan helper sama dengan route kiriman FIX-1; ember
 *   terpisah, bawaan 120/menit per pemanggil) -> 429 `RATE_LIMITED` + `Retry-After`.
 *   `?preview=html` tetap juga dihitung pembatas laju render.
 * - SR-55b N2 / D-280 S2-01 (FIX-S2): `draftTemplate` hanya dipratinjau bila boleh disimpan
 *   pemanggil (hak tulis sama dengan simpan v2); selain itu `valid:false` dengan isu kode simpan.
 */
import type { NextRequest } from "../shims";
import {
  STUDIO_SCHEMA_IDS,
  STUDIO_ERROR_HTTP,
  isNormSnapshotV2,
  type NormDocSnapshot,
  type RenderContext,
  type ResolvedTemplate,
  type RoleFormatMap,
  type StudioCaller,
  type StudioIngestRequest,
  type ValidationIssue,
} from "@/lib/studio/contract";
import { getStudioCaller } from "../shims";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import { requireSession } from "../shims";
import { registerForSnapshot } from "@/lib/studio/engine/bind";
import { assembleHtml } from "@/lib/studio/engine/html/assemble";
import { ingestDocument, validateSchema, type IngestResultV2 } from "@/lib/studio/services/ingest";
import { resolveTemplate } from "@/lib/studio/services/templates";
import { apiLog, checkRenderRate, isRecord, json, readJsonBody, reqCtx, withQuotaHeaders, type ReqCtx } from "@/lib/studio/http";
import {
  attachPreview,
  buildPreviewV2,
  draftRoleFormats,
  draftTemplateMisplaced,
  isUserError,
  v2RoleFormatsIssue,
  validateV2Submission,
  withoutDraftFields,
  type ValidateBody,
} from "./validate-dry-run";
import { S55_BODY_OPTIONS, bodyAgentId, failFrom } from "../route-kit";
import { issuesFromError } from "./error-issues";
import { checkValidateRate } from "./validate-rate";
import { asCompletenessReport, isV2SubmissionSchema, schemaRootOf } from "@/app/api/studio/validate/_shared/v2-kit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "/api/studio/validate";

function isSchemaForm(b: Record<string, unknown>): b is { schemaId: string; spec: unknown; agentId?: unknown } {
  return typeof b.schemaId === "string" && "spec" in b && !("document" in b);
}

// ── IP-10: roleFormats draf ─────────────────────────────────────────────

/**
 * Templat dokumen dari DB dengan `roleFormats` draf ditimpakan per peran.
 * `undefined` bila dokumen tidak menyebut templat yang dapat diresolusi:
 * ingest lalu melaporkan isunya sendiri (TEMPLATE_NOT_FOUND / skema).
 */
async function draftTemplate(doc: unknown, roles: RoleFormatMap): Promise<ResolvedTemplate | undefined> {
  if (!isRecord(doc) || !isRecord(doc.template) || typeof doc.template.slug !== "string" || !doc.template.slug) return undefined;
  const version = typeof doc.template.version === "number" ? doc.template.version : undefined;
  try {
    const tpl = await resolveTemplate(doc.template.slug, version);
    return { ...tpl, roleFormats: { ...tpl.roleFormats, ...roles } };
  } catch (err) {
    if (err instanceof StudioEngineError && STUDIO_ERROR_HTTP[err.code] < 500) return undefined;
    throw err;
  }
}

async function buildPreview(snapshot: NormDocSnapshot, ctx: ReqCtx, draftTpl?: ResolvedTemplate): Promise<string> {
  const doc = snapshot.doc;
  const tpl = draftTpl ?? (await resolveTemplate(doc.template.slug, doc.template.version));
  const rctx: RenderContext = {
    snapshot,
    tpl,
    register: registerForSnapshot(snapshot),
    fixedDate: doc.meta.issueDate,
    figures: { get: () => undefined },
    log: (e) => {
      if (e.level === "error" || e.level === "warn") {
        apiLog({ ...ctx, level: e.level, message: `preview: ${e.message}`, code: "PREVIEW_RENDER_LOG" });
      }
    },
  };
  return assembleHtml(rctx, { preview: true });
}

async function validateDocument(
  ingestReq: StudioIngestRequest,
  caller: StudioCaller,
  wantPreview: boolean,
  ctx: ReqCtx,
  draftTpl?: ResolvedTemplate,
): Promise<ValidateBody> {
  let result: IngestResultV2;
  try {
    result = await ingestDocument(ingestReq, caller, { dryRun: true, ...(draftTpl ? { template: draftTpl } : {}) });
  } catch (err) {
    if (!isUserError(err)) throw err;
    apiLog({ ...ctx, level: "info", message: `dry-run rejected: ${err.message}`, code: err.code });
    return { valid: false, issues: issuesFromError(err), lint: null };
  }
  const out: ValidateBody = { valid: result.valid, issues: result.issues ?? [], lint: result.lint ?? null };
  // SR-20: v1 lewat adaptor SR-12 juga membawa pratinjau kelengkapan.
  const completeness = asCompletenessReport(result.completeness);
  if (completeness) out.completenessPreview = completeness;
  if (!wantPreview || !result.valid) return out;

  if (typeof result.previewHtml === "string") {
    out.previewHtml = result.previewHtml;
    return out;
  }
  if (!result.snapshot) {
    out.previewError = { code: "PREVIEW_UNAVAILABLE", message: "ingest returned no snapshot for preview" };
    return out;
  }
  const snapshot = result.snapshot;
  if (isNormSnapshotV2(snapshot)) {
    // FIX-V: v1 lewat adaptor SR-09 menghasilkan norm/v2 -> perakit sadar slot (draf roleFormats ikut).
    await attachPreview(out, () => buildPreviewV2(snapshot, ctx, { ...(draftTpl ? { tpl: draftTpl } : {}), draft: false }), ctx);
    return out;
  }
  await attachPreview(out, () => buildPreview(snapshot, ctx, draftTpl), ctx);
  return out;
}

export async function POST(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE);
  // DC-19 (QH-03): header kuota pada respons apa pun sesudah tagihan bucket; tanpa tagihan = tanpa header.
  return withQuotaHeaders(ctx, () => postValidate(req, ctx));
}

async function postValidate(req: NextRequest, ctx: ReqCtx): Promise<Response> {
  const body = await readJsonBody(req, ctx, S55_BODY_OPTIONS);
  if (!body.ok) return body.response;

  try {
    const caller = await getStudioCaller(req, bodyAgentId(body.value));
    // D-280 S2-03: setiap dry-run R08 (transaksi READ ONLY + lint penuh) dibatasi per pemanggil.
    const limitedValidate = checkValidateRate(caller, ctx);
    if (limitedValidate) return limitedValidate;
    const wantPreview = new URL(req.url).searchParams.get("preview") === "html";
    if (wantPreview) {
      // FIX-1 (S87 M-03): pratinjau HTML = perakitan berat; dihitung pembatas laju render.
      const limited = checkRenderRate(caller, ctx);
      if (limited) return limited;
    }
    const raw = body.value;

    if (!isRecord(raw)) {
      const res: ValidateBody = { valid: false, issues: [{ pointer: "", keyword: "type", message: "must be object" }], lint: null };
      return json(res, 200, ctx);
    }
    const roles = draftRoleFormats(raw);
    const draftRaw = raw.draftTemplate === undefined || raw.draftTemplate === null ? undefined : raw.draftTemplate;
    const b = roles.present || "draftTemplate" in raw ? withoutDraftFields(raw) : raw;

    const root = schemaRootOf(b);

    let res: ValidateBody;
    if (roles.present && roles.issues.length > 0) {
      res = { valid: false, issues: roles.issues, lint: null };
    } else if (root !== null) {
      // SR-20: kiriman v2 di tingkat atas badan (`$schema`).
      if (roles.present) res = v2RoleFormatsIssue();
      else if (root === "other") {
        res = {
          valid: false,
          issues: [{ pointer: "/$schema", keyword: "enum", message: `$schema must be one of studio.doc/v2, studio.chapter/v2, studio.slot/v2 (or absent for a v1 StudioIngestRequest)` }],
          lint: null,
        };
      } else res = await validateV2Submission(root, b, b.agentId, caller, wantPreview, "", ctx, draftRaw);
    } else if (roles.present && isSchemaForm(b) && b.schemaId !== "studio.doc/v1") {
      res = {
        valid: false,
        issues: [{ pointer: "/roleFormats", keyword: "not", message: "roleFormats only applies to studio.doc/v1 documents" }],
        lint: null,
      };
    } else if (isSchemaForm(b)) {
      const schemaId = b.schemaId;
      if (!(STUDIO_SCHEMA_IDS as readonly string[]).includes(schemaId)) {
        res = {
          valid: false,
          issues: [{ pointer: "/schemaId", keyword: "enum", message: `schemaId must be one of ${STUDIO_SCHEMA_IDS.join(", ")}` }],
          lint: null,
        };
      } else if (isV2SubmissionSchema(schemaId)) {
        res = await validateV2Submission(schemaId, b.spec, b.agentId, caller, wantPreview, "/spec", ctx, draftRaw);
      } else if (draftRaw !== undefined) {
        res = draftTemplateMisplaced();
      } else if (schemaId === "studio.doc/v1") {
        const ingestReq = { document: b.spec, ...(typeof b.agentId === "string" ? { agentId: b.agentId } : {}) } as unknown as StudioIngestRequest;
        const draftTpl = roles.present ? await draftTemplate(b.spec, roles.roleFormats) : undefined;
        res = await validateDocument(ingestReq, caller, wantPreview, ctx, draftTpl);
      } else {
        let issues: ValidationIssue[];
        try {
          issues = validateSchema(schemaId, b.spec);
        } catch (err) {
          if (!isUserError(err)) throw err;
          issues = issuesFromError(err);
        }
        res = { valid: issues.length === 0, issues, lint: null };
      }
    } else if (draftRaw !== undefined) {
      res = draftTemplateMisplaced();
    } else {
      const draftTpl = roles.present ? await draftTemplate(b.document, roles.roleFormats) : undefined;
      res = await validateDocument(b as unknown as StudioIngestRequest, caller, wantPreview, ctx, draftTpl);
    }
    if (roles.present) {
      apiLog({
        ...ctx,
        level: "info",
        message: "dry-run with draft roleFormats",
        code: "DRAFT_ROLE_FORMATS",
        context: { roles: Object.keys(roles.roleFormats).length, issues: roles.issues.length, valid: res.valid },
      });
    }
    return json(res, 200, ctx);
  } catch (err) {
    return failFrom(err, ctx);
  }
}
