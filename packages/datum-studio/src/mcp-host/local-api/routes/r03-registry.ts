/**
 * R03 `/api/studio/registry` (01_specs.md §6.2, S54; register 03_structural_sections_specs §12 R03, SR-27) — registri hanya-baca.
 *
 * GET `?kind=`
 *   sections    -> 51 jenis section (§5.2)
 *   params      -> 743 parameter (685 katalog + 37 renderer + 21 struktur) dengan kelas, rentang,
 *                  grup, bab, cakupan, lapis; filter opsional `class=B|K|T`, `group=`, `chapter=`,
 *                  `origin=catalog|contract`, `surface=essential|advanced|derived|internal`
 *   charts      -> 76 jenis chart (§5.3)
 *   diagram     -> 9 keluarga diagram + tata letak efektif (§8.3)
 *   symbols     -> 41 simbol (S31)
 *   lint        -> pemeriksaan lint (§5.4)
 *   roles       -> 76 kunci peran format (§5.6; +6 peran toc.section dan toc.appendix, D-355)
 *   presets     -> templat `isPreset` aktif (DB) + status terbatas D-98 dari versi terbaru
 *   essentials  -> 30 kenop esensial berlabel awam (D-165/D-168): `items` datar + `global` +
 *                  `bySectionType` (setiap C33 sectionType, <= 8 per kelompok) + medan esensial
 *                  `ESSENTIAL_FIELD_PATHS` (D-171)
 *   slots       -> 8 jenis slot C33 + aturan mode/berulang/admits + kelompok shared C32a
 *   paramScopes -> cakupan + lapis setiap kunci (aturan `PARAM_SCOPE` disertakan); filter opsional
 *                  `scopeKind=document|section|shared|slot`, `surface=`, `sectionType=` (kunci yang
 *                  boleh di slot sectionType itu dengan `admits` bawaan)
 *   schema      -> dokumen JSON Schema `schemaId=` salah satu STUDIO_SCHEMA_IDS (v1 + SID01-SID05)
 *                  atau `common/v1` | `common/v2` (agar `$ref` skema v2 dapat diselesaikan klien, D-172)
 *                  (`application/schema+json`; `download=1` -> lampiran berkas)
 *   contracts   -> jenis kontrak aktif C58 (`ContractKindDefV2`, register 05 §9.4, AM-07; tahap 1 =
 *                  agentWorkReport): kerangka, outline wajib, set status, vonis, status butir, rel
 *                  rujukan, jenis bukti, pola, batas, label, alias, format bawaan. Tanpa parameter
 *                  lain (400 SCHEMA_INVALID `/query/<nama>`); jenis dicadangkan tidak dicantumkan
 *                  Setiap butir memuat `examples` (U-03, D-419): badan `record` + `chapters["1".."5"]` siap salin
 * Respons: 200 `{ kind, count, items, meta? }` (essentials menambah `global`, `bySectionType`);
 * galat 400 REGISTRY_KIND_UNKNOWN (kind/filter tidak dikenal); `details` selalu larik isu (01 §6.2).
 * `kind` absen atau tak dikenal (U-07, R2-F1 D-426): satu isu
 * `{ pointer: "/query/kind", keyword, message, received, validKinds, examples }`; filter tak dikenal:
 * isu berpointer `/query/<nama>`.
 */
