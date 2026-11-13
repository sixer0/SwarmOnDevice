/**
 * FIG-03b — pratinjau SATU figur (chart/diagram) tanpa tulis apa pun (D-322: Studio tidak menulis ke
 * workspace bersama; tanpa job, tanpa berkas, tanpa baris DB).
 *
 * Murni (tanpa Prisma, kecuali rujukan `{ artifactId }` yang dibaca lewat `ArtifactSpecReader` layanan
 * render): blok figur dicari di snapshot revisi (alamat `3.1.4`, label `Gambar 3.1`, atau pid), lalu
 * dirender dengan jalur yang SAMA dengan render dokumen (`buildFigures`, `services/render/figures.ts`):
 * chart -> `chartSvg(spec, tpl)`, diagram -> `buildDiagramSvg(spec, { release: false, grid })`, dengan
 * `tpl` = templat tersemat revisi + override dokumen (`templateForDoc`). Blok inline (fragmen v2
 * `chart`/`diagram`) disusun dengan `mapBlock` compose memakai konteks compose tersimpan di snapshot
 * (`snapshot.compose`: parameter slot), sehingga lebar dan id figur sama dengan kiriman nyata.
 *
 * Swarm port (row 31c): clone C/src/app/api/studio/documents/[id]/figures/preview/_lib/figure.ts, verbatim
 * apart from `./limits` -> services/render/figure-limits (what ./limits re-exports). `ArtifactSpecReader`
 * is row 109's: an `{ artifactId }` reference is ARTIFACT_NOT_FOUND (store M07 has no artifacts).
 */
import type { AnyNormSnapshot, BlockV2, NormBlock, ResolvedTemplate, StudioChartV1, StudioDiagramV1, SvgResult } from "@/lib/studio/contract";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import { applyChartIntent, orientationTarget } from "@/lib/studio/engine/chart/core";
import { figureGrid } from "@/lib/studio/engine/chart/core/guards";
import type { ChartLang } from "@/lib/studio/engine/chart/core/lang";
import { buildDiagramSvgAuto } from "@/lib/studio/engine/diagram/elk";
import { placeDiagram, type DiagramBuildOptions, type DiagramBuildReport } from "@/lib/studio/engine/diagram/build";
import { routeLattice, viaFamily, type RouteLattice } from "@/lib/studio/engine/diagram/build/route";
import { Sheet } from "@/lib/studio/engine/diagram/core";
import { resolveDiagramGrid } from "@/lib/studio/engine/diagram/core/grid";
import { DIAGRAM_LAYOUTS } from "@/lib/studio/contract/dispatch";
import { APPARATUS_TEXT, provenanceMarkLabelText } from "@/lib/studio/engine/front/texts";
import { glyphSet, mapBlock, storedComposeContext } from "@/lib/studio/services/compose";
import { templateForDoc } from "@/lib/studio/services/render/common";
import { ArtifactSpecReader, chartSvg, diagramApparatusOptions, diagramSpecForBlock } from "@/lib/studio/services/render/figures";
import { capacityMessage, figureBytesIssues, figureCapacityIssuesFor, type CapacityIssue } from "@/lib/studio/services/render/figure-limits";
import { renderVegaFigure, vegaCodeOf } from "@/lib/studio/services/render/vega-figure";
import { figureFileName, inlineText } from "@/lib/studio/services/render/naming";
import { rasterizeSvg } from "@/lib/studio/engine/browser";

export const FIGURE_TYPES: ReadonlySet<string> = new Set(["chart", "diagram"]);
/** Batas isu yang dikembalikan (hasil kecil; jumlah penuh di `issueCount`). */
export const PREVIEW_ISSUE_CAP = 40;
const DETAIL_MAX = 600;

export interface FigureTarget {
  pid?: string;
  address?: string;
}

export interface PreviewIssue {
  checkId: string;
  status: string;
  detail: string | null;
  suggest: string | null;
  /** `engine` = saran mesin (GEOM_*); `hint` = saran baku route untuk catatan tata letak tanpa saran mesin. */
  suggestSource: "engine" | "hint" | null;
  /** Catatan informatif (bukan cacat tata letak), mis. DATUM-36 aparatus dicetak halaman. */
  info: boolean;
}

