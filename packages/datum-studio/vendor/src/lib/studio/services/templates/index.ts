/**
 * Swarm twin (row 109, Prisma cut; 01_specs_studio.md §1.2 site 3 "Twin TemplateSource", §6).
 *
 * Same module path and exported names as the clone's Prisma service (I39), implemented over the
 * shipped builtin template files plus the `user` templates in the DATUM Studio store:
 * - Builtin templates are read-only `studio.template/v2` files (row 110, `templates/catalog.json`).
 *   Their version payload (resolved parameters, role formats, section plan, folded skeleton) is
 *   computed here exactly as the clone's v2 save core did (`saveTemplateV2Tx` steps 1-5: preset
 *   chain -> base layer -> `composeVersion`), and pinned into the store with
 *   `StudioStore.pinBuiltinVersion` on first use (C5 "shipped templates copied into the store on
 *   first use", store spec §7.2). File sha256 and skeleton sha256 are checked against the catalog.
 * - Documents FK the pinned rows, so `resolveTemplate`, `resolveTemplateVersion`, `listTemplates`,
 *   `getTemplate` and `getTemplateV2` read the store only.
 * - Writes (row 66): the v2 create/version entry points go through the Swarm template service
 *   (`./service`: form lock P1-P9, guard seam, immutable versions). v1 flat-profile writes, profile
 *   import and canonical sync stay refused (FORBIDDEN `TEMPLATE_V1_UNSUPPORTED` / `TEMPLATE_OP_DROPPED`).
 * - `foldTemplateDefinition` / `presetFoldBase` (row 66) fold a definition on a builtin preset exactly
 *   as the builtins are folded, so a user copy is byte-equal to its source.
 * `templates/{v2,profile,import,assets,log,access}.ts` stay verbatim (closure C, research/04 finding 4).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CreateTemplateInput,
  CreateTemplateVersionInput,
  ParamValue,
  ResolvedTemplate,
  RoleFormatMap,
  SectionPlan,
  StudioCaller,
  StudioSkeletonV1,
  StudioTemplateKind,
  StudioTemplateV2,
  TemplateDetail,
  TemplateListQuery,
  TemplateProvenance,
  TemplateSlotDef,
  TemplateSummary,
  TemplateVersionDto,
  VersionSummary,
} from "../../contract";
import { STUDIO_TEMPLATE_KINDS } from "../../contract/enums";
import { StudioEngineError } from "../../contract/errors";
import {
  findTemplateById,
  findTemplateBySlug,
  findTemplateVersionById,
  findTemplateVersionByNo,
  readWith,
  studioStore,
  templateOf,
  templateVersionsOf,
  withStudioTx,
  type StudioTemplate,
  type StudioTemplateVersion,
  type StudioTx,
} from "../_swarm-store";
import { flattenSlotParams, skeletonSha256 as skeletonShaOfSlots, validateSkeleton } from "../skeleton/pure";
import { templateRestriction, type TemplateAccessOptions, type TemplateRestriction, assertTemplateUsable } from "./access";
import { resolveRepoAssetPath } from "./assets";
import { canonicalizeFaceNames } from "./face-names";
import type { ReadProfileOptions } from "./import";
import { templatesLog } from "./log";
import {
  canonicalVersionPayload,
  DATUM_CANONICAL_SLUG,
  foldOverrides,
  isPlainObject,
  type ParamRecord,
  type ParsedTemplateProfile,
  sha256Hex,
  stableStringify,
  type TemplateAssets,
  throwIssues,
  toResolvedTemplate,
  validateAssets,
  validateRoleFormats,
  type VersionPayload,
  composeVersion,
} from "./profile";
import { assertTemplateLayerKeys, layerToSurfaces, ownRoleFormats, parseTemplateV2, templateLayerOf } from "./v2";

export * from "./profile";
export { essentialProjection, layerToSurfaces, parseTemplateV2, splitBySurface, surfaceOfKey, TEMPLATE_V2_SCHEMA } from "./v2";
export {
  assertTemplateUsable,
  isAdminCaller,
  isTrustedCaller,
  TEMPLATE_RESTRICTED_DENIED,
  templateRestriction,
  type TemplateAccessOptions,
  type TemplateRestriction,
} from "./access";
export { CANONICAL_ASSET_DIR, resolveRepoAssetPath, scanCanonicalAssets } from "./assets";
export {
  loadResolvedProfileFile,
  loadResolvedTemplateV2File,
  readTemplateProfileFile,
  type LoadTemplateV2Options,
  type LoadTemplateV2Result,
  type ReadProfileOptions,
} from "./import";
export { setTemplatesLogSink, templatesLog, type TemplatesLogEntry, type TemplatesLogSink } from "./log";

export type TemplateSummaryAccess = TemplateSummary & TemplateRestriction & {
  /** SR-07 MX01: preset gaya (hanya ADMIN yang membuat versi). */
  isPreset: boolean;
  /** Swarm: `builtin` (shipped file, read-only) or `user` (store). */
  origin: "builtin" | "user";
};
export type TemplateVersionDtoAccess = TemplateVersionDto & TemplateRestriction & {
  /** SR-07 MX02: null = versi lama, kerangka implisit. */
  skeletonSha256: string | null;
};
export type TemplateDetailAccess = TemplateDetail & { template: TemplateSummaryAccess; version: TemplateVersionDtoAccess };

