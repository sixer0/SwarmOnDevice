/**
 * Kapasitas yang membantu (FIG-02b2, audit research/18 §6 P1-14).
 *
 * Bila render pertama ditolak DATUM-37 (graph / swimlane), rakitan diulang di dalam fit dengan
 * `capacity: true` (tata letak beradaptasi: pitch graph dipadatkan, swimlane kolom waktu bersama
 * lalu bungkus dalam lajur). Hasil dengan skor lint terkecil dipakai dan dilaporkan REPORT
 * `CAPACITY_ADAPT`, tetapi hanya hasil yang lolos `capacityAcceptable` (D-503: tanpa teks
 * bertumpuk, persilangan + berimpit <= 3). Bila semua gagal atau tidak ada yang lolos, penolakan
 * asli dilempar ulang (kelas, kode, checkId sama) dengan saran aksi konkret di pesannya.
 */
import { StudioEngineError } from "../../../contract/errors";
import type { StudioDiagramV1 } from "../../../contract";
import { DiagramDefect, LATTICE_X } from "../core";
import { lintDiagramGeometry, type DiagramGeomLint } from "../fit/lint";
import { withDiagramFit, type DiagramFitState } from "../fit/state";
import { diagramGeometryIssues, type DiagramGeometryIssue } from "./autofit";
import type { DiagramSvgResult } from "./svg";

const ADAPTIVE = new Set(["graph", "swimlane"]);

function checkIdOf(e: unknown): string {
  const d = (e as { details?: { checkId?: string } } | null)?.details;
  return d?.checkId ?? (e as { checkId?: string } | null)?.checkId ?? "";
}

/** Penolakan kapasitas yang boleh dicoba ulang dengan adaptasi tata letak. */
export function isCapacityReject(e: unknown, s: StudioDiagramV1): boolean {
  return e instanceof StudioEngineError && checkIdOf(e).startsWith("DATUM-37") && ADAPTIVE.has(String(s.family));
}

/** Saran aksi konkret per keluarga untuk penolakan kapasitas/tinggi. */
export function capacityAction(s: StudioDiagramV1, checkId: string): string | null {
  const W = Number(s.width_mm) || 166;
  const fam = String(s.family);
  if (checkId.startsWith("DATUM-33")) return "kurangi simpul/pesan per gambar atau pecah menjadi 2 diagram";
  if (!checkId.startsWith("DATUM-37")) return null;
  if (fam === "graph") {
    const cols = [...new Set((s.nodes ?? []).map((n) => Number((n.class as Record<string, unknown> | undefined)?.col ?? 0)))].sort((a, b) => a - b);
    const gap = cols.some((c, i) => i > 0 && c !== cols[i - 1] + 1);
    const maxCols = Math.floor((W - LATTICE_X * 2) / (LATTICE_X * 3) + 1e-9) + 1;
    return gap
      ? `rapatkan class.col (ada kolom kosong di antara kolom ${cols.join(", ")}); maks ${maxCols} kolom pada ${W} mm`
      : `maks ${maxCols} kolom pada ${W} mm; bagi menjadi dua gambar atau pakai layered`;
  }
  if (fam === "swimlane") return `kurangi simpul per lajur, bagi lajur, atau pecah menjadi 2 diagram (lebar ${W} mm)`;
  if (fam === "sld") return `maks 3 cabang per tingkat pada ${W} mm; pecah rel atau bagi menjadi dua gambar`;
  if (fam === "flow") return "persingkat label keputusan (maks ~40 karakter) atau pakai per_row";
  return `persingkat label atau pecah menjadi 2 diagram (lebar ${W} mm)`;
}

/** Lempar ulang `e` dengan saran aksi (kelas, kode, checkId, pointer dipertahankan). */
export function withAction(e: unknown, s: StudioDiagramV1): unknown {
  if (!(e instanceof StudioEngineError)) return e;
  const action = capacityAction(s, checkIdOf(e));
  if (!action || e.message.includes("saran:")) return e;
  const msg = `${e.message}; saran: ${action}`;
  if (e instanceof DiagramDefect) return new DiagramDefect(msg, { checkId: e.checkId, pointer: e.pointer, code: e.code });
  const out = new StudioEngineError(e.code, msg, e.details as never);
  out.name = e.name;
  return out;
}

const MODES: ReadonlyArray<{ grow: boolean; capMode?: string }> = [
  { grow: true, capMode: "time" },
  { grow: true, capMode: "pack" },
  { grow: false, capMode: "time" },
  { grow: false, capMode: "pack" },
];

/** D-503 (3): batas rute bercacat untuk render hasil adaptasi kapasitas (persilangan + berimpit). */
export const CAPACITY_MAX_ROUTE_DEFECTS = 3;

/**
 * D-503 (3): render hasil adaptasi kapasitas hanya dipakai bila lint tanpa teks bertumpuk dan
 * persilangan + segmen berimpit <= 3. Selain itu penolakan lama dipertahankan (dokumen klien
 * tidak boleh memuat diagram rusak diam-diam).
 */
export function capacityAcceptable(g: DiagramGeomLint): boolean {
  return (g.counts.textOverlap ?? 0) === 0 && (g.counts.edgeCross ?? 0) + (g.counts.edgeCollinear ?? 0) <= CAPACITY_MAX_ROUTE_DEFECTS;
}

/**
 * Coba ulang rakitan yang ditolak kapasitas; lempar penolakan asli (+ saran) bila semua gagal
 * atau bila tidak ada hasil yang lolos `capacityAcceptable`.
 */
export function capacityRetry(s: StudioDiagramV1, original: unknown, rebuild: () => DiagramSvgResult): DiagramSvgResult {
  let best: { res: DiagramSvgResult; g: DiagramGeomLint; state: DiagramFitState } | undefined;
  const tried: string[] = [];
  const modes = s.family === "swimlane" ? MODES : MODES.filter((m) => m.capMode === "time");
  for (const m of modes) {
    const state: DiagramFitState = { notes: [], grow: m.grow, numbered: true, capacity: true, capMode: m.capMode, defects: {} };
    try {
      const res = withDiagramFit(state, rebuild);
      const g = lintDiagramGeometry(res.svg);
      const ok = capacityAcceptable(g);
      tried.push(`${m.capMode}${m.grow ? "" : ", tanpa tumbuh"}: ${g.score}${ok ? "" : " (ditolak: teks bertumpuk atau persilangan + berimpit > 3)"}`);
      if (ok && (!best || g.score < best.g.score)) best = { res, g, state };
      if (g.score === 0) break;
    } catch (e) {
      tried.push(`${m.capMode}${m.grow ? "" : ", tanpa tumbuh"}: gagal ${checkIdOf(e)}`);
    }
  }
  if (!best) throw withAction(original, s);
  const geometry: DiagramGeometryIssue[] = [
    {
      checkId: "AUTO_FIT",
      status: "REPORT",
      detail: `render pertama ditolak ${checkIdOf(original)}; tata letak kapasitas -> sisa ${best.g.score}; dicoba: ${tried.join("; ")}`,
      suggest: best.g.score ? "lihat isu GEOM_* berikut" : "tidak ada",
    },
    ...best.state.notes.map((n) => ({ checkId: n.checkId, status: "REPORT" as const, detail: n.suggest ? `${n.detail}; saran: ${n.suggest}` : n.detail, suggest: n.suggest ?? "tidak ada" })),
    ...diagramGeometryIssues(best.g),
  ];
  return { ...best.res, report: { ...best.res.report, geometry } };
}
