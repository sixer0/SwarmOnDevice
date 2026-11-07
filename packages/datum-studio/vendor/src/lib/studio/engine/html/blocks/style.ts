/**
 * Konversi format kontrak (ParaFormat, RunProps, BorderSpec) ke CSS inline dan
 * resolusi format per peran (01_specs.md §5.6): format eksplisit blok >
 * `roleFormats[role]` templat > turunan katalog (> benchmark pembungkus) >
 * CSS token S21 — urutan yang sama dengan DOCX (ENG-01).
 *
 * Semua nilai CSS dibangkitkan dari angka tervalidasi, enum tertutup, heks
 * tervalidasi, atau nama wajah tersaring; tidak ada string masukan mentah.
 */
import type {
  BorderSpec,
  Borders,
  FaceRole,
  ParaFormat,
  RenderContext,
  ResolvedTemplate,
  RoleFormat,
  RoleKey,
  RunProps,
  Shading,
} from "../../../contract";
import { benchmarkRole, roleFormat as wrapperRoleFormat, type WrapperRole } from "../../docx/wrapper/formats";
import { resolveRoleFormat } from "../../tokens";
import { faceForRole } from "../assemble/faces";
import { HTML_BLOCK_CLASSES as C } from "./classes";
import { finite, num, safeFaceName, safeHex } from "./escape";

const TW_PER_PT = 20;

function pt(tw: number): string {
  return `${num(tw / TW_PER_PT)}pt`;
}

// ── Resolusi format per peran (ENG-01, paritas DOCX) ─────────────────────
//
// HTML memakai resolver DOCX yang SAMA (tanpa salinan logika), dipilih per
// jalur pemanggil seperti di DOCX:
// - blok isi (DOCX `blocks/env.ts` role): `roleFormats[role]` templat > turunan
//   katalog (`resolveRoleFormat`, S11);
// - halaman pembungkus (DOCX `wrapper/pages.ts` + `render.ts`): `roleFormats`
//   templat (sub-objek utuh) > turunan katalog > nilai terukur benchmark
//   (`docx/wrapper/formats.ts` roleFormat, termasuk turunan entri TOC FIX-TL).
// Di bawah keduanya tetap CSS token S21 (padanan gaya Normal DOCX). Sebelum
// ENG-01 hanya `roleFormats` templat yang dibaca, sehingga templat tanpa
// roleFormats (DATUM-kanonik) jatuh ke gaya bawaan peramban (UA-M02).

/** Konteks yang sedang merender halaman pembungkus -> konteks dasar pemanggil. */
const WRAPPER_SCOPE = new WeakMap<RenderContext, RenderContext>();

/**
 * Konteks lingkup pembungkus (renderer cover/controlSheet/toc/partDivider/
 * signatureBlock/appendix): `roleFormat` memakai rantai DOCX pembungkus.
 * Idempoten; konteks dasar tidak diubah.
 */
export function wrapperScope(ctx: RenderContext): RenderContext {
  if (WRAPPER_SCOPE.has(ctx)) return ctx;
  const scoped: RenderContext = { ...ctx };
  WRAPPER_SCOPE.set(scoped, ctx);
  return scoped;
}

/** Konteks blok isi: unsur pembungkus yang DOCX delegasikan ke renderer blok (list, aside, spacer, ...). */
export function blockScope(ctx: RenderContext): RenderContext {
  return WRAPPER_SCOPE.get(ctx) ?? ctx;
}

function templateOnly(ctx: RenderContext, role: RoleKey): RoleFormat {
  const rf = ctx.tpl?.roleFormats?.[role];
  return rf && typeof rf === "object" ? rf : {};
}

/**
 * Format efektif peran untuk jalur pemanggil `ctx` (lihat kepala bagian ini).
 * Galat resolusi (templat cacat) dicatat ke log render dan format templat saja
 * dipakai, agar render tidak gagal karena lapisan cadangan.
 */
export function roleFormat(ctx: RenderContext, role: RoleKey): RoleFormat {
  const tpl = ctx.tpl;
  if (!tpl || typeof tpl !== "object" || !tpl.params || !tpl.roleFormats) return templateOnly(ctx, role);
  try {
    // `benchmarkRole` = undefined untuk peran di luar himpunan pembungkus DOCX (WrapperRole).
    if (WRAPPER_SCOPE.has(ctx) && benchmarkRole(role as WrapperRole, tpl.params) !== undefined) {
      return wrapperRoleFormat(ctx, role as WrapperRole);
    }
    return resolveRoleFormat(tpl, role);
  } catch (e) {
    ctx.log?.({
      level: "warn",
      code: "RENDER_ROLE_FORMAT_FALLBACK",
      message: `engine/html/blocks: format peran ${role} gagal diselesaikan (${e instanceof Error ? e.message : String(e)}); format templat saja dipakai`,
    });
    return templateOnly(ctx, role);
  }
}