/** R01 GET (SR-07): `preset` true = hanya preset, false = tanpa preset, tak diisi = semua. */
export type TemplateListQueryV2 = TemplateListQuery & { preset?: boolean };

// ── Configuration (set once by the host; no env, no cwd) ─────────────────

export interface TemplateSourceConfig {
  /** Absolute folder of the builtin `studio.template/v2` files with `catalog.json` (packaged: Res/datum-studio/templates). */
  templatesDir: string;
  /** Absolute root under which template asset paths `src/lib/studio/assets/...` resolve (row 107 resolveRepoAssetPath). */
  assetRepoRoot: string;
  /** Release that pins builtin versions (store spec §7.2 provenance), e.g. "1.2.0". */
  release: string;
}

let config: TemplateSourceConfig | null = null;
let builtinCache: { dir: string; byslug: Map<string, BuiltinTemplate>; editionAssets: EditionAssets } | null = null;
const pinned = new WeakMap<object, Promise<void>>();

export function configureTemplateSource(c: TemplateSourceConfig | null): void {
  if (c !== null) {
    for (const [k, v] of [["templatesDir", c.templatesDir], ["assetRepoRoot", c.assetRepoRoot]] as const) {
      if (typeof v !== "string" || !path.isAbsolute(v)) throw new StudioEngineError("STORAGE_ROOT_FORBIDDEN", `${k} must be an absolute path`);
    }
    if (typeof c.release !== "string" || c.release.length === 0) throw new StudioEngineError("SCHEMA_INVALID", "release is required");
  }
  config = c;
  builtinCache = null;
}

function cfg(): TemplateSourceConfig {
  if (!config) throw new StudioEngineError("STORAGE_ROOT_FORBIDDEN", "Template source is not configured (configureTemplateSource)");
  return config;
}

// ── Builtin files -> version payloads ────────────────────────────────────

interface CatalogEntry {
  slug: string;
  file: string;
  sha256: string;
  name: string;
  description?: string | null;
  kind: string;
  isPreset: boolean;
  contractKind: string | null;
  preset: string | null;
  skeletonSha256: string;
  versionNo?: number;
}

/** One builtin template, folded (in memory, from the shipped files only). */
export interface BuiltinTemplate {
  entry: CatalogEntry;
  versionNo: number;
  definition: StudioTemplateV2;
  definitionSha256: string;
  payload: VersionPayload;
  skeleton: StudioSkeletonV1;
  skeletonSha256: string;
  /** Overrides chain folded root -> preset (the clone's `loadLayers` preset layer). */
  presetFold: ParamRecord;
  /** Chain root -> this version (for builtins derived from this one). */
  chain: ParamRecord[];
}

const BUILTIN_VERSION_DEFAULT = 1;

function readCatalog(dir: string): { templates: CatalogEntry[]; editionAssets: EditionAssets } {
  const raw = JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8")) as { templates?: unknown; editionAssets?: unknown };
  if (!Array.isArray(raw.templates)) throw new StudioEngineError("TEMPLATE_NOT_FOUND", "builtin catalog has no templates[]");
  return { templates: raw.templates as CatalogEntry[], editionAssets: editionAssetsOf(raw.editionAssets) };
}

/**
 * Swarm patch (row 110e, C75): template assets per edition (`doc.language` -> assets), shipped in
 * catalog.json `editionAssets` (the manual's cover logo: ID seal, ID p.48 DT-13c; EN black, EN p.50
 * DT-13c and p.51 Table 8.1). Each asset passes `validateAssets` (path under `src/lib/studio/assets/`,
 * no `..` or hidden segment, closed extension list); reads stay behind row 107's guards.
 */
export type EditionAssets = Readonly<Record<string, TemplateAssets>>;
const EDITION_LANGUAGES = ["ID", "EN"];

function editionAssetsOf(raw: unknown): EditionAssets {
  if (raw === undefined) return Object.freeze({});
  if (!isPlainObject(raw)) throw new StudioEngineError("SCHEMA_INVALID", "builtin catalog editionAssets must be an object");
  const out: Record<string, TemplateAssets> = {};
  for (const [lang, a] of Object.entries(raw)) {
    if (!EDITION_LANGUAGES.includes(lang)) throw new StudioEngineError("SCHEMA_INVALID", `builtin catalog editionAssets: unknown language ${lang}`);
    const v = validateAssets(a, `/editionAssets/${lang}`);
    if (v.issues.length > 0) throwIssues(v.issues, "builtin catalog editionAssets tidak sah");
    out[lang] = Object.freeze(v.assets) as TemplateAssets;
  }
  return Object.freeze(out);
}

