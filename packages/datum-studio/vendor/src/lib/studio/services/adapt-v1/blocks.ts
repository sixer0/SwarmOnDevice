/**
 * services/adapt-v1 — bab, section, blok (register §14.3).
 *
 * Setiap objek v1 diubah dengan daftar medan v2 eksplisit; sisa medan dihitung
 * `AdaptRecorder.rest` (format inline R-38 atau tata letak). `SpacerBlock` dan
 * `DeviceBlock` dibuang (KS-05, DF-60) dan dihitung di `dropped`.
 */
import { TABLE_BLOCK_TYPES } from "@/lib/studio/contract";
import type {
  AsideBlock,
  BlockV2,
  Cell,
  CellParagraph,
  CellV2,
  Chapter,
  ChapterV2,
  ChartBlock,
  ChartData,
  ChartDataV2,
  ChartPanelV2,
  ChartV2,
  ColumnSpec,
  ColumnV2,
  DerivationBlock,
  DerivationV2,
  DiagramBlock,
  DiagramSpecV2,
  DiagramV2,
  FlowItem,
  ImageBlock,
  ImageV2,
  ListBlock,
  ListV2,
  MonoBlock,
  ParagraphRoleV2,
  Row,
  RowV2,
  Section,
  SectionV2,
  StudioChartV1,
  StudioDiagramV1,
  SymbolSheetBlock,
  SymbolSheetV2,
  TableBlock,
  TableBlockType,
  TableV2,
} from "@/lib/studio/contract";
import { PARAGRAPH_ROLES_V2 } from "@/lib/studio/contract";
import type { PidMapper } from "./ids";
import {
  INLINE_KEYS,
  adaptCaption,
  adaptInline,
  adaptKeyRow,
  adaptRail,
  adaptRuns,
  adaptSource,
  inlinePart,
  ptr,
} from "./inline";
import type { AdaptRecorder } from "./report";

export interface AdaptCtx {
  rec: AdaptRecorder;
  pids: PidMapper;
  /** Kunci aset v1 → v2 (C26). */
  assetKeys: ReadonlyMap<string, string>;
}

const TABLE_TYPES: ReadonlySet<string> = new Set(TABLE_BLOCK_TYPES);
const ROLES_V2: ReadonlySet<string> = new Set(PARAGRAPH_ROLES_V2);
const FIGURE_CONSUMED = ["type", "blockId", "caption", "source", "keyRow"] as const;

function withId<T extends object>(out: T, blockId: unknown, ctx: AdaptCtx): T & { id?: string } {
  const id = ctx.pids.map(blockId);
  return id === undefined ? out : { id, ...out };
}

// ── Aliran blok ──────────────────────────────────────────────────────────

/** `FlowItem[]` → `BlockV2[]`; spacer/device dibuang. */
export function adaptFlow(items: readonly FlowItem[] | undefined, p: string, ctx: AdaptCtx): BlockV2[] {
  const out: BlockV2[] = [];
  (items ?? []).forEach((item, i) => {
    const b = adaptFlowItem(item, ptr(p, i), ctx);
    if (b) out.push(b);
  });
  return out;
}

export function adaptFlowItem(item: FlowItem | { type: string }, p: string, ctx: AdaptCtx): BlockV2 | null {
  const t = (item as { type: string }).type;
  if (t === "spacer") {
    ctx.rec.drop("spacer");
    return null;
  }
  if (t === "device") {
    ctx.rec.drop("device");
    return null;
  }
  const b = item as FlowItem;
  switch (b.type) {
    case "paragraph":
      return adaptParagraph(b, p, ctx);
    case "list":
      return adaptList(b, p, ctx);
    case "aside":
      return adaptAside(b, p, ctx);
    case "monoBlock":
      return adaptMono(b, p, ctx);
    case "assumptionInline": {
      ctx.rec.rest(b, ["type", "blockId", ...INLINE_KEYS, "asmId", "impact"], p);
      return withId({ type: "assumptionInline" as const, ...inlinePart(b, p, ctx.rec), asmId: b.asmId, impact: b.impact }, b.blockId, ctx);
    }
    case "derivation":
      return adaptDerivation(b, p, ctx);
    case "chart":
      return adaptChart(b, p, ctx);
    case "diagram":
      return adaptDiagram(b, p, ctx);
    case "image":
      return adaptImage(b, p, ctx);
    case "symbolSheet":
      return adaptSymbolSheet(b, p, ctx);
    default:
      if (TABLE_TYPES.has(b.type)) return adaptTable(b as TableBlock, p, ctx);
      // Unsur halaman depan (controlBlock, colophon, signatureBlock) di aliran bab: tidak ada padanan v2.
      ctx.rec.drop("frontItems");
      return null;
  }
}