import type { NextRequest } from "../shims";
import { requireSession } from "../shims";
import { STUDIO_JSON_SCHEMAS, commonV2Schema } from "@/lib/studio/contract";
import {
  DIAGRAM_FAMILIES,
  PARAM_SCOPE_KINDS,
  PARAM_SURFACES,
  ROLE_KEYS,
  STUDIO_SLOT_CONTENT_MODES,
  SYMBOL_DIALECTS,
} from "@/lib/studio/contract/enums";
import { STUDIO_SCHEMA_IDS } from "@/lib/studio/contract/env";
import { commonSchema } from "@/lib/studio/contract/schema/common.schema";
import { REGISTRY_KINDS, type RegistryKind } from "@/lib/studio/contract/types/api";
import { SYMBOL_IDS } from "@/lib/studio/engine/symbols";
import {
  ALL_PARAM_COUNT,
  ALL_PARAMS,
  CATALOG_PARAM_COUNT,
  RENDER_PARAM_COUNT,
  STRUCTURE_PARAM_COUNT,
  type ScopedParamDef,
} from "@/lib/studio/params";
import {
  CHART_REGISTRY,
  ESSENTIAL_FIELD_PATHS,
  ESSENTIAL_KNOB_COUNT,
  ESSENTIAL_KNOBS,
  ESSENTIAL_MAX_PER_GROUP,
  ESSENTIAL_MAX_TOTAL,
  LINT_REGISTRY,
  PAGE_DEVICE_SECTION_TYPES,
  PARAM_SCOPE,
  SECTION_REGISTRY,
  SECTION_REGISTRY_VERSION,
  SHARED_PARAM_GROUP_MEMBERS,
  SLOT_KIND_BY_TYPE,
  SLOT_KINDS,
  SLOT_SECTION_TYPES,
  essentialKnobsFor,
  isScopeAllowedInSlot,
  parseParamScope,
  type EssentialKnobSpec,
} from "@/lib/studio/registry";
import { templateRestriction } from "@/lib/studio/services/templates/access";
import { listTemplates } from "@/lib/studio/services/templates";
import { presetTemplates } from "../db";
import { CONTRACT_KIND_DEFS } from "@/lib/studio/registry/contracts";
import { VEGA_CHART_REGISTRY, type VegaChartCodeDef } from "@/lib/studio/registry/charts";
import { VEGA_CHART_SCHEMA, vegaChartInputSchema } from "@/lib/studio/engine/chart/family-v/input";
import { apiLog, failure, issue, json, reject, reqCtx, schemaInvalid, withCorrelation, type ReqCtx } from "@/lib/studio/http";

export const dynamic = "force-dynamic";

const ROUTE = "/api/studio/registry";
const SOURCE = "studio.api.registry";
const KINDS: readonly RegistryKind[] = REGISTRY_KINDS;
type ListKind = Exclude<RegistryKind, "params" | "schema" | "presets" | "essentials" | "slots" | "paramScopes" | "contracts">;

const SCHEMA_DOCS: Readonly<Record<string, unknown>> = {
  ...STUDIO_JSON_SCHEMAS,
  "common/v1": commonSchema,
  "common/v2": commonV2Schema,
};
const SCHEMA_IDS: readonly string[] = [...STUDIO_SCHEMA_IDS, "common/v1", "common/v2"];

/** Registri statis per build: boleh di-cache privat singkat. */
const CACHE = { "Cache-Control": "private, max-age=300" };
/** Preset = isi DB (berubah lewat seed/ADMIN): tanpa cache. */
const NO_CACHE = { "Cache-Control": "no-store" };

/** stack/topology memakai tata letak layered (§8.3 D01). */
const DIAGRAM_LAYOUT_ALIAS: Readonly<Record<string, string>> = { stack: "layered", topology: "layered" };

// ── Row 163b (C155): the Vega chart family in the agent catalog (studio_registry kind=charts -> meta.vega) ──────────
// A document chart block `{ type: "chart", code, data, highlight?, options?, unit?, dec?, note?, caption, source }` with
// code V-01..V-08 (or the DF code in `replaces`) renders through the Vega family. `data` and `options` below are the
// exact closed JSON Schemas the family validates with ajv (engine/chart/family-v/input.ts); agents send data and these
// options only, never Vega, colours, fonts, field names or URLs.

