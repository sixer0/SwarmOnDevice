/**
 * Penempatan simpul untuk rakitan (S30): jalankan `LayoutFn` keluarga
 * (layout-a/b/c lewat dispatcher D01) pada `Sheet` core, pindahkan hasilnya ke
 * lembar dalam urutan sisip dict Python, lalu kunci kisi + clamp DATUM-37
 * (`Sheet.snapToLattice`, `HS/datum_diagram.py` build_svg :1124-1136).
 */
import type { DiagramFamily, DiagramNode, LayoutFn, LayoutResult, StudioDiagramV1 } from "../../../contract";
import { DiagramDefect, Sheet } from "../core";

/** Medan lembar tambahan yang dikembalikan layout-b (swimlane/sequence) di atas `LayoutResult`. */
interface LayoutExtras {
  laneOrder?: string[];
  nodeLane?: Record<string, string>;
  gutterMm?: number;
  lifelines?: Array<{ x: number; top: number }>;
  msgY?: number;
  msgStep?: number;
}

export interface Placement {
  sheet: Sheet;
  layout: LayoutResult & LayoutExtras;
}

/** Kunci indeks larik JS: `Object.keys` mengurutkannya numerik, bukan urutan sisip. */
function isIndexKey(k: string): boolean {
  return /^(0|[1-9]\d*)$/.test(k) && Number(k) < 4294967295;
}

/** Python `str(v)` untuk kunci tingkat/lajur. */
function keyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

function classOf(n: DiagramNode): Record<string, unknown> {
  return (n.class ?? {}) as Record<string, unknown>;
}

/**
 * Urutan sisip `sheet.nodes` Python per mesin (HS :452-799), dipakai bila id
 * simpul berbentuk bilangan bulat (urutan kunci `Record` JS tidak lagi = sisip).
 */
function pythonInsertionOrder(s: StudioDiagramV1, layout: LayoutResult & LayoutExtras): string[] {
  const nodes = s.nodes ?? [];
  const groupBy = (key: (n: DiagramNode) => string): string[] => {
    const order: string[] = [];
    const groups = new Map<string, string[]>();
    for (const n of nodes) {
      const k = key(n);
      if (!groups.has(k)) {
        groups.set(k, []);
        order.push(k);
      }
      groups.get(k)!.push(n.id);
    }
    return order.flatMap((k) => groups.get(k)!);
  };
  switch (s.family) {
    case "layered":
    case "topology":
    case "stack":
      return groupBy((n) => {
        const c = classOf(n);
        const has = (k: string) => Object.prototype.hasOwnProperty.call(c, k);
        return keyStr(has("tier") ? c.tier : has("row") ? c.row : 0);
      });
    case "swimlane": {
      const lane = layout.nodeLane;
      return groupBy((n) => (lane ? (lane[n.id] ?? "") : classOf(n).lane === undefined ? "tanpa lajur" : keyStr(classOf(n).lane)));
    }
    case "sld": {
      // layout-c menempatkan semua rel bus dulu (multi-bus INT-J/D-89), lalu cabang.
      const buses = nodes.filter((n) => n.shape === "bus");
      return [...buses, ...nodes.filter((n) => n.shape !== "bus")].map((n) => n.id);
    }
    case "rack": {
      const rowOf = (n: DiagramNode) => Math.trunc(Number(classOf(n).row ?? 0));
      return nodes
        .map((n, i) => ({ n, i }))
        .sort((a, b) => rowOf(a.n) - rowOf(b.n) || a.i - b.i)
        .map((x) => x.n.id);
    }
    default:
      return nodes.map((n) => n.id);
  }
}

function nodeOrder(s: StudioDiagramV1, layout: LayoutResult & LayoutExtras): string[] {
  const keys = Object.keys(layout.nodes);
  if (!keys.some(isIndexKey)) return keys;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...pythonInsertionOrder(s, layout), ...keys]) {
    if (Object.prototype.hasOwnProperty.call(layout.nodes, id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Tata letak keluarga lalu kunci kisi. Bila `LayoutFn` sudah memasang simpul
 * lewat `Sheet.placeNode`, urutan lembar itu dipakai apa adanya.
 */
export function placeDiagram(s: StudioDiagramV1, sheet: Sheet, layouts: Readonly<Record<DiagramFamily, LayoutFn>>): Placement {
  const fn = layouts[s.family];
  if (typeof fn !== "function") {
    throw new DiagramDefect(`family '${String(s.family)}' tidak punya mesin tata letak (P2)`, { checkId: "P1-family" });
  }
  const layout = fn(s, sheet) as LayoutResult & LayoutExtras;

  if (sheet.nodes.size === 0) {
    const specById = new Map<string, DiagramNode>();
    for (const n of s.nodes ?? []) if (!specById.has(n.id)) specById.set(n.id, n);
    for (const id of nodeOrder(s, layout)) {
      const spec = specById.get(id);
      if (!spec) throw new DiagramDefect(`tata letak mengembalikan simpul tak dikenal '${id}'`, { checkId: "P1-nodes+P3-shapes" });
      const b = layout.nodes[id];
      sheet.placeNode({ id, spec, x: b.x, y: b.y, w: b.w, h: b.h });
    }
  }
  if (sheet.lanes.length === 0 && layout.lanes) {
    for (const name of layout.laneOrder ?? Object.keys(layout.lanes)) {
      const b = layout.lanes[name];
      if (b) sheet.lanes.push({ name, y: b.y, h: b.h });
    }
  }
  if (sheet.lifelines.length === 0 && Array.isArray(layout.lifelines)) {
    for (const l of layout.lifelines) sheet.lifelines.push({ x: l.x, top: l.top });
  }
  if (sheet.gutterW === undefined && typeof layout.gutterMm === "number") sheet.gutterW = layout.gutterMm;
  if (sheet.msgY === undefined && typeof layout.msgY === "number") sheet.msgY = layout.msgY;
  if (sheet.msgStep === undefined && typeof layout.msgStep === "number") sheet.msgStep = layout.msgStep;

  sheet.snapToLattice();
  return { sheet, layout };
}