function adaptParagraph(b: Extract<FlowItem, { type: "paragraph" }>, p: string, ctx: AdaptCtx): BlockV2 {
  const { rec } = ctx;
  rec.rest(b, ["type", "blockId", ...INLINE_KEYS, "role", "rail"], p);
  const out: Record<string, unknown> = { type: "paragraph", ...inlinePart(b, p, rec) };
  if (b.role !== undefined) {
    if (ROLES_V2.has(b.role)) out.role = b.role as ParagraphRoleV2;
    else rec.rename(`paragraph.role:${b.role}->body`); // peran halaman depan (DF-61): body bawaan
  }
  if (b.rail && b.rail.length > 0) out.rail = adaptRail(b.rail, `${p}/rail`, rec);
  return withId(out as unknown as BlockV2, b.blockId, ctx);
}

function adaptList(b: ListBlock, p: string, ctx: AdaptCtx): ListV2 {
  const { rec } = ctx;
  rec.rest(b, ["type", "blockId", "style", "items"], p);
  rec.rename("list.style->ordered");
  const items = b.items.map((it, i) => {
    const pi = ptr(p, "items", i);
    rec.rest(it, [...INLINE_KEYS, "rail"], pi);
    const v: ListV2["items"][number] = { ...inlinePart(it, pi, rec) };
    if (it.rail && it.rail.length > 0) v.rail = adaptRail(it.rail, `${pi}/rail`, rec);
    return v;
  });
  return withId({ type: "list" as const, ordered: b.style === "number", items }, b.blockId, ctx);
}

function cellParagraphs(ps: readonly CellParagraph[], p: string, rec: AdaptRecorder) {
  return ps.map((x, i) => adaptInline(x, ptr(p, i), rec));
}

function adaptAside(b: AsideBlock, p: string, ctx: AdaptCtx): BlockV2 {
  const { rec } = ctx;
  rec.rest(b, ["type", "blockId", "variant", "label", "body"], p);
  const out: Record<string, unknown> = { type: "aside", variant: b.variant };
  if (b.label) out.label = adaptInline(b.label, `${p}/label`, rec);
  out.body = cellParagraphs(b.body, `${p}/body`, rec);
  return withId(out as unknown as BlockV2, b.blockId, ctx);
}

function adaptMono(b: MonoBlock, p: string, ctx: AdaptCtx): BlockV2 {
  const { rec } = ctx;
  rec.rest(b, ["type", "blockId", "label", "lines"], p);
  return withId(
    { type: "monoBlock" as const, label: adaptInline(b.label, `${p}/label`, rec), lines: cellParagraphs(b.lines, `${p}/lines`, rec) },
    b.blockId,
    ctx,
  );
}

