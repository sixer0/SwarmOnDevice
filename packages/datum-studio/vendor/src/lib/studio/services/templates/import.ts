/**
 * Baca berkas profil templat (S49): mis. `benchmark/manual000/template.json`
 * (S95) untuk runner benchmark S97 dan CLI render S67.
 *
 * - `readTemplateProfileFile`: baca + batas ukuran + parse + validasi kunci.
 * - `loadResolvedProfileFile`: resolusi di memori tanpa DB (dasar kanonik).
 * - `loadResolvedTemplateV2File` (SR-07, D-160): berkas `studio.template/v2` ->
 *   `ResolvedTemplate` di memori tanpa DB (preset + esensial + lanjutan + kerangka),
 *   seam runner benchmark `TEMPLATE_V2_LOADER_EXPORT`.
 * Persistensi ke DB lewat `importTemplateProfile` (index.ts).
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ResolvedTemplate, StudioSkeletonV1, StudioTemplateV2 } from "../../contract";
import { isPathInside, STUDIO_MAX_JSON_BYTES } from "../../contract/env";
import { StudioEngineError } from "../../contract/errors";
import { skeletonSha256, validateSkeleton } from "../skeleton/pure";
import { requireRepoRoot, resolveRepoAssetPath, scanCanonicalAssets } from "./assets";
import { templatesLog } from "./log";
import {
  canonicalSectionPlan,
  composeVersion,
  DATUM_CANONICAL_SLUG,
  type ParsedTemplateProfile,
  parseTemplateProfile,
  resolveProfileInMemory,
  splitDerivedOverrides,
  type TemplateProfileFile,
  toResolvedTemplate,
} from "./profile";
import { assertTemplateLayerKeys, parseTemplateV2, templateLayerOf } from "./v2";

export interface ReadProfileOptions {
  /** Buang override kelas T (default true); false = tolak 400. */
  dropDerived?: boolean;
}

