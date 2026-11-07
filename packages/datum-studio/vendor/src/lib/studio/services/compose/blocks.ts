/**
 * Pemetaan blok v2 -> blok internal v1 (SR-08; register §4.3, §14.3 arah balik;
 * blueprint §0, §2.9). Mesin render tidak berubah: snapshot norm/v2 membawa
 * `doc: StudioDocV1` hasil pemetaan ini.
 *
 * Keputusan keluaran yang diambil di sini (milik mesin, D-139 butir b):
 * - Figur tanpa ukuran: `widthMm` dari parameter templat per jenis figur
 *   (`chart.output.widthMm`, `diagram.widthMm`, `image.widthMm`,
 *   `symbolSheet.widthMm`: turunan `<jenis>.widthClass` lewat `figureWidthFromClass`;
 *   cadangan `grid.textColumnMm`, lalu `grid.allowedFigureWidthsMm[0]`; tanpa
 *   cadangan literal A4: semua absen = BY_CONSTRUCTION_FAILED). Lebar turunan
 *   diteruskan APA ADANYA ke spec chart/diagram (D-158/D-245 H1): mesin menggambar
 *   pada lebar nyata, tanpa skala pasca-render.
 * - Lebar kolom tabel (D-166 KC-6): `render.table.columnProfiles[preset].colsTw`
 *   bila jumlah kolom sama; selain itu tanpa lebar (solver lebar otomatis mesin
 *   atas peran kolom dan teks sel).
 * - Label aparatus figur KUNCI/SUMBER dari medan `keyRow`/`source` (D-145).
 * - Label kotak samping bawaan dari varian (registri S11 `aside`).
 * - Chart komposit selalu bergaya galeri; kolom/celah dari R-50/R-51 (KD-17).
 */
import type {
  AsideBlock,
  AsideV2,
  Block,
  BlockV2,
  Caption,
  CaptionV2,
  Cell,
  CellV2,
  ChartAccent,
  ChartBlock,
  ChartData,
  ChartDataV2,
  ChartPanelSpec,
  ChartV2,
  ColumnSpec,
  DerivationBlock,
  DerivationV2,
  DiagramBlock,
  DiagramSpecV2,
  DiagramV2,
  ImageBlock,
  ImageV2,
  ListBlock,
  ListV2,
  MonoBlock,
  MonoBlockV2,
  ParagraphBlock,
  ParagraphV2,
  ParamMap,
  ParamValue,
  RailLine,
  RailLineV2,
  Row,
  SourceLine,
  SourceV2,
  StudioChartV1,
  StudioDiagramV1,
  SymbolSheetBlock,
  SymbolSheetV2,
  TableBlock,
  TableV2,
} from "../../contract";
import { TABLE_BLOCK_TYPES } from "../../contract";
import { chartSpecFromDraft, type StudioChartDraft } from "../../engine/chart/core/custom";
import { chartIntentOf } from "../../engine/chart/core/intent";
import type { DiagramPageKeySignal } from "../../engine/diagram/core/sheet";
import { PARAMS_BY_KEY } from "../../params";
import { composeFail } from "./errors";
import { apparatusInline, inlineV2Plain, mapInline, mapRuns, type InlineCtx } from "./inline";

const TABLE_TYPES: ReadonlySet<string> = new Set<string>(TABLE_BLOCK_TYPES);

/** Label kotak samping per varian (registri `sections.ts` S11 "aside"; hipotesis label generic). */
export const ASIDE_DEFAULT_LABELS: Readonly<Record<AsideV2["variant"], string>> = {
  generic: "CATATAN",
  doctrine: "DIKTUM",
  story: "KEMASAN BUKAN KEPEDULIAN",
  quickCheck: "TIGA CEK TERCEPAT",
  ifInDoubt: "BILA RAGU",
};

export interface BlockCtx extends InlineCtx {
  /** Nilai efektif parameter untuk slot pemilik blok. */
  params: ParamMap;
  /** Label artefak hasil penomoran (Gambar 3.1) bila ada; dipakai `id` spec chart/diagram. */
  artifactLabel?: string;
  /** Klasifikasi dokumen (cadangan `classification` spec diagram). */
  classification: string;
  /** Kunci aset internal untuk medan `asset` blok gambar. */
  assetKey?: (asset: string) => string;
}

