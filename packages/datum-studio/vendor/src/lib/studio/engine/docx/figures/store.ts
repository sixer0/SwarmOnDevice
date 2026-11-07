/**
 * Persiapan FigureStore untuk perakitan DOCX (S19): renderer blok DOCX bersifat
 * sinkron, sedangkan rasterisasi PNG 300 dpi lewat layanan browser (S25,
 * `rasterizeSvg`) asinkron. Perakit S20 / layanan render S51 memanggil
 * `prepareFigureStore` sekali per revisi, lalu meneruskan hasilnya sebagai
 * `ctx.figures`.
 *
 * Sumber SVG disuntikkan (`svgFor`) agar modul ini tidak mengimpor
 * chart/diagram/symbols (mencegah siklus impor dengan dispatcher D01):
 * pemanggil memetakan `chart` -> `renderChart`, `diagram` -> `buildDiagramSvg`,
 * `symbolSheet` -> `symbolSheetSvg` (beberapa lembar). Rasterisasi berurutan
 * (semafor browser = 1). Kunci = label artefak ("Gambar n.m"), lalu blockId;
 * lembar ke-n >= 2 berkunci `<kunci>#<n>`.
 */
import type { FigureStore, NormBlock, NormDocSnapshot, RenderLogEntry, ResolvedTemplate } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { rasterizeSvg } from "../../browser";
import { FIGURES_MODULE } from "./log";
import { figureStoreKeys, sheetKey } from "./figure";

export interface FigureSvgSheet {
  svg: string;
  widthMm: number;
  heightMm: number;
}

export interface FigureStoreEntry {
  svg?: string;
  png?: Uint8Array;
  widthMm: number;
  heightMm: number;
}

export interface PrepareFigureStoreOptions {
  /** SVG per blok figur (`chart`, `diagram`, `symbolSheet`; `image` opsional). undefined = lewati. */
  svgFor: (block: NormBlock) => FigureSvgSheet | readonly FigureSvgSheet[] | undefined | Promise<FigureSvgSheet | readonly FigureSvgSheet[] | undefined>;
  /** Default: `rasterizeSvg` engine/browser (S25). */
  rasterize?: (svg: string, i: { widthMm: number; heightMm: number; dpi: 300; tpl?: ResolvedTemplate }) => Promise<Uint8Array>;
  /** IMPL-W4 (review 15 F4): templat dokumen; aset fon templat dipakai untuk fon tertanam raster. */
  tpl?: ResolvedTemplate;
  log: (e: RenderLogEntry) => void;
  /** Cap waktu deterministik log (meta.issueDate). */
  fixedDate?: string;
  /** Jenis blok yang dirasterisasi. Default chart, diagram, symbolSheet. */
  types?: readonly string[];
}

export interface PreparedFigureStore extends FigureStore {
  /** Entri terurut kunci (untuk penulisan berkas figur S52 dan uji). */
  entries(): ReadonlyArray<readonly [string, FigureStoreEntry]>;
}

const DEFAULT_TYPES: readonly string[] = ["chart", "diagram", "symbolSheet"];

/** FigureStore dari peta siap pakai (mis. PNG yang sudah ada di penyimpanan). */
export function figureStoreFromMap(map: ReadonlyMap<string, FigureStoreEntry>): PreparedFigureStore {
  const frozen = new Map(map);
  return {
    get: (label) => frozen.get(label),
    entries: () => [...frozen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

function widthOf(block: NormBlock): number | undefined {
  const c = block.content as { widthMm?: unknown } | null;
  return c && typeof c.widthMm === "number" ? c.widthMm : undefined;
}

export async function prepareFigureStore(snapshot: NormDocSnapshot, opts: PrepareFigureStoreOptions): Promise<PreparedFigureStore> {
  const rasterize = opts.rasterize ?? rasterizeSvg;
  const types = opts.types ?? DEFAULT_TYPES;
  const map = new Map<string, FigureStoreEntry>();

  for (const block of snapshot.blocks) {
    if (!types.includes(block.type)) continue;
    const address = block.address ?? undefined;
    const keys = figureStoreKeys(block, snapshot.numbering);
    const key = keys[0];
    try {
      const got = await opts.svgFor(block);
      if (!got) continue;
      const sheets: readonly FigureSvgSheet[] = Array.isArray(got) ? got : [got as FigureSvgSheet];
      // Lebar terpasang blok menang (128/166 mm); tinggi diskalakan proporsional.
      const placedW = widthOf(block);
      for (let i = 0; i < sheets.length; i++) {
        const s = sheets[i];
        const widthMm = placedW ?? s.widthMm;
        const heightMm = (s.heightMm * widthMm) / s.widthMm;
        const png = await rasterize(s.svg, { widthMm, heightMm, dpi: 300, ...(opts.tpl ? { tpl: opts.tpl } : {}) });
        map.set(sheetKey(key, i + 1), { svg: s.svg, png, widthMm, heightMm });
      }
    } catch (e) {
      const code = e instanceof StudioEngineError ? e.code : "BY_CONSTRUCTION_FAILED";
      const message = `${FIGURES_MODULE}: figur ${key} gagal disiapkan: ${e instanceof Error ? e.message : String(e)}`;
      opts.log({ level: "error", message, code, address, at: opts.fixedDate });
      if (e instanceof StudioEngineError) throw e;
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", message);
    }
  }
  return figureStoreFromMap(map);
}