const VEGA_HIGHLIGHT: Readonly<Record<VegaChartCodeDef, string>> = {
  "V-01": "one date (YYYY-MM-DD)",
  "V-02": "one series name",
  "V-03": "one row name",
  "V-04": "one group name",
  "V-05": "one category label",
  "V-06": "one series name",
  "V-07": "one node id",
  "V-08": "one node id",
};

const VEGA_EXAMPLE_DATA: Readonly<Record<VegaChartCodeDef, { data: unknown; highlight?: string[]; options?: Record<string, unknown> }>> = {
  "V-01": { data: { shape: "days", days: [{ date: "2026-01-01", value: 4 }, { date: "2026-01-02", value: 7 }] }, options: { weekStart: "monday" } },
  "V-02": { data: { shape: "series", categories: ["Jan", "Feb", "Mar"], series: [{ name: "Telepon", values: [20, 26, 31] }, { name: "Aplikasi", values: [30, 44, 52] }] }, highlight: ["Aplikasi"], options: { offset: "center" } },
  "V-03": { data: { shape: "matrix", rows: ["Wilayah A", "Wilayah B"], cols: ["Respons", "Tuntas", "Biaya"], values: [[62, 70, 41], [48, 81, 55]] }, highlight: ["Wilayah B"] },
  "V-04": { data: { shape: "distribution", groups: [{ name: "Unit utara", values: [3, 8, 12, 15, 21] }, { name: "Unit selatan", values: [5, 9, 18, 26, 40] }] }, highlight: ["Unit selatan"] },
  "V-05": { data: { shape: "categorical", points: [{ label: "Banjir", value: 42 }, { label: "Longsor", value: 25 }, { label: "Angin", value: 9 }] }, highlight: ["Banjir"] },
  "V-06": { data: { shape: "series", categories: ["Analisis", "Respons", "Koordinasi", "Logistik"], series: [{ name: "Tim A", values: [80, 65, 70, 55] }, { name: "Tim B", values: [60, 85, 50, 75] }] }, highlight: ["Tim B"], options: { max: 100 } },
  "V-07": { data: { shape: "hierarchy", nodes: [{ id: "root", label: "Anggaran" }, { id: "a", parent: "root", label: "Operasi", value: 40 }, { id: "b", parent: "root", label: "Dukungan", value: 25 }] }, options: { form: "sunburst" } },
  "V-08": { data: { shape: "hierarchy", nodes: [{ id: "k", label: "Komandan" }, { id: "o", parent: "k", label: "Operasi" }, { id: "l", parent: "k", label: "Logistik" }] }, options: { form: "tidy" } },
};

function vegaCatalogItem(d: (typeof VEGA_CHART_REGISTRY)[number]) {
  const schema = vegaChartInputSchema(d.code) as { properties: Record<string, unknown> };
  const ex = VEGA_EXAMPLE_DATA[d.code];
  return {
    code: d.code,
    name: d.name,
    description: `${d.fn}. Use when: ${d.useWhen}. Avoid when: ${d.avoidWhen}.`,
    group: d.group,
    purpose: d.purpose,
    dataShape: d.dataShape,
    replaces: d.replaces ?? null,
    capacity: d.capacity,
    highlight: VEGA_HIGHLIGHT[d.code],
    data: schema.properties.data,
    options: schema.properties.options ?? null,
    example: {
      type: "chart",
      code: d.code,
      caption: { text: `${d.name}.` },
      source: { text: "Sumber data." },
      data: ex.data,
      ...(ex.highlight ? { highlight: ex.highlight } : {}),
      ...(ex.options ? { options: ex.options } : {}),
    },
  };
}

/** `meta.vega` of kind=charts: how to use the Vega family in a document chart block, one entry per type. */
export function vegaChartCatalog() {
  return {
    schema: VEGA_CHART_SCHEMA,
    count: VEGA_CHART_REGISTRY.length,
    usage:
      "Chart block with code V-01..V-08 (or the DF code in `replaces`): { type: \"chart\", code, data, highlight?, options?, unit?, dec?, note?, caption, source }. " +
      "`data` and `options` must match the schemas below exactly (closed; extra fields are refused). Not supported on Vega codes: limit, orientation, sort, topN, labelShort, panels. " +
      "Check one figure first with studio_figure_preview; FIGURE_OVER_CAPACITY names what to reduce.",
    items: VEGA_CHART_REGISTRY.map(vegaCatalogItem),
  };
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[key(it)] = (out[key(it)] ?? 0) + 1;
  return out;
}

