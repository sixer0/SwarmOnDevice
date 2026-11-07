/**
 * Aset templat (S49): pemindaian aset profil DATUM-kanonik
 * (`src/lib/studio/assets/**`, KT-15) dan resolusi path aset tersimpan ke path
 * absolut dengan penjaga traversal (path relatif akar repo, `/`).
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { StudioEngineError } from "../../contract/errors";
import { assertPathInsideRoot, isPathInside } from "../../contract/env";
import { templatesLog } from "./log";
import { isTemplateAssetPath, TEMPLATE_ASSET_ROOT, type TemplateAssets } from "./profile";

/** Folder aset kanonik relatif akar repo (= akar aset templat, S87 L-06). */
export const CANONICAL_ASSET_DIR = TEMPLATE_ASSET_ROOT;

function kindFor(rel: string): "font" | "raster" | "base" {
  const top = rel.split("/")[0];
  if (top === "fonts") return "font";
  if (top === "base") return "base";
  return "raster";
}

async function walk(dir: string, prefix: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(path.join(dir, e.name), rel, out);
    else if (e.isFile()) out.push(rel);
  }
}

/**
 * Aset profil kanonik: id = path di bawah folder aset (mis.
 * `fonts/IBMPlexMono-Regular.ttf`), kind dari subfolder (`fonts` -> font,
 * `base` -> base, lain -> raster), sha256 isi berkas. Urutan deterministik.
 * Folder tidak ada -> {} (dicatat warn).
 */
export async function scanCanonicalAssets(repoRoot: string): Promise<TemplateAssets> {
  const dir = path.join(requireRepoRoot(repoRoot), ...CANONICAL_ASSET_DIR.split("/"));
  const files: string[] = [];
  try {
    await walk(dir, "", files);
  } catch (err) {
    templatesLog({
      level: "warn",
      message: "Folder aset kanonik tidak terbaca; profil kanonik tanpa aset",
      code: "ASSET_DIR_UNREADABLE",
      context: { dir: CANONICAL_ASSET_DIR, error: String(err) },
    });
    return {};
  }
  files.sort();
  const assets: TemplateAssets = {};
  for (const rel of files) {
    const bytes = await readFile(path.join(dir, ...rel.split("/")));
    assets[rel] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      path: `${CANONICAL_ASSET_DIR}/${rel}`,
      kind: kindFor(rel),
    };
  }
  return assets;
}

/**
 * Path aset tersimpan -> absolut di dalam folder aset templat
 * (`src/lib/studio/assets/`, S87 L-06: bukan seluruh akar repo, tanpa segmen
 * tersembunyi seperti `.env`); selain itu `PATH_OUTSIDE_ROOT`.
 */
export function resolveRepoAssetPath(relPath: string, repoRoot: string): string {
  requireRepoRoot(repoRoot);
  const assetRoot = path.resolve(repoRoot, ...TEMPLATE_ASSET_ROOT.split("/"));
  const abs = path.resolve(path.resolve(repoRoot), ...relPath.split("/"));
  if (!isTemplateAssetPath(relPath) || !isPathInside(abs, assetRoot)) {
    throw new StudioEngineError("PATH_OUTSIDE_ROOT", `Path aset templat di luar folder aset ${TEMPLATE_ASSET_ROOT}: ${relPath}`);
  }
  // Swarm patch (row 107, row 11 M3): realpath check on top of the lexical one (no symlink escape).
  return assertPathInsideRoot(abs, assetRoot, "Path aset templat");
}

// Swarm patch (row 107, row 11 M4 / C13 M3): repoRoot has no process.cwd() default; it must be an
// explicit absolute path from the host.
export function requireRepoRoot(repoRoot: unknown): string {
  if (typeof repoRoot !== "string" || repoRoot.trim() === "" || !path.isAbsolute(repoRoot)) {
    throw new StudioEngineError("STORAGE_ROOT_FORBIDDEN", "repoRoot templat wajib path absolut eksplisit (tanpa cadangan cwd)");
  }
  return path.resolve(repoRoot);
}