/** Baca berkas JSON (maks `STUDIO_MAX_JSON_BYTES`, BOM dibuang). */
async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch (err) {
    templatesLog({ level: "warn", message: `Berkas ${label} tidak terbaca`, code: "TEMPLATE_NOT_FOUND", context: { filePath, error: String(err) } });
    throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Berkas ${label} tidak ditemukan: ${filePath}`);
  }
  if (size > STUDIO_MAX_JSON_BYTES) {
    throw new StudioEngineError("PAYLOAD_TOO_LARGE", `Berkas ${label} ${size} byte melebihi batas ${STUDIO_MAX_JSON_BYTES} byte`);
  }
  const text = (await readFile(filePath, "utf8")).replace(/^﻿/, "");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new StudioEngineError("JSON_MALFORMED", `Berkas ${label} bukan JSON sah: ${(err as Error).message}`);
  }
}

/** Baca dan validasi berkas profil JSON (maks `STUDIO_MAX_JSON_BYTES`). */
export async function readTemplateProfileFile(filePath: string, opts: ReadProfileOptions = {}): Promise<ParsedTemplateProfile> {
  const raw = await readJsonFile(filePath, "profil templat");
  const parsed = parseTemplateProfile(raw, opts);
  if (parsed.droppedDerived.length > 0 || parsed.ignoredFields.length > 0) {
    templatesLog({
      level: "info",
      message: "Profil templat dibaca dengan medan diabaikan / override kelas T dibuang",
      code: "PROFILE_NORMALIZED",
      context: { filePath, droppedDerived: parsed.droppedDerived, ignoredFields: parsed.ignoredFields },
    });
  }
  return parsed;
}

/**
 * Berkas profil -> `ResolvedTemplate` di memori (tanpa DB; dasar wajib
 * `datum-kanonik`). Aset = aset profil saja (profil kanonik tanpa aset,
 * selaras seed S70); `withCanonicalAssets` menambahkan pindaian
 * `src/lib/studio/assets`.
 */
export async function loadResolvedProfileFile(
  filePath: string,
  opts: ReadProfileOptions & { repoRoot?: string; withCanonicalAssets?: boolean } = {},
): Promise<{ template: ResolvedTemplate } & Omit<ParsedTemplateProfile, "profile"> & { slug: string | undefined }> {
  const parsed = await readTemplateProfileFile(filePath, opts);
  // Swarm patch (row 107, C13 M3): repoRoot required, no process.cwd() default.
  const repoRoot = requireRepoRoot(opts.repoRoot);
  const canonicalAssets = opts.withCanonicalAssets ? await scanCanonicalAssets(repoRoot) : {};
  const template = resolveProfileInMemory(parsed.profile, {
    canonicalAssets,
    resolveAssetPath: (rel) => resolveRepoAssetPath(rel, repoRoot),
  });
  return { template, slug: parsed.profile.slug, droppedDerived: parsed.droppedDerived, ignoredFields: parsed.ignoredFields };
}

// ── studio.template/v2 tanpa DB (SR-07) ──────────────────────────────────

export interface LoadTemplateV2Options extends ReadProfileOptions {
  repoRoot?: string;
  withCanonicalAssets?: boolean;
  /** slug preset -> path berkas profil preset (`template-profile/v1`; relatif = terhadap `repoRoot`). */
  presetFiles?: Readonly<Record<string, string>>;
}

export interface LoadTemplateV2Result {
  template: ResolvedTemplate;
  /** Slug profil preset (identitas templat berkas; mis. `datum-manual-000`). */
  slug: string | undefined;
  /** Override kelas T yang dibuang (preset + lapis templat). */
  droppedDerived: string[];
  /** Medan yang tidak dipakai (mis. `preset.version` pada mode berkas, medan profil preset tak dikenal). */
  ignoredFields: string[];
  definition: StudioTemplateV2;
  /** Kerangka kanonik SR-06 (`validateSkeleton`). */
  skeleton: StudioSkeletonV1;
  skeletonSha256: string;
  preset: { slug: string; file: string | null };
}

/**
 * Cari profil preset untuk mode berkas, berurutan: `presetFiles[slug]`;
 * `<dir templat>/<slug>.preset.json`; `<dir>/presets/<slug>.json`; `<dir>/template.json`
 * bila slug profilnya = slug preset (mis. `benchmark/manual000/template.json` =
 * preset "datum-manual-000"). Tidak ditemukan = 404 TEMPLATE_NOT_FOUND.
 */
async function findPresetProfile(
  slug: string,
  templateFile: string,
  opts: LoadTemplateV2Options,
  repoRoot: string,
): Promise<{ parsed: ParsedTemplateProfile; file: string }> {
  const dir = path.dirname(templateFile);
  const explicit = opts.presetFiles?.[slug];
  const explicitAbs = explicit ? path.resolve(repoRoot, explicit) : undefined;
  // Swarm patch (row 107, C13 M3): preset files are read only inside repoRoot (the builtin root):
  // an explicit entry outside it is refused, sibling lookups outside it are not tried.
  if (explicitAbs !== undefined && !isPathInside(explicitAbs, repoRoot)) {
    throw new StudioEngineError("PATH_OUTSIDE_ROOT", `presetFiles["${slug}"] di luar akar templat: ${explicit}`);
  }
  const candidates = [
    ...(explicitAbs !== undefined ? [explicitAbs] : []),
    path.join(dir, `${slug}.preset.json`),
    path.join(dir, "presets", `${slug}.json`),
  ].filter((f) => isPathInside(path.resolve(f), repoRoot));
  const exists = async (f: string) => {
    try {
      return (await stat(f)).isFile();
    } catch {
      return false;
    }
  };
  for (const f of candidates) {
    if (await exists(f)) return { parsed: await readTemplateProfileFile(f, opts), file: f };
  }
  const sibling = path.join(dir, "template.json");
  if (isPathInside(path.resolve(sibling), repoRoot) && path.resolve(sibling) !== path.resolve(templateFile) && (await exists(sibling))) {
    const parsed = await readTemplateProfileFile(sibling, opts);
    if (parsed.profile.slug === slug) return { parsed, file: sibling };
    candidates.push(`${sibling} (slug ${parsed.profile.slug ?? "-"})`);
  }
  templatesLog({ level: "warn", message: "Profil preset untuk templat v2 berkas tidak ditemukan", code: "TEMPLATE_NOT_FOUND", context: { slug, templateFile, tried: candidates } });
  throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Profil preset "${slug}" untuk ${templateFile} tidak ditemukan`, { preset: slug, tried: candidates });
}