/**
 * Catatan mesin yang informatif, bukan masalah tata letak (tidak dihitung `layoutIssueCount`). SEC-FIX (D-502 Low 10):
 * `INTENT_APPLIED` = maksud agen (topN/sort/orientation/labelShort) BERHASIL diterapkan, dan `CAPACITY_ADAPT` = tata
 * letak diagram beradaptasi dan lolos lint; keduanya bukan alasan merevisi. `HINT_IGNORED` tetap dihitung (medan
 * maksud tidak berlaku untuk kode itu: agen perlu membuangnya).
 */
// Row 163b: VEGA_ENGINE = which Vega engine drew the chart (informative, not a layout issue).
export const INFO_CODES: ReadonlySet<string> = new Set(["DATUM-36", "FIGURE_LIMITS_DEFAULT", "PARAM_ALIAS", "AUTO_FIT", "INTENT_APPLIED", "CAPACITY_ADAPT", "VEGA_ENGINE"]);

/**
 * Swarm 1.2.6 row 73 (W-03, register N-020): class of a preview issue. A notice = the engine already adapted the
 * layout (lanes, moved labels, auto fit, ELK); a defect = something the agent must fix (caption wrap, leader lines,
 * text outside, every `GEOM_*`, a serialised legacy flow). Codes not listed: `GEOM_*` and any FAIL are defects,
 * `INFO_CODES` are notices, anything else is a defect (seen, not hidden). See {@link previewIssueClass}.
 */
export const PREVIEW_ISSUE_CLASS: Readonly<Record<string, "notice" | "defect">> = {
  EDGE_LANES: "notice",
  LABEL_MOVED: "notice",
  AUTO_FIT: "notice",
  VALUE_LABEL_MOVED: "notice",
  ELK_LAYOUT: "notice",
  AUTO_ORIENT: "notice",
  AXIS_TICK_THIN: "notice",
  AXIS_LABEL_WRAP: "notice",
  AXIS_LABEL_ROTATE: "notice",
  AXIS_WIDENED: "notice",
  LEGEND_WRAP: "notice",
  RADIAL_LABEL_MOVED: "notice",
  CONTOUR_LABEL_MOVED: "notice",
  VENN_LABEL_WRAP: "notice",
  LABEL_HALO: "notice",
  CAPTION_WRAP: "defect",
  CAPTION_TRUNCATED: "defect",
  LABEL_LEADER: "defect",
  LABEL_DROPPED: "defect",
  TEXT_OUTSIDE: "defect",
  FLOW_SERIALISED: "defect",
};

/**
 * Swarm 1.2.7 row 37 (N-6/F-6, register N7-069, decision C3): the three connector-end (T-03) preview codes, in this
 * order. Values = engine `CHECK` codes of `edgeEntryCollision`, `stubSegment`, `arrowTangent`
 * (V engine/diagram/build/autofit.ts); after render they fail FIGURE_FIT as `FIG_GEOMETRY`. Class stays "defect"
 * (`GEOM_*`, {@link previewIssueClass}). Scope: fires on hand-drawn or imported SVG; engine layouts keep connector
 * ends at least 1.5 mm apart, so on an engine-built figure STUB or TANGENT is the usual one. No check reorder.
 */
export const GEOM_T03_CODES = ["GEOM_ENTRY_COLLISION", "GEOM_STUB_SEGMENT", "GEOM_ARROW_TANGENT"] as const;

/** Row 73 (W-03): class of one issue: FAIL and `GEOM_*` are always defects; then the table; then INFO_CODES -> notice. */
export function previewIssueClass(checkId: string, status?: string): "notice" | "defect" {
  if (status === "FAIL" || checkId.startsWith("GEOM_")) return "defect";
  return PREVIEW_ISSUE_CLASS[checkId] ?? (INFO_CODES.has(checkId) ? "notice" : "defect");
}