export function mergePara(...formats: ReadonlyArray<ParaFormat | undefined>): ParaFormat {
  const out: ParaFormat = {};
  for (const f of formats) if (f && typeof f === "object") Object.assign(out, f);
  return out;
}

export function mergeRun(...props: ReadonlyArray<RunProps | undefined>): RunProps {
  const out: RunProps = {};
  for (const p of props) {
    if (!p || typeof p !== "object") continue;
    // face XOR faceRole: yang belakangan menang dan menghapus pasangannya.
    if (p.face !== undefined) delete out.faceRole;
    if (p.faceRole !== undefined) delete out.face;
    Object.assign(out, pickRunProps(p));
  }
  return out;
}

function pickRunProps(p: RunProps): RunProps {
  const o: RunProps = {};
  if (p.face !== undefined) o.face = p.face;
  if (p.faceRole !== undefined) o.faceRole = p.faceRole;
  if (p.szHalfPt !== undefined) o.szHalfPt = p.szHalfPt;
  if (p.color !== undefined) o.color = p.color;
  if (p.b !== undefined) o.b = p.b;
  if (p.i !== undefined) o.i = p.i;
  if (p.caps !== undefined) o.caps = p.caps;
  const sc = (p as RunProps & { smallCaps?: boolean }).smallCaps;
  if (sc !== undefined) (o as RunProps & { smallCaps?: boolean }).smallCaps = sc;
  if (p.spacingTw !== undefined) o.spacingTw = p.spacingTw;
  if (p.u !== undefined) o.u = p.u;
  if (p.vertAlign !== undefined) o.vertAlign = p.vertAlign;
  return o;
}

const BORDER_STYLE: Readonly<Record<BorderSpec["val"], string>> = {
  single: "solid",
  dashed: "dashed",
  dotted: "dotted",
  double: "double",
  none: "none",
};

/** BorderSpec -> nilai `border-*` CSS (sz dalam 1/8 pt). */
export function borderCss(b: BorderSpec | undefined): string | undefined {
  if (!b || typeof b !== "object") return undefined;
  const style = BORDER_STYLE[b.val];
  if (!style) return undefined;
  if (style === "none") return "none";
  const sz = finite(b.sz, 0, 96) ?? 4;
  const color = safeHex(b.color) ?? "currentColor";
  return `${num(sz / 8)}pt ${style} ${color}`;
}

export function bordersCss(borders: Omit<Borders, "insideH" | "insideV"> | undefined, decl: string[]): void {
  if (!borders || typeof borders !== "object") return;
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const v = borderCss(borders[side]);
    if (v) decl.push(`border-${side}:${v}`);
    const space = finite(borders[side]?.space, 0, 31);
    if (space !== undefined && v && v !== "none") decl.push(`padding-${side}:${num(space)}pt`);
  }
}

export function shadingCss(s: Shading | undefined, decl: string[]): void {
  const fill = safeHex(s?.fill);
  if (fill) decl.push(`background-color:${fill}`);
}

const JC: Readonly<Record<NonNullable<ParaFormat["jc"]>, string>> = {
  left: "left",
  right: "right",
  center: "center",
  both: "justify",
};

/** ParaFormat -> deklarasi CSS. */
export function paraDecl(f: ParaFormat | undefined): string[] {
  const d: string[] = [];
  if (!f || typeof f !== "object") return d;
  const before = finite(f.spacingBeforeTw, 0, 31680);
  if (before !== undefined) d.push(`margin-top:${pt(before)}`);
  const after = finite(f.spacingAfterTw, 0, 31680);
  if (after !== undefined) d.push(`margin-bottom:${pt(after)}`);
  const line = finite(f.lineTw, 1, 31680);
  if (line !== undefined) {
    if (f.lineRule === "exact") d.push(`line-height:${pt(line)}`);
    else if (f.lineRule === "atLeast") d.push(`line-height:max(${pt(line)}, 1.15em)`);
    else d.push(`line-height:${num(line / 240)}`);
  }
  if (f.jc && JC[f.jc]) d.push(`text-align:${JC[f.jc]}`);
  const left = finite(f.indLeftTw, -31680, 31680);
  if (left !== undefined) d.push(`margin-left:${pt(left)}`);
  const right = finite(f.indRightTw, -31680, 31680);
  if (right !== undefined) d.push(`margin-right:${pt(right)}`);
  const hanging = finite(f.indHangingTw, 0, 31680);
  const firstLine = finite(f.indFirstLineTw, 0, 31680);
  if (hanging !== undefined && hanging > 0) {
    d.push(`text-indent:-${pt(hanging)}`, `padding-left:${pt(hanging)}`);
  } else if (firstLine !== undefined) {
    d.push(`text-indent:${pt(firstLine)}`);
  }
  if (f.keepNext) d.push("break-after:avoid");
  if (f.keepLines) d.push("break-inside:avoid");
  if (f.pageBreakBefore) d.push("break-before:page");
  if (f.widowControl === false) d.push("orphans:1", "widows:1");
  bordersCss(f.borders, d);
  shadingCss(f.shading, d);
  return d;
}

