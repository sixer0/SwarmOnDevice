/**
 * `studio.html/v1` (01_specs.md §3.8, KT-11). Tidak ada medan HTML/CSS/JS
 * mentah. Keluaran: satu berkas, fon base64, tanpa `<script>`, tanpa URL eksternal.
 */
import type { StudioDocV1 } from "./doc";

export type StudioHtmlSource =
  | { kind: "document"; documentId: string; revisionNo?: number }
  | { kind: "artifact"; artifactId: string }
  | { kind: "inline"; document: StudioDocV1 };

export interface StudioHtmlV1 {
  $schema: "studio.html/v1";
  template: { slug: string; version?: number };
  source: StudioHtmlSource;
  options?: { paged: boolean; embedFonts: true; previewLabel?: boolean };
}
