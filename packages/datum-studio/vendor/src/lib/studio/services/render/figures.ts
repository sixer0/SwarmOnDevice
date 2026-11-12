/**
 * Perakitan figur (S51): SVG per blok figur dokumen (chart S32, diagram S30,
 * lembar simbol S31) lalu PNG 300 dpi lewat `prepareFigureStore` (S19, memakai
 * `rasterizeSvg` S25) untuk DOCX; SVG yang sama dipakai HTML dan lint render.
 *
 * Spec figur boleh merujuk artefak (`{ artifactId }`): spec dibaca dari
 * StudioArtifact (sekali per job). Diagram selalu dibangun `release:false`
 * (lint tidak menahan berkas); gerbang `labels_verified` untuk tier rilis
 * dilaporkan sebagai cek lint `P1-labels_verified`.
 */
import type {
  LintIssue,
  NormBlock,
  NormDocSnapshot,
  ResolvedTemplate,
  StudioChartV1,
  StudioDiagramV1,
  StudioTier,
  SvgResult,
  SymbolDialect,
} from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { figureGrid } from "../../engine/chart/core/guards";
import type { ChartLang } from "../../engine/chart/core/lang";
import { APPARATUS_TEXT, keyLineText, wrapperLangOf, type WrapperLang } from "../../engine/front/texts";
import { type DiagramBuildOptions } from "../../engine/diagram/build";
import { buildDiagramSvgAuto } from "../../engine/diagram/elk";
import { rasterizeSvg } from "../../engine/browser";
import { prepareFigureStore, type FigureSvgSheet, type PreparedFigureStore } from "../../engine/docx/figures";
import { symbolSheetSvg, type SymbolSheetOptions } from "../../engine/symbols";
import { db } from "./db";
import { assertFigureCapacity, figureBytesIssues } from "./figure-limits";
import type { RenderJobHandle } from "./job";
import { pureChartSvg } from "./pure/chart";
import { renderVegaFigure, vegaCodeOf } from "./vega-figure";

// D-156: tipe opsi lembar simbol milik mesin (IP-42a); diekspor ulang untuk pemanggil lama.
export type { SymbolSheetOptions };

export const LABELS_VERIFIED_CHECK = "P1-labels_verified";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isArtifactRef(v: unknown): v is { artifactId: string } {
  return isRecord(v) && typeof v.artifactId === "string" && !("$schema" in v);
}

/** Pembaca spec artefak dengan cache per job. */
export class ArtifactSpecReader {
  private readonly cache = new Map<string, Promise<{ kind: string; spec: unknown }>>();

  read(artifactId: string): Promise<{ kind: string; spec: unknown }> {
    let p = this.cache.get(artifactId);
    if (!p) {
      // Swarm patch (row 109, Prisma cut; store spec M07 DROP, 01_specs_studio.md §1.2 site 1):
      // the DATUM Studio store has no standalone artifacts, so an `artifactId` reference is unknown
      // (figures are read from their inline specs only).
      p = db().then(() => {
        throw new StudioEngineError("ARTIFACT_NOT_FOUND", `artifact ${artifactId} not found`, { artifactId });
      });
      this.cache.set(artifactId, p);
    }
    return p;
  }

  async chart(spec: unknown): Promise<StudioChartV1> {
    if (isArtifactRef(spec)) {
      const a = await this.read(spec.artifactId);
      if (a.kind !== "CHART") throw new StudioEngineError("REGISTRY_KIND_UNKNOWN", `artifact ${spec.artifactId} is ${a.kind}, not CHART`);
      return a.spec as StudioChartV1;
    }
    return spec as StudioChartV1;
  }

  async diagram(spec: unknown): Promise<StudioDiagramV1> {
    if (isArtifactRef(spec)) {
      const a = await this.read(spec.artifactId);
      if (a.kind !== "DIAGRAM") throw new StudioEngineError("REGISTRY_KIND_UNKNOWN", `artifact ${spec.artifactId} is ${a.kind}, not DIAGRAM`);
      return a.spec as StudioDiagramV1;
    }
    return spec as StudioDiagramV1;
  }
}

/**
 * FIX-F C6 (D-313; aturan D-288 satu aparatus, D-145/RQ-10): blok diagram yang MERUJUK artefak
 * (`{ artifactId }`) dan membawa `keyRow` dicetak halaman dengan baris KUNCI, jadi mesin diagram tidak
 * menggambar baris KEY di SVG, sama dengan spec inline yang ditandai compose (`compose/blocks.ts`).
 * Sinyal dipasang pada salinan spec saat build (bukan medan spec artefak tersimpan, IP-80); artefak
 * mandiri (R09, `render/artifact.ts`) tidak punya baris KUNCI halaman sehingga tetap menggambar KEY.
 */
export function diagramSpecForBlock(spec: StudioDiagramV1, content: Readonly<Record<string, unknown>>): StudioDiagramV1 {
  if (!isArtifactRef(content.spec) || !content.keyRow || spec.keyRowOnPage === true) return spec;
  return { ...spec, keyRowOnPage: true };
}

