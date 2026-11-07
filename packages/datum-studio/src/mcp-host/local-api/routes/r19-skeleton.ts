/**
 * R19 `/api/studio/templates/[id]/skeleton` (SR-26; register 03_structural_sections_specs §12,
 * blueprint 05 §2.3 + §2.11).
 *
 * GET  `?version=n` -> 200 `{ template, versionNo, skeleton: StudioSkeletonV1, skeletonSha256,
 *      implicit, essentials: { global, bySlot }, advancedIncluded }`. Lapis lanjutan dan
 *      roleFormats slot hanya untuk ADMIN (D-163 T-1); selain ADMIN, medan yang dibuka kenop
 *      esensial (`ESSENTIAL_FIELD_PATHS`, D-170) tetap tampil sebagai proyeksi di `essentials`.
 * POST `StudioSkeletonV1 & { baseVersionNo, changeNote, expertMode? }` -> 201
 *      `{ version, skeletonSha256 }`. Simpan = versi baru dengan parameter tingkat templat
 *      SAMA (preset, esensial, lanjutan, roleFormats versi terbaru dibawa apa adanya); hanya
 *      kerangka yang diganti. UI menyimpan esensial + kerangka sekaligus lewat R02 (D-163 T-2);
 *      R19 tetap untuk kerangka saja.
 *
 * Izin per kunci yang BERUBAH (D-134, §13.5 1-7), aturan per kenop (D-170/D-171), pembawaan
 * lapis tersembunyi untuk non-ADMIN, VERSION_CONFLICT, dan tulis satu transaksi ditegakkan
 * layanan templat v2 (SR-07 `createTemplateVersionV2`). Route hanya memvalidasi bentuk badan
 * dan memetakan pointer galat layanan (`/template/skeleton/...`) ke badan R19 (`/...`).
 *
 * Galat: 400 SCHEMA_INVALID (SKELETON_*)/JSON_MALFORMED/CHANGE_NOTE_REQUIRED/PARAM_CLASS_T_READONLY,
 * 403 PRESET_READONLY/PARAM_SURFACE_FORBIDDEN/PARAM_CLASS_K_FORBIDDEN/FORBIDDEN,
 * 404 TEMPLATE_NOT_FOUND, 409 VERSION_CONFLICT, 413 PAYLOAD_TOO_LARGE,
 * 422 SLOT_PARAM_SCOPE_INVALID/SLOT_DUPLICATE/PARAM_UNKNOWN_KEY.
 */
import type { NextRequest } from "../shims";
import { requireSession } from "../shims";
import { getStudioCaller } from "../shims";
import { StudioEngineError, isStudioEngineError } from "@/lib/studio/contract/errors";
import type { ValidationIssue } from "@/lib/studio/contract/types/api";
import type { ParamValue } from "@/lib/studio/contract/types/common";
import type { StudioSkeletonV1, StudioTemplateV2, TemplateSlotDef } from "@/lib/studio/contract/types/v2/template";
import { apiLog, failure, isPlainObject, issue, json, positiveIntParam, readJsonObject, reject, reqCtx, schemaInvalid } from "@/lib/studio/http";
import { validateAgainst } from "@/lib/studio/services/ingest/validate";
import { getTemplateSkeleton } from "@/lib/studio/services/skeleton";
import {
  createTemplateVersionV2,
  essentialProjection,
  getTemplate,
  getTemplateV2,
  isAdminCaller,
  splitBySurface,
  type TemplateDetailV2,
} from "@/lib/studio/services/templates";

export const dynamic = "force-dynamic";

const ROUTE = "/api/studio/templates/[id]/skeleton";
const SOURCE = "studio.api.templates.skeleton";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SKELETON_SCHEMA_ID = "studio.skeleton/v1";
/** Prefiks pointer galat layanan templat v2 untuk kerangka; badan R19 = kerangka itu sendiri. */
const SERVICE_SKELETON_POINTER = "/template/skeleton";

type RouteCtx = { params: Promise<{ id: string }> };
type ParamRecord = Record<string, ParamValue>;

interface SkeletonSaveBody {
  skeleton: StudioSkeletonV1;
  baseVersionNo: number;
  changeNote: string;
  expertMode?: boolean;
}

type ParsedBody = { ok: true; value: SkeletonSaveBody } | { ok: false; issues: ValidationIssue[] } | { ok: false; changeNoteMissing: true };

/**
 * Pisahkan tiga medan amplop (marker 05 §3: `additionalProperties: false` pada skema) lalu
 * validasi `studio.skeleton/v1`. Urutan: bentuk (400 SCHEMA_INVALID) -> catatan perubahan
 * (400 CHANGE_NOTE_REQUIRED). Aturan SKELETON_* dan kunci parameter = layanan.
 */