/** Row 73 (W-03, N-021/N-022): the issue list split into notices and defects (order kept). */
export function splitPreviewIssues<T extends { checkId: string; status: string }>(issues: readonly T[]): { notices: T[]; defects: T[] } {
  const notices: T[] = [];
  const defects: T[] = [];
  for (const i of issues) (previewIssueClass(i.checkId, i.status) === "notice" ? notices : defects).push(i);
  return { notices, defects };
}

/**
 * Saran baku untuk catatan tata letak yang tidak membawa `suggest` dari mesin (medan maksud D-482: `orientation`,
 * `sort`, `topN` + `otherLabel`, `labelShort`). Teks milik Studio, bukan isi dokumen.
 */
export const FIT_HINTS: Readonly<Record<string, string>> = {
  AUTO_ORIENT: "label kategori tidak muat sebagai kolom: persingkat label (labelShort) atau tetapkan orientation horizontal",
  LABEL_GUTTER: "talang label lebar mempersempit area plot: persingkat label kategori (labelShort)",
  LABEL_DROPPED: "label disembunyikan karena tidak ada ruang: kurangi kategori (topN + otherLabel), persingkat label, atau pisah gambar",
  VALUE_LABEL_MOVED: "label nilai digeser agar tidak bertumpuk; bila masih padat kurangi kategori (topN)",
  AXIS_TICK_THIN: "tick sumbu dijarangkan: persingkat label kategori atau kurangi kategori (topN)",
  AXIS_LABEL_WRAP: "label sumbu dibungkus: persingkat label (labelShort)",
  AXIS_LABEL_ROTATE: "label sumbu diputar agar muat: persingkat label kategori (labelShort) atau kurangi kategori (topN)",
  AXIS_WIDENED: "domain sumbu diperlebar agar memuat semua data; periksa batas sumbu yang dikirim",
  CAPTION_WRAP: "keterangan panjang dibungkus: persingkat caption",
  CAPTION_TRUNCATED: "keterangan dipotong: persingkat caption",
  LEGEND_WRAP: "legenda dibungkus: persingkat nama seri",
  RADIAL_LABEL_MOVED: "label lingkar digeser; persingkat label bila masih padat",
  CONTOUR_LABEL_MOVED: "label kontur digeser; kurangi tingkat bila masih padat",
  VENN_LABEL_WRAP: "nama himpunan dibungkus: persingkat nama himpunan",
  LABEL_HALO: "label diberi halo agar terbaca di atas garis; persingkat label bila masih padat",
};