function param(params: ParamMap, key: string): unknown {
  return params[key] !== undefined ? params[key] : PARAMS_BY_KEY.get(key)?.default;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Lebar figur dari templat (figur v2 tanpa ukuran). */
export function figureWidthMm(type: "chart" | "diagram" | "image" | "symbolSheet", params: ParamMap): number {
  const byType = type === "chart" ? "chart.output.widthMm" : type === "diagram" ? "diagram.widthMm" : type === "image" ? "image.widthMm" : "symbolSheet.widthMm";
  const allowed = param(params, "grid.allowedFigureWidthsMm");
  const w = num(param(params, byType)) ?? num(param(params, "grid.textColumnMm")) ?? (Array.isArray(allowed) ? num(allowed[0]) : undefined);
  if (w === undefined) {
    composeFail("BY_CONSTRUCTION_FAILED", `Lebar figur ${type} tidak terbaca: ${byType}, grid.textColumnMm dan grid.allowedFigureWidthsMm absen di parameter templat`, {
      checkId: "FIGURE_WIDTH",
      keys: [byType, "grid.textColumnMm", "grid.allowedFigureWidthsMm"],
    });
  }
  return w;
}

function caption(c: CaptionV2, ctx: BlockCtx): Caption {
  return { inline: mapInline(c, ctx) };
}

/** Baris SUMBER figur: label dibangkitkan struktural (D-145). */
function figureSource(s: SourceV2, ctx: BlockCtx): SourceLine {
  const { provenance, ...inline } = s as SourceV2 & { provenance?: SourceLine["provenance"] };
  const out: SourceLine = { inline: apparatusInline(inline as CaptionV2, "source", ctx) };
  if (provenance && provenance.length > 0) out.provenance = [...provenance];
  return out;
}

/**
 * Baris SUMBER tabel. Bentuk `text`: label + PROVENANS dibangkitkan modul tabel
 * mesin dari medan `source` (tetap teks). Bentuk `runs`: modul tabel tidak
 * menambah label, jadi compose menyisipkan run label struktural.
 */
function tableSource(s: SourceV2, ctx: BlockCtx): SourceLine {
  const { provenance, ...inline } = s as SourceV2 & { provenance?: SourceLine["provenance"] };
  const base = inline as CaptionV2;
  const out: SourceLine = { inline: "runs" in base ? apparatusInline(base, "source", ctx) : mapInline(base, ctx) };
  if (provenance && provenance.length > 0) out.provenance = [...provenance];
  return out;
}

function rail(lines: RailLineV2[] | undefined, ctx: BlockCtx): RailLine[] | undefined {
  if (!lines) return undefined;
  return lines.map((l) => {
    const out: RailLine = { kind: l.kind };
    if (l.mark) out.mark = l.mark;
    if (typeof l.text === "string") out.text = l.text;
    if (Array.isArray(l.runs)) out.runs = mapRuns(l.runs, ctx);
    return out;
  });
}

function withId<T extends object>(o: T, pid: string): T & { blockId: string } {
  return { ...o, blockId: pid };
}

function paragraph(b: ParagraphV2, pid: string, ctx: BlockCtx): ParagraphBlock {
  const out = withId({ type: "paragraph" as const, ...mapInline(b, ctx) }, pid) as ParagraphBlock;
  if (b.role) out.role = b.role;
  const r = rail(b.rail, ctx);
  if (r) out.rail = r;
  return out;
}

function list(b: ListV2, pid: string, ctx: BlockCtx): ListBlock {
  return withId(
    {
      type: "list" as const,
      style: b.ordered ? ("number" as const) : ("bullet" as const),
      items: b.items.map((it) => {
        const item = { ...mapInline(it, ctx) } as ListBlock["items"][number];
        const r = rail(it.rail, ctx);
        if (r) item.rail = r;
        return item;
      }),
    },
    pid,
  );
}

function aside(b: AsideV2, pid: string, ctx: BlockCtx): AsideBlock {
  return withId(
    {
      type: "aside" as const,
      variant: b.variant,
      label: b.label ? mapInline(b.label, ctx) : { text: ASIDE_DEFAULT_LABELS[b.variant] },
      body: b.body.map((x) => mapInline(x, ctx)),
    },
    pid,
  );
}

function mono(b: MonoBlockV2, pid: string, ctx: BlockCtx): MonoBlock {
  return withId({ type: "monoBlock" as const, label: mapInline(b.label, ctx), lines: b.lines.map((x) => mapInline(x, ctx)) }, pid);
}

/** Profil lebar kolom (R-52, KC-6) untuk `preset` tabel bila jumlah kolom cocok. */
export function columnProfile(params: ParamMap, preset: string | undefined, ncols: number): number[] | undefined {
  if (!preset) return undefined;
  const profiles = param(params, "render.table.columnProfiles");
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return undefined;
  const prof = (profiles as Record<string, unknown>)[preset];
  const cols = prof && typeof prof === "object" && !Array.isArray(prof) ? (prof as { colsTw?: unknown }).colsTw : undefined;
  if (!Array.isArray(cols) || cols.length !== ncols || !cols.every((c) => typeof c === "number" && c > 0)) return undefined;
  return cols as number[];
}

function cell(c: CellV2, ctx: BlockCtx): Cell {
  const out: Cell = {};
  if (typeof c.text === "string") out.text = c.text;
  if (Array.isArray(c.runs)) out.runs = mapRuns(c.runs, ctx);
  if (Array.isArray(c.paragraphs)) out.paragraphs = c.paragraphs.map((p) => mapInline(p, ctx));
  if (c.gridSpan !== undefined) out.gridSpan = c.gridSpan;
  if (c.vMerge !== undefined) out.vMerge = c.vMerge;
  if (c.nested) out.nested = table(c.nested, undefined, ctx);
  if (c.nestedIndex !== undefined) out.nestedIndex = c.nestedIndex;
  return out;
}

/** Tabel v2 -> TableBlock (juga dipakai daftar lembar kendali, KD-19). `pid` absen = tabel bersarang. */
export function table(b: TableV2, pid: string | undefined, ctx: BlockCtx): TableBlock {
  const widths = columnProfile(ctx.params, b.preset, b.columns.length);
  const columns: ColumnSpec[] = b.columns.map((c, i) => {
    const col: ColumnSpec = {};
    if (c.role) col.role = c.role;
    if (c.unit !== undefined) col.unit = c.unit;
    if (widths) col.widthTw = widths[i];
    return col;
  });
  const out: TableBlock = {
    type: b.type,
    columns,
    rows: b.rows.map((r): Row => {
      const row: Row = { cells: r.cells.map((c) => cell(c, ctx)) };
      if (r.kind) row.kind = r.kind;
      return row;
    }),
  };
  if (pid !== undefined) out.blockId = pid;
  if (b.caption) out.caption = caption(b.caption, ctx);
  if (b.source) out.source = tableSource(b.source, ctx);
  if (b.preset !== undefined) out.preset = b.preset;
  return out;
}

function derivation(b: DerivationV2, pid: string, ctx: BlockCtx): DerivationBlock {
  const out: DerivationBlock = withId(
    {
      type: "derivation" as const,
      title: mapInline(b.title, ctx),
      lines: b.lines.map((l) => {
        const line: DerivationBlock["lines"][number] = { label: mapInline(l.label, ctx) };
        if (l.value !== undefined) line.value = "registerKey" in l.value ? { ...l.value } : mapInline(l.value, ctx);
        if (l.mark) line.mark = l.mark;
        return line;
      }),
      closing: mapInline(b.closing, ctx),
    },
    pid,
  );
  if (b.intro) out.intro = mapInline(b.intro, ctx);
  if (b.result) out.result = { ...b.result, label: mapInline(b.result.label, ctx) };
  if (b.verdict) out.verdict = { ...b.verdict, label: mapInline(b.verdict.label, ctx) };
  return out;
}

/** Spec diagram v2 -> `studio.diagram/v1` (ukuran, judul, sumber dari dokumen/templat). */
export function diagramSpec(spec: DiagramSpecV2, title: string, sourceText: string, widthMm: number, ctx: BlockCtx): StudioDiagramV1 {
  const out: StudioDiagramV1 = {
    $schema: "studio.diagram/v1",
    family: spec.family,
    id: ctx.artifactLabel ?? "Gambar 0.0",
    title,
    classification: spec.classification ?? ctx.classification,
    width_mm: widthMm,
    sources: spec.sources && spec.sources.length > 0 ? [...spec.sources] : [sourceText],
    source: sourceText,
    nodes: spec.nodes,
  };
  if (spec.labels_verified !== undefined) out.labels_verified = spec.labels_verified;
  if (spec.edges) out.edges = spec.edges;
  if (spec.zones) out.zones = spec.zones;
  if (spec.legend) out.legend = spec.legend;
  if (spec.notes) out.notes = spec.notes;
  if (spec.per_row !== undefined) out.per_row = spec.per_row;
  return out;
}

/**
 * Data chart v2 + `highlight` -> data v1 dengan aksen. Bentuk berlabel (titik
 * kategoris, seri, titik xy) mendapat `accent: true` per butir yang cocok
 * (label/nama, atau indeks 0-based); bentuk lain memakai aksen tingkat spec
 * (butir highlight pertama, KD-17 / D-58 maks satu aksen).
 *
 * RQ-11 (D-223): bentuk `series` dengan nama KATEGORI di highlight -> aksen titik
 * `{ point: kategori }` (P-14), ditambah `series` bila tepat satu nama seri ikut
 * disorot (= satu titik di dalam seri itu, D-136; P-03). Medan konten data
 * (`points[].target`, `divider`, `binEdges`, `sectors`) diteruskan ke mesin sebagai
 * petunjuk data `params` (CHART_DATA_HINT_KEYS mesin), bukan medan data v1.
 */
function chartData(
  data: ChartDataV2,
  highlight: Array<string | number> | undefined,
  title: string,
  sourceText: string,
  widthMm: number,
  ctx: BlockCtx,
): { data: ChartData; accent?: ChartAccent; params?: Record<string, ParamValue> } {
  const hl = highlight ?? [];
  const hit = (label: string | undefined, i: number) => hl.some((h) => (typeof h === "number" ? h === i : label !== undefined && h === label));
  switch (data.shape) {
    case "categorical": {
      const points = data.points.map((p, i) => {
        const pt: { label: string; value: number; sub?: string; accent?: boolean } = { label: p.label, value: p.value };
        if (p.sub !== undefined) pt.sub = p.sub;
        if (hit(p.label, i)) pt.accent = true;
        return pt;
      });
      const out: { data: ChartData; params?: Record<string, ParamValue> } = { data: { shape: "categorical", points } };
      if (data.points.some((p) => p.target !== undefined)) out.params = { targets: data.points.map((p) => p.target ?? null) };
      return out;
    }
    case "series": {
      const names = data.series.map((s) => s.name);
      const category = hl.find((h): h is string => typeof h === "string" && !names.includes(h) && data.categories.includes(h));
      if (category !== undefined) {
        const accent: ChartAccent = { point: category };
        const hitSeries = data.series.filter((s, i) => hit(s.name, i));
        if (hitSeries.length === 1) accent.series = hitSeries[0].name;
        return { data: { shape: "series", categories: [...data.categories], series: data.series.map((s) => ({ ...s })) }, accent };
      }
      return { data: { shape: "series", categories: [...data.categories], series: data.series.map((s, i) => (hit(s.name, i) ? { ...s, accent: true } : { ...s })) } };
    }
    case "xy": {
      const out: { data: ChartData; params?: Record<string, ParamValue> } = {
        data: { shape: "xy", points: data.points.map((p, i) => (hit(p.label, i) ? { ...p, accent: true } : { ...p })) },
      };
      if (data.divider) out.params = { divider: { ...data.divider } };
      return out;
    }
    case "steps":
      return { data: { shape: "steps", spec: diagramSpec(data.spec, title, sourceText, widthMm, ctx) } };
    case "distribution": {
      const params: Record<string, ParamValue> = {};
      if (data.binEdges) params.binEdges = [...data.binEdges];
      if (data.sectors !== undefined) params.sectors = data.sectors;
      const out: { data: ChartData; accent?: ChartAccent; params?: Record<string, ParamValue> } = {
        data: { shape: "distribution", groups: data.groups.map((g) => ({ name: g.name, values: [...g.values] })) },
      };
      if (Object.keys(params).length > 0) out.params = params;
      const first = hl[0];
      // Indeks bulat = indeks grup (S-01..S-06) atau sektor (S-08): mesin membaca angka dari `point`.
      if (first !== undefined) out.accent = typeof first === "number" ? { point: first } : { group: first };
      return out;
    }
    default: {
      const first = hl[0];
      if (first === undefined) return { data: data as ChartData };
      const accent: ChartAccent = data.shape === "graph" || data.shape === "intervals" ? { group: String(first) } : { point: first };
      if (data.shape === "graph" && typeof first === "string" && data.nodes.some((n) => n.id === first)) return { data: data as ChartData, accent: { point: first } };
      return { data: data as ChartData, accent };
    }
  }
}

/**
 * Parameter templat `chart.kind.<KODE>.*` yang diset (nilai efektif slot berbeda dari default
 * registri) -> `params` spec mesin dengan kunci penuh (IP-59/FIX-A, D-227). Konten v2 tidak
 * membawa medan tampilan (`axis` = DISPLAY_FIELD DF-63..65), jadi domain sumbu dan bawaan
 * tampilan per jenis hanya datang dari templat; panel komposit dirender dengan templat bawaan
 * (`services/render/pure/chart.ts`, D-134), sehingga tanpa penerusan ini nilai templat panel
 * (mis. `chart.kind.P-13.axis`) tidak sampai ke mesin. Nilai = default tidak diteruskan
 * (perilaku mesin sama, D-77 eksplisit tetap). Kunci berurutan leksikografis (deterministik).
 */
function kindTemplateParams(params: ParamMap, code: string): Record<string, ParamValue> {
  const prefix = `chart.kind.${code}.`;
  const out: Record<string, ParamValue> = {};
  for (const k of Object.keys(params).filter((key) => key.startsWith(prefix)).sort()) {
    const v = params[k];
    const def = PARAMS_BY_KEY.get(k);
    if (v === undefined || v === null || !def || JSON.stringify(v) === JSON.stringify(def.default)) continue;
    out[k] = v;
  }
  return out;
}

/** Petunjuk data konten (`chartData`) + parameter templat jenis chart; `undefined` bila kosong. */
function specParams(data: Record<string, ParamValue> | undefined, params: ParamMap, code: string): Record<string, ParamValue> | undefined {
  const out = { ...data, ...kindTemplateParams(params, code) };
  return Object.keys(out).length > 0 ? out : undefined;
}

function chart(b: ChartV2, pid: string, ctx: BlockCtx): ChartBlock {
  const widthMm = figureWidthMm("chart", ctx.params);
  const title = inlineV2Plain(b.caption);
  const sourceText = inlineV2Plain(b.source);
  let spec: ChartBlock["spec"];
  if (b.artifactId !== undefined) {
    spec = { artifactId: b.artifactId };
  } else {
    // AM-03 (DC-27): `code = "custom"` disalin apa adanya lalu didispatch mesin chart di bawah.
    const s: StudioChartDraft = {
      $schema: "studio.chart/v1",
      kind: b.code,
      title,
      source: sourceText,
      widthMm,
    };
    if (ctx.artifactLabel) s.id = ctx.artifactLabel;
    if (b.unit !== undefined) s.unit = b.unit;
    if (b.dec !== undefined) s.dec = b.dec;
    if (b.note !== undefined) s.note = b.note;
    if (b.limit) {
      s.limit = b.limit.value;
      if (b.limit.label !== undefined) s.limitLabel = b.limit.label;
    }
    if (b.code === "composite") {
      s.style = "gallery";
      const columns = param(ctx.params, "chart.composite.columns");
      const gap = param(ctx.params, "chart.composite.gapMm");
      s.composite = {
        columns: (columns === 1 || columns === 2 || columns === 3 ? columns : 3) as 1 | 2 | 3,
        panels: (b.panels ?? []).map((p) => {
          const pd = chartData(p.data, p.highlight, title, sourceText, widthMm, ctx);
          const ps: ChartPanelSpec = { kind: p.code, data: pd.data };
          if (pd.accent) ps.accent = pd.accent;
          const pp = specParams(pd.params, ctx.params, p.code);
          if (pp) ps.params = pp;
          if (p.unit !== undefined) ps.unit = p.unit;
          if (p.dec !== undefined) ps.dec = p.dec;
          if (p.limit) {
            ps.limit = p.limit.value;
            if (p.limit.label !== undefined) ps.limitLabel = p.limit.label;
          }
          const panel: NonNullable<StudioChartV1["composite"]>["panels"][number] = { name: p.name, code: p.code, spec: ps };
          if (p.caption !== undefined) panel.caption = p.caption;
          if (p.axisNote !== undefined) panel.axisNote = p.axisNote;
          return panel;
        }),
      };
      if (typeof gap === "number" && gap >= 0) s.composite.gapMm = gap;
    } else if (b.data) {
      const d = chartData(b.data, b.highlight, title, sourceText, widthMm, ctx);
      s.data = d.data;
      if (d.accent) s.accent = d.accent;
      const sp = specParams(d.params, ctx.params, b.code);
      if (sp) s.params = sp;
    }
    // FIG-03a (D-482 butir 2): medan maksud analitis blok v2 diteruskan ke mesin; absen = undefined, spec tidak berubah.
    const intent = chartIntentOf(b);
    if (intent) s.intent = intent;
    spec = chartSpecFromDraft(s, b.form);
  }
  const out: ChartBlock = withId({ type: "chart" as const, caption: caption(b.caption, ctx), source: figureSource(b.source, ctx), widthMm, spec }, pid);
  if (b.keyRow) out.keyRow = apparatusInline(b.keyRow, "key", ctx);
  return out;
}

function diagram(b: DiagramV2, pid: string, ctx: BlockCtx): DiagramBlock {
  const widthMm = figureWidthMm("diagram", ctx.params);
  const spec: DiagramBlock["spec"] =
    b.artifactId !== undefined ? { artifactId: b.artifactId } : diagramSpec(b.spec as DiagramSpecV2, inlineV2Plain(b.caption), inlineV2Plain(b.source), widthMm, ctx);
  const out: DiagramBlock = withId({ type: "diagram" as const, caption: caption(b.caption, ctx), source: figureSource(b.source, ctx), widthMm, spec }, pid);
  if (b.keyRow) {
    out.keyRow = apparatusInline(b.keyRow, "key", ctx);
    // D-288 (satu aparatus, D-145/RQ-10): halaman mencetak baris KUNCI, jadi mesin
    // diagram tidak menggambar baris KEY di dalam SVG (legenda tetap untuk DATUM-34).
    if (!("artifactId" in spec)) (spec as DiagramPageKeySignal).keyRowOnPage = true;
  }
  return out;
}

function image(b: ImageV2, pid: string, ctx: BlockCtx): ImageBlock {
  const out: ImageBlock = withId(
    {
      type: "image" as const,
      caption: caption(b.caption, ctx),
      source: figureSource(b.source, ctx),
      widthMm: figureWidthMm("image", ctx.params),
      asset: ctx.assetKey ? ctx.assetKey(b.asset) : b.asset,
    },
    pid,
  );
  if (b.keyRow) out.keyRow = apparatusInline(b.keyRow, "key", ctx);
  return out;
}

function symbolSheet(b: SymbolSheetV2, pid: string, ctx: BlockCtx): SymbolSheetBlock {
  const out: SymbolSheetBlock = withId(
    {
      type: "symbolSheet" as const,
      dialect: b.dialect,
      caption: caption(b.caption, ctx),
      source: figureSource(b.source, ctx),
      widthMm: figureWidthMm("symbolSheet", ctx.params),
    },
    pid,
  );
  if (b.keyRow) out.keyRow = apparatusInline(b.keyRow, "key", ctx);
  return out;
}

/** Satu blok v2 (ber-pid) -> blok internal v1. */
export function mapBlock(b: BlockV2, pid: string, ctx: BlockCtx): Block {
  switch (b.type) {
    case "paragraph":
      return paragraph(b, pid, ctx);
    case "list":
      return list(b, pid, ctx);
    case "aside":
      return aside(b, pid, ctx);
    case "monoBlock":
      return mono(b, pid, ctx);
    case "assumptionInline":
      return withId({ type: "assumptionInline" as const, ...mapInline(b, ctx), asmId: b.asmId, impact: b.impact }, pid) as Block;
    case "derivation":
      return derivation(b, pid, ctx);
    case "chart":
      return chart(b, pid, ctx);
    case "diagram":
      return diagram(b, pid, ctx);
    case "image":
      return image(b, pid, ctx);
    case "symbolSheet":
      return symbolSheet(b, pid, ctx);
    default:
      if (TABLE_TYPES.has((b as TableV2).type)) return table(b as TableV2, pid, ctx);
      return composeFail("BY_CONSTRUCTION_FAILED", `Jenis blok "${String((b as { type?: unknown }).type)}" tidak dikenal kontrak v2`, { pid });
  }
}