function unknownKind(message: string, details: unknown, ctx: ReqCtx): Response {
  return reject(ctx, "REGISTRY_KIND_UNKNOWN", message, details);
}

/** Contoh kueri sah yang disertakan pada 400 kind absen/tak dikenal (U-07). */
const KIND_EXAMPLES: readonly string[] = [
  `${ROUTE}?kind=contracts`,
  `${ROUTE}?kind=schema&schemaId=studio.chapter/v2`,
  `${ROUTE}?kind=sections`,
];

/**
 * U-07 (D-419): `kind` absen atau tak dikenal -> 400 REGISTRY_KIND_UNKNOWN (perilaku kontrak R03 tetap;
 * tidak ada respons 200 tanpa kind). R2-F1 (D-424 #4): `details` = larik SATU isu seperti filter tak
 * dikenal (01 §6.2 `ValidationIssue[]`, satu bentuk per kode); daftar kind sah dan contoh kueri
 * dibawa di dalam isu itu agar agen tidak perlu menebak.
 */
function kindRequired(kind: string, ctx: ReqCtx): Response {
  const missing = kind === "";
  const message = missing
    ? `kind query parameter is required; one of ${KINDS.join(", ")} (e.g. ?kind=contracts)`
    : `kind must be one of ${KINDS.join(", ")} (e.g. ?kind=contracts)`;
  return unknownKind(
    message,
    [
      {
        pointer: "/query/kind",
        keyword: missing ? "required" : "enum",
        message: KINDS.join("|"),
        received: missing ? null : kind.slice(0, 64),
        validKinds: [...KINDS],
        examples: [...KIND_EXAMPLES],
      },
    ],
    ctx,
  );
}

/** Filter query berdaftar tertutup; nilai di luar daftar -> 400 REGISTRY_KIND_UNKNOWN (pointer `/query/<nama>`). */
function enumFilter(sp: URLSearchParams, name: string, allowed: readonly string[], ctx: ReqCtx): { value: string | null; error?: Response } {
  const value = sp.get(name) || null;
  if (value && !allowed.includes(value)) {
    return {
      value,
      error: unknownKind(`${name} must be one of ${allowed.join(", ")}`, [{ pointer: `/query/${name}`, keyword: "enum", message: allowed.join("|") }], ctx),
    };
  }
  return { value };
}

const surfaceOf = (p: Pick<ScopedParamDef, "surface">): string => p.surface ?? "unmapped";

function paramsPayload(sp: URLSearchParams, ctx: ReqCtx): Response {
  const cls = enumFilter(sp, "class", ["B", "K", "T"], ctx);
  if (cls.error) return cls.error;
  const origin = enumFilter(sp, "origin", ["catalog", "contract"], ctx);
  if (origin.error) return origin.error;
  const surface = enumFilter(sp, "surface", PARAM_SURFACES, ctx);
  if (surface.error) return surface.error;
  const group = sp.get("group");
  const chapter = sp.get("chapter");
  const items = ALL_PARAMS.filter(
    (p) =>
      (!cls.value || p.class === cls.value) &&
      (!group || p.group === group) &&
      (!chapter || p.chapter === chapter) &&
      (!origin.value || p.origin === origin.value) &&
      (!surface.value || p.surface === surface.value),
  );
  return json(
    {
      kind: "params",
      count: items.length,
      items,
      meta: {
        total: ALL_PARAMS.length,
        expectedTotal: ALL_PARAM_COUNT,
        catalog: CATALOG_PARAM_COUNT,
        render: RENDER_PARAM_COUNT,
        structure: STRUCTURE_PARAM_COUNT,
        byClass: countBy(ALL_PARAMS, (p) => p.class),
        byGroup: countBy(ALL_PARAMS, (p) => p.group),
        byChapter: countBy(ALL_PARAMS, (p) => p.chapter),
        bySurface: countBy(ALL_PARAMS, surfaceOf),
        byScopeKind: countBy(ALL_PARAMS, (p) => parseParamScope(p.scope).kind),
      },
    },
    200,
    ctx,
    CACHE,
  );
}

