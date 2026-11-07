/**
 * Templat tanpa DB untuk CLI render (H01): berkas profil JSON
 * (`{ base: "datum-kanonik", overrides, roleFormats, sectionPlan }`) atau slug
 * yang dapat diselesaikan di memori. Memakai resolusi profil S49
 * (`services/templates/import` + `profile`), yang tidak menyentuh Prisma.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ResolvedTemplate } from "../../../../src/lib/studio/contract";
import { resolveRepoAssetPath, scanCanonicalAssets } from "../../../../src/lib/studio/services/templates/assets";
import { loadResolvedProfileFile } from "../../../../src/lib/studio/services/templates/import";
import { DATUM_CANONICAL_SLUG, MANUAL000_SLUG, resolveProfileInMemory } from "../../../../src/lib/studio/services/templates/profile";
import { UsageError } from "./common";

/** Slug yang dapat diselesaikan tanpa DB -> berkas profil relatif akar repo (null = kanonik murni). */
export const OFFLINE_SLUGS: Readonly<Record<string, string | null>> = {
  [DATUM_CANONICAL_SLUG]: null,
  [MANUAL000_SLUG]: "benchmark/manual000/template.json",
};

export interface LoadedTemplate {
  template: ResolvedTemplate;
  /** "canonical" | "file:<abs>" | "slug:<slug>" */
  source: string;
  droppedDerived: string[];
  ignoredFields: string[];
}

export async function canonicalTemplate(repoRoot: string, withCanonicalAssets: boolean): Promise<LoadedTemplate> {
  const canonicalAssets = withCanonicalAssets ? await scanCanonicalAssets(repoRoot) : {};
  const template = resolveProfileInMemory(
    { base: DATUM_CANONICAL_SLUG, slug: DATUM_CANONICAL_SLUG, kind: "DOCUMENT", overrides: {} },
    { canonicalAssets, resolveAssetPath: (rel) => resolveRepoAssetPath(rel, repoRoot) },
  );
  return { template, source: "canonical", droppedDerived: [], ignoredFields: [] };
}

/**
 * `arg` = path berkas profil (bila ada di disk) atau slug luring. Slug lain
 * butuh DB (resolveTemplate S49) dan ditolak sebagai salah pakai.
 */
export async function loadTemplate(arg: string | undefined, repoRoot: string, withCanonicalAssets: boolean): Promise<LoadedTemplate> {
  if (!arg) return canonicalTemplate(repoRoot, withCanonicalAssets);
  const asPath = path.resolve(arg);
  if (existsSync(asPath) && statSync(asPath).isFile()) {
    const r = await loadResolvedProfileFile(asPath, { repoRoot, withCanonicalAssets });
    return { template: r.template, source: `file:${asPath}`, droppedDerived: r.droppedDerived, ignoredFields: r.ignoredFields };
  }
  if (!(arg in OFFLINE_SLUGS)) {
    throw new UsageError(
      `templat "${arg}" bukan berkas dan bukan slug luring (${Object.keys(OFFLINE_SLUGS).join(", ")}); slug lain butuh DB`,
      "TEMPLATE_NOT_FOUND",
    );
  }
  const rel = OFFLINE_SLUGS[arg];
  if (rel === null) return { ...(await canonicalTemplate(repoRoot, withCanonicalAssets)), source: `slug:${arg}` };
  const abs = path.join(repoRoot, ...rel.split("/"));
  if (!existsSync(abs)) throw new UsageError(`berkas profil untuk slug ${arg} tidak ada: ${rel}`, "TEMPLATE_NOT_FOUND");
  const r = await loadResolvedProfileFile(abs, { repoRoot, withCanonicalAssets });
  return { template: r.template, source: `slug:${arg}`, droppedDerived: r.droppedDerived, ignoredFields: r.ignoredFields };
}