const FACE_ROLE_CLASS: Readonly<Record<FaceRole, string>> = {
  serif: C.faceSerif,
  condensed: C.faceCondensed,
  mono: C.faceMono,
  workbookUi: C.faceWorkbookUi,
  symbolGlyph: C.faceSymbolGlyph,
};

export interface RunStyle {
  classes: string[];
  decl: string[];
  vert?: "sup" | "sub";
}

/**
 * Row 123 (C40 FIX CP-19, ID p.50 DT-08a/DT-09, p.89 A.2 "Glif provenans, Yunani, ... memakai DejaVu Sans tertanam"):
 * a run face is followed by the embedded symbol face (`type.face.symbolGlyph`, DejaVu Sans), so a glyph the Plex face
 * lacks (■ ◈ ◇ △) falls back to DejaVu, never to a system font (row 98: rail marks printed in Menlo-Regular).
 */
function fontFamilyDecl(face: string, tpl?: ResolvedTemplate): string {
  const sym = safeFaceName(tpl && typeof tpl === "object" ? faceForRole(tpl, "symbolGlyph") : "DejaVu Sans");
  return sym && sym !== face ? `font-family:'${face}','${sym}'` : `font-family:'${face}'`;
}

/**
 * RunProps -> kelas + deklarasi CSS. `sizeDeltaPt` dipakai md-lite mono (-0,8 pt, HS datum_docx).
 * `tpl` (ENG-01): `faceRole` tanpa `face` juga ditulis sebagai `font-family` keluarga peran
 * templat (`type.face.<peran>`, padanan DOCX rFonts); kelas `st-face-*` tetap dipasang untuk
 * deteksi fon tertanam (assemble/faces.ts) tetapi tidak punya aturan CSS sendiri.
 */
export function runStyle(p: RunProps | undefined, sizeDeltaPt = 0, tpl?: ResolvedTemplate): RunStyle {
  const s: RunStyle = { classes: [], decl: [] };
  if (!p || typeof p !== "object") return s;
  const face = safeFaceName(p.face);
  if (face) s.decl.push(fontFamilyDecl(face, tpl));
  else if (p.faceRole && FACE_ROLE_CLASS[p.faceRole]) {
    s.classes.push(FACE_ROLE_CLASS[p.faceRole]);
    const roleFace = tpl && typeof tpl === "object" ? safeFaceName(faceForRole(tpl, p.faceRole)) : undefined;
    if (roleFace) s.decl.push(fontFamilyDecl(roleFace, tpl));
  }
  const sz = finite(p.szHalfPt, 2, 400);
  if (sz !== undefined) s.decl.push(`font-size:${num(Math.max(1, sz / 2 + sizeDeltaPt))}pt`);
  else if (sizeDeltaPt !== 0) s.decl.push(`font-size:calc(1em - ${num(-sizeDeltaPt)}pt)`);
  const color = safeHex(p.color);
  if (color) s.decl.push(`color:${color}`);
  if (p.b === true) s.classes.push(C.bold);
  else if (p.b === false) s.decl.push("font-weight:400");
  if (p.i === true) s.classes.push(C.italic);
  else if (p.i === false) s.decl.push("font-style:normal");
  if (p.caps === true) s.classes.push(C.caps);
  // `smallCaps` belum ada di RunProps kontrak; dibaca defensif bila kontrak menambahkannya (D-46).
  if ((p as RunProps & { smallCaps?: boolean }).smallCaps === true) s.classes.push(C.smallCaps);
  if (p.u === "single") s.classes.push(C.underline);
  const sp = finite(p.spacingTw, -400, 800);
  if (sp !== undefined && sp !== 0) s.decl.push(`letter-spacing:${pt(sp)}`);
  if (p.vertAlign === "superscript") s.vert = "sup";
  else if (p.vertAlign === "subscript") s.vert = "sub";
  return s;
}

/** Gabungan atribut `class` dan `style` (nilai sudah aman; tetap di-escape oleh pemanggil `attr`). */
export function classStyle(classes: ReadonlyArray<string | undefined | false>, decl: readonly string[]): { cls: string; style: string } {
  return {
    cls: classes.filter((c): c is string => typeof c === "string" && c.length > 0).join(" "),
    style: decl.join(";"),
  };
}
