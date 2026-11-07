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
import { buildDiagramSvg } from "@/lib/studio/engine/diagram/build";
import { glyphSet, mapBlock, storedComposeContext } from "@/lib/studio/services/compose";
import { templateForDoc } from "@/lib/studio/services/render/common";
import { ArtifactSpecReader, chartSvg, diagramApparatusOptions, diagramSpecForBlock } from "@/lib/studio/services/render/figures";
import { capacityMessage, figureBytesIssues, figureCapacityIssuesFor, type CapacityIssue } from "@/lib/studio/services/render/figure-limits";

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
export const INFO_CODES: ReadonlySet<string> = new Set(["DATUM-36", "FIGURE_LIMITS_DEFAULT", "PARAM_ALIAS", "AUTO_FIT", "INTENT_APPLIED", "CAPACITY_ADAPT"]);

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

/** Render figur terselesaikan (sinkron, CPU); galat mesin (StudioEngineError) diteruskan ke pemanggil. */
export function renderResolved(f: ResolvedFigure, tpl: ResolvedTemplate, o: { inline: boolean; withSvg: boolean; lang?: ChartLang }): FigurePreview {
  const { block } = f;
  let r: SvgResult;
  let code: string | null;
  let data: FigurePreview["data"] = null;
  let rendered: FigurePreview["rendered"] = null;
  if (f.type === "chart") {
    r = chartSvg(f.spec, tpl, o.lang);
    code = typeof f.spec.kind === "string" ? f.spec.kind : null;
    data = dataSummary(f.spec);
    rendered = renderedSummary(f.spec, tpl, r.svg);
  } else {
    // I-2 (C74): the in-SVG key in the document language (ID: KUNCI, PENUH / PUTUS-PUTUS / ...), as buildFigures does.
    r = buildDiagramSvg(f.spec, { release: false, grid: figureGrid(tpl.params), ...(o.lang ? diagramApparatusOptions(o.lang) : {}) });
    code = typeof f.spec.family === "string" ? f.spec.family : null;
  }
  const issues = issuesOf(r);
  return {
    type: block.type as FigurePreview["type"],
    code,
    pid: block.pid ?? null,
    address: block.address,
    label: block.artifactLabel ?? null,
    inline: o.inline,
    size: { widthMm: r.widthMm, heightMm: r.heightMm, svgBytes: Buffer.byteLength(r.svg, "utf8") },
    issues: issues.slice(0, PREVIEW_ISSUE_CAP),
    issueCount: issues.length,
    layoutIssueCount: issues.filter((i) => !i.info).length,
    checksRun: r.report.checksRun.length,
    data,
    rendered,
    ...(o.withSvg ? { svg: r.svg } : {}),
  };
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
