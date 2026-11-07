/**
 * Modul engine/docx/figures (I08, 01_specs.md §8.2), diisi S19.
 *
 * `docxFigures`: renderer DOCX blok `chart`, `diagram`, `image`, `symbolSheet`
 * (caption di atas, `wp:inline` berukuran mm tepat, KUNCI, SUMBER + PROVENANS)
 * dan `derivation` (diperiksa terhadap register lewat engine/bind S12;
 * `render.derivation.renderer` monoLines | nestedTable).
 *
 * Ekspor pendukung untuk perakit S20 / layanan render S51:
 * - `prepareFigureStore`: rasterisasi PNG 300 dpi lewat engine/browser (S25)
 *   sebelum renderer sinkron dipanggil;
 * - `mergeFigureMedia`, `figureMediaRelId`, `FIGURE_IMAGE_REL_TYPE`: media
 *   bernama `fig-<sha256>.<ext>` di `word/media/` dengan relasi deterministik.
 *
 * Modul khusus server (node:crypto, node:fs).
 */
import type { DocxBlockRenderer } from "../../../contract";
import { renderDerivation } from "./derivation";
import { renderChartFigure, renderDiagramFigure, renderImageFigure, renderSymbolSheetFigure } from "./figure";

export type DocxFigureKey = "chart" | "diagram" | "image" | "symbolSheet" | "derivation";

export const docxFigures: Partial<Record<DocxFigureKey, DocxBlockRenderer>> = {
  chart: renderChartFigure,
  diagram: renderDiagramFigure,
  image: renderImageFigure,
  symbolSheet: renderSymbolSheetFigure,
  derivation: renderDerivation,
};

export { captionXml, figureStoreKeys, keyRowXml, sheetKey, sourceLineXml, type FigureBlockType } from "./figure";
export { derivationId, renderDerivation, type DerivationRenderer } from "./derivation";
export {
  FIGURE_IMAGE_REL_TYPE,
  figureMediaName,
  figureMediaRelId,
  mergeFigureMedia,
  sha256Hex,
  sniffImage,
  type FigureImage,
  type FigureMediaEntry,
  type FigureMime,
} from "./media";
export { FIGURE_DESCR_MAX, FIGURE_NAME_MAX, FIGURE_NAME_SEPARATOR, figureAltText, normalizeAltText, shortenAtWord, stripSourceLabel, type FigureAltInput, type FigureAltText } from "../../front/alt-text";
export { DOCPR_ID_BASE, EMU_PER_MM, inlineDrawingXml, mmToEmu, type InlineDrawing } from "./ooxml";
export { FIGURE_LABELS, FIGURE_LABEL_SPACING, figureRole } from "./defaults";
export {
  figureStoreFromMap,
  prepareFigureStore,
  type FigureStoreEntry,
  type FigureSvgSheet,
  type PrepareFigureStoreOptions,
  type PreparedFigureStore,
} from "./store";