function adaptDerivation(b: DerivationBlock, p: string, ctx: AdaptCtx): DerivationV2 {
  const { rec } = ctx;
  // `id` (label "D-C.n") milik mesin.
  rec.rest(b, ["type", "blockId", "title", "intro", "lines", "result", "verdict", "closing"], p);
  const out: DerivationV2 = {
    type: "derivation",
    title: adaptInline(b.title, `${p}/title`, rec),
    lines: b.lines.map((l, i) => {
      const pl = ptr(p, "lines", i);
      rec.rest(l, ["label", "value", "mark"], pl);
      const line: DerivationV2["lines"][number] = { label: adaptInline(l.label, `${pl}/label`, rec) };
      if (l.value !== undefined) {
        if ("registerKey" in l.value) {
          const v: { registerKey: string; dec?: 0 | 1 | 2 | 3 } = { registerKey: l.value.registerKey };
          if (l.value.dec !== undefined) v.dec = l.value.dec as 0 | 1 | 2 | 3;
          line.value = v;
        } else line.value = adaptInline(l.value, `${pl}/value`, rec);
      }
      if (l.mark !== undefined) line.mark = l.mark;
      return line;
    }),
    closing: adaptInline(b.closing, `${p}/closing`, rec),
  };
  if (b.intro) out.intro = adaptInline(b.intro, `${p}/intro`, rec);
  if (b.result) {
    const r = b.result;
    rec.rest(r, ["label", "expr", "registerKey", "tol"], `${p}/result`);
    out.result = { label: adaptInline(r.label, `${p}/result/label`, rec), expr: r.expr, registerKey: r.registerKey };
    if (r.tol !== undefined) out.result.tol = r.tol;
  }
  if (b.verdict) {
    const v = b.verdict;
    rec.rest(v, ["label", "registerKey", "limit", "direction"], `${p}/verdict`);
    out.verdict = { label: adaptInline(v.label, `${p}/verdict/label`, rec), registerKey: v.registerKey, limit: v.limit };
    if (v.direction !== undefined) out.verdict.direction = v.direction;
  }
  return withId(out, b.blockId, ctx);
}

// ── Tabel ────────────────────────────────────────────────────────────────

export function adaptTable(b: TableBlock, p: string, ctx: AdaptCtx, nested = false): TableV2 {
  const { rec } = ctx;
  rec.rest(b, ["type", "blockId", "caption", "columns", "rows", "source", "preset"], p);
  const out: TableV2 = {
    type: b.type as TableBlockType,
    columns: b.columns.map((c, i) => adaptColumn(c, ptr(p, "columns", i), rec)),
    rows: b.rows.map((r, i) => adaptRow(r, ptr(p, "rows", i), ctx, nested)),
  };
  if (b.caption) out.caption = adaptCaption(b.caption, `${p}/caption`, rec);
  if (b.source) out.source = adaptSource(b.source, `${p}/source`, rec);
  if (b.preset !== undefined) out.preset = b.preset;
  return withId(out, b.blockId, ctx);
}

function adaptColumn(c: ColumnSpec, p: string, rec: AdaptRecorder): ColumnV2 {
  rec.rest(c, ["role", "unit"], p);
  const out: ColumnV2 = {};
  if (c.role !== undefined) out.role = c.role;
  if (c.unit !== undefined) out.unit = c.unit;
  return out;
}

function adaptRow(r: Row, p: string, ctx: AdaptCtx, nested: boolean): RowV2 {
  ctx.rec.rest(r, ["kind", "cells"], p);
  const out: RowV2 = { cells: r.cells.map((c, i) => adaptCell(c, ptr(p, "cells", i), ctx, nested)) };
  if (r.kind !== undefined) out.kind = r.kind;
  return out;
}

function adaptCell(c: Cell, p: string, ctx: AdaptCtx, nested: boolean): CellV2 {
  const { rec } = ctx;
  rec.rest(c, ["paragraphs", "text", "runs", "gridSpan", "vMerge", "nested", "nestedIndex"], p);
  const out: CellV2 = {};
  if (c.paragraphs !== undefined) out.paragraphs = cellParagraphs(c.paragraphs, `${p}/paragraphs`, rec);
  else if (c.runs !== undefined) out.runs = adaptRuns(c.runs, `${p}/runs`, rec);
  else if (c.text !== undefined) out.text = c.text;
  if (c.gridSpan !== undefined) out.gridSpan = c.gridSpan;
  if (c.vMerge !== undefined) out.vMerge = c.vMerge;
  if (c.nested !== undefined && !nested) out.nested = adaptTable(c.nested, `${p}/nested`, ctx, true);
  if (c.nestedIndex !== undefined) out.nestedIndex = c.nestedIndex;
  return out;
}

// ── Figur ────────────────────────────────────────────────────────────────

