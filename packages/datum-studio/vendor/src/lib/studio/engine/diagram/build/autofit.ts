/**
 * Aktivasi tata letak otomatis diagram (FIG-02b, pola FIG-02a `chart/core/autofit.ts`).
 *
 * 1. Render pertama dilint (`fit/lint.ts`). Skor 0 -> dikembalikan apa adanya (byte-identik).
 * 2. Ada cacat -> rakit ulang di dalam `withDiagramFit`. Hasilnya dipakai hanya bila skor lint
 *    lebih kecil; selain itu (atau bila rakitan ulang gagal) render pertama dipertahankan.
 * 3. Temuan dan catatan pembantu masuk `report.geometry` sebagai REPORT dengan `suggest`
 *    (tidak pernah FAIL).
 */
import type { LintIssue } from "../../../contract";
import { lintDiagramGeometry, type DiagramDefectKind, type DiagramGeomLint } from "../fit/lint";
import { withDiagramFit, type DiagramFitState } from "../fit/state";
import type { DiagramSvgResult } from "./svg";

export type DiagramGeometryIssue = LintIssue & { suggest: string };

const CHECK: Record<DiagramDefectKind, string> = {
  textOverlap: "GEOM_TEXT_OVERLAP",
  textOutside: "GEOM_TEXT_OUTSIDE",
  lineThroughText: "GEOM_LINE_TEXT",
  textOverNode: "GEOM_TEXT_NODE",
  textExceedsNode: "GEOM_LABEL_OVERFLOW",
  edgeCross: "GEOM_EDGE_CROSS",
  edgeCollinear: "GEOM_EDGE_COLLINEAR",
  edgeThroughNode: "GEOM_EDGE_NODE",
};

const WHAT: Record<DiagramDefectKind, string> = {
  textOverlap: "pasangan teks bertumpuk",
  textOutside: "teks keluar lembar",
  lineThroughText: "teks ditembus konektor",
  textOverNode: "teks menimpa garis tepi simpul",
  textExceedsNode: "label lebih lebar dari simpul",
  edgeCross: "persilangan konektor",
  edgeCollinear: "segmen konektor berimpit",
  edgeThroughNode: "konektor menembus simpul",
};

const SUGGEST: Record<DiagramDefectKind, string> = {
  textOverlap: "persingkat label simpul (maks ~40 karakter) dan label tepi (maks ~20 karakter)",
  textOutside: "persingkat label zona/lajur atau judul yang keluar lembar",
  lineThroughText: "persingkat label tepi (maks ~20 karakter) atau kurangi konektor per simpul",
  textOverNode: "persingkat label simpul (maks ~40 karakter); detail ke `sub`",
  textExceedsNode: "persingkat label simpul (maks ~40 karakter); detail ke `sub`",
  edgeCross: "ubah urutan simpul dalam tingkat/kolom agar konektor tidak bersilang, atau pecah menjadi 2 diagram",
  edgeCollinear: "kurangi konektor yang berbagi jalur atau pecah menjadi 2 diagram (maks ~12 simpul per tingkat 166 mm)",
  edgeThroughNode: "ubah urutan simpul agar konektor tidak melewati simpul lain",
};

/** Isu REPORT per jenis cacat tersisa, dengan contoh teks dan `suggest`. */
export function diagramGeometryIssues(g: DiagramGeomLint): DiagramGeometryIssue[] {
  const out: DiagramGeometryIssue[] = [];
  for (const kind of Object.keys(CHECK) as DiagramDefectKind[]) {
    const ds = g.defects.filter((d) => d.kind === kind);
    if (!ds.length) continue;
    const sample = [...new Set(ds.map((d) => (d.other ? `'${d.text}' x '${d.other}'` : `'${d.text}'`)))].slice(0, 2).join("; ");
    const suggest = SUGGEST[kind];
    out.push({ checkId: CHECK[kind], status: "REPORT", detail: `${ds.length} ${WHAT[kind]}: ${sample}; saran: ${suggest}`, suggest });
  }
  return out;
}