export interface FigurePreview {
  type: "chart" | "diagram";
  /** Kode chart (`P-02`) atau keluarga diagram. */
  code: string | null;
  pid: string | null;
  address: string | null;
  label: string | null;
  inline: boolean;
  size: { widthMm: number; heightMm: number; svgBytes: number };
  issues: PreviewIssue[];
  /** Row 73 (W-03, N-021): issues of class notice (engine adapted; no action needed), capped like `issues`. */
  notices: PreviewIssue[];
  /** Row 73 (W-03, N-022): issues of class defect (fix before delivery), capped like `issues`. */
  defects: PreviewIssue[];
  issueCount: number;
  /** Isu tanpa catatan informatif (`info: false`). */
  layoutIssueCount: number;
  checksRun: number;
  /** Ringkasan data MASUKAN (sebelum maksud/autofit). */
  data: { shape: string; items: number; maxLabelChars: number } | null;
  /**
   * SEC-FIX (D-502 Low 11): yang BENAR-BENAR dirender (chart): kode akhir (sesudah `orientation`/AUTO_ORIENT, dari
   * atribut `data-chart` SVG), arahnya, dan butir sesudah `topN`/`labelShort`. null untuk diagram.
   */
  rendered: { code: string | null; orientation: "horizontal" | "vertical" | null; shape: string; items: number; maxLabelChars: number } | null;
  svg?: string;
  /**
   * Row 165C (F56-3): set when the figure was drawn stand-alone (`standalone: true`): the figure number and title
   * the SVG prints, and the DATUM figure file name stem (`Gambar <n> <Judul>`, naming.ts figureFileName).
   */
  standalone?: { id: string; title: string; fileName: { svg: string; png: string }; furniture?: NonNullable<DiagramBuildReport["furniture"]> };
  /** Row 165C (F56-3): base64 PNG (300 dpi) of the stand-alone figure, only with `png: true`. */
  png?: string;
  /**
   * Swarm 1.2.8 row 56b (VIS-6, R18-5, OP-18-3, register N8-472): the layout lattice of a diagram whose family takes
   * `via` (flow without direction, graph, swimlane), so an author can choose bend points: lattice size in mm, sheet size
   * in lattice units and each node's cell `[col0, row0, col1, row1]`. Structured content only (no text line).
   */
  lattice?: RouteLattice;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (code: ConstructorParameters<typeof StudioEngineError>[0], message: string, details?: unknown): never => {
  throw new StudioEngineError(code, message, details);
};

/** Blok snapshot untuk pid / alamat / label artefak; bukan figur -> 422 BLOCK_TYPE_NOT_ADMITTED. */
export function findFigureBlock(snapshot: AnyNormSnapshot, t: FigureTarget): NormBlock & { pid?: string; slotKey?: string } {
  const blocks = snapshot.blocks as Array<NormBlock & { pid?: string; slotKey?: string }>;
  const hit =
    t.pid !== undefined
      ? blocks.find((b) => b.pid === t.pid || (b.pid === undefined && b.blockId === t.pid))
      : blocks.find((b) => b.address === t.address || (b.artifactLabel !== undefined && b.artifactLabel === t.address));
  if (!hit) {
    return t.pid !== undefined ? fail("PID_NOT_FOUND", `Pid ${t.pid} tidak ada pada revisi ini`, { pid: t.pid }) : fail("ADDRESS_NOT_FOUND", "Address not found in revision", { address: t.address });
  }
  if (!FIGURE_TYPES.has(hit.type)) fail("BLOCK_TYPE_NOT_ADMITTED", `Blok ${hit.address ?? hit.blockId} berjenis ${hit.type}; pratinjau figur hanya untuk chart dan diagram`, { type: hit.type });
  return hit;
}

/** Fragmen v2 inline -> blok internal (compose) dengan parameter slot sasaran (atau parameter dokumen). */
export function composeInlineBlock(
  snapshot: AnyNormSnapshot,
  block: BlockV2,
  near: { pid?: string; slotKey?: string; artifactLabel?: string; address?: string | null } | null,
): NormBlock & { pid?: string } {
  const ctx = storedComposeContext(snapshot);
  if (!ctx) fail("SCHEMA_INVALID", "Pratinjau blok inline hanya untuk dokumen v2 (snapshot tanpa konteks compose)", [{ pointer: "/block", keyword: "const", message: "document must be studio.doc/v2" }]);
  const c = ctx as NonNullable<typeof ctx>;
  const params = (near?.slotKey !== undefined ? c.slotParams?.[near.slotKey] : undefined) ?? c.params;
  const doc: Rec = isRec(snapshot.doc) ? (snapshot.doc as unknown as Rec) : {};
  const meta: Rec = isRec(doc.meta) ? doc.meta : {};
  const pid = near?.pid ?? "preview";
  const content = mapBlock(block, pid, {
    glyphs: glyphSet(c.params["render.run.symbolGlyphs"]),
    params,
    classification: typeof meta.classification === "string" ? meta.classification : "",
    ...(near?.artifactLabel !== undefined ? { artifactLabel: near.artifactLabel } : {}),
  });
  return {
    blockId: pid,
    ...(near?.pid !== undefined ? { pid: near.pid } : {}),
    address: near?.address ?? null,
    ordinal: 0,
    unitKey: "",
    type: block.type,
    content,
    textPlain: "",
    contentSha256: "",
    ...(near?.artifactLabel !== undefined ? { artifactLabel: near.artifactLabel } : {}),
  };
}

/** Templat efektif render (templat tersemat + override dokumen), sama dengan orkestrator render. */
export function effectiveTemplate(base: ResolvedTemplate, snapshot: AnyNormSnapshot): ResolvedTemplate {
  const quiet = { warn: () => undefined, info: () => undefined };
  return templateForDoc(base, snapshot.doc, quiet);
}

function labelsOf(data: Rec): string[] {
  const pick = (xs: unknown, k: string) => (Array.isArray(xs) ? xs.filter(isRec).map((x) => String(x[k] ?? "")) : []);
  switch (data.shape) {
    case "categorical":
    case "xy":
      return pick(data.points, "label");
    case "series":
      return Array.isArray(data.categories) ? data.categories.map(String) : [];
    case "intervals":
      return pick(data.items, "label");
    case "matrix":
      return [...(Array.isArray(data.rows) ? data.rows : []), ...(Array.isArray(data.cols) ? data.cols : [])].map(String);
    case "graph":
      return pick(data.nodes, "label");
    case "distribution":
      return pick(data.groups, "name");
    case "sets":
      return pick(data.sets, "name");
    // Swarm patch (row 163b, C155): Vega family shapes.
    case "days":
      return pick(data.days, "date");
    case "hierarchy":
      return pick(data.nodes, "label");
    default:
      return [];
  }
}

/** Ringkasan data chart (jumlah butir, label terpanjang) untuk memandu revisi; null untuk diagram. */
export function dataSummary(spec: StudioChartV1): FigurePreview["data"] {
  const data = isRec((spec as unknown as Rec).data) ? ((spec as unknown as Rec).data as Rec) : null;
  if (!data) return null;
  const labels = labelsOf(data);
  return { shape: String(data.shape ?? ""), items: labels.length, maxLabelChars: labels.reduce((m, l) => Math.max(m, [...l].length), 0) };
}

/**
 * Isu pratinjau: `report.issues` (chart: REPORT FIG-02a/02c termasuk GEOM_* bersaran) ditambah `report.geometry`
 * diagram (FIG-02b: REPORT + `suggest`, sengaja di luar `issues`), urutan: issues lalu geometry.
 */
function issuesOf(r: SvgResult): PreviewIssue[] {
  const geometry = (r.report as { geometry?: unknown }).geometry;
  const extra = Array.isArray(geometry) ? (geometry.filter((g) => isRec(g) && typeof g.checkId === "string") as unknown as SvgResult["report"]["issues"]) : [];
  return [...r.report.issues, ...extra]
    .filter((i) => i.status !== "PASS")
    .map((i) => {
      const s = (i as { suggest?: unknown }).suggest;
      const hint = FIT_HINTS[i.checkId];
      const suggest = typeof s === "string" ? s.slice(0, DETAIL_MAX) : (hint ?? null);
      const suggestSource = typeof s === "string" ? "engine" : hint !== undefined ? "hint" : null;
      return { checkId: i.checkId, status: i.status, detail: i.detail !== undefined ? i.detail.slice(0, DETAIL_MAX) : null, suggest, suggestSource, info: INFO_CODES.has(i.checkId) };
    });
}

/** Blok figur dengan spec terselesaikan (rujukan `artifactId` sudah dibaca), siap dicek batas lalu dirender. */
export type ResolvedFigure = { block: NormBlock & { pid?: string }; type: "chart"; spec: StudioChartV1 } | { block: NormBlock & { pid?: string }; type: "diagram"; spec: StudioDiagramV1 };

/** Selesaikan spec blok figur (chart/diagram; `{ artifactId }` dibaca lewat `ArtifactSpecReader`), tanpa render. */
export async function resolveFigure(block: NormBlock & { pid?: string }, reader: ArtifactSpecReader = new ArtifactSpecReader()): Promise<ResolvedFigure> {
  const c = isRec(block.content) ? block.content : {};
  if (block.type === "chart") return { block, type: "chart", spec: await reader.chart(c.spec) };
  return { block, type: "diagram", spec: diagramSpecForBlock(await reader.diagram(c.spec), c) };
}

/** SEC-FIX M-1: pelanggaran batas kardinalitas spec terselesaikan ([] = boleh dirender). */
export function figureCapacityIssues(f: ResolvedFigure): CapacityIssue[] {
  // SEC-FIX2 (D-506): ukuran serial blok (caption/sumber/baris kunci ikut) + semua larik/string spec.
  return [...figureBytesIssues(f.block.content, "/block"), ...figureCapacityIssuesFor(f.type, f.spec)];
}

/** Galat batas (422 BY_CONSTRUCTION_FAILED, `details.checkId = FIGURE_CAPACITY`) untuk pemanggil langsung. */
export function capacityError(f: ResolvedFigure, issues: CapacityIssue[]): StudioEngineError {
  return new StudioEngineError("BY_CONSTRUCTION_FAILED", capacityMessage(f.type, issues), { checkId: "FIGURE_CAPACITY", issues });
}

/** Kode akhir chart dari atribut akar `data-chart` SVG (sesudah orientation/AUTO_ORIENT). */
function renderedCodeOf(svg: string): string | null {
  const head = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  return /\bdata-chart="([^"]{1,40})"/.exec(head)?.[1] ?? null;
}

