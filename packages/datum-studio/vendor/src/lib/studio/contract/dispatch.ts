/**
 * Dispatcher statis milik kontrak (01_specs.md §8.3 D01). KHUSUS SERVER.
 *
 * Impor statis indeks I05-I08, I11-I12, I17-I19, I22-I33 dan menggabungkan
 * peta renderer. Modul mesin TIDAK mengimpor berkas ini kecuali I09 (docx
 * assemble), I13 (html assemble), I20 (diagram build), I22 (chart core).
 *
 * Siklus impor: chart/core (I22) mengimpor dispatch, dan dispatch mengimpor
 * chart/core. Agar aman di ESM (TDZ) maupun CJS (ekspor belum terisi), setiap
 * peta dibangun MALAS saat pertama dibaca (Proxy hanya-baca), sehingga nilai
 * modul lain sudah terinisialisasi. Konsumen memakai peta seperti objek biasa
 * (`DOCX_RENDERERS[type]`, `{ ...CHART_RENDERERS }`, `Object.keys(...)`).
 */
import { docxBlocks } from "../engine/docx/blocks";
import { docxFigures } from "../engine/docx/figures";
import { docxTables } from "../engine/docx/tables";
import { docxWrapper } from "../engine/docx/wrapper";
import { htmlBlocks } from "../engine/html/blocks";
import { htmlTables } from "../engine/html/tables";
import { layoutFlow, layoutLayered } from "../engine/diagram/layout-a";
import { layoutSequence, layoutSwimlane } from "../engine/diagram/layout-b";
import { layoutGraph, layoutRack, layoutSld } from "../engine/diagram/layout-c";
import { chartCore } from "../engine/chart/core";
import { chartFamilyP1 } from "../engine/chart/family-p1";
import { chartFamilyP2 } from "../engine/chart/family-p2";
import { chartFamilyH1 } from "../engine/chart/family-h1";
import { chartFamilyH2 } from "../engine/chart/family-h2";
import { chartFamilyK1 } from "../engine/chart/family-k1";
import { chartFamilyK2 } from "../engine/chart/family-k2";
import { chartFamilyW1 } from "../engine/chart/family-w1";
import { chartFamilyW2 } from "../engine/chart/family-w2";
import { chartFamilyS1 } from "../engine/chart/family-s1";
import { chartFamilyS2 } from "../engine/chart/family-s2";
import { chartFamilyG } from "../engine/chart/family-g";
import type { ChartRendererMap, DocxBlockRenderer, HtmlBlockRenderer, LayoutFn } from "./engine";
import { BLOCK_TYPES, DRAWN_CHART_CODES, STRUCTURAL_TYPES, type DiagramFamily } from "./enums";

export type DocxRendererMap = Readonly<Partial<Record<string, DocxBlockRenderer>>>;
export type HtmlRendererMap = Readonly<Partial<Record<string, HtmlBlockRenderer>>>;

/** Objek hanya-baca yang isinya dibangun saat properti pertama kali dibaca. */
function lazyMap<T extends object>(build: () => T): T {
  let cache: T | null = null;
  const real = (): T => {
    if (!cache) cache = Object.freeze(build());
    return cache;
  };
  return new Proxy({} as T, {
    get: (_t, key) => Reflect.get(real(), key),
    has: (_t, key) => Reflect.has(real(), key),
    ownKeys: () => Reflect.ownKeys(real()),
    getOwnPropertyDescriptor: (_t, key) => {
      const d = Reflect.getOwnPropertyDescriptor(real(), key);
      return d ? { ...d, configurable: true } : undefined;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

export const DOCX_RENDERERS: DocxRendererMap = lazyMap(() => ({
  ...docxBlocks,
  ...docxTables,
  ...docxWrapper,
  ...docxFigures,
}));

export const HTML_RENDERERS: HtmlRendererMap = lazyMap(() => ({ ...htmlBlocks, ...htmlTables }));

/** stack/topology memakai layered (I17). */
export const DIAGRAM_LAYOUTS: Readonly<Record<DiagramFamily, LayoutFn>> = lazyMap(() => ({
  layered: layoutLayered,
  topology: layoutLayered,
  stack: layoutLayered,
  flow: layoutFlow,
  swimlane: layoutSwimlane,
  sequence: layoutSequence,
  sld: layoutSld,
  rack: layoutRack,
  graph: layoutGraph,
}));

export const CHART_RENDERERS: Readonly<ChartRendererMap> = lazyMap(() => ({
  ...chartCore,
  ...chartFamilyP1,
  ...chartFamilyP2,
  ...chartFamilyH1,
  ...chartFamilyH2,
  ...chartFamilyK1,
  ...chartFamilyK2,
  ...chartFamilyW1,
  ...chartFamilyW2,
  ...chartFamilyS1,
  ...chartFamilyS2,
  ...chartFamilyG,
}));

/** Kunci renderer blok yang diharapkan (BlockType ∪ StructuralType = 31). */
export const EXPECTED_BLOCK_RENDERER_KEYS: readonly string[] = Array.from(
  new Set<string>([...BLOCK_TYPES, ...STRUCTURAL_TYPES]),
);

/** Daftar yang BELUM terisi (dipakai uji S72/S73). */
export function dispatchCoverage(): { docx: string[]; html: string[]; charts: string[] } {
  return {
    docx: EXPECTED_BLOCK_RENDERER_KEYS.filter((k) => typeof DOCX_RENDERERS[k] !== "function"),
    html: EXPECTED_BLOCK_RENDERER_KEYS.filter((k) => typeof HTML_RENDERERS[k] !== "function"),
    charts: DRAWN_CHART_CODES.filter((c) => typeof CHART_RENDERERS[c] !== "function"),
  };
}