function checkIdOf(e: unknown): string {
  const d = (e as { details?: { checkId?: string } } | null)?.details;
  return d?.checkId ?? (e instanceof Error ? e.message.slice(0, 80) : String(e));
}

/**
 * Kandidat fit, dari perubahan terbesar ke terkecil: (1) penuh; (2) tanpa tumbuh tinggi simpul;
 * (3) tanpa tumbuh tinggi dan tanpa baris catatan bernomor. Kandidat berikutnya dicoba hanya bila
 * yang sebelumnya gagal (mis. DATUM-33 karena tinggi) atau tidak lebih baik dari render pertama.
 */
const CANDIDATES: ReadonlyArray<{ label: string; grow: boolean; numbered: boolean }> = [
  { label: "penuh", grow: true, numbered: true },
  { label: "tanpa tumbuh tinggi simpul", grow: false, numbered: true },
  { label: "tanpa tumbuh tinggi dan tanpa label bernomor", grow: false, numbered: false },
];

/** Jenis cacat yang ditangani pembantu rute FIG-02b2. */
const ROUTE_KINDS: readonly DiagramDefectKind[] = ["edgeCross", "edgeCollinear", "lineThroughText", "edgeThroughNode"];

/** Pilih render pertama atau rakitan ulang fit (lihat kepala berkas). */
export function autoFitDiagram(first: DiagramSvgResult, rerender: () => DiagramSvgResult): DiagramSvgResult {
  const g0 = lintDiagramGeometry(first.svg);
  if (g0.score === 0) return first;
  const tried: string[] = [];
  let best: { res: DiagramSvgResult; g: DiagramGeomLint; state: DiagramFitState; label: string } | undefined;
  // FIG-02b2: tiap kandidat dicoba dengan pembantu rute (urutan simpul, jalur, rute rak/sld; aktif
  // hanya pada cacat rute terukur) dan tanpa (= perilaku FIG-02b1); skor terkecil dipakai.
  const routeCan = ROUTE_KINDS.some((k) => (g0.counts[k] ?? 0) > 0);
  let routeRendered = !routeCan;
  for (const c of CANDIDATES) {
    for (const noRoute of routeCan ? [true, false] : [true]) {
      const label = routeCan ? `${c.label}${noRoute ? ", tanpa rute ulang" : ", rute ulang"}` : c.label;
      const state: DiagramFitState = { notes: [], grow: c.grow, numbered: c.numbered, defects: g0.counts, noRoute };
      try {
        const res = withDiagramFit(state, rerender);
        const g = lintDiagramGeometry(res.svg);
        tried.push(`${label}: ${g.score}`);
        if (!noRoute) routeRendered = true;
        if (g.score < g0.score && (!best || g.score < best.g.score)) best = { res, g, state, label };
      } catch (e) {
        tried.push(`${label}: gagal ${checkIdOf(e)}`);
      }
    }
    if (best && routeRendered) break;
  }
  if (best) {
    const { res, g, state } = best;
    const geometry: DiagramGeometryIssue[] = [
      {
        checkId: "AUTO_FIT",
        status: "REPORT",
        detail: `cacat geometri terdeteksi (${g0.score}); tata letak otomatis (${best.label}) -> sisa ${g.score}; dicoba: ${tried.join("; ")}`,
        suggest: g.score ? "lihat isu GEOM_* berikut" : "tidak ada",
      },
      ...state.notes.map((n) => ({ checkId: n.checkId, status: "REPORT" as const, detail: n.suggest ? `${n.detail}; saran: ${n.suggest}` : n.detail, suggest: n.suggest ?? "tidak ada" })),
      ...diagramGeometryIssues(g),
    ];
    return { ...res, report: { ...res.report, geometry } };
  }
  const geometry: DiagramGeometryIssue[] = [
    {
      checkId: "AUTO_FIT",
      status: "REPORT",
      detail: `cacat geometri terdeteksi (${g0.score}); tata letak otomatis tidak lebih baik (${tried.join("; ")}); render pertama dipertahankan`,
      suggest: "lihat isu GEOM_* berikut",
    },
    ...diagramGeometryIssues(g0),
  ];
  return { ...first, report: { ...first.report, geometry } };
}
