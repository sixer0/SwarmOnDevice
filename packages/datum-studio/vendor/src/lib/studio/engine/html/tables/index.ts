/**
 * Modul engine/html/tables (I12, 01_specs.md §8.2), diisi S23.
 *
 * Padanan HTML himpunan DOCX S17 (keluarga tabel, 11 jenis) + S19 (chart,
 * diagram, image, symbolSheet, derivation). Fragmen memakai CSS inline sehingga
 * benar tanpa lembar gaya eksternal; kelas `st-*` adalah penanda struktur.
 * Konvensi markup S25 (D-38): `data-address` pada blok beralamat,
 * `data-figure` pada wadah figur. Semua teks di-escape; SVG tak tepercaya
 * disanitasi; aset raster sebagai data URI.
 *
 * Tidak mengimpor indeks engine/html/blocks (S22 mengimpor modul ini; D-46);
 * hanya berkas `../blocks/semantic` (tanpa impor balik ke modul ini).
 */
import type { HtmlBlockRenderer, TableBlock } from "../../../contract";
import { TABLE_BLOCK_TYPES } from "../../../contract/enums";
import { renderDerivationBlock } from "./derivation";
import { renderFigureBlock } from "./figure";
import { renderTableBlock } from "./table";
import { withAutoSpacers } from "../blocks/semantic";

export type HtmlTableFigureKey = TableBlock["type"] | "chart" | "diagram" | "image" | "symbolSheet" | "derivation";

function buildMap(): Partial<Record<HtmlTableFigureKey, HtmlBlockRenderer>> {
  const m: Partial<Record<HtmlTableFigureKey, HtmlBlockRenderer>> = {};
  for (const t of TABLE_BLOCK_TYPES) m[t] = renderTableBlock;
  m.chart = renderFigureBlock;
  m.diagram = renderFigureBlock;
  m.image = renderFigureBlock;
  m.symbolSheet = renderFigureBlock;
  m.derivation = renderDerivationBlock;
  return m;
}

/** Renderer dibungkus spacer otomatis peran (RT-01/RQ-5; opt-in `render.spacer.autoMode`). */
export const htmlTables: Partial<Record<HtmlTableFigureKey, HtmlBlockRenderer>> = withAutoSpacers(buildMap());

export { MAX_NESTED_DEPTH, tableHtml, renderTableBlock, type TableHtmlOptions } from "./table";
export { renderFigureBlock } from "./figure";
export { renderDerivationBlock } from "./derivation";
export { RENDER_DERIVATION_VERBATIM, isBenchmarkReproduction, isVerbatimDerivation, renderVerbatimDerivation } from "./reproduction";
export {
  SVG_DROPPED_ELEMENTS,
  base64DataUri,
  rasterDataUri,
  sanitizeSvg,
  sniffRasterMime,
  toBase64,
  type SvgSanitizeOptions,
  type SvgSanitizeResult,
} from "./svg";
export { captionHtml, sourceInner, sourceParagraphHtml, provenanceHtml } from "./apparatus";