function orientationOf(code: string | null): "horizontal" | "vertical" | null {
  if (code === null) return null;
  if (orientationTarget(code, "vertical") !== null) return "horizontal";
  if (orientationTarget(code, "horizontal") !== null) return "vertical";
  return null;
}

/** Ringkasan hasil render chart: kode akhir + arah + data sesudah maksud (topN/labelShort/sort). */
function renderedSummary(spec: StudioChartV1, tpl: ResolvedTemplate, svg: string): NonNullable<FigurePreview["rendered"]> {
  const code = renderedCodeOf(svg) ?? (typeof spec.kind === "string" ? spec.kind : null);
  // Maksud diterapkan ulang (deterministik, O(n); render yang sama baru saja lolos) hanya untuk ringkasan butir.
  const applied = spec.intent !== undefined ? applyChartIntent(spec, tpl).spec : spec;
  const d = dataSummary(applied) ?? { shape: "", items: 0, maxLabelChars: 0 };
  return { code, orientation: orientationOf(code), ...d };
}

/** Row 165C (F56-3): figure number of a block label (`Gambar 4.1` / `Figure 4.1` -> `4.1`), null when it has none. */
export function figureNumberOf(label: string | null | undefined): string | null {
  const m = typeof label === "string" ? /(\d+(?:\.\d+)+)\s*$/.exec(label.trim()) : null;
  return m ? m[1] : null;
}

