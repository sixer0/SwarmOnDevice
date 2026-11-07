/**
 * Kiriman satu bab `studio.chapter/v2` (register 03_structural_sections_specs.md
 * §4.5 T2-47; blueprint §2.5, use case D-128). Agen tidak mengirim parameter.
 */
import type { RegisterEntry } from "../doc";
import type { AssetInputV2, ChangeV2, DocMetaV2, DocTargetV2 } from "./common";
import type { ChapterV2 } from "./doc";

/** T2-47 (SID02) */
export interface StudioChapterV2 {
  $schema: "studio.chapter/v2";
  agentId?: string;
  target: DocTargetV2;
  /** Wajib hanya bila dokumen belum ada (bersama `meta.title`, 400 `META_REQUIRED_FOR_CREATE`). */
  template?: { slug: string; version?: number };
  meta?: DocMetaV2;
  /** Bawaan: slot berulang aktif pertama (`content`); lampiran: `"appendices"`. */
  slot?: string;
  chapter: ChapterV2;
  register?: Record<string, RegisterEntry>;
  assets?: Record<string, AssetInputV2>;
  baseRevisionNo?: number;
  change?: ChangeV2;
  // D-247: tanpa `render`; build hanya lewat POST /api/studio/documents/{id}/render.
}