function figureFields(b: { caption: ChartBlock["caption"]; source: ChartBlock["source"]; keyRow?: ChartBlock["keyRow"] }, p: string, rec: AdaptRecorder) {
  const out: { caption: ChartV2["caption"]; source: ChartV2["source"]; keyRow?: ChartV2["keyRow"] } = {
    caption: adaptCaption(b.caption, `${p}/caption`, rec),
    source: adaptSource(b.source, `${p}/source`, rec),
  };
  const keyRow = adaptKeyRow(b.keyRow, `${p}/keyRow`, rec);
  if (keyRow) out.keyRow = keyRow;
  return out;
}

/** `StudioDiagramV1` → `DiagramSpecV2` (T2-27). */
export function adaptDiagramSpec(s: StudioDiagramV1, p: string, rec: AdaptRecorder): DiagramSpecV2 {
  rec.rest(s, ["$schema", "family", "classification", "labels_verified", "sources", "nodes", "edges", "zones", "legend", "notes", "per_row"], p);
  const out: DiagramSpecV2 = { family: s.family, nodes: s.nodes };
  if (s.classification !== undefined) out.classification = s.classification;
  if (s.labels_verified !== undefined) out.labels_verified = s.labels_verified;
  if (s.sources !== undefined) out.sources = s.sources;
  if (s.edges !== undefined) out.edges = s.edges;
  if (s.zones !== undefined) out.zones = s.zones;
  if (s.legend !== undefined) out.legend = s.legend;
  if (s.notes !== undefined) out.notes = s.notes;
  if (s.per_row !== undefined) out.per_row = s.per_row;
  return out;
}

/**
 * `ChartData` v1 → `ChartDataV2` + penekanan. `accent: true` per butir menjadi
 * `highlight`: label titik (categorical/xy) atau indeks bila tanpa label, nama seri (series).
 */
function adaptChartData(d: ChartData, p: string, rec: AdaptRecorder, highlight: Array<string | number>): ChartDataV2 {
  const take = (accent: unknown, key: string | number) => {
    if (accent === undefined) return;
    rec.rename("accent->highlight");
    if (accent === true && !highlight.includes(key)) highlight.push(key);
  };
  switch (d.shape) {
    case "categorical":
      return {
        shape: "categorical",
        points: d.points.map(({ accent, ...pt }, i) => {
          take(accent, pt.label ?? i);
          return pt;
        }),
      };
    case "series":
      return {
        shape: "series",
        categories: d.categories,
        series: d.series.map(({ accent, ...s }) => {
          take(accent, s.name);
          return s;
        }),
      };
    case "xy":
      return {
        shape: "xy",
        points: d.points.map(({ accent, ...pt }, i) => {
          take(accent, pt.label ?? i);
          return pt;
        }),
      };
    case "steps":
      return { shape: "steps", spec: adaptDiagramSpec(d.spec, `${p}/spec`, rec) };
    default:
      return d;
  }
}

/**
 * Penekanan tingkat spec (`accent`, alias `params.accent*`) → `highlight`. `{point, series}`
 * menjadi `[titik, seri]`: compose membacanya sebagai SATU titik di dalam seri itu (D-136, RQ-11).
 */
function specHighlight(spec: Pick<StudioChartV1, "accent" | "params">, rec: AdaptRecorder, highlight: Array<string | number>) {
  const push = (v: unknown) => {
    if ((typeof v === "string" && v !== "") || (typeof v === "number" && Number.isInteger(v) && v >= 0)) {
      if (!highlight.includes(v)) highlight.push(v);
      rec.rename("accent->highlight");
    }
  };
  if (spec.accent) {
    push(spec.accent.point);
    push(spec.accent.group);
    push(spec.accent.series);
  } else if (spec.params) {
    push(spec.params.accentPoint);
    push(spec.params.accentGroup);
    push(spec.params.accentSeries);
  }
}

