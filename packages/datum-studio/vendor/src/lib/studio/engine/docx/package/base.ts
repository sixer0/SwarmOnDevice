/**
 * Basis paket: `default.docx` templat python-docx yang disalin S13 ke
 * `src/lib/studio/assets/base/default.docx` (manifest S13, kind "base").
 * Dari basis diambil bagian yang tidak dibangkitkan ulang: tema, webSettings,
 * numbering, customXml, dan entri fontTable tanpa tanam (research/07 §9.4).
 * styles/settings/core/app/fontTable/document dibangkitkan S14.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { unzipSync } from "fflate";

import type { ResolvedTemplate } from "../../../contract";
import { studioAssetsRoot } from "../../../contract/env";
import { StudioEngineError } from "../../../contract/errors";

/** Path kontrak aset basis relatif akar aset Studio (manifest S13). */
export const BASE_ASSET_REL_PATH = "base/default.docx";
/** Akar aset Studio relatif cwd repo (S13). */
export const STUDIO_ASSETS_DIR = path.join("src", "lib", "studio", "assets");

/** Bagian basis yang disalin apa adanya ke paket keluaran. */
export const BASE_KEPT_PARTS = [
  "word/theme/theme1.xml",
  "word/webSettings.xml",
  "word/numbering.xml",
  "customXml/item1.xml",
  "customXml/itemProps1.xml",
  "customXml/_rels/item1.xml.rels",
] as const;

export interface BasePackage {
  absPath: string;
  sha256: string;
  /** Bagian BASE_KEPT_PARTS (hanya yang ada di basis). */
  parts: ReadonlyMap<string, Uint8Array>;
  /** Elemen `<w:font>` fontTable basis (8 entri tanpa tanam), teks XML apa adanya. */
  fontEntriesXml: readonly string[];
}

const cache = new Map<string, BasePackage>();

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

interface ManifestEntry {
  path?: string;
  sha256?: string;
  kind?: string;
}

function manifestSha(assetsDir: string): string | undefined {
  const mp = path.join(assetsDir, "manifest.json");
  if (!existsSync(mp)) return undefined;
  try {
    const m = JSON.parse(readFileSync(mp, "utf8")) as { entries?: ManifestEntry[] };
    return m.entries?.find((e) => e.path === BASE_ASSET_REL_PATH)?.sha256;
  } catch (e) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `manifest aset Studio tidak terbaca: ${mp}`, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Lokasi dan sha256 harapan basis: aset templat ber-kind "base" (kunci
 * `base/default.docx` didahulukan) > manifest S13 di cwd.
 */
export function locateBase(tpl: ResolvedTemplate): { absPath: string; expectedSha?: string } {
  const entries = Object.entries(tpl.assets).filter(([, a]) => a.kind === "base");
  const chosen = entries.find(([k]) => k === BASE_ASSET_REL_PATH) ?? entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))[0];
  if (chosen) return { absPath: chosen[1].absPath, expectedSha: chosen[1].sha256 };
  // Swarm patch (row 107, row 11 M4): explicit Studio asset root, not cwd.
  const assetsDir = studioAssetsRoot();
  return { absPath: path.join(assetsDir, BASE_ASSET_REL_PATH), expectedSha: manifestSha(assetsDir) };
}

export function loadBasePackage(tpl: ResolvedTemplate): BasePackage {
  const { absPath, expectedSha } = locateBase(tpl);
  if (!existsSync(absPath)) {
    throw new StudioEngineError("FILE_MISSING_ON_DISK", `Basis DOCX tidak ada: ${absPath}`);
  }
  const bytes = readFileSync(absPath);
  const sha = sha256Hex(bytes);
  if (expectedSha && expectedSha.toLowerCase() !== sha) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `sha256 basis DOCX tidak cocok: ${absPath}`, {
      expected: expectedSha,
      actual: sha,
    });
  }
  const key = `${absPath}|${sha}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(bytes));
  } catch (e) {
    throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Basis DOCX bukan ZIP sah: ${absPath}`, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  const parts = new Map<string, Uint8Array>();
  for (const p of BASE_KEPT_PARTS) {
    if (files[p]) parts.set(p, files[p]);
  }
  const ft = files["word/fontTable.xml"] ? new TextDecoder("utf-8").decode(files["word/fontTable.xml"]) : "";
  const fontEntriesXml = ft.match(/<w:font\b[\s\S]*?<\/w:font>/g) ?? [];
  const base: BasePackage = { absPath, sha256: sha, parts, fontEntriesXml };
  cache.set(key, base);
  return base;
}
