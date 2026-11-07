/**
 * R01 `/api/studio/templates` (01_specs.md §6.2, S54; SR-61: register
 * 03_structural_sections_specs.md §12 R01, blueprint 05 §2.3/§2.11, D-163 T-1/T-2, D-166).
 *
 * GET  `?kind=&archived=0|1&preset=0|1`  -> 200 `{ templates: TemplateSummary[] }` (+ `isPreset`,
 *      `restricted`). `preset=1` = hanya preset gaya, `preset=0` = tanpa preset, tak diisi = semua
 *      (menggantikan usulan blueprint `?kind=preset`; deviasi diterima D-166).
 * POST v2 `{ slug, name, kind, description?, isPreset? (ADMIN), changeNote, template: StudioTemplateV2,
 *      expertMode? }` -> 201 `{ template, version, skeletonSha256 }`: preset + esensial + lanjutan
 *      (hanya ADMIN, D-163 T-1) + kerangka dalam SATU transaksi layanan (SR-07).
 * POST v1 datar `CreateTemplateInput` -> 201 `{ template, version }` (tetap; kunci non-esensial
 *      hanya ADMIN -> 403 PARAM_SURFACE_FORBIDDEN untuk pemanggil lain).
 * POST `?import=profile` + profil JSON   -> 201 `{ template, version }` (hanya ADMIN_SESSION;
 *      bentuk `benchmark/manual000/template.json`, S95)
 *
 * Galat: 400 SCHEMA_INVALID/JSON_MALFORMED/CHANGE_NOTE_REQUIRED/PARAM_CLASS_T_READONLY,
 * 403 PARAM_CLASS_K_FORBIDDEN (kunci kelas K) / PARAM_SURFACE_FORBIDDEN (lapis lanjutan/internal/
 * turunan) / FORBIDDEN (peran: impor atau preset baru non-ADMIN), 404 TEMPLATE_NOT_FOUND (preset v2),
 * 409 TEMPLATE_SLUG_EXISTS, 413 PAYLOAD_TOO_LARGE,
 * 422 PARAM_UNKNOWN_KEY/SLOT_PARAM_SCOPE_INVALID/SLOT_DUPLICATE.
 */
import type { NextRequest } from "../shims";
import { requireSession } from "../shims";
import { getStudioCaller } from "../shims";
import type { StudioCaller } from "@/lib/studio/contract/auth";
import { STUDIO_TEMPLATE_KINDS, type StudioTemplateKind } from "@/lib/studio/contract/enums";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import type { CreateTemplateInput, ValidationIssue } from "@/lib/studio/contract/types/api";
import type { ParamValue } from "@/lib/studio/contract/types/common";
import type { StudioTemplateV2 } from "@/lib/studio/contract/types/v2/template";
import { ESSENTIAL_FIELD_PATHS, isEssentialFieldPath } from "@/lib/studio/registry/essentials";
import {
  createTemplate,
  createTemplateV2,
  isAdminCaller,
  listTemplates,
  surfaceOfKey,
  type CreateTemplateV2Input,
  type TemplateListQueryV2,
} from "@/lib/studio/services/templates";
import { apiLog, failure, isPlainObject, issue, json, ptr, readJsonBody, reject, reqCtx, schemaInvalid, type ReqCtx } from "@/lib/studio/http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/studio/templates";
const SOURCE = "studio.api.templates";
const KIND_SET: ReadonlySet<string> = new Set(STUDIO_TEMPLATE_KINDS);
const BOOL_QUERY = ["0", "1", "true", "false"];
const TEMPLATE_V2_SCHEMA = "studio.template/v2";
const NAME_MAX = 200;
const DESCRIPTION_MAX = 4000;
const CHANGE_NOTE_MAX = 4000;

function boolQuery(v: string | null): boolean | undefined {
  if (v === null || v === "") return undefined;
  return v === "1" || v === "true";
}

export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE, SOURCE);

  const sp = new URL(req.url).searchParams;
  const kind = sp.get("kind");
  const archived = sp.get("archived");
  const preset = sp.get("preset");
  const issues: ValidationIssue[] = [];
  if (kind !== null && kind !== "" && !KIND_SET.has(kind)) {
    issues.push(issue("/query/kind", "enum", `kind must be one of ${STUDIO_TEMPLATE_KINDS.join(", ")}`));
  }
  if (archived !== null && archived !== "" && !BOOL_QUERY.includes(archived)) {
    issues.push(issue("/query/archived", "enum", "archived must be 0, 1, true or false"));
  }
  if (preset !== null && preset !== "" && !BOOL_QUERY.includes(preset)) {
    issues.push(issue("/query/preset", "enum", "preset must be 0 (exclude style presets) or 1 (style presets only)"));
  }
  if (issues.length) return schemaInvalid(issues, ctx);

  const q: TemplateListQueryV2 = {};
  if (kind) q.kind = kind as StudioTemplateKind;
  // Default spesifikasi `archived=0`: templat aktif saja.
  q.archived = boolQuery(archived) === true;
  const presetFilter = boolQuery(preset);
  if (presetFilter !== undefined) q.preset = presetFilter;

  try {
    const rows = await listTemplates(q);
    // Respons R01 SR-61: `isPreset` selalu boolean (penanda preset di daftar); filter diulang
    // di route sebagai pertahanan berlapis terhadap layanan.
    const templates = rows
      .map((t) => ({ ...t, isPreset: t.isPreset === true }))
      .filter((t) => presetFilter === undefined || t.isPreset === presetFilter);
    return json({ templates }, 200, ctx);
  } catch (e) {
    return failure(e, ctx, { op: "GET templates", context: { kind: q.kind ?? null, archived: q.archived, preset: presetFilter ?? null } });
  }
}

// Swarm port (row 31): only GET is ported. Template writes are the template tools of rows 63/66/68 (studio
// spec §5.3); the row 109 TemplateSource twin refuses them (FORBIDDEN, TEMPLATE_WRITE_NOT_AVAILABLE).
