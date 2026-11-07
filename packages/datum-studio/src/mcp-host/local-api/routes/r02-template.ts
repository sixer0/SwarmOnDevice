/**
 * R02 `/api/studio/templates/[id]` (01_specs.md §6.2, D-24 butir 2, S54; SR-61: register
 * 03_structural_sections_specs.md §12 R02, blueprint 05 §2.3/§2.11, D-163 T-1/T-2).
 *
 * GET   `?version=n&expert=0|1` -> 200 `{ template, version, versions: VersionSummary[],
 *       definition: StudioTemplateV2 | null, skeletonSha256, implicit, advancedIncluded }`.
 *       Non-ADMIN: `definition` hanya preset + esensial (+ kerangka dengan esensial slot);
 *       lanjutan dan roleFormats (templat, slot, `version.roleFormats`) hanya ADMIN;
 *       `version.overrides` dipangkas ke kunci esensial; `resolvedParams` (nilai efektif,
 *       baca saja) tetap untuk pratinjau. `expert=1` tidak membuka lanjutan bagi USER (D-163 T-1).
 * POST  v2 `{ baseVersionNo, changeNote, template: StudioTemplateV2, expertMode? }` -> 201
 *       `{ template, version, skeletonSha256 }`: SATU paket gabungan preset + esensial +
 *       lanjutan (ADMIN) + kerangka = SATU versi (D-163 T-2), satu transaksi layanan (SR-07).
 * POST  v1 datar `CreateTemplateVersionInput` (simpan = versi baru) -> 201 `{ version }`: tetap,
 *       HANYA ADMIN (non-ADMIN 403 FORBIDDEN `V1_FLAT_ADMIN_ONLY`).
 * PATCH alias POST: templat tak berubah, setiap suntingan menjadi versi baru.
 *
 * Galat: 400 SCHEMA_INVALID/JSON_MALFORMED/CHANGE_NOTE_REQUIRED/PARAM_CLASS_T_READONLY,
 * 403 PRESET_READONLY (versi preset gaya oleh non-ADMIN) / PARAM_SURFACE_FORBIDDEN (lapis
 * lanjutan/internal/turunan) / PARAM_CLASS_K_FORBIDDEN (kunci kelas K yang berubah) /
 * FORBIDDEN (peran: ubah profil kanonik atau templat terbatas non-ADMIN, v1 datar non-ADMIN),
 * 404 TEMPLATE_NOT_FOUND, 409 VERSION_CONFLICT, 413 PAYLOAD_TOO_LARGE,
 * 422 PARAM_UNKNOWN_KEY/SLOT_PARAM_SCOPE_INVALID/SLOT_DUPLICATE.
 */
import type { NextRequest } from "../shims";
import { requireSession } from "../shims";
import { getStudioCaller } from "../shims";
import type { StudioCaller } from "@/lib/studio/contract/auth";
import type { ValidationIssue } from "@/lib/studio/contract/types/api";
import type { StudioTemplateV2, TemplateSlotDef } from "@/lib/studio/contract/types/v2/template";
import {
  createTemplateVersion,
  createTemplateVersionV2,
  getTemplateV2,
  isAdminCaller,
  type CreateTemplateVersionV2Input,
  type TemplateDetailV2,
} from "@/lib/studio/services/templates";
import {
  apiLog,
  failure,
  isPlainObject,
  issue,
  json,
  positiveIntParam,
  readJsonBody,
  reject,
  reqCtx,
  schemaInvalid,
  type ReqCtx,
} from "@/lib/studio/http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/studio/templates/[id]";
const SOURCE = "studio.api.templates.id";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BOOL_QUERY = ["0", "1", "true", "false"];
const TEMPLATE_V2_SCHEMA = "studio.template/v2";
const CHANGE_NOTE_MAX = 4000;

type RouteCtx = { params: Promise<{ id: string }> };

/** Slot kerangka tanpa lapis lanjutan dan roleFormats (pemanggil non-ADMIN). */
function essentialSlot(slot: TemplateSlotDef): TemplateSlotDef {
  const { advanced: _advanced, roleFormats: _roleFormats, ...rest } = slot;
  void _advanced;
  void _roleFormats;
  return rest;
}

/**
 * Proyeksi respons GET untuk non-ADMIN (PT-07, D-163 T-1): definisi hanya preset + esensial
 * (+ kerangka berisi esensial slot); `version.roleFormats` dikosongkan. Layanan SR-07 sudah
 * memangkas lanjutan (`includeAdvanced: false`); proyeksi ini pertahanan berlapis yang idempoten.
 */
function projectForNonAdmin(detail: TemplateDetailV2): TemplateDetailV2 {
  let definition: StudioTemplateV2 | null = null;
  if (detail.definition) {
    const { advanced: _advanced, roleFormats: _roleFormats, skeleton, ...head } = detail.definition;
    void _advanced;
    void _roleFormats;
    definition = { ...head, skeleton: { slots: (skeleton?.slots ?? []).map(essentialSlot) } };
  }
  return { ...detail, version: { ...detail.version, roleFormats: {} }, definition, advancedIncluded: false };
}

export async function GET(req: NextRequest, { params }: RouteCtx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE, SOURCE);

  const { id } = await params;
  if (!ID_PATTERN.test(id)) {
    return reject(ctx, "TEMPLATE_NOT_FOUND", "Template not found");
  }
  const sp = new URL(req.url).searchParams;
  const versionNo = positiveIntParam(sp.get("version"));
  const issues: ValidationIssue[] = [];
  if (Number.isNaN(versionNo)) issues.push(issue("/query/version", "type", "version must be a positive integer"));
  const expert = sp.get("expert");
  if (expert !== null && expert !== "" && !BOOL_QUERY.includes(expert)) {
    issues.push(issue("/query/expert", "enum", "expert must be 0, 1, true or false"));
  }
  if (issues.length) return schemaInvalid(issues, ctx);

  let admin = false;
  try {
    const caller = await getStudioCaller(req);
    admin = isAdminCaller(caller);
    // Lanjutan + roleFormats hanya ADMIN; `expert=1` USER diterima tetapi tidak membuka lapis (D-163 T-1).
    const detail = await getTemplateV2(id, versionNo ?? undefined, { includeAdvanced: admin });
    return json(admin ? detail : projectForNonAdmin(detail), 200, ctx);
  } catch (e) {
    return failure(e, ctx, { op: "GET template", context: { templateId: id, versionNo, admin, expertRequested: expert === "1" || expert === "true" } });
  }
}

// Swarm port (row 31): only GET is ported. Template writes are the template tools of rows 63/66/68 (studio
// spec §5.3); the row 109 TemplateSource twin refuses them (FORBIDDEN, TEMPLATE_WRITE_NOT_AVAILABLE).