/** Sektor bawaan mesin S-08 (`engine/chart/family-s2/radial.ts` DEFAULT_SECTORS) bila data tanpa `sectors`. */
const S08_DEFAULT_SECTORS = 36;

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * `params` spec S94 -> medan KONTEN v2 (RQ-11, D-223). Klasifikasi per kunci berpijak pada
 * tabel petunjuk data mesin (`engine/chart/core/params.ts` CHART_DATA_HINT_KEYS) dan D-215:
 * - DATA (bernilai satuan data / pengelompokan data): P-09 `targets`/`target` ->
 *   `points[].target`; P-13 `divider` -> `divider`; S-01 `binEdges` -> `binEdges` (nilai data
 *   merata di dalam tepi itu); S-08 `sectors` -> `sectors` (sudut data = pusat sektor).
 * - SOROTAN (tingkat terendah, hanya bila belum ada sorotan dari `accent`, sama dengan
 *   prioritas mesin): P-14 `accentCategory` -> kategori; S-08 `accentSectorDeg` -> indeks sektor.
 * - Alias aksen `accentPoint|accentGroup|accentSeries`: dibaca `specHighlight`.
 * - TAMPILAN (dibuang, dihitung `params` satu kali per spec): `chart.kind.*`/`chart.*` (ParamDef
 *   templat, D-215), `axis` (domain sumbu, preseden ParamDef `chart.kind.P-11.axis`), `max`
 *   (domain skala P-09; mesin menurunkannya dari `bandLevels`/data), `belowTargetColour`
 *   (warna), `compassLabels` (label arah = bawaan mesin), `medianLabel` (format label median;
 *   mesin menghitung median sendiri).
 * Nilai berbentuk salah tidak dipetakan dan ikut dihitung `params` (tidak diam).
 */
function adaptChartParams(
  code: string,
  spec: Pick<StudioChartV1, "accent" | "params">,
  data: ChartDataV2 | undefined,
  highlight: Array<string | number>,
  p: string,
  rec: AdaptRecorder,
): ChartDataV2 | undefined {
  const params = spec.params;
  if (!params) return data;
  const used = new Set<string>();
  if (!spec.accent) for (const k of ["accentPoint", "accentGroup", "accentSeries"]) used.add(k);
  let out = data;
  const hasHighlight = highlight.length > 0;
  if (code === "P-09" && out?.shape === "categorical") {
    const list = params.targets;
    const one = params.target;
    const listOk =
      Array.isArray(list) && list.length === out.points.length && list.every((t) => t === null || (isFiniteNum(t) && t >= 0));
    const oneOk = isFiniteNum(one) && one >= 0;
    if (listOk || oneOk) {
      out = {
        ...out,
        points: out.points.map((pt, i) => {
          const li = listOk ? (list as unknown[])[i] : undefined;
          const t = isFiniteNum(li) ? li : oneOk ? (one as number) : undefined;
          return t === undefined ? pt : { ...pt, target: t };
        }),
      };
      if (listOk) {
        used.add("targets");
        rec.rename("params.targets->data.points.target");
      }
      if (oneOk) {
        used.add("target");
        rec.rename("params.target->data.points.target");
      }
    }
  }
  if (code === "P-13" && out?.shape === "xy") {
    const d = params.divider;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const keys = Object.keys(d);
      if (keys.length > 0 && keys.every((k) => (k === "x" || k === "y") && isFiniteNum(d[k]))) {
        const div: { x?: number; y?: number } = {};
        if (isFiniteNum(d.x)) div.x = d.x;
        if (isFiniteNum(d.y)) div.y = d.y;
        out = { ...out, divider: div };
        used.add("divider");
        rec.rename("params.divider->data.divider");
      }
    }
  }
  if (code === "S-01" && out?.shape === "distribution") {
    const e = params.binEdges;
    if (Array.isArray(e) && e.length >= 2 && e.every(isFiniteNum)) {
      out = { ...out, binEdges: e as number[] };
      used.add("binEdges");
      rec.rename("params.binEdges->data.binEdges");
    }
  }
  if (code === "S-08" && out?.shape === "distribution") {
    const n = params.sectors;
    if (isFiniteNum(n) && Number.isInteger(n) && n >= 4 && n <= 72) {
      out = { ...out, sectors: n };
      used.add("sectors");
      rec.rename("params.sectors->data.sectors");
    }
    const deg = params.accentSectorDeg;
    if (isFiniteNum(deg)) {
      used.add("accentSectorDeg");
      if (!hasHighlight) {
        const k = out.shape === "distribution" && out.sectors !== undefined ? out.sectors : S08_DEFAULT_SECTORS;
        highlight.push(Math.min(k - 1, Math.floor((((deg % 360) + 360) % 360) / (360 / k) + 1e-9)));
        rec.rename("params.accentSectorDeg->highlight");
      }
    }
  }
  if (code === "P-14") {
    const ac = params.accentCategory;
    if ((typeof ac === "string" && ac !== "") || (isFiniteNum(ac) && Number.isInteger(ac) && ac >= 0)) {
      used.add("accentCategory");
      if (!hasHighlight) {
        highlight.push(ac);
        rec.rename("params.accentCategory->highlight");
      }
    }
  }
  if (Object.keys(params).some((k) => !used.has(k) && params[k] !== undefined)) rec.strip("params", p);
  return out;
}