function loadBuiltins(): Map<string, BuiltinTemplate> {
  const c = cfg();
  if (builtinCache && builtinCache.dir === c.templatesDir) return builtinCache.byslug;
  const cat = readCatalog(c.templatesDir);
  const entries = new Map(cat.templates.map((e) => [e.slug, e]));
  const out = new Map<string, BuiltinTemplate>();
  const canonical = canonicalVersionPayload({});
  const fold = (slug: string, seen: string[]): BuiltinTemplate => {
    const have = out.get(slug);
    if (have) return have;
    if (seen.includes(slug)) throw new StudioEngineError("SCHEMA_INVALID", `builtin preset chain loops: ${[...seen, slug].join(" -> ")}`);
    const entry = entries.get(slug);
    if (!entry) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Templat tidak ditemukan: ${slug}`);
    const file = path.join(c.templatesDir, entry.file);
    if (path.dirname(file) !== path.resolve(c.templatesDir)) throw new StudioEngineError("PATH_OUTSIDE_ROOT", `builtin file outside the templates folder: ${entry.file}`);
    const bytes = readFileSync(file);
    const fileSha = sha256Hex(bytes);
    if (fileSha !== entry.sha256) {
      templatesLog({ level: "error", message: "builtin template file sha256 differs from catalog", code: "TEMPLATE_BUILTIN_SHA_MISMATCH", context: { slug, file: entry.file, catalog: entry.sha256, computed: fileSha } });
      throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Builtin template ${slug} failed its integrity check`);
    }
    const definition = parseTemplateV2(JSON.parse(bytes.toString("utf8").replace(/^﻿/, "")), "");
    // Step 1 (clone saveTemplateV2Tx): preset -> base layer; a preset without preset sits on the
    // canonical registry profile (seed S70: no overrides, canonical section plan, no assets).
    let base: TemplateFoldBase;
    if (definition.preset) {
      const parent = fold(definition.preset.slug, [...seen, slug]);
      if (!parent.entry.isPreset) throw new StudioEngineError("SCHEMA_INVALID", `templat ${parent.entry.slug} bukan preset gaya`);
      base = foldBaseOfPreset(parent, cat.editionAssets);
    } else if (entry.isPreset) {
      base = { baseOverrides: foldOverrides([canonical.overrides]), roleFormats: canonical.roleFormats, sectionPlan: canonical.sectionPlan, assets: {}, chain: [canonical.overrides], editionAssets: cat.editionAssets };
    } else {
      throw new StudioEngineError("SCHEMA_INVALID", `builtin ${slug}: preset wajib kecuali templat preset gaya`);
    }
    // Steps 2-5 (ADMIN path: shipped files are written by the release).
    const { payload, skeleton, skeletonSha256: skSha } = foldTemplateDefinition(definition, base);
    if (skSha !== entry.skeletonSha256) {
      templatesLog({ level: "error", message: "builtin skeleton sha256 differs from catalog", code: "TEMPLATE_SKELETON_SHA_MISMATCH", context: { slug, catalog: entry.skeletonSha256, computed: skSha } });
      throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Builtin template ${slug} failed its skeleton check`);
    }
    const t: BuiltinTemplate = {
      entry,
      versionNo: Number.isInteger(entry.versionNo) && (entry.versionNo as number) >= 1 ? (entry.versionNo as number) : BUILTIN_VERSION_DEFAULT,
      definition,
      definitionSha256: sha256Hex(stableStringify(definition)),
      payload,
      skeleton,
      skeletonSha256: skSha,
      presetFold: base.baseOverrides,
      chain: [...base.chain, payload.overrides],
    };
    out.set(slug, t);
    return t;
  };
  for (const slug of entries.keys()) fold(slug, []);
  builtinCache = { dir: c.templatesDir, byslug: out, editionAssets: cat.editionAssets };
  return out;
}

/** The folded builtin template (for the skeleton twin's preset layer and for tests). */
export function builtinTemplate(slug: string): BuiltinTemplate | null {
  return loadBuiltins().get(slug) ?? null;
}

export function builtinTemplateSlugs(): string[] {
  return [...loadBuiltins().keys()];
}

/** Base layer a definition is folded on: the preset chain (clone `saveTemplateV2Tx` step 1). */
export interface TemplateFoldBase {
  baseOverrides: ParamRecord;
  roleFormats: RoleFormatMap;
  sectionPlan: SectionPlan;
  assets: TemplateAssets;
  chain: ParamRecord[];
  /** Row 110e: assets per resolved `doc.language` laid over `assets` by `foldTemplateDefinition` (builtin catalog). */
  editionAssets?: EditionAssets;
}

function foldBaseOfPreset(parent: BuiltinTemplate, editionAssets: EditionAssets): TemplateFoldBase {
  return {
    baseOverrides: foldOverrides(parent.chain),
    roleFormats: parent.payload.roleFormats,
    sectionPlan: parent.payload.sectionPlan,
    assets: parent.payload.assets as TemplateAssets,
    chain: parent.chain,
    editionAssets,
  };
}

/** Row 110e: the shipped edition assets (catalog.json `editionAssets`), for the candidate render side. */
export function builtinEditionAssets(): EditionAssets {
  loadBuiltins();
  return builtinCache?.editionAssets ?? Object.freeze({});
}

/** Row 110e: each edition's assets resolved exactly as a stored version's (row 107 resolveRepoAssetPath). */
export function resolvedBuiltinEditionAssets(): Array<ResolvedTemplate["assets"]> {
  const root = cfg().assetRepoRoot;
  return Object.values(builtinEditionAssets()).map(
    (assets) =>
      toResolvedTemplate({ templateId: "", versionId: "", versionNo: 1, resolvedParams: {}, roleFormats: {}, sectionPlan: {}, assets, resolveAssetPath: (rel) => resolveRepoAssetPath(rel, root) }).assets,
  );
}

/**
 * Row 66: the base layer of a user template = a shipped builtin preset (templates spec §1.3: a user
 * template is never a preset, and its `preset.slug` must name a builtin preset). Only the shipped
 * version exists; another `version` is TEMPLATE_NOT_FOUND.
 */
export function presetFoldBase(slug: string, version?: number): TemplateFoldBase {
  const p = loadBuiltins().get(slug);
  if (!p || !p.entry.isPreset) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Preset gaya bawaan tidak ditemukan: ${slug}`, { preset: { slug, version: version ?? null } });
  if (version !== undefined && version !== p.versionNo) {
    throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi ${version} preset gaya ${slug} tidak dikirim (versi bawaan ${p.versionNo})`, { preset: { slug, version } });
  }
  return foldBaseOfPreset(p, builtinCache?.editionAssets ?? Object.freeze({}));
}

/**
 * Steps 2-5 of the clone's v2 save core for one `studio.template/v2` definition on its base layer:
 * template layer (essentials ∪ advanced) -> own role formats -> `composeVersion` -> slots folded
 * (slot layer = essentials ∪ advanced, SR-06) and validated -> canonical skeleton + sha. Used for the
 * shipped builtins and, unchanged, for user versions (row 66), so a copy folds byte for byte alike.
 */
export function foldTemplateDefinition(definition: StudioTemplateV2, base: TemplateFoldBase): { payload: VersionPayload; skeleton: StudioSkeletonV1; skeletonSha256: string } {
  const layer = templateLayerOf(definition);
  assertTemplateLayerKeys(layer, "/template/essentials");
  let ownRoles: Record<string, unknown> = {};
  if (definition.roleFormats !== undefined) {
    const r = validateRoleFormats(definition.roleFormats, "/template/roleFormats");
    if (r.issues.length > 0) throwIssues(r.issues, "Templat tidak sah");
    ownRoles = ownRoleFormats(r.roleFormats as Record<string, unknown>, base.roleFormats as Record<string, unknown>);
  }
  const composed = composeVersion({
    baseOverrides: base.baseOverrides,
    overrides: layer,
    baseRoleFormats: base.roleFormats,
    roleFormats: ownRoles,
    baseSectionPlan: base.sectionPlan,
    assets: base.assets,
  });
  // Swarm patch (row 110e, C75): the edition assets of the resolved doc.language (the manual's cover logo
  // per edition) lie over the base assets, for builtins and user versions alike (a copy folds byte-equal).
  const lang = composed.resolvedParams["doc.language"];
  const edition = typeof lang === "string" ? base.editionAssets?.[lang] : undefined;
  const payload: VersionPayload = edition ? { ...composed, assets: { ...composed.assets, ...edition } } : composed;
  const slots: TemplateSlotDef[] = definition.skeleton.slots.map((s) => {
    const { essentials: _e, advanced: _a, roleFormats, ...rest } = s;
    void _e;
    void _a;
    return { ...rest, essentials: flattenSlotParams(s) as ParamRecord, ...(roleFormats && Object.keys(roleFormats).length > 0 ? { roleFormats } : {}) };
  });
  const skeleton = validateSkeleton({ slots });
  return { payload, skeleton, skeletonSha256: skeletonShaOfSlots(skeleton) };
}

function pinAll(tx: StudioTx): Promise<void> {
  const store = studioStore();
  const release = cfg().release;
  return (async () => {
    for (const b of loadBuiltins().values()) {
      await store.pinBuiltinVersion(tx, {
        slug: b.entry.slug,
        name: b.entry.name,
        kind: b.entry.kind,
        description: b.entry.description ?? null,
        contractKind: b.entry.contractKind ?? null,
        isCanonical: b.entry.slug === DATUM_CANONICAL_SLUG,
        isPreset: b.entry.isPreset === true,
        versionNo: b.versionNo,
        definition: b.definition,
        definitionSha256: b.definitionSha256,
        overrides: b.payload.overrides,
        resolvedParams: b.payload.resolvedParams,
        paramsSha256: b.payload.paramsSha256,
        roleFormats: b.payload.roleFormats,
        sectionPlan: b.payload.sectionPlan,
        assets: b.payload.assets,
        skeleton: b.skeleton,
        skeletonSha256: b.skeletonSha256,
        file: b.entry.file,
        fileSha256: b.entry.sha256,
        release,
      });
    }
  })();
}

/** Pin every shipped builtin version into the store once per store instance (idempotent, §7.2). */
export async function ensureBuiltinTemplates(tx?: StudioTx): Promise<void> {
  const store = studioStore();
  let p = pinned.get(store);
  if (!p) {
    p = (tx ? pinAll(tx) : withStudioTx((t) => pinAll(t), { timeoutMs: TEMPLATE_V2_TX_TIMEOUT_MS })).catch((err) => {
      pinned.delete(store);
      templatesLog({ level: "error", message: "builtin template pin failed", code: "TEMPLATE_BUILTIN_PIN_FAILED", stack_trace: err instanceof Error ? err.stack : undefined, context: { error: err instanceof Error ? err.message : String(err) } });
      throw err;
    });
    pinned.set(store, p);
  }
  return p;
}

// ── Row -> DTO (clone mapping, verbatim fields) ──────────────────────────

export function toSummary(t: StudioTemplate, latest: Pick<StudioTemplateVersion, "resolvedParams"> | null): TemplateSummaryAccess {
  return {
    ...templateRestriction(latest ? (latest.resolvedParams as unknown as ParamRecord) : null),
    id: t.id,
    slug: t.slug,
    name: t.name,
    kind: t.kind as StudioTemplateKind,
    description: t.description,
    isCanonical: t.isCanonical,
    isPreset: t.isPreset,
    origin: t.origin,
    contractKind: t.contractKind ?? null,
    archived: t.archived,
    latestVersionNo: t.latestVersionNo,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** Version summary + the row 64 guard verdict (templates spec §4 "extended with guardVerdict per version"). */
export type VersionSummaryAccess = VersionSummary & { guardVerdict: "pass" | "warn" | null };

function toVersionSummary(v: StudioTemplateVersion): VersionSummaryAccess {
  return {
    id: v.id,
    templateId: v.templateId,
    versionNo: v.versionNo,
    baseVersionId: v.baseVersionId,
    paramsSha256: v.paramsSha256,
    changeNote: v.changeNote,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    guardVerdict: v.guardVerdict ?? null,
  };
}

function overridesOf(v: Pick<StudioTemplateVersion, "overrides">): ParamRecord {
  return isPlainObject(v.overrides) ? (v.overrides as unknown as ParamRecord) : {};
}

export function toVersionDto(v: StudioTemplateVersion): TemplateVersionDtoAccess {
  return {
    ...toVersionSummary(v),
    ...templateRestriction(isPlainObject(v.resolvedParams) ? (v.resolvedParams as unknown as ParamRecord) : null),
    overrides: overridesOf(v),
    resolvedParams: v.resolvedParams as unknown as Record<string, ParamValue>,
    roleFormats: v.roleFormats as unknown as RoleFormatMap,
    sectionPlan: v.sectionPlan as unknown as SectionPlan,
    assets: v.assets as unknown as TemplateAssets,
    provenance: v.provenance as unknown as TemplateProvenance,
    skeletonSha256: v.skeletonSha256 ?? null,
  };
}

// ── Log and errors (clone runOp; store errors are not Prisma errors) ─────

async function runOp<T>(op: string, context: Record<string, unknown>, fn: (cid: string) => Promise<T>): Promise<T> {
  const cid = randomUUID();
  try {
    return await fn(cid);
  } catch (err) {
    if (err instanceof StudioEngineError) {
      templatesLog({ level: "warn", message: `${op}: ${err.message}`, code: err.code, correlationId: cid, context: { op, ...context } });
      throw err;
    }
    templatesLog({
      level: "error",
      message: `${op}: galat tak terduga`,
      code: "INTERNAL",
      correlationId: cid,
      stack_trace: err instanceof Error ? err.stack : undefined,
      context: { op, ...context, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

const TEMPLATE_V2_TX_TIMEOUT_MS = 20_000;

function idOrSlugValid(idOrSlug: string): boolean {
  return typeof idOrSlug === "string" && idOrSlug.length > 0 && idOrSlug.length <= 200;
}

function templateNotFound(idOrSlug: string): StudioEngineError {
  return new StudioEngineError("TEMPLATE_NOT_FOUND", idOrSlugValid(idOrSlug) ? `Templat tidak ditemukan: ${idOrSlug}` : "Templat tidak ditemukan");
}

function findTemplateOrNull(tx: StudioTx, idOrSlug: string): StudioTemplate | null {
  if (!idOrSlugValid(idOrSlug)) return null;
  return findTemplateById(tx, idOrSlug) ?? findTemplateBySlug(tx, idOrSlug);
}

function findTemplate(tx: StudioTx, idOrSlug: string): StudioTemplate {
  const t = findTemplateOrNull(tx, idOrSlug);
  if (!t) throw templateNotFound(idOrSlug);
  return t;
}

function findVersion(tx: StudioTx, t: StudioTemplate, versionNo?: number): StudioTemplateVersion {
  const no = versionNo ?? t.latestVersionNo;
  if (!Number.isInteger(no) || no < 1) {
    throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi templat ${t.slug} tidak sah: ${String(versionNo)}`);
  }
  const v = findTemplateVersionByNo(tx, t.id, no);
  if (!v) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi ${no} templat ${t.slug} tidak ada`);
  return v;
}

/** ResolvedTemplate dari baris versi; memeriksa integritas sha256 parameter (clone verbatim). */
function resolvedFromVersion(t: Pick<StudioTemplate, "id" | "slug">, v: StudioTemplateVersion, cid?: string): ResolvedTemplate {
  const params = (isPlainObject(v.resolvedParams) ? v.resolvedParams : {}) as unknown as ParamRecord;
  const sha = sha256Hex(stableStringify(params));
  if (sha !== v.paramsSha256) {
    templatesLog({
      level: "error",
      message: "paramsSha256 versi templat tidak cocok dengan resolvedParams tersimpan",
      code: "TEMPLATE_PARAMS_SHA_MISMATCH",
      correlationId: cid,
      context: { templateId: t.id, slug: t.slug, versionId: v.id, versionNo: v.versionNo, stored: v.paramsSha256, computed: sha },
    });
  }
  // Swarm patch (row 165D, F113-11): canonical family names ("IBM Plex Sans Cond" -> "IBM Plex Sans Condensed") in
  // the params and role formats every store-resolved template hands to the engines (runs, fontTable, @font-face).
  // After the sha check above, so the stored definition and its sha stay as saved.
  return toResolvedTemplate({
    templateId: t.id,
    versionId: v.id,
    versionNo: v.versionNo,
    resolvedParams: canonicalizeFaceNames(params),
    roleFormats: canonicalizeFaceNames((v.roleFormats ?? {}) as unknown as RoleFormatMap),
    sectionPlan: (v.sectionPlan ?? {}) as unknown as SectionPlan,
    assets: (v.assets ?? {}) as unknown as TemplateAssets,
    resolveAssetPath: (rel) => resolveRepoAssetPath(rel, cfg().assetRepoRoot),
  });
}

// ── API I39 (read) ───────────────────────────────────────────────────────

/** R01 GET: daftar templat; `archived` tak diisi = hanya yang aktif. Kanonik lebih dulu. */
export async function listTemplates(q: TemplateListQueryV2): Promise<TemplateSummaryAccess[]> {
  return runOp("listTemplates", { kind: q?.kind, archived: q?.archived, preset: q?.preset }, async () => {
    if (q?.kind !== undefined && !(STUDIO_TEMPLATE_KINDS as readonly string[]).includes(q.kind)) {
      throwIssues([{ key: "kind", code: "SCHEMA_INVALID", message: `kind harus salah satu dari ${STUDIO_TEMPLATE_KINDS.join(", ")}`, pointer: "/kind" }]);
    }
    if (q?.preset !== undefined && typeof q.preset !== "boolean") {
      throwIssues([{ key: "preset", code: "SCHEMA_INVALID", message: "preset harus boolean (1 = hanya preset, 0 = tanpa preset)", pointer: "/preset" }]);
    }
    await ensureBuiltinTemplates();
    return readWith(undefined, (tx) => {
      const rows = tx
        .all(
          `SELECT * FROM template WHERE (? IS NULL OR kind = ?) AND archived = ? AND (? IS NULL OR is_preset = ?)
            ORDER BY is_canonical DESC, is_preset DESC, slug ASC`,
          [q?.kind ?? null, q?.kind ?? null, q?.archived ? 1 : 0, q?.preset === undefined ? null : 1, q?.preset ? 1 : 0],
        )
        .map(templateOf);
      return rows.map((t) => toSummary(t, findTemplateVersionByNo(tx, t.id, t.latestVersionNo)));
    });
  });
}

/** R02 GET: templat (id atau slug) + versi (default terbaru) + ringkasan semua versi (terbaru dulu). */
export async function getTemplate(id: string, versionNo?: number): Promise<TemplateDetailAccess> {
  return runOp("getTemplate", { id, versionNo }, async () => {
    await ensureBuiltinTemplates();
    return readWith(undefined, (tx) => {
      const t = findTemplate(tx, id);
      const v = findVersion(tx, t, versionNo);
      const versions = templateVersionsOf(tx, t.id);
      const latest = v.versionNo === t.latestVersionNo ? v : findVersion(tx, t, t.latestVersionNo);
      return { template: toSummary(t, latest), version: toVersionDto(v), versions: versions.map(toVersionSummary) };
    });
  });
}

/** Templat (slug) -> `ResolvedTemplate` beku untuk versi tertentu atau terbaru. */
export async function resolveTemplate(slug: string, version?: number): Promise<ResolvedTemplate> {
  return runOp("resolveTemplate", { slug, version }, async (cid) => {
    await ensureBuiltinTemplates();
    return readWith(undefined, (tx) => {
      const t = findTemplateBySlug(tx, slug);
      if (!t) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Templat tidak ditemukan: ${slug}`);
      return resolvedFromVersion(t, findVersion(tx, t, version), cid);
    });
  });
}

