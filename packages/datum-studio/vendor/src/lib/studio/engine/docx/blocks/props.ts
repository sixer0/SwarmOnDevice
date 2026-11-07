/**
 * Format langsung paragraf/run (S16): `ParaFormat` -> isi `w:pPr`, `RunProps`
 * -> `w:rPr`. Tanpa gaya bernama: semua paragraf tetap `Normal` (BM.docx,
 * research/07 §8: pStyle badan = 0), seluruh format ditulis per paragraf/run.
 *
 * Urutan elemen mengikuti skema OOXML (CT_PPrBase, CT_RPr; sama dengan
 * PPR_ORDER/RPR_ORDER datum_docx.py). `caps` ditulis sebagai `w:caps`;
 * huruf teks tidak pernah diubah.
 *
 * Sejak IP-38 (INT-T, INT-W; D-110) serialisasi `w:rPr`/`w:pPr`, garis dan
 * arsir berasal dari satu sumber `../package/xml` ragam `BLOCK_FLAVOR`
 * (urutan atribut `w:rFonts` ascii/hAnsi/eastAsia/cs, `w:caps w:val="0"`
 * eksplisit, tanpa `w:szCs`, `w:lineRule` tanpa bawaan "auto", bilangan
 * dibulatkan, slot `framePr`); modul ini hanya mengikat peta wajah `FaceMap`.
 */
import type { BorderSpec, Borders, FaceRole, ParaFormat, RunProps, Shading } from "../../../contract";
import {
  BLOCK_FLAVOR,
  borderXml,
  pPrInner as packagePPrInner,
  rPrInnerXml,
  shadingXml,
  sideBordersXml,
} from "../package/xml";

/** Peta peran wajah -> nama wajah (parameter `type.face.<peran>`). */
export type FaceMap = Readonly<Record<FaceRole, string>>;

export const FACE_ROLES: readonly FaceRole[] = ["serif", "condensed", "mono", "workbookUi", "symbolGlyph"];

/** Atribut di atas `base` per kunci; `face` dan `faceRole` saling meniadakan (XOR, §3.2). */
export function mergeRun(base: RunProps | undefined, over: RunProps | undefined): RunProps {
  const out: RunProps = { ...(base ?? {}) };
  if (!over) return out;
  for (const [k, v] of Object.entries(over) as Array<[keyof RunProps, RunProps[keyof RunProps]]>) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  if (over.face !== undefined) delete out.faceRole;
  if (over.faceRole !== undefined) delete out.face;
  return out;
}

/** Atribut `over` menang per kunci; `borders` digabung per sisi, `tabs` diganti utuh. */
export function mergePara(base: ParaFormat | undefined, over: ParaFormat | undefined): ParaFormat {
  const out: ParaFormat = { ...(base ?? {}) };
  if (!over) return out;
  for (const [k, v] of Object.entries(over) as Array<[keyof ParaFormat, ParaFormat[keyof ParaFormat]]>) {
    if (v === undefined) continue;
    if (k === "borders") out.borders = { ...(base?.borders ?? {}), ...(over.borders ?? {}) };
    else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Hanya properti run dari objek `Run` (membuang `t`, `tab`, `br`, `field`). */
export function runPropsOf(run: object): RunProps {
  const { t: _t, tab: _tab, br: _br, field: _field, ...rest } = run as Record<string, unknown>;
  void _t;
  void _tab;
  void _br;
  void _field;
  return rest as RunProps;
}

/** Nama wajah efektif run (face langsung > peta faceRole). */
export function faceOf(p: RunProps, faces: FaceMap): string | undefined {
  if (p.face) return p.face;
  if (p.faceRole) return faces[p.faceRole];
  return undefined;
}

/** Isi `w:rPr` (tanpa pembungkus); wajah yang dipakai dicatat ke `used`. */
export function rPrInner(p: RunProps, faces: FaceMap, used: Set<string>): string {
  const face = faceOf(p, faces);
  if (face) used.add(face);
  return rPrInnerXml(p, face, undefined, BLOCK_FLAVOR);
}

export function rPrXml(p: RunProps, faces: FaceMap, used: Set<string>): string {
  const inner = rPrInner(p, faces, used);
  return inner ? `<w:rPr>${inner}</w:rPr>` : "";
}

/** Satu sisi garis (`w:top`, `w:bottom`, ...): `borderXml` paket. */
export function borderEl(tag: string, b: BorderSpec): string {
  return borderXml(tag.replace(/^w:/, ""), b);
}

/** Garis per sisi dengan urutan skema: top, left, bottom, right, insideH, insideV. */
export function bordersInner(b: Borders): string {
  return sideBordersXml(b) + borderXml("insideH", b.insideH) + borderXml("insideV", b.insideV);
}

export function shadingEl(s: Shading): string {
  return shadingXml(s);
}

/**
 * Isi `w:pPr` (tanpa pembungkus). `framePr` (chip rel moda A, Garis A) disisipkan
 * di posisi skemanya bila diberikan.
 */
export function pPrInner(f: ParaFormat, framePr?: string): string {
  return packagePPrInner(f, undefined, BLOCK_FLAVOR, { framePr });
}