/**
 * Chart tunggal (templat dokumen) atau komposit (templat bawaan eksplisit
 * `COMPOSITE_CHART_TEMPLATE`). Satu sumber dengan orkestrator murni (D-155). `lang` = bahasa dokumen (label KUNCI/KEY).
 */
export function chartSvg(spec: StudioChartV1, tpl: ResolvedTemplate, lang?: ChartLang): SvgResult {
  return pureChartSvg(spec, tpl, lang);
}

function num(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Ukuran mm SVG dari atribut akar `width/height` ber-`mm`, lalu viewBox (diasumsikan mm). */
export function svgSizeMm(svg: string, fallbackWidthMm = 128): { widthMm: number; heightMm: number } {
  const head = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const attr = (name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(head)?.[1];
  const w = attr("width");
  const h = attr("height");
  if (w && h && /mm\s*$/i.test(w) && /mm\s*$/i.test(h)) {
    const wm = num(w);
    const hm = num(h);
    if (wm && hm) return { widthMm: wm, heightMm: hm };
  }
  const vb = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { widthMm: vb[2], heightMm: vb[3] };
  return { widthMm: fallbackWidthMm, heightMm: fallbackWidthMm * 0.75 };
}

/**
 * Parameter templat lembar simbol isi-pas (D-137 opsi B, IP-42): tampilan
 * milik templat, bukan medan konten (D-139). Bawaan false = lembar blok 247 mm
 * (paritas HS Garis A); true = tinggi mengikuti isi (RL Garis B `--sheet`).
 */
export const PARAM_SYMBOL_SHEET_FIT = "symbol.sheet.fit";

/**
 * Opsi lembar simbol efektif untuk satu blok: kolom dari konten, `fit` dari templat;
 * ukuran lembar TURUNAN (D-245 H1): lebar = lebar figur blok (kelas templat, compose),
 * tinggi = `grid.textBlockHeightMm` efektif. Nilai absen = bawaan registri di mesin simbol.
 */
export function symbolSheetOptions(content: Record<string, unknown>, tpl: Pick<ResolvedTemplate, "params">): {
  dialect: SymbolDialect;
  cols: number | undefined;
  widthMm: number;
  opts: SymbolSheetOptions;
} {
  const blockWidth = typeof content.widthMm === "number" && content.widthMm > 0 ? content.widthMm : undefined;
  const blockHeight = tpl.params["grid.textBlockHeightMm"];
  const opts: SymbolSheetOptions = { fit: tpl.params[PARAM_SYMBOL_SHEET_FIT] === true };
  if (blockWidth !== undefined) opts.widthMm = blockWidth;
  if (typeof blockHeight === "number" && blockHeight > 0) opts.heightMm = blockHeight;
  return {
    dialect: content.dialect as SymbolDialect,
    cols: typeof content.cols === "number" ? content.cols : undefined,
    widthMm: blockWidth ?? 128,
    opts,
  };
}

/** SVG lembar simbol (satu per halaman) beserta ukuran mm tiap lembar. */
export function symbolSheetFigures(content: Record<string, unknown>, tpl: Pick<ResolvedTemplate, "params">): FigureSvgSheet[] {
  const o = symbolSheetOptions(content, tpl);
  return symbolSheetSvg(o.dialect, o.cols, o.opts).map((svg) => ({ svg, ...svgSizeMm(svg, o.widthMm) }));
}

export interface FigureBuild {
  store: PreparedFigureStore;
  /** Laporan SVG mesin per figur (urutan blok). */
  svgs: SvgResult[];
  /** Cek tambahan (gerbang labels_verified tier rilis). */
  extra: LintIssue[];
}

const FIGURE_TYPES: readonly string[] = ["chart", "diagram", "symbolSheet"];

/**
 * Swarm patch (row 124b, CP-35 / C69; ID p.13, p.41, p.67 Tabel 10.4): apparatus words a diagram
 * SVG draws itself, in the document language: caption label (GAMBAR / FIGURE) and key line (ID:
 * KUNCI with edge kinds by line pattern, as the HTML key row of row 123; EN: KEY as written).
 */
export function diagramApparatusOptions(lang: WrapperLang): Pick<DiagramBuildOptions, "figureLabel" | "keyLabel" | "keyRowText"> {
  const words = { figureLabel: APPARATUS_TEXT.figure[lang].toUpperCase(), keyLabel: APPARATUS_TEXT.key[lang].toUpperCase() };
  if (lang !== "ID") return words;
  return { ...words, keyRowText: (row: string) => keyLineText(row, "ID") };
}

/**
 * Bangun FigureStore untuk satu revisi. Galat per figur dicatat sebagai galat
 * job (figur dilewati; renderer DOCX/HTML melaporkan figur yang hilang).
 * Swarm 1.2.6 (row 68, T-15): galat SVG dan rasterisasi satu figur dicatat sebagai galat job (job PARTIAL), dan
 * `prepareFigureStore` menyimpan penanda FIGURE_PREPARE_FAILED untuk figur itu (`failureFor`, atau galat raster yang
 * dilempar ulang): DOCX mencetak placeholder berpenanda, HTML placeholder, verifikasi UNVERIFIED. RENDER_TIMEOUT
 * tetap menghentikan job.
 */
export async function buildFigures(i: {
  snapshot: NormDocSnapshot;
  tpl: ResolvedTemplate;
  tier: StudioTier;
  job: RenderJobHandle;
  reader: ArtifactSpecReader;
}): Promise<FigureBuild> {
  const svgs: SvgResult[] = [];
  const extra: LintIssue[] = [];
  const releaseTier = i.tier === "TERBIT" || i.tier === "SERAH";

  const failures = new Map<string, { message: string; causeCode?: string }>();
  const svgFor = async (block: NormBlock): Promise<FigureSvgSheet | readonly FigureSvgSheet[] | undefined> => {
    i.job.checkAborted("figures");
    const c = isRecord(block.content) ? block.content : {};
    const address = block.address ?? undefined;
    try {
      if (block.type === "chart") {
        const spec = await i.reader.chart(c.spec);
        // Swarm patch (row 163b, C155): V-01..V-08 (or a DF code vegaChartFor maps) -> the Vega family (async). Same
        // limits as below first; the family then applies its input limits (C8) and capacity (FIGURE_OVER_CAPACITY).
        const vega = vegaCodeOf(spec.kind);
        if (vega !== null) {
          assertFigureCapacity("chart", spec, figureBytesIssues(block.content, "/content"));
          const r = await renderVegaFigure(spec, vega, i.tpl, wrapperLangOf(i.snapshot.doc.meta));
          svgs.push(r);
          return { svg: r.svg, widthMm: r.widthMm, heightMm: r.heightMm };
        }
        // SEC-FIX / SEC-FIX2 (D-505, D-506): batas yang sama dengan rute pratinjau (spec + byte blok) SEBELUM render, agar
        // figur tersimpan sebelum batas ada (atau rujukan artefak) tidak membekukan proses HQ. Gagal -> galat figur di job.
        assertFigureCapacity("chart", spec, figureBytesIssues(block.content, "/content"));
        const r = chartSvg(spec, i.tpl, wrapperLangOf(i.snapshot.doc.meta));
        svgs.push(r);
        return { svg: r.svg, widthMm: r.widthMm, heightMm: r.heightMm };
      }
      if (block.type === "diagram") {
        const spec = diagramSpecForBlock(await i.reader.diagram(c.spec), c);
        assertFigureCapacity("diagram", spec, figureBytesIssues(block.content, "/content"));
        // D-245/D-252: grid turunan kertas (lebar sah, blok teks, kisi X) dari templat efektif.
        // Row 124b (CP-35): caption label and key words drawn inside the SVG follow the document language.
        const r = await buildDiagramSvgAuto(spec, { release: false, grid: figureGrid(i.tpl.params), ...diagramApparatusOptions(wrapperLangOf(i.snapshot.doc.meta)) });
        svgs.push(r);
        if (releaseTier) {
          extra.push({
            checkId: LABELS_VERIFIED_CHECK,
            status: spec.labels_verified === true ? "PASS" : "FAIL",
            detail: spec.labels_verified === true ? undefined : `diagram ${spec.id}: labels_verified wajib true untuk tier ${i.tier}`,
            address,
          });
        }
        return { svg: r.svg, widthMm: r.widthMm, heightMm: r.heightMm };
      }
      if (block.type === "symbolSheet") {
        return symbolSheetFigures(c, i.tpl);
      }
      return undefined;
    } catch (err) {
      const code = err instanceof StudioEngineError ? err.code : "RENDER_FAILED";
      const label = block.artifactLabel ?? i.snapshot.numbering[block.blockId] ?? block.blockId;
      i.job.addError(code, `figure ${label}${address ? ` (${address})` : ""} failed: ${err instanceof Error ? err.message : String(err)}`, undefined, err);
      // Swarm 1.2.6 (row 68, T-15): remembered so `prepareFigureStore` records the FIGURE_PREPARE_FAILED marker
      // (`failureFor`) and the DOCX prints a marked placeholder for this figure instead of aborting; the job stays
      // PARTIAL through the error above.
      failures.set(block.blockId, { message: `figure ${label} failed: ${err instanceof Error ? err.message : String(err)}`, causeCode: code });
      return undefined;
    }
  };

  // T-15 (row 68): a raster failure of one figure is recorded as a job error (PARTIAL) and rethrown to the store.
  const rasterize: NonNullable<Parameters<typeof prepareFigureStore>[1]["rasterize"]> = async (svg, o) => {
    try {
      return await rasterizeSvg(svg, o);
    } catch (err) {
      const code = err instanceof StudioEngineError ? err.code : "RENDER_FAILED";
      i.job.addError(code, `figure raster failed: ${err instanceof Error ? err.message : String(err)}`, undefined, err);
      throw err;
    }
  };

  const store = await prepareFigureStore(i.snapshot, {
    svgFor,
    failureFor: (block) => failures.get(block.blockId),
    rasterize,
    tpl: i.tpl,
    log: i.job.log.renderLog,
    fixedDate: i.snapshot.doc.meta.issueDate,
    types: FIGURE_TYPES,
  });
  return { store, svgs, extra };
}