/** Kenop esensial per kelompok: `global` + setiap sectionType C33 (kosong bila jenis itu tidak punya kenop). */
function essentialsPayload(ctx: ReqCtx): Response {
  const global = essentialKnobsFor("global");
  const bySectionType: Record<string, readonly EssentialKnobSpec[]> = {};
  for (const t of SLOT_SECTION_TYPES) bySectionType[t] = essentialKnobsFor(t);
  const byScope = countBy(ESSENTIAL_KNOBS, (k) => k.scope);
  const overLimit = Object.entries(byScope)
    .filter(([, n]) => n > ESSENTIAL_MAX_PER_GROUP)
    .map(([scope, count]) => ({ scope, count }));
  // Kenop berkelompok di luar "global" + C33 tidak pernah tampil di UI: dicatat agar registri diperbaiki.
  const orphanScopes = Object.keys(byScope).filter((s) => s !== "global" && !SLOT_KIND_BY_TYPE.has(s));
  const withinLimits =
    overLimit.length === 0 &&
    orphanScopes.length === 0 &&
    ESSENTIAL_KNOBS.length <= ESSENTIAL_MAX_TOTAL &&
    ESSENTIAL_KNOBS.length === ESSENTIAL_KNOB_COUNT;
  if (!withinLimits) {
    apiLog({
      level: "warn",
      source: SOURCE,
      route: ROUTE,
      method: ctx.method,
      correlationId: ctx.correlationId,
      code: "ESSENTIAL_SURFACE_LIMIT",
      message: "ESSENTIAL_KNOBS di luar batas permukaan ringkas (PT-07)",
      context: { total: ESSENTIAL_KNOBS.length, expected: ESSENTIAL_KNOB_COUNT, overLimit, orphanScopes },
    });
  }
  return json(
    {
      kind: "essentials",
      count: ESSENTIAL_KNOBS.length,
      items: ESSENTIAL_KNOBS,
      global,
      bySectionType,
      meta: {
        expectedTotal: ESSENTIAL_KNOB_COUNT,
        maxPerGroup: ESSENTIAL_MAX_PER_GROUP,
        maxTotal: ESSENTIAL_MAX_TOTAL,
        byScope,
        withinLimits,
        fieldPaths: Object.fromEntries(ESSENTIAL_FIELD_PATHS),
      },
    },
    200,
    ctx,
    CACHE,
  );
}

function slotsPayload(ctx: ReqCtx): Response {
  return json(
    {
      kind: "slots",
      count: SLOT_KINDS.length,
      items: SLOT_KINDS,
      meta: {
        sectionTypes: SLOT_SECTION_TYPES,
        contentModes: STUDIO_SLOT_CONTENT_MODES,
        repeatable: SLOT_KINDS.filter((k) => k.repeatable).map((k) => k.sectionType),
        sharedGroups: SHARED_PARAM_GROUP_MEMBERS,
        pageDeviceSectionTypes: PAGE_DEVICE_SECTION_TYPES,
      },
    },
    200,
    ctx,
    CACHE,
  );
}