/**
 * Swarm patch (row 165C, F56-3; decision C189): the stand-alone figure of the original Studio (case 04:
 * `studio.diagram/v1` with `apparatus: "figure"`, render_cli). A document diagram block is drawn with apparatus
 * "page" (its page prints caption, KUNCI and SUMBER); stand-alone, the SVG carries them itself (engine figure branch,
 * build/svg.ts): `apparatus: "figure"`, `id` = the figure number (the engine adds the GAMBAR/FIGURE word), `title` =
 * the block caption, the key drawn in the SVG (`keyRowOnPage` dropped). The v2 block schema still forbids
 * `apparatus`/`id`/`title` in a block (forbidden.ts DF-37): they are derived here, never sent by the agent.
 */
export function standaloneDiagramSpec(spec: StudioDiagramV1, block: NormBlock & { pid?: string }): StudioDiagramV1 {
  const c = isRec(block.content) ? block.content : {};
  const id = figureNumberOf(block.artifactLabel) ?? figureNumberOf(typeof spec.id === "string" ? spec.id : null);
  if (id === null) fail("SCHEMA_INVALID", "Gambar mandiri butuh nomor gambar (blok tanpa label Gambar n.m)", [{ pointer: "/standalone", keyword: "required", message: "figure number" }]);
  const cap = inlineText(c.caption as Parameters<typeof inlineText>[0]).trim();
  const title = cap || (typeof spec.title === "string" ? spec.title.trim() : "");
  const out: StudioDiagramV1 & { keyRowOnPage?: boolean } = { ...spec, apparatus: "figure", id: id as string, title: /[.!?]$/.test(title) ? title : `${title}.` };
  delete out.keyRowOnPage;
  return out;
}

const PROVENANCE_MARK_ORDER = ["TERUKUR", "DITURUNKAN", "PEMASOK", "ASUMSI"] as const