function parseBody(body: Record<string, unknown>): ParsedBody {
  const { baseVersionNo, changeNote, expertMode, ...skeleton } = body;
  const issues: ValidationIssue[] = validateAgainst(SKELETON_SCHEMA_ID, skeleton);
  if (typeof baseVersionNo !== "number" || !Number.isInteger(baseVersionNo) || baseVersionNo < 1) {
    issues.push(issue("/baseVersionNo", "type", "baseVersionNo wajib bilangan bulat >= 1 (versi terbaru yang dimuat)"));
  }
  if (expertMode !== undefined && typeof expertMode !== "boolean") {
    issues.push(issue("/expertMode", "type", "expertMode harus boolean"));
  }
  if (changeNote !== undefined && typeof changeNote !== "string") {
    issues.push(issue("/changeNote", "type", "changeNote harus teks"));
  }
  if (issues.length > 0) return { ok: false, issues };
  if (typeof changeNote !== "string" || changeNote.trim().length === 0) return { ok: false, changeNoteMissing: true };
  return {
    ok: true,
    value: {
      skeleton: skeleton as unknown as StudioSkeletonV1,
      baseVersionNo: baseVersionNo as number,
      changeNote,
      ...(expertMode !== undefined ? { expertMode: expertMode as boolean } : {}),
    },
  };
}

/**
 * Templat v2 = parameter tingkat templat versi terbaru apa adanya + kerangka baru.
 * Versi lama tanpa kerangka eksplisit (`definition` null): lapis override dipisah per lapis
 * registri; tanpa preset (layanan menuntut preset kecuali templat itu preset gaya).
 */
function templateWithSkeleton(current: TemplateDetailV2, slots: TemplateSlotDef[]): StudioTemplateV2 {
  if (current.definition) return { ...current.definition, skeleton: { slots } };
  const { essentials, advanced } = splitBySurface(current.version.overrides as ParamRecord);
  return {
    $schema: "studio.template/v2",
    essentials,
    ...(Object.keys(advanced).length > 0 ? { advanced } : {}),
    skeleton: { slots },
  };
}

function rebasePointer(p: unknown): unknown {
  if (typeof p !== "string" || !p.startsWith(SERVICE_SKELETON_POINTER)) return p;
  return p.slice(SERVICE_SKELETON_POINTER.length);
}

function rebaseEntries(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v.map((e) => (isPlainObject(e) && "pointer" in e ? { ...e, pointer: rebasePointer(e.pointer) } : e));
}

/** Petakan pointer `details` galat layanan (`issues[]`, `items[]`) ke badan R19. */
function rebaseServiceError(e: unknown): unknown {
  if (!isStudioEngineError(e) || e.details === undefined) return e;
  let details: unknown = e.details;
  if (Array.isArray(details)) details = rebaseEntries(details);
  else if (isPlainObject(details)) {
    const d: Record<string, unknown> = { ...details };
    if ("issues" in d) d.issues = rebaseEntries(d.issues);
    if ("items" in d) d.items = rebaseEntries(d.items);
    if ("pointer" in d) d.pointer = rebasePointer(d.pointer);
    details = d;
  } else return e;
  const out = new StudioEngineError(e.code, e.message, details);
  out.stack = e.stack;
  return out;
}

/**
 * Tampilan slot untuk pemanggil: ADMIN melihat semua lapis; selain itu lanjutan dan
 * roleFormats dipangkas, medan kenop esensial di kunci lanjutan diproyeksikan ke `essentials`.
 */
function visibleSlot(slot: TemplateSlotDef, admin: boolean): TemplateSlotDef {
  if (admin) return slot;
  const { advanced, roleFormats: _hidden, ...rest } = slot;
  void _hidden;
  const essentials: ParamRecord = { ...rest.essentials };
  for (const [key, value] of Object.entries(advanced ?? {})) {
    const projected = essentialProjection(key, value);
    if (projected) essentials[key] = projected;
  }
  return { ...rest, essentials };
}

export async function GET(req: NextRequest, { params }: RouteCtx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE, SOURCE);

  const { id } = await params;
  if (!ID_PATTERN.test(id)) {
    return reject(ctx, "TEMPLATE_NOT_FOUND", "Template not found");
  }
  const versionNo = positiveIntParam(new URL(req.url).searchParams.get("version"));
  if (Number.isNaN(versionNo)) {
    return schemaInvalid([issue("/query/version", "type", "version must be a positive integer")], ctx);
  }

  try {
    const caller = await getStudioCaller(req);
    const admin = isAdminCaller(caller);
    const [view, detail] = await Promise.all([getTemplateSkeleton(id, versionNo ?? undefined), getTemplate(id, versionNo ?? undefined)]);
    return json(
      {
        template: detail.template,
        versionNo: view.versionNo,
        skeleton: { $schema: view.skeleton.$schema, slots: view.skeleton.slots.map((s) => visibleSlot(s, admin)) },
        skeletonSha256: view.skeletonSha256,
        implicit: view.implicit,
        essentials: view.essentials,
        advancedIncluded: admin,
      },
      200,
      ctx,
    );
  } catch (e) {
    return failure(e, ctx, { op: "GET template skeleton", context: { templateId: id, versionNo } });
  }
}

// Swarm port (row 31): only GET is ported. Template writes are the template tools of rows 63/66/68 (studio
// spec §5.3); the row 109 TemplateSource twin refuses them (FORBIDDEN, TEMPLATE_WRITE_NOT_AVAILABLE).