function adaptChart(b: ChartBlock, p: string, ctx: AdaptCtx): ChartV2 {
  const { rec } = ctx;
  rec.rest(b, [...FIGURE_CONSUMED, "spec"], p);
  const fig = figureFields(b, p, rec);
  const ps = `${p}/spec`;
  if ("artifactId" in b.spec) {
    rec.rest(b.spec, ["artifactId"], ps);
    // `code` tidak diketahui dari rujukan artefak v1; layanan mengisinya dari artefak tersimpan (R09).
    return withId({ type: "chart", artifactId: b.spec.artifactId, ...fig } as ChartV2, b.blockId, ctx);
  }
  const s = b.spec;
  rec.rest(s, ["$schema", "kind", "data", "unit", "dec", "note", "limit", "limitLabel", "composite", "accent", "params"], ps);
  rec.rename("chart.kind->code");
  const highlight: Array<string | number> = [];
  const out: ChartV2 = { type: "chart", code: s.kind, ...fig };
  if (s.data) out.data = adaptChartData(s.data, `${ps}/data`, rec, highlight);
  if (s.composite) {
    const pc = `${ps}/composite`;
    rec.rest(s.composite, ["panels"], pc);
    out.panels = [];
    s.composite.panels.forEach((panel, i) => {
      const pp = ptr(pc, "panels", i);
      rec.rest(panel, ["name", "code", "caption", "axisNote", "spec"], pp);
      const sp = panel.spec;
      rec.rest(sp, ["kind", "data", "unit", "dec", "accent", "limit", "limitLabel", "params"], `${pp}/spec`);
      if (!sp.data) {
        rec.strip("panel(noData)", pp); // panel tanpa data tidak punya padanan v2 (ChartPanelV2.data wajib)
        return;
      }
      const hl: Array<string | number> = [];
      const pd = adaptChartData(sp.data, `${pp}/spec/data`, rec, hl);
      specHighlight(sp, rec, hl);
      const v: ChartPanelV2 = { name: panel.name, code: panel.code, data: adaptChartParams(panel.code, sp, pd, hl, `${pp}/spec`, rec) ?? pd };
      if (hl.length > 0) v.highlight = hl;
      if (sp.unit !== undefined) v.unit = sp.unit;
      if (sp.dec !== undefined) v.dec = sp.dec;
      if (sp.limit !== undefined) {
        // Ambang panel = DATA (D-223), bentuk sama dengan tingkat blok.
        v.limit = sp.limitLabel !== undefined ? { value: sp.limit, label: sp.limitLabel } : { value: sp.limit };
        rec.rename("limit->limit.value");
      } else if (sp.limitLabel !== undefined) {
        rec.strip("limitLabel", `${pp}/spec`); // label tanpa nilai ambang tidak bermakna
      }
      if (panel.caption !== undefined) v.caption = panel.caption;
      if (panel.axisNote !== undefined) v.axisNote = panel.axisNote;
      out.panels!.push(v);
    });
    rec.rename("composite.panels->panels");
  }
  specHighlight(s, rec, highlight);
  if (s.composite) {
    // Komposit: params tingkat spec = tata letak/templat; data hanya di panel.
    if (s.params && Object.keys(s.params).length > 0) rec.strip("params", ps);
  } else {
    const d = adaptChartParams(s.kind, s, out.data, highlight, ps, rec);
    if (d) out.data = d;
  }
  if (highlight.length > 0) out.highlight = highlight;
  if (s.unit !== undefined) out.unit = s.unit;
  if (s.dec !== undefined) out.dec = s.dec;
  if (s.limit !== undefined) {
    out.limit = s.limitLabel !== undefined ? { value: s.limit, label: s.limitLabel } : { value: s.limit };
    rec.rename("limit->limit.value");
  }
  if (s.note !== undefined) out.note = s.note;
  return withId(out, b.blockId, ctx);
}

