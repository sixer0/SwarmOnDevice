/**
 * Geometri DATUM-32: konektor yang melewati kotak tak terkait.
 *
 * Simpul terkait = simpul terdekat dari titik awal dan titik akhir konektor
 * (konektor berujung di tepi simpul atau celah port; panah `refX`). Segmen
 * dicuplik rapat; satu cuplikan di bagian DALAM simpul lain (setelah inset
 * toleransi) = pelanggaran. Inset menyingkirkan sentuhan tepi dan garis
 * rambut yang sejajar tepi.
 */
import type { Pt, SvgLink, SvgNode } from "./svg";

export interface CrossingFinding {
  link: string;
  node: string;
  /** Panjang lintasan di dalam simpul (uu). */
  insideUu: number;
}

function distToBox(p: Pt, b: SvgNode["box"]): number {
  const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
  const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
  return Math.hypot(dx, dy);
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

function inPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Titik di bagian dalam bentuk dengan jarak ke tepi > inset. */
export function insideShape(p: Pt, n: SvgNode, inset: number): boolean {
  const s = n.shape;
  if (s.kind === "rect") {
    return p.x > s.x + inset && p.x < s.x + s.w - inset && p.y > s.y + inset && p.y < s.y + s.h - inset;
  }
  if (s.kind === "circle") return Math.hypot(p.x - s.cx, p.y - s.cy) < s.r - inset;
  if (!inPolygon(p, s.points)) return false;
  for (let i = 0, j = s.points.length - 1; i < s.points.length; j = i++) {
    if (distToSegment(p, s.points[j], s.points[i]) <= inset) return false;
  }
  return true;
}

function nearestNode(p: Pt, nodes: readonly SvgNode[], maxDist: number): number {
  let best = -1;
  let bestD = Infinity;
  nodes.forEach((n, i) => {
    const d = distToBox(p, n.box);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return bestD <= maxDist ? best : -1;
}

const MAX_SAMPLES_PER_SEGMENT = 20_000;

/**
 * Cari konektor yang melewati simpul tak terkait.
 * @param stepUu jarak cuplikan; @param insetUu toleransi tepi; @param endpointUu jarak maks ujung ke simpul terkait.
 */
export function findCrossings(
  nodes: readonly SvgNode[],
  links: readonly SvgLink[],
  o: { stepUu: number; insetUu: number; endpointUu: number },
): CrossingFinding[] {
  const out: CrossingFinding[] = [];
  for (const l of links) {
    const pts = l.points;
    const related = new Set<number>();
    const a = nearestNode(pts[0], nodes, o.endpointUu);
    const b = nearestNode(pts[pts.length - 1], nodes, o.endpointUu);
    if (a >= 0) related.add(a);
    if (b >= 0) related.add(b);
    const inside = new Map<number, number>();
    for (let k = 1; k < pts.length; k++) {
      const p0 = pts[k - 1];
      const p1 = pts[k];
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (len === 0) continue;
      const n = Math.min(MAX_SAMPLES_PER_SEGMENT, Math.max(1, Math.ceil(len / o.stepUu)));
      const step = len / n;
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const p = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
        nodes.forEach((nd, i) => {
          if (related.has(i)) return;
          const bx = nd.box;
          if (p.x < bx.x0 || p.x > bx.x1 || p.y < bx.y0 || p.y > bx.y1) return;
          if (insideShape(p, nd, o.insetUu)) inside.set(i, (inside.get(i) ?? 0) + step);
        });
      }
    }
    for (const [i, d] of [...inside.entries()].sort((x, y) => x[0] - y[0])) {
      out.push({ link: l.index, node: nodes[i].id, insideUu: d });
    }
  }
  return out;
}