function paramScopesPayload(sp: URLSearchParams, ctx: ReqCtx): Response {
  const scopeKind = enumFilter(sp, "scopeKind", PARAM_SCOPE_KINDS, ctx);
  if (scopeKind.error) return scopeKind.error;
  const surface = enumFilter(sp, "surface", PARAM_SURFACES, ctx);
  if (surface.error) return surface.error;
  const sectionType = enumFilter(sp, "sectionType", SLOT_SECTION_TYPES, ctx);
  if (sectionType.error) return sectionType.error;
  const slot = sectionType.value ? SLOT_KIND_BY_TYPE.get(sectionType.value) : undefined;
  const all = ALL_PARAMS.map((p) => ({ id: p.id, key: p.key, class: p.class, scope: p.scope, surface: p.surface ?? null }));
  const items = all.filter(
    (p) =>
      (!scopeKind.value || parseParamScope(p.scope).kind === scopeKind.value) &&
      (!surface.value || p.surface === surface.value) &&
      (!slot || isScopeAllowedInSlot(p.scope, { sectionType: slot.sectionType, admits: slot.defaultAdmits })),
  );
  return json(
    {
      kind: "paramScopes",
      count: items.length,
      items,
      meta: {
        total: all.length,
        rules: PARAM_SCOPE,
        byScopeKind: countBy(all, (p) => parseParamScope(p.scope).kind),
        byScope: countBy(all, (p) => p.scope),
        bySurface: countBy(all, (p) => p.surface ?? "unmapped"),
        ...(slot ? { sectionType: slot.sectionType, admits: slot.defaultAdmits } : {}),
      },
    },
    200,
    ctx,
    CACHE,
  );
}

/**
 * R03 `kind=contracts` (register 05 §9.4, AM-07): jenis kontrak berstatus `active` apa adanya
 * dari C58, agar agen membaca enum dan kerangka tanpa menebak. Parameter selain `kind` ditolak.
 */
function contractsPayload(sp: URLSearchParams, ctx: ReqCtx): Response {
  const extra = [...new Set(sp.keys())].filter((name) => name !== "kind");
  if (extra.length > 0) {
    return schemaInvalid(
      extra.map((name) => issue(`/query/${name}`, "additionalProperties", "kind=contracts accepts no other query parameters")),
      ctx,
    );
  }
  const items = CONTRACT_KIND_DEFS.filter((d) => d.stage === "active");
  return json(
    {
      kind: "contracts",
      count: items.length,
      items,
      meta: {
        kinds: items.map((d) => d.kind),
        templateSlugs: Object.fromEntries(items.map((d) => [d.kind, d.templateSlug])),
      },
    },
    200,
    ctx,
    CACHE,
  );
}

/** Templat `isPreset` aktif + status terbatas D-98 dari versi terbaru (dua kueri, tanpa N+1). */
async function presetsPayload(ctx: ReqCtx): Promise<Response> {
  // Swarm port (row 31): SQL over the store (../db.ts). listTemplates first, so the builtins are pinned
  // on first use exactly as every other template read does (row 109 TemplateSource twin).
  await listTemplates({});
  const rows = await presetTemplates();
  const byTemplate = new Map(rows.map((v) => [v.id, v.resolvedParams]));
  const items = rows.map((t) => {
    const params = byTemplate.get(t.id);
    const { restricted } = templateRestriction(params && typeof params === "object" ? (params as Readonly<Record<string, unknown>>) : null);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      kind: t.kind,
      description: t.description,
      isCanonical: t.isCanonical,
      isPreset: true,
      restricted,
      latestVersionNo: t.latestVersionNo,
      updatedAt: t.updatedAt.toISOString(),
    };
  });
  return json(
    { kind: "presets", count: items.length, items, meta: { restricted: items.filter((i) => i.restricted).length } },
    200,
    ctx,
    NO_CACHE,
  );
}