function adaptDiagram(b: DiagramBlock, p: string, ctx: AdaptCtx): DiagramV2 {
  const { rec } = ctx;
  rec.rest(b, [...FIGURE_CONSUMED, "spec"], p);
  const fig = figureFields(b, p, rec);
  if ("artifactId" in b.spec) {
    rec.rest(b.spec, ["artifactId"], `${p}/spec`);
    return withId({ type: "diagram" as const, artifactId: b.spec.artifactId, ...fig }, b.blockId, ctx);
  }
  return withId({ type: "diagram" as const, spec: adaptDiagramSpec(b.spec, `${p}/spec`, rec), ...fig }, b.blockId, ctx);
}

function adaptImage(b: ImageBlock, p: string, ctx: AdaptCtx): ImageV2 {
  const { rec } = ctx;
  rec.rest(b, [...FIGURE_CONSUMED, "asset"], p);
  const asset = ctx.assetKeys.get(b.asset) ?? b.asset;
  if (asset !== b.asset) rec.rename("image.asset(normalized)");
  return withId({ type: "image" as const, asset, ...figureFields(b, p, rec) }, b.blockId, ctx);
}

function adaptSymbolSheet(b: SymbolSheetBlock, p: string, ctx: AdaptCtx): SymbolSheetV2 {
  ctx.rec.rest(b, [...FIGURE_CONSUMED, "dialect"], p);
  return withId({ type: "symbolSheet" as const, dialect: b.dialect, ...figureFields(b, p, ctx.rec) }, b.blockId, ctx);
}

// ── Bab dan section ──────────────────────────────────────────────────────

/**
 * `Chapter` → `ChapterV2`. `key` absen → posisi (`fallbackKey`); `partId`
 * dari bab itu sendiri atau dari `PartSpec.chapterKeys` (`partOf`).
 */
export function adaptChapter(
  c: Chapter,
  fallbackKey: string,
  partOf: ReadonlyMap<string, string>,
  p: string,
  ctx: AdaptCtx,
): ChapterV2 {
  const { rec } = ctx;
  rec.rest(c, ["key", "blockId", "title", "partId", "runningHeadTitle", "intro", "sections"], p);
  let key = c.key;
  if (key === undefined || key === "") {
    key = fallbackKey;
    rec.rename("chapter.key(position)");
  }
  const id = ctx.pids.map(c.blockId);
  const out: ChapterV2 = { key, ...(id ? { id } : {}), title: adaptInline(c.title, `${p}/title`, rec), sections: [] };
  if (c.runningHeadTitle !== undefined) {
    out.shortTitle = c.runningHeadTitle;
    rec.rename("runningHeadTitle->shortTitle");
  }
  const partId = c.partId ?? partOf.get(key);
  if (partId !== undefined) {
    out.partId = partId;
    if (c.partId === undefined) rec.rename("chapterKeys->partId");
  }
  if (c.intro && c.intro.length > 0) out.intro = adaptFlow(c.intro, `${p}/intro`, ctx);
  out.sections = c.sections.map((s, i) => adaptSection(s, ptr(p, "sections", i), ctx));
  return out;
}

function adaptSection(s: Section, p: string, ctx: AdaptCtx): SectionV2 {
  ctx.rec.rest(s, ["blockId", "title", "blocks"], p);
  const id = ctx.pids.map(s.blockId);
  return { ...(id ? { id } : {}), title: adaptInline(s.title, `${p}/title`, ctx.rec), blocks: adaptFlow(s.blocks, `${p}/blocks`, ctx) };
}

