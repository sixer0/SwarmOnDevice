/**
 * Swarm TWIN (row 108, studio spec §1.3 and §2 F, U9.7, decision C31): no relabelled faces.
 *
 * The original module (clone relabel.ts:1-298) embedded modified IBM Plex files from
 * `assets/fonts/renamed/` (SemiBold faces relabelled as Bold, "IBM Plex Sans Cond" relabels) and
 * built two alias faces at run time with `rename.ts`. Those files are Modified Versions that keep the
 * Reserved Font Name "Plex" (D-317), so Swarm does not ship them (U9.7) and never builds them.
 *
 * Result in planEmbeddedFontsDetailed (plan.ts, unchanged): with both tables empty
 * `findRelabelFace` / `findRelabelAlias` find nothing, so every slot is served from the standard OFL
 * files of the catalog (`pickFace`):
 *   - bold / boldItalic slots with policy `semibold` -> the standard SemiBold / SemiBoldItalic file
 *     (Claude's control does the same, embed_fonts.py:124-133);
 *   - "IBM Plex Sans Cond" -> the standard IBMPlexSansCond-*.ttf files (catalog.ts familyKeysOf
 *     recognises the file-name stem "IBMPlexSansCond").
 * The font-table difference is measured by B-O (C31); any loss is reported, not hidden.
 *
 * Exported names and types are kept so importers (fonts/index.ts, plan.ts) stay byte-identical.
 */
import os from "node:os";
import path from "node:path";

import { StudioEngineError } from "../../../contract/errors";
import { normalizeFamily, type FontSource } from "./catalog";

/** Asset subfolder of the original relabelled faces; such keys stay excluded from face selection. */
export const RELABEL_ASSET_DIR = "fonts/renamed";

export type RelabelSlot = "regular" | "bold" | "italic" | "boldItalic";

export interface RelabelFace {
  family: string;
  slot: RelabelSlot;
  key: string;
  sha256: string;
  source: string;
  sourceSha256: string;
}

export function relabelWeight(slot: RelabelSlot): number {
  return slot === "bold" || slot === "boldItalic" ? 700 : 400;
}

export function relabelItalic(slot: RelabelSlot): boolean {
  return slot === "italic" || slot === "boldItalic";
}

/** Empty in Swarm (U9.7): no relabelled file is shipped. */
export const RELABEL_FACES: readonly RelabelFace[] = [];

export interface RelabelAliasFace {
  family: string;
  from: string;
  slot: RelabelSlot;
  key: string;
  sha256: string;
}

/** Empty in Swarm (U9.7): alias faces are never built at run time. */
export const RELABEL_ALIAS_FACES: readonly RelabelAliasFace[] = [];

export function findRelabelAlias(family: string, slot: string): RelabelAliasFace | undefined {
  const want = normalizeFamily(family);
  return RELABEL_ALIAS_FACES.find((f) => f.slot === slot && normalizeFamily(f.family) === want);
}

/** Kept for API compatibility; nothing is written there by this twin. */
export function relabelAliasCacheDir(): string {
  const env = process.env.STUDIO_FONT_CACHE_DIR;
  return env && env.trim() ? path.resolve(env.trim()) : path.join(os.tmpdir(), "gsp-studio-fonts", "relabel");
}

function notShipped(key: string): never {
  // FILE_MISSING_ON_DISK is the soft code plan.ts turns into "use the standard catalog face".
  throw new StudioEngineError("FILE_MISSING_ON_DISK", `relabelled font faces are not shipped in Swarm (U9.7): ${key}`, { key });
}

/** Never builds a face (the original renamed a SemiBold file at run time). */
export function relabelAliasSource(alias: RelabelAliasFace, _templateAssets?: ReadonlyArray<FontSource>, _assetsRoot?: string, _cacheDir?: string): FontSource {
  return notShipped(alias.key);
}

/** true for asset keys under `fonts/renamed/` (excluded from normal face selection, as in the original). */
export function isRelabelKey(key: string): boolean {
  return key.replace(/\\/g, "/").split("/").slice(-2, -1)[0] === RELABEL_ASSET_DIR.split("/")[1];
}

export function findRelabelFace(family: string, slot: string): RelabelFace | undefined {
  const want = normalizeFamily(family);
  return RELABEL_FACES.find((f) => f.slot === slot && normalizeFamily(f.family) === want);
}

/** Never resolves a relabelled file (no such file is shipped). */
export function relabelSource(face: RelabelFace, _templateAssets?: ReadonlyArray<FontSource>, _assetsRoot?: string): FontSource {
  return notShipped(face.key);
}
