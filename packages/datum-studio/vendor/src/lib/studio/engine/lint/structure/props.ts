/**
 * Pemindaian properti format di seluruh pohon dokumen (termasuk kepala/kaki
 * halaman dan halaman depan): wajah fon, warna run, garis, dan isian. Dipakai
 * DATUM-05, DATUM-12, DATUM-21. Subpohon `x`, `spec` (spesifikasi mesin
 * chart/diagram), `register`, `assets`, dan `overrides` dilewati.
 */
import type { StudioDocV1 } from "../../../contract";
import { normHex } from "./text";

export interface FaceUse {
  face: string;
  pointer: string;
}

export interface ColorUse {
  hex: string;
  pointer: string;
  kind: "run" | "border" | "shading";
}

export interface BorderUse {
  sz: number;
  val: string;
  pointer: string;
}

export interface PropScan {
  faces: FaceUse[];
  colors: ColorUse[];
  borders: BorderUse[];
  fills: ColorUse[];
}

const SKIP: ReadonlySet<string> = new Set(["x", "spec", "register", "assets", "overrides"]);

function esc(seg: string): string {
  return seg.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function scanProps(doc: StudioDocV1): PropScan {
  const out: PropScan = { faces: [], colors: [], borders: [], fills: [] };
  const visit = (o: unknown, p: string, depth: number): void => {
    if (depth > 64 || o === null || typeof o !== "object") return;
    if (Array.isArray(o)) {
      o.forEach((x, i) => visit(x, `${p}/${i}`, depth + 1));
      return;
    }
    const r = o as Record<string, unknown>;
    const isBorder = typeof r.val === "string" && typeof r.sz === "number";
    const isShading = typeof r.fill === "string" && r.val === "clear";
    if (isBorder) {
      out.borders.push({ sz: r.sz as number, val: r.val as string, pointer: p });
      const hex = normHex(r.color);
      if (hex && r.val !== "none") out.colors.push({ hex, pointer: p, kind: "border" });
    } else if (isShading) {
      const hex = normHex(r.fill);
      if (hex) {
        out.fills.push({ hex, pointer: p, kind: "shading" });
        out.colors.push({ hex, pointer: p, kind: "shading" });
      }
    } else {
      const hex = normHex(r.color);
      if (hex) out.colors.push({ hex, pointer: `${p}/color`, kind: "run" });
    }
    if (typeof r.face === "string" && r.face.trim() !== "") out.faces.push({ face: r.face.trim(), pointer: `${p}/face` });
    for (const [k, v] of Object.entries(r)) {
      if (SKIP.has(k)) continue;
      if (v && typeof v === "object") visit(v, `${p}/${esc(k)}`, depth + 1);
    }
  };
  visit(doc, "", 0);
  return out;
}

/** Semua hex di nilai parameter (rekursif). */
export function hexesIn(v: unknown, into: Set<string>, depth = 0): void {
  if (depth > 16 || v === null || v === undefined) return;
  const h = normHex(v);
  if (h) {
    into.add(h);
    return;
  }
  if (Array.isArray(v)) for (const x of v) hexesIn(x, into, depth + 1);
  else if (typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) hexesIn(x, into, depth + 1);
}