/** `resolveTemplate` + gerbang templat terbatas D-98 (clone verbatim). */
export async function resolveTemplateFor(
  slug: string,
  version: number | undefined,
  caller: StudioCaller,
  opts: TemplateAccessOptions & { purpose?: string } = {},
): Promise<ResolvedTemplate> {
  const tpl = await resolveTemplate(slug, version);
  assertTemplateUsable(tpl, caller, { ...opts, slug });
  return tpl;
}

/** Versi templat (id; dipin revisi) -> `ResolvedTemplate` (render ulang identik, D-06). */
export async function resolveTemplateVersion(versionId: string): Promise<ResolvedTemplate> {
  return runOp("resolveTemplateVersion", { versionId }, async (cid) => {
    return readWith(undefined, (tx) => {
      const v = typeof versionId === "string" && versionId.length <= 200 ? findTemplateVersionById(tx, versionId) : null;
      if (!v) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi templat tidak ditemukan: ${versionId}`);
      return resolvedFromVersion(v.template, v, cid);
    });
  });
}

// ── studio.template/v2 (read) ────────────────────────────────────────────

export interface CreateTemplateV2Input {
  slug: string;
  name: string;
  kind: StudioTemplateKind;
  description?: string | null;
  isPreset?: boolean;
  contractKind?: string | null;
  changeNote: string;
  template: StudioTemplateV2;
  expertMode?: boolean;
}

export interface CreateTemplateVersionV2Input {
  baseVersionNo: number;
  changeNote: string;
  template: StudioTemplateV2;
  expertMode?: boolean;
}

export interface TemplateV2SaveResult {
  template: TemplateSummaryAccess;
  version: TemplateVersionDtoAccess;
  skeletonSha256: string;
}

export interface TemplateDetailV2 extends TemplateDetailAccess {
  /** Bentuk `studio.template/v2` versi ini; null = versi lama tanpa kerangka (kerangka implisit, SR-06). */
  definition: StudioTemplateV2 | null;
  skeletonSha256: string | null;
  implicit: boolean;
  /** Lapis lanjutan + roleFormats disertakan (ADMIN; mode ahli USER ditunda D-163 T-1). */
  advancedIncluded: boolean;
}

/**
 * R02 GET (bentuk v2). The store keeps the saved/shipped definition on the version row (§7.3), so
 * the definition is that row's, projected like the clone: without `includeAdvanced` only the
 * essential surface (template and slots) and no roleFormats.
 */
export async function getTemplateV2(id: string, versionNo: number | undefined, opts: { includeAdvanced: boolean }): Promise<TemplateDetailV2> {
  return runOp("getTemplateV2", { id, versionNo, includeAdvanced: opts?.includeAdvanced }, async () => {
    const includeAdvanced = opts?.includeAdvanced === true;
    const detail = await getTemplate(id, versionNo);
    return readWith(undefined, (tx) => {
      const v = findTemplateVersionById(tx, detail.version.id)!;
      const surfaces = layerToSurfaces(overridesOf(v), includeAdvanced);
      const version = { ...detail.version };
      if (!includeAdvanced) version.overrides = surfaces.essentials;
      const stored = isPlainObject(v.definition) && (v.definition as { $schema?: unknown }).$schema === "studio.template/v2" ? (v.definition as unknown as StudioTemplateV2) : null;
      const sk = v.skeleton && isPlainObject(v.skeleton) ? (v.skeleton as unknown as StudioSkeletonV1) : null;
      let definition: StudioTemplateV2 | null = null;
      if (stored && sk) {
        definition = {
          $schema: "studio.template/v2",
          ...(stored.preset ? { preset: stored.preset } : {}),
          ...surfaces,
          ...(includeAdvanced && stored.roleFormats && Object.keys(stored.roleFormats).length > 0 ? { roleFormats: stored.roleFormats } : {}),
          skeleton: {
            slots: sk.slots.map((s) => {
              const { advanced, roleFormats, ...rest } = s;
              const ls = layerToSurfaces(flattenSlotParams({ essentials: s.essentials, advanced }) as ParamRecord, includeAdvanced);
              return { ...rest, ...ls, ...(includeAdvanced && roleFormats ? { roleFormats } : {}) };
            }),
          },
        } as StudioTemplateV2;
      }
      return {
        ...detail,
        version,
        definition,
        skeletonSha256: sk ? (v.skeletonSha256 ?? null) : null,
        implicit: sk === null,
        advancedIncluded: includeAdvanced,
      };
    });
  });
}

// ── Writes: the Swarm template service (row 66, `./service`) ─────────────

/**
 * Refusals that stay: v1 flat-profile writes (user templates are `studio.template/v2` only, templates
 * spec §7.2) and the dropped admin seeding (`importTemplateProfile`, canonical sync, spec §7.1).
 */
function writeRefused(op: string, reason: "TEMPLATE_V1_UNSUPPORTED" | "TEMPLATE_OP_DROPPED"): never {
  const why = reason === "TEMPLATE_V1_UNSUPPORTED" ? "user templates are studio.template/v2; use the v2 create/version entry points" : "builtin templates ship with the release";
  throw new StudioEngineError("FORBIDDEN", `${op}: ${why}`, { reason, op });
}

export async function createTemplate(input: CreateTemplateInput, caller: StudioCaller): Promise<{ template: TemplateSummary; version: TemplateVersionDto }> {
  return runOp("createTemplate", { slug: input?.slug, requester: caller?.requester }, async () => writeRefused("createTemplate", "TEMPLATE_V1_UNSUPPORTED"));
}

export async function createTemplateVersion(id: string, input: CreateTemplateVersionInput, caller: StudioCaller): Promise<{ version: TemplateVersionDto }> {
  return runOp("createTemplateVersion", { id, baseVersionNo: input?.baseVersionNo, requester: caller?.requester }, async () => writeRefused("createTemplateVersion", "TEMPLATE_V1_UNSUPPORTED"));
}

/**
 * R01 POST v2 (clone entry point): a user template made from scratch, through the Swarm template
 * service (form lock P1-P9, guard seam, immutable version 1). `isPreset`/`contractKind`/`expertMode`
 * are refused when set: a user template is never a preset and a contract template is made by copy.
 */
export async function createTemplateV2(input: CreateTemplateV2Input, caller: StudioCaller): Promise<TemplateV2SaveResult> {
  const { createTemplateFromStudioInput } = await import("./service");
  return createTemplateFromStudioInput(input, caller);
}

/** The store has one writer and joins an open job, so the caller's tx is the job this call runs in. */
export async function createTemplateV2InTx(_tx: StudioTx, input: CreateTemplateV2Input, caller: StudioCaller): Promise<TemplateV2SaveResult> {
  return createTemplateV2(input, caller);
}

/** R02 POST v2 (clone entry point): a new immutable version of a user template (Swarm service). */
export async function createTemplateVersionV2(id: string, input: CreateTemplateVersionV2Input, caller: StudioCaller): Promise<TemplateV2SaveResult> {
  const { createVersionFromStudioInput } = await import("./service");
  return createVersionFromStudioInput(id, input, caller);
}

export async function createTemplateVersionV2InTx(_tx: StudioTx, id: string, input: CreateTemplateVersionV2Input, caller: StudioCaller): Promise<TemplateV2SaveResult> {
  return createTemplateVersionV2(id, input, caller);
}

export interface EnsureCanonicalResult {
  template: TemplateSummary;
  version: TemplateVersionDto;
  created: boolean;
  synced: boolean;
  stale: boolean;
}

/** The canonical profile ships as the builtin `datum-kanonik` (row 110); it is pinned, never synced at run time. */
export async function ensureCanonicalTemplate(opts: { createdBy: string; syncRegistry?: boolean; withCanonicalAssets?: boolean; repoRoot?: string }): Promise<EnsureCanonicalResult> {
  return runOp("ensureCanonicalTemplate", { createdBy: opts?.createdBy, syncRegistry: opts?.syncRegistry }, async () => {
    if (opts?.syncRegistry) writeRefused("ensureCanonicalTemplate(syncRegistry)", "TEMPLATE_OP_DROPPED");
    const d = await getTemplate(DATUM_CANONICAL_SLUG);
    return { template: d.template, version: d.version, created: false, synced: false, stale: false };
  });
}

export interface ImportTemplateProfileResult {
  template: TemplateSummary;
  version: TemplateVersionDto;
  created: boolean;
  /** Isi identik dengan versi terbaru: tidak ada versi baru. */
  unchanged: boolean;
  droppedDerived: string[];
  ignoredFields: string[];
}

export async function importTemplateProfile(
  source: string | ParsedTemplateProfile,
  opts: ReadProfileOptions & { caller: StudioCaller; slug?: string; changeNote?: string },
): Promise<ImportTemplateProfileResult> {
  return runOp("importTemplateProfile", { source: typeof source === "string" ? source : "(parsed)", slug: opts?.slug, requester: opts?.caller?.requester }, async () =>
    writeRefused("importTemplateProfile", "TEMPLATE_OP_DROPPED"),
  );
}
