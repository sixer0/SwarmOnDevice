/**
 * Konversi format kontrak (RunProps, ParaFormat, BorderSpec) ke CSS inline,
 * plus pembaca parameter/token untuk keluarga tabel dan figur (S23).
 *
 * CSS ditulis inline agar fragmen mandiri terhadap lembar gaya S21/S24:
 * fragmen tabel/figur benar tanpa kelas eksternal; kelas `st-*` hanya penanda
 * struktur (untuk uji dan lint R).
 */
import type {
  BorderSpec,
  FaceRole,
  Hex,
  ParaFormat,
  ParamMap,
  ProvenanceMark,
  RenderContext,
  ResolvedTemplate,
  RoleFormat,
  RoleKey,
  RunProps,
} from "../../../contract";
import { PROVENANCE_GLYPHS } from "../../../contract/enums";
import { apparatusText, wrapperLangOf } from "../../front/texts";
import { resolveRoleFormat, resolveTokenColor } from "../../tokens";
import { cssString } from "./escape";

/** 1 mm = 1440 / 25,4 twip. */
export const TW_PER_MM = 1440 / 25.4;

/** Angka CSS ringkas (maks 3 desimal, tanpa nol buntut). */
export function n(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}

export function twToMm(tw: number): number {
  return tw / TW_PER_MM;
}

/** sz 1/8 pt -> mm. */
export function eighthToMm(sz: number): number {
  return ((sz / 8) * 25.4) / 72;
}

// ── Parameter ────────────────────────────────────────────────────────────