function schemaPayload(sp: URLSearchParams, ctx: ReqCtx): Response {
  const schemaId = sp.get("schemaId") || "";
  const doc = SCHEMA_IDS.includes(schemaId) ? SCHEMA_DOCS[schemaId] : undefined;
  if (!doc) {
    return unknownKind(
      `schemaId must be one of ${SCHEMA_IDS.join(", ")}`,
      [{ pointer: "/query/schemaId", keyword: "enum", message: SCHEMA_IDS.join("|") }],
      ctx,
    );
  }
  const headers: Record<string, string> = { "Content-Type": "application/schema+json; charset=utf-8", ...CACHE };
  const download = sp.get("download");
  if (download === "1" || download === "true") {
    // Nama berkas dari daftar tertutup SCHEMA_IDS (tanpa masukan bebas): "studio.doc/v1" -> "studio.doc.v1.schema.json".
    headers["Content-Disposition"] = `attachment; filename="${schemaId.replace(/\//g, ".")}.schema.json"`;
  }
  const res = new Response(JSON.stringify(doc, null, 2) + "\n", { status: 200, headers });
  return withCorrelation(res, ctx);
}

function listPayload(kind: ListKind, ctx: ReqCtx): Response {
  switch (kind) {
    case "sections":
      return json(
        {
          kind,
          count: SECTION_REGISTRY.length,
          items: SECTION_REGISTRY,
          meta: { version: SECTION_REGISTRY_VERSION, byGroup: countBy(SECTION_REGISTRY, (s) => s.group) },
        },
        200,
        ctx,
        CACHE,
      );
    case "charts":
      return json(
        {
          kind,
          count: CHART_REGISTRY.length,
          items: CHART_REGISTRY,
          meta: {
            drawn: CHART_REGISTRY.filter((c) => c.drawn).length,
            byGroup: countBy(CHART_REGISTRY, (c) => c.group),
            // Row 163b (C155): the Vega family (V-01..V-08) for agents; `items` stays the 76 Rev A codes.
            vega: vegaChartCatalog(),
          },
        },
        200,
        ctx,
        CACHE,
      );
    case "diagram": {
      const items = DIAGRAM_FAMILIES.map((family) => ({ family, layout: DIAGRAM_LAYOUT_ALIAS[family] ?? family }));
      return json({ kind, count: items.length, items, meta: { symbolDialects: SYMBOL_DIALECTS } }, 200, ctx, CACHE);
    }
    case "symbols": {
      const items = SYMBOL_IDS.map((id) => ({ id, dialect: id.split(":")[0] }));
      return json({ kind, count: items.length, items, meta: { byDialect: countBy(items, (s) => s.dialect) } }, 200, ctx, CACHE);
    }
    case "lint":
      return json(
        {
          kind,
          count: LINT_REGISTRY.length,
          items: LINT_REGISTRY,
          meta: { byGroup: countBy(LINT_REGISTRY, (l) => l.group), blocksIngest: LINT_REGISTRY.filter((l) => l.blocksIngest).length },
        },
        200,
        ctx,
        CACHE,
      );
    case "roles":
      return json({ kind, count: ROLE_KEYS.length, items: ROLE_KEYS }, 200, ctx, CACHE);
  }
}

export async function GET(req: NextRequest) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const ctx = reqCtx(req, ROUTE, SOURCE);

  const sp = new URL(req.url).searchParams;
  const kind = sp.get("kind") || "";
  if (!(KINDS as readonly string[]).includes(kind)) return kindRequired(kind, ctx);

  try {
    const k = kind as RegistryKind;
    switch (k) {
      case "params":
        return paramsPayload(sp, ctx);
      case "schema":
        return schemaPayload(sp, ctx);
      case "presets":
        return await presetsPayload(ctx);
      case "essentials":
        return essentialsPayload(ctx);
      case "slots":
        return slotsPayload(ctx);
      case "paramScopes":
        return paramScopesPayload(sp, ctx);
      case "contracts":
        return contractsPayload(sp, ctx);
      default:
        return listPayload(k, ctx);
    }
  } catch (e) {
    return failure(e, ctx, { op: "GET registry", context: { kind } });
  }
}