/**
 * Swarm row 165P (C205, CP-28/48; research/14 CP-48 "SOURCE with provenance, node marks rendered with glyph and label"):
 * the marks of the stand-alone figure's PROVENANS part. The block's own SUMBER marks (`source.provenance`, what the page
 * apparatus prints, html/tables/apparatus.ts `sourceInner`) when it has any, else the marks its nodes carry, in the
 * Table 7.1 order. Labels in the document language (`provenanceMarkLabelText`); none = undefined (SUMBER as before).
 */
export function standaloneProvenance(spec: StudioDiagramV1, block: NormBlock, lang: ChartLang | undefined): DiagramBuildOptions["provenance"] {
  const c = isRec(block.content) ? block.content : {}
  const src = isRec(c.source) && Array.isArray(c.source.provenance) ? c.source.provenance : []
  const nodeMarks = (Array.isArray(spec.nodes) ? spec.nodes : []).map((n) => (isRec(n) ? n.mark : undefined))
  const given = (src.length > 0 ? src : nodeMarks).filter((m): m is (typeof PROVENANCE_MARK_ORDER)[number] => PROVENANCE_MARK_ORDER.includes(m as never))
  const marks = PROVENANCE_MARK_ORDER.filter((m) => given.includes(m))
  if (marks.length === 0) return undefined
  const wl = lang === "EN" ? "EN" : "ID"
  return { label: APPARATUS_TEXT.provenance[wl].toUpperCase(), marks: marks.map((mark) => ({ mark, text: provenanceMarkLabelText(mark, wl) })) }
}

/** Render figur terselesaikan (sinkron, CPU); galat mesin (StudioEngineError) diteruskan ke pemanggil. */
export async function renderResolved(
  f: ResolvedFigure,
  tpl: ResolvedTemplate,
  o: { inline: boolean; withSvg: boolean; lang?: ChartLang; standalone?: boolean; png?: boolean },
): Promise<FigurePreview> {
  // Row 165C (F56-3): stand-alone apparatus is a diagram mode (charts print their own apparatus already).
  if (o.standalone === true && f.type !== "diagram") fail("BLOCK_TYPE_NOT_ADMITTED", `Gambar mandiri hanya untuk diagram; blok ini ${f.type}`, { type: f.type });
  const solo = o.standalone === true && f.type === "diagram" ? standaloneDiagramSpec(f.spec, f.block) : null;
  const { block } = f;
  let r: SvgResult;
  let code: string | null;
  let data: FigurePreview["data"] = null;
  let rendered: FigurePreview["rendered"] = null;
  let lattice: RouteLattice | undefined;
  const vega = f.type === "chart" ? vegaCodeOf(f.spec.kind) : null;
  if (f.type === "chart" && vega !== null) {
    // Row 163b (C155): V-01..V-08 (or a DF code vegaChartFor maps) through the Vega family, as buildFigures does.
    r = await renderVegaFigure(f.spec, vega, tpl, o.lang);
    code = typeof f.spec.kind === "string" ? f.spec.kind : null;
    data = dataSummary(f.spec);
    rendered = { code: renderedCodeOf(r.svg) ?? vega, orientation: null, ...(data ?? { shape: "", items: 0, maxLabelChars: 0 }) };
  } else if (f.type === "chart") {
    r = chartSvg(f.spec, tpl, o.lang);
    code = typeof f.spec.kind === "string" ? f.spec.kind : null;
    data = dataSummary(f.spec);
    rendered = renderedSummary(f.spec, tpl, r.svg);
  } else {
    // I-2 (C74): the in-SVG key in the document language (ID: KUNCI, PENUH / PUTUS-PUTUS / ...), as buildFigures does.
    // Swarm row 165P (C205, CP-28/48): a stand-alone figure prints SUMBER with its PROVENANS part, as the page does.
    const provenance = solo ? standaloneProvenance(solo, f.block, o.lang) : undefined;
    r = await buildDiagramSvgAuto(solo ?? f.spec, { release: false, grid: figureGrid(tpl.params), ...(o.lang ? diagramApparatusOptions(o.lang) : {}), ...(provenance ? { provenance } : {}) });
    code = typeof f.spec.family === "string" ? f.spec.family : null;
    lattice = figureLattice(solo ?? f.spec, tpl);
  }
  const issues = issuesOf(r);
  const split = splitPreviewIssues(issues);
  return {
    type: block.type as FigurePreview["type"],
    code,
    pid: block.pid ?? null,
    address: block.address,
    label: block.artifactLabel ?? null,
    inline: o.inline,
    size: { widthMm: r.widthMm, heightMm: r.heightMm, svgBytes: Buffer.byteLength(r.svg, "utf8") },
    issues: issues.slice(0, PREVIEW_ISSUE_CAP),
    notices: split.notices.slice(0, PREVIEW_ISSUE_CAP),
    defects: split.defects.slice(0, PREVIEW_ISSUE_CAP),
    issueCount: issues.length,
    layoutIssueCount: issues.filter((i) => !i.info).length,
    checksRun: r.report.checksRun.length,
    data,
    rendered,
    ...(o.withSvg ? { svg: r.svg } : {}),
    // Swarm 1.2.7 row 36b (T-12, N7-068): the engine's furniture report (N7-138) travels with the stand-alone info.
    ...(solo !== null ? { standalone: standaloneInfo(solo, block.artifactLabel ?? null, (r.report as Partial<DiagramBuildReport>).furniture) } : {}),
    // Row 165C (F56-3): PNG through the render bridge (same raster as the document figures: 300 dpi).
    ...(solo !== null && o.png === true ? { png: Buffer.from(await rasterizeSvg(r.svg, { widthMm: r.widthMm, heightMm: r.heightMm, dpi: 300, tpl })).toString("base64") } : {}),
    ...(lattice ? { lattice } : {}),
  };
}

