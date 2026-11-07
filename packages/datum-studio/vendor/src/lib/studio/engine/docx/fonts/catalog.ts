/**
 * Katalog wajah fon yang tersedia untuk ditanam: aset templat ber-kind "font"
 * (`ResolvedTemplate.assets`), atau bila templat tidak membawa aset fon,
 * manifest S13 `src/lib/studio/assets/manifest.json` relatif cwd repo.
 * Setiap berkas dibaca, sha256-nya dicocokkan dengan nilai terkunci (bila ada),
 * lalu keluarga/bobot/gaya dibaca dari tabel sfnt.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ResolvedTemplate } from "../../../contract";
import { studioAssetsRoot } from "../../../contract/env";
import { StudioEngineError } from "../../../contract/errors";
import { readSfntFaceInfo, type SfntFaceInfo } from "./sfnt";

/** Akar aset Studio relatif cwd repo (S13). Sengaja tidak diimpor dari docx/package (hindari siklus impor). */
export const STUDIO_ASSETS_DIR = path.join("src", "lib", "studio", "assets");

/** Sumber fon: kunci aset (mis. `fonts/IBMPlexSerif-Regular.ttf`), path absolut, sha256 terkunci opsional. */
export interface FontSource {
  key: string;
  absPath: string;
  sha256?: string;
}

export interface FontFace {
  key: string;
  absPath: string;
  /** sha256 isi TTF (heksa huruf kecil). */
  sha256: string;
  bytes: number;
  info: SfntFaceInfo;
  /** Nama keluarga ternormalisasi yang dikenali wajah ini (lihat normalizeFamily). */
  familyKeys: readonly string[];
}

/** Normalisasi nama keluarga untuk pencocokan: huruf kecil, hanya [a-z0-9]. */
export function normalizeFamily(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function byKey<T extends { key: string }>(a: T, b: T): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

interface ManifestEntry {
  path?: string;
  sha256?: string;
  kind?: string;
}

/** Sumber fon dari aset templat; cadangan manifest S13 di `assetsRoot` (default cwd/STUDIO_ASSETS_DIR). */
export function fontSourcesFromTemplate(tpl: ResolvedTemplate, assetsRoot?: string): FontSource[] {
  const fromTpl = Object.entries(tpl.assets ?? {})
    // Hanya berkas sfnt: pindaian aset kanonik menandai seluruh isi fonts/ sebagai "font"
    // (mis. PASANG-DULU.txt), yang tidak boleh masuk katalog (temuan INT-B).
    .filter(([key, a]) => a.kind === "font" && /\.(ttf|otf)$/i.test(key))
    .map(([key, a]) => ({ key, absPath: a.absPath, sha256: a.sha256 }))
    .sort(byKey);
  if (fromTpl.length > 0) return fromTpl;
  // Swarm patch (row 107, row 11 M4): default font root is the explicit Studio asset root, not cwd.
  return fontSourcesFromManifest(assetsRoot ?? studioAssetsRoot());
}

/** Entri ber-kind "font" dari manifest S13. Manifest tidak ada = katalog kosong. */
export function fontSourcesFromManifest(assetsRoot: string): FontSource[] {
  const mp = path.join(assetsRoot, "manifest.json");
  if (!existsSync(mp)) return [];
  let entries: ManifestEntry[];
  try {
    const m = JSON.parse(readFileSync(mp, "utf8")) as { entries?: ManifestEntry[] };
    entries = Array.isArray(m.entries) ? m.entries : [];
  } catch (e) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `manifest aset Studio tidak terbaca: ${mp}`, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  return entries
    .filter((e): e is ManifestEntry & { path: string } => e.kind === "font" && typeof e.path === "string")
    .filter((e) => /\.(ttf|otf)$/i.test(e.path))
    .map((e) => ({ key: e.path, absPath: path.join(assetsRoot, ...e.path.split("/")), sha256: e.sha256 }))
    .sort(byKey);
}

const faceCache = new Map<string, { info: SfntFaceInfo; bytes: number }>();

/** Baca satu sumber fon: verifikasi keberadaan dan sha256 terkunci, parse sfnt (di-cache per sha256). */
export function loadFontFace(src: FontSource): FontFace {
  if (!existsSync(src.absPath)) {
    throw new StudioEngineError("FILE_MISSING_ON_DISK", `Berkas fon tidak ada: ${src.absPath}`, { key: src.key });
  }
  const data = new Uint8Array(readFileSync(src.absPath));
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (src.sha256 && src.sha256.toLowerCase() !== sha256) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `sha256 fon tidak cocok: ${src.key}`, {
      expected: src.sha256,
      actual: sha256,
    });
  }
  let cached = faceCache.get(sha256);
  if (!cached) {
    cached = { info: readSfntFaceInfo(data, src.key), bytes: data.length };
    faceCache.set(sha256, cached);
  }
  return {
    key: src.key,
    absPath: src.absPath,
    sha256,
    bytes: cached.bytes,
    info: cached.info,
    familyKeys: familyKeysOf(src, cached.info),
  };
}

/**
 * Nama keluarga yang dikenali: keluarga tipografis (nameID 16), keluarga lama
 * (nameID 1), awalan nama PostScript sebelum "-", dan awalan nama berkas
 * sebelum "-". Contoh: IBMPlexSansCond-SemiBold.ttf dikenali sebagai
 * "IBM Plex Sans Condensed" dan "IBM Plex Sans Cond".
 */
function familyKeysOf(src: FontSource, info: SfntFaceInfo): string[] {
  const base = path.basename(src.key).replace(/\.(ttf|otf)$/i, "");
  // Swarm patch (row 108, C31/U9.7): the standard static Plex SemiBold files carry nameID 1
  // "<Family> SemiBold" and no nameID 16, so "IBM Plex Sans Condensed SemiBold" also counts as
  // "IBM Plex Sans Condensed" (the original reached it through the relabelled alias faces, not shipped).
  const cands = [info.typoFamily, info.family, info.family?.replace(/ SemiBold$/, ""), info.postscriptName?.split("-")[0], base.split("-")[0]];
  const out: string[] = [];
  for (const c of cands) {
    const n = c ? normalizeFamily(c) : "";
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Muat semua sumber; urutan keluaran = urutan kunci (deterministik). */
export function loadFontCatalog(sources: readonly FontSource[]): FontFace[] {
  return [...sources].sort(byKey).map(loadFontFace);
}