export function pNum(p: ParamMap, key: string, def: number): number {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

export function pBool(p: ParamMap, key: string, def: boolean): boolean {
  const v = p[key];
  return typeof v === "boolean" ? v : def;
}

export function pStr(p: ParamMap, key: string, def: string): string {
  const v = p[key];
  return typeof v === "string" ? v : def;
}

export function pObj(p: ParamMap, key: string): Record<string, unknown> | undefined {
  const v = p[key];
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// ── Warna ────────────────────────────────────────────────────────────────

/** Cadangan palet interior kanonik (params/color-type.ts) bila token tak terselesaikan. */
const PALETTE_FALLBACK: Readonly<Record<string, Hex>> = {
  ink900: "101418",
  ink700: "2B3640",
  ink400: "6B7783",
  ink200: "C3CBD1",
  ink100: "EFF2F4",
  signal: "B45309",
  alert: "9B1C1C",
  paper: "FCFCFB",
};

const HEX_RE = /^[0-9A-Fa-f]{6}$/;

/** `#RRGGBB` untuk token/kunci; cadangan palet bila tidak terselesaikan. */
export function color(tpl: ResolvedTemplate, ref: string, fallback: keyof typeof PALETTE_FALLBACK | Hex): string {
  const hex = resolveTokenColor(tpl, ref);
  if (hex && HEX_RE.test(hex)) return `#${hex.toUpperCase()}`;
  const fb = PALETTE_FALLBACK[fallback] ?? fallback;
  return HEX_RE.test(fb) ? `#${fb.toUpperCase()}` : "currentColor";
}

export function hexCss(v: string | undefined): string | undefined {
  if (!v || v === "auto") return undefined;
  return HEX_RE.test(v) ? `#${v.toUpperCase()}` : undefined;
}

// ── Fon ──────────────────────────────────────────────────────────────────

/** Nama keluarga apa adanya per peran (padanan DEFAULT_FACES DOCX, research/05:13). */
const DEFAULT_FACES: Readonly<Record<FaceRole, string>> = {
  serif: "IBM Plex Serif",
  condensed: "IBM Plex Sans Cond",
  mono: "IBM Plex Mono",
  workbookUi: "IBM Plex Sans",
  symbolGlyph: "DejaVu Sans",
};

/** Alias nama keluarga (D-31: renderer "IBM Plex Sans Cond", kanonik "IBM Plex Sans Condensed"). */
const FACE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "IBM Plex Sans Cond": ["IBM Plex Sans Condensed"],
  "IBM Plex Sans Condensed": ["IBM Plex Sans Cond"],
};

const GENERIC: Readonly<Record<FaceRole, string>> = {
  serif: "serif",
  condensed: "sans-serif",
  mono: "monospace",
  workbookUi: "sans-serif",
  symbolGlyph: "sans-serif",
};

/** `font-family` untuk run; undefined bila run tidak menyatakan wajah. */
export function fontFamily(props: RunProps, params: ParamMap): string | undefined {
  let face = props.face;
  const role = props.faceRole;
  if (!face && role) face = pStr(params, `type.face.${role}`, DEFAULT_FACES[role]) || DEFAULT_FACES[role];
  if (!face) return undefined;
  const list = [face, ...(FACE_ALIASES[face] ?? [])];
  // Glif provenans/centang selalu punya cadangan DejaVu Sans (K-18, R-14).
  if (!list.includes(DEFAULT_FACES.symbolGlyph)) list.push(DEFAULT_FACES.symbolGlyph);
  const generic = role ? GENERIC[role] : /mono/i.test(face) ? "monospace" : /serif/i.test(face) && !/sans/i.test(face) ? "serif" : "sans-serif";
  return [...list.map(cssString), generic].join(",");
}

// ── Run dan paragraf ─────────────────────────────────────────────────────

export function runCss(props: RunProps, params: ParamMap): string {
  const out: string[] = [];
  const ff = fontFamily(props, params);
  if (ff) out.push(`font-family:${ff}`);
  if (props.szHalfPt !== undefined) out.push(`font-size:${n(props.szHalfPt / 2)}pt`);
  const c = hexCss(props.color);
  if (c) out.push(`color:${c}`);
  if (props.b !== undefined) out.push(`font-weight:${props.b ? 600 : 400}`);
  if (props.i !== undefined) out.push(`font-style:${props.i ? "italic" : "normal"}`);
  if (props.caps) out.push("text-transform:uppercase");
  if (props.spacingTw !== undefined && props.spacingTw !== 0) out.push(`letter-spacing:${n(props.spacingTw / 20)}pt`);
  if (props.u === "single") out.push("text-decoration:underline");
  if (props.vertAlign) out.push(`vertical-align:${props.vertAlign === "superscript" ? "super" : "sub"};font-size:smaller`);
  if (props.faceRole === "mono" || (props.face && /mono/i.test(props.face))) out.push("font-variant-numeric:tabular-nums");
  return out.join(";");
}

const JC: Readonly<Record<NonNullable<ParaFormat["jc"]>, string>> = {
  left: "left",
  right: "right",
  center: "center",
  both: "justify",
};

/** CSS paragraf. Margin vertikal default 0 (DOCX: spasi hanya dari pPr). */
export function paraCss(f: ParaFormat | undefined): string {
  const out: string[] = ["margin:0", "white-space:pre-wrap"];
  if (!f) return out.join(";");
  if (f.spacingBeforeTw !== undefined) out.push(`margin-top:${n(f.spacingBeforeTw / 20)}pt`);
  if (f.spacingAfterTw !== undefined) out.push(`margin-bottom:${n(f.spacingAfterTw / 20)}pt`);
  if (f.lineTw !== undefined) {
    out.push(f.lineRule === "auto" || f.lineRule === undefined ? `line-height:${n(f.lineTw / 240)}` : `line-height:${n(f.lineTw / 20)}pt`);
  }
  if (f.jc) out.push(`text-align:${JC[f.jc]}`);
  if (f.indLeftTw) out.push(`padding-left:${n(twToMm(f.indLeftTw))}mm`);
  if (f.indRightTw) out.push(`padding-right:${n(twToMm(f.indRightTw))}mm`);
  if (f.indFirstLineTw) out.push(`text-indent:${n(twToMm(f.indFirstLineTw))}mm`);
  if (f.indHangingTw) out.push(`text-indent:-${n(twToMm(f.indHangingTw))}mm`);
  if (f.keepNext) out.push("break-after:avoid");
  if (f.keepLines) out.push("break-inside:avoid");
  if (f.pageBreakBefore) out.push("break-before:page");
  if (f.borders) {
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const b = borderCss(f.borders[side]);
      if (b) out.push(`border-${side}:${b}`);
    }
  }
  const fill = f.shading ? hexCss(f.shading.fill) : undefined;
  if (fill) out.push(`background:${fill}`);
  return out.join(";");
}