/**
 * Row 56b (VIS-6, N8-472): the lattice the router maps `via` on, from the first-render placement on the same sheet as the
 * build (template lattice column); undefined for families that place and route nodes themselves (D-V3). The figure was
 * just built from this spec, so the placement cannot fail here.
 */
function figureLattice(spec: StudioDiagramV1, tpl: ResolvedTemplate): RouteLattice | undefined {
  if (!viaFamily(spec)) return undefined;
  const sheet = new Sheet(Number(spec.width_mm), undefined, resolveDiagramGrid(figureGrid(tpl.params)).latticeXMm);
  placeDiagram(spec, sheet, DIAGRAM_LAYOUTS);
  return routeLattice(sheet);
}

/** Row 165C (F56-3): number, title and DATUM file names (`Gambar 4.1 <Judul>.svg`, p.11-12) of a stand-alone figure. */
function standaloneInfo(spec: StudioDiagramV1, label: string | null, furniture?: DiagramBuildReport["furniture"]): NonNullable<FigurePreview["standalone"]> {
  const id = String(spec.id);
  const word = label !== null && /^\s*\D+?\s+\d/.test(label) ? label.trim().replace(/\s+\d[\d.]*$/, "") : "Gambar";
  const title = String(spec.title);
  const fu = furniture ? { furniture: { keyLines: furniture.keyLines, sourceLines: furniture.sourceLines, heightMm: furniture.heightMm } } : {};
  return { id, title, fileName: { svg: figureFileName(`${word} ${id}`, title, 1, "svg"), png: figureFileName(`${word} ${id}`, title, 1, "png") }, ...fu };
}

/**
 * Selesaikan + cek batas (SEC-FIX M-1: melempar 422 FIGURE_CAPACITY SEBELUM render) + render satu blok figur. Route
 * memakai langkahnya terpisah agar render berjalan di `renderGate()`; fungsi ini untuk pemanggil langsung (uji, probe).
 */
export async function renderFigure(
  block: NormBlock & { pid?: string },
  tpl: ResolvedTemplate,
  o: { inline: boolean; withSvg: boolean; reader?: ArtifactSpecReader; lang?: ChartLang },
): Promise<FigurePreview> {
  const f = await resolveFigure(block, o.reader);
  const over = figureCapacityIssues(f);
  if (over.length > 0) throw capacityError(f, over);
  return renderResolved(f, tpl, o);
}