/**
 * Berkas `studio.template/v2` -> `ResolvedTemplate` di memori (tanpa DB), nilai efektif
 * sesuai blueprint §2.3: default registri <- preset (profil `template-profile/v1` berdasar
 * `datum-kanonik`, disematkan) <- esensial ∪ lanjutan templat; kelas T dihitung ulang;
 * roleFormats templat ditimpakan per peran di atas roleFormats preset. Kerangka divalidasi
 * dan dikanonikkan layanan kerangka SR-06. Preset tanpa `preset` atau `datum-kanonik` =
 * profil kanonik. Dipakai runner benchmark (D-160) dan CLI render (SR-33).
 */
export async function loadResolvedTemplateV2File(filePath: string, opts: LoadTemplateV2Options = {}): Promise<LoadTemplateV2Result> {
  // Swarm patch (row 107, C13 M3): repoRoot required, no process.cwd() default.
  const repoRoot = requireRepoRoot(opts.repoRoot);
  const raw = await readJsonFile(filePath, "templat studio.template/v2");
  const definition = parseTemplateV2(raw, "");
  const skeleton = validateSkeleton(definition.skeleton);
  const ignoredFields: string[] = [];
  const droppedDerived: string[] = [];

  const presetSlug = definition.preset?.slug ?? DATUM_CANONICAL_SLUG;
  if (definition.preset?.version !== undefined) ignoredFields.push("preset.version");
  let preset: TemplateProfileFile = { base: DATUM_CANONICAL_SLUG, slug: DATUM_CANONICAL_SLUG, kind: "DOCUMENT", overrides: {} };
  let presetFile: string | null = null;
  if (presetSlug !== DATUM_CANONICAL_SLUG) {
    const found = await findPresetProfile(presetSlug, filePath, opts, repoRoot);
    if (found.parsed.profile.base !== DATUM_CANONICAL_SLUG) {
      throw new StudioEngineError(
        "TEMPLATE_NOT_FOUND",
        `Profil preset ${found.file} berdasar "${found.parsed.profile.base}"; mode berkas hanya mendukung preset berdasar "${DATUM_CANONICAL_SLUG}"`,
      );
    }
    preset = found.parsed.profile;
    presetFile = found.file;
    droppedDerived.push(...found.parsed.droppedDerived.map((k) => `preset:${k}`));
    ignoredFields.push(...found.parsed.ignoredFields.map((k) => `preset:${k}`));
  }

  const layer = templateLayerOf(definition);
  const split = opts.dropDerived === false ? { kept: layer, dropped: [] as string[] } : splitDerivedOverrides(layer);
  droppedDerived.push(...split.dropped);
  assertTemplateLayerKeys(split.kept, "/essentials");

  const canonicalAssets = opts.withCanonicalAssets ? await scanCanonicalAssets(repoRoot) : {};
  const presetPayload = composeVersion({
    baseOverrides: {},
    overrides: preset.overrides,
    baseRoleFormats: {},
    roleFormats: preset.roleFormats,
    baseSectionPlan: canonicalSectionPlan(),
    sectionPlan: preset.sectionPlan,
    assets: { ...canonicalAssets, ...(preset.assets ?? {}) },
  });
  const payload = composeVersion({
    baseOverrides: preset.overrides,
    overrides: split.kept,
    baseRoleFormats: presetPayload.roleFormats,
    roleFormats: definition.roleFormats,
    baseSectionPlan: presetPayload.sectionPlan,
    assets: presetPayload.assets,
    provenance: preset.provenance,
    meta: preset.meta,
  });
  const sha = skeletonSha256(skeleton);
  const slug = preset.slug ?? presetSlug;
  const template = toResolvedTemplate({
    templateId: `file:${slug}`,
    versionId: `file:${payload.paramsSha256.slice(0, 16)}:${sha.slice(0, 8)}`,
    versionNo: 0,
    resolvedParams: payload.resolvedParams,
    roleFormats: payload.roleFormats,
    sectionPlan: payload.sectionPlan,
    assets: payload.assets,
    resolveAssetPath: (rel) => resolveRepoAssetPath(rel, repoRoot),
  });
  if (droppedDerived.length > 0 || ignoredFields.length > 0) {
    templatesLog({ level: "info", message: "Templat v2 berkas dibaca dengan medan diabaikan / override kelas T dibuang", code: "PROFILE_NORMALIZED", context: { filePath, presetFile, droppedDerived, ignoredFields } });
  }
  return { template, slug, droppedDerived, ignoredFields, definition, skeleton, skeletonSha256: sha, preset: { slug: presetSlug, file: presetFile } };
}