const BORDER_STYLE: Readonly<Record<BorderSpec["val"], string>> = {
  single: "solid",
  dashed: "dashed",
  dotted: "dotted",
  double: "double",
  none: "none",
};

/** `border` CSS dari BorderSpec (sz 1/8 pt); undefined bila tidak ada. */
export function borderCss(b: BorderSpec | undefined): string | undefined {
  if (!b) return undefined;
  if (b.val === "none" || b.sz <= 0) return "none";
  const c = hexCss(b.color) ?? "currentColor";
  return `${n(eighthToMm(b.sz))}mm ${BORDER_STYLE[b.val] ?? "solid"} ${c}`;
}

/** Garis mm + warna -> `border` CSS. */
export function ruleCss(mm: number, c: string): string {
  return mm > 0 ? `${n(mm)}mm solid ${c}` : "none";
}

/** Gabung deklarasi CSS (abaikan kosong). */
export function css(...parts: Array<string | undefined | false>): string {
  return parts.filter((x): x is string => typeof x === "string" && x.length > 0).join(";");
}

// ── Peran ────────────────────────────────────────────────────────────────

const ROLE_CACHE = new WeakMap<ResolvedTemplate, Map<RoleKey, RoleFormat>>();

/** Format peran templat (di-cache per templat); galat resolusi dicatat dan format kosong dipakai. */
export function role(ctx: RenderContext, key: RoleKey): RoleFormat {
  let cache = ROLE_CACHE.get(ctx.tpl);
  if (!cache) {
    cache = new Map();
    ROLE_CACHE.set(ctx.tpl, cache);
  }
  const hit = cache.get(key);
  if (hit) return hit;
  let rf: RoleFormat;
  try {
    rf = resolveRoleFormat(ctx.tpl, key);
  } catch (e) {
    ctx.log({ level: "warn", message: `engine/html/tables: format peran ${key} gagal diselesaikan (${e instanceof Error ? e.message : String(e)})` });
    rf = {};
  }
  cache.set(key, rf);
  return rf;
}

// ── Label bahasa ─────────────────────────────────────────────────────────

export interface ApparatusLabels {
  source: string;
  provenance: string;
  key: string;
  derivation: string;
  figureMissing: string;
}

/** Label aparatus berbahasa dokumen; satu sumber dengan DOCX (`APPARATUS_TEXT`, `engine/front/texts.ts`, S13/F-2). */
export function labels(ctx: RenderContext): ApparatusLabels {
  const t = apparatusText(wrapperLangOf(ctx.snapshot?.doc?.meta));
  return { source: t.source, provenance: t.provenance, key: t.key, derivation: t.derivation, figureMissing: t.figureMissing };
}

// ── Tanda provenans ──────────────────────────────────────────────────────

export function markGlyph(p: ParamMap, m: ProvenanceMark): string {
  const g = p[`marks.${m.toLowerCase()}.glyph`];
  return typeof g === "string" && g.length > 0 ? g : PROVENANCE_GLYPHS[m];
}

const MARK_FALLBACK: Readonly<Record<ProvenanceMark, keyof typeof PALETTE_FALLBACK>> = {
  TERUKUR: "ink900",
  DITURUNKAN: "signal",
  PEMASOK: "ink400",
  ASUMSI: "alert",
};

export function markColor(tpl: ResolvedTemplate, m: ProvenanceMark): string {
  return color(tpl, `marks.${m.toLowerCase()}.colour`, MARK_FALLBACK[m]);
}
