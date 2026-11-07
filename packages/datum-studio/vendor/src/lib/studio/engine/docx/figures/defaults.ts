/**
 * Format bawaan peran figur dan turunan (S19) serta resolusinya.
 *
 * Urutan resolusi (01_specs.md §5.6): format eksplisit blok > `roleFormats[role]`
 * templat > turunan katalog (`resolveRoleFormat`, S11) > bawaan modul ini.
 * Bawaan modul diukur dari BM (research/07 §3: K-29 caption, K-32 paragraf
 * gambar, K-33 baris KUNCI, K-34 baris SUMBER; RS19/20/23/24; blok turunan
 * T034/T050 + N01/N02: RS53, RS44, RS55, TCP-20) dan hanya mengisi atribut yang
 * tidak diberikan katalog. Sub-objek yang ditulis templat dipakai utuh (sama
 * dengan aturan S11), agar profil terukur tidak mendapat atribut tambahan.
 *
 * Warna ditulis sebagai token (`ink900`, `signal`, ...) dan diselesaikan lewat
 * parameter templat; heks di kolom kedua hanya cadangan bila token absen.
 */
import type { Hex, ParaFormat, ParamMap, ProvenanceMark, ResolvedTemplate, RoleFormat, RoleKey, RunProps } from "../../../contract";
import { PROVENANCE_GLYPHS } from "../../../contract";
import { APPARATUS_TEXT, type WrapperLang } from "../../front/texts";
import { resolveRoleFormat, resolveTokenColor } from "../../tokens";

/** Token warna yang dipakai modul + cadangan heks (nilai kanonik P4C, research/07 RS). */
const COLOR_FALLBACK: Readonly<Record<string, Hex>> = {
  ink900: "101418",
  ink700: "2B3640",
  ink400: "6B7783",
  ink200: "C3CBD1",
  signal: "B45309",
  alert: "9B1C1C",
  verd: "2F6F6B",
};

export type FigureColorToken = keyof typeof COLOR_FALLBACK;

export function tokenColor(tpl: ResolvedTemplate, token: FigureColorToken): Hex {
  return resolveTokenColor(tpl, token) ?? COLOR_FALLBACK[token];
}

export interface FigureLabelSet {
  readonly source: string;
  readonly provenance: string;
  readonly key: string;
  readonly derivationPrefix: string;
}

/**
 * Label aparatus figur DOCX per bahasa (DT-15; bentuk "SUMBER ... PROVENANS ..." P5-23). Satu sumber
 * dengan HTML: tabel `APPARATUS_TEXT` (`engine/front/texts.ts`, S13/F-2); DOCX mencetak label
 * SUMBER/PROVENANS/KUNCI kapital literal, kata depan turunan berhuruf campur.
 */
export function figureLabels(lang: WrapperLang): FigureLabelSet {
  return {
    source: APPARATUS_TEXT.source[lang].toUpperCase(),
    provenance: APPARATUS_TEXT.provenance[lang].toUpperCase(),
    key: APPARATUS_TEXT.key[lang].toUpperCase(),
    derivationPrefix: APPARATUS_TEXT.derivation[lang],
  };
}

/** Label ID: penanda struktural kiriman/compose dan alamat turunan ("Turunan D-n.m"), tetap ID. */
export const FIGURE_LABELS: FigureLabelSet = figureLabels("ID");

/**
 * Spasi pengapit label di dalam run label, persis BM (`research/07`, p#78-79):
 * `"KUNCI  "`, `"SUMBER  "`, `"   PROVENANS "`.
 */
export const FIGURE_LABEL_SPACING = {
  keyAfter: "  ",
  sourceAfter: "  ",
  provenanceBefore: "   ",
  provenanceAfter: " ",
} as const;

/** Pemisah label caption bawaan bila `caption.separator` dan R-15 absen. */
export const DEFAULT_CAPTION_SEPARATOR = " ";

/** Pemisah nomor dan judul pada label turunan ("Turunan D-4.1 · Judul"). */
export const DERIVATION_TITLE_SEPARATOR = " · ";

type RoleDefaults = (tpl: ResolvedTemplate) => RoleFormat;

/** Bawaan per peran (diukur BM). */
const ROLE_DEFAULTS: Readonly<Partial<Record<RoleKey, RoleDefaults>>> = {
  // K-29: sp[b120 a48 l220x]; keepNext. RS19 label Cond 7 pt tebal kapital ink900 spc16; RS20 teks Cond 7,5 pt ink700.
  caption: (t) => ({
    para: { spacingBeforeTw: 120, spacingAfterTw: 48, lineTw: 220, lineRule: "exact", keepNext: true },
    labelRun: { faceRole: "condensed", b: true, caps: true, color: tokenColor(t, "ink900"), szHalfPt: 14, spacingTw: 16 },
    run: { faceRole: "condensed", b: false, color: tokenColor(t, "ink700"), szHalfPt: 15 },
  }),
  // K-32: sp[b0 a48 l240auto]; keepNext. Spasi baris "auto" melepas spasi tepat badan (P9-51) agar gambar tidak terpotong.
  "figure.paragraph": () => ({
    para: { spacingBeforeTw: 0, spacingAfterTw: 48, lineTw: 240, lineRule: "auto", keepNext: true },
  }),
  // K-33: sp[b0 a20 l180x]; keepNext. RS23 label Cond 6,5 pt tebal ink400 spc12; RS24 teks Cond 6,5 pt ink400.
  "figure.keyRow": (t) => ({
    para: { spacingBeforeTw: 0, spacingAfterTw: 20, lineTw: 180, lineRule: "exact", keepNext: true },
    labelRun: { faceRole: "condensed", b: true, color: tokenColor(t, "ink400"), szHalfPt: 13, spacingTw: 12 },
    run: { faceRole: "condensed", b: false, color: tokenColor(t, "ink400"), szHalfPt: 13 },
  }),
  // K-34: sp[b0 a0 l180x]; pBdr top single sz5 space1 ink200.
  "figure.source": (t) => ({
    para: {
      spacingBeforeTw: 0,
      spacingAfterTw: 0,
      lineTw: 180,
      lineRule: "exact",
      borders: { top: { val: "single", sz: 5, space: 1, color: tokenColor(t, "ink200") } },
    },
    labelRun: { faceRole: "condensed", b: true, color: tokenColor(t, "ink400"), szHalfPt: 13, spacingTw: 12 },
    run: { faceRole: "condensed", b: false, color: tokenColor(t, "ink400"), szHalfPt: 13 },
  }),
  // RS53: Cond 6,5 pt tebal kapital signal spc22; sp[b0 a40 l180x].
  "derivation.label": (t) => ({
    para: { spacingBeforeTw: 0, spacingAfterTw: 40, lineTw: 180, lineRule: "exact", keepNext: true },
    run: { faceRole: "condensed", b: true, caps: true, color: tokenColor(t, "signal"), szHalfPt: 13, spacingTw: 22 },
  }),
  // RS54: Cond 7 pt ink400; sp[b40 a0 l200x] (kalimat penutup BM; prosa turunan memakai bentuk yang sama).
  "derivation.intro": (t) => ({
    para: { spacingBeforeTw: 40, spacingAfterTw: 0, lineTw: 200, lineRule: "exact" },
    run: { faceRole: "condensed", b: false, color: tokenColor(t, "ink400"), szHalfPt: 14 },
  }),
  // KT-35 / RS44: Mono 7 pt ink900; sp[b0 a0 l220x].
  "derivation.expr": (t) => ({
    para: { spacingBeforeTw: 0, spacingAfterTw: 0, lineTw: 220, lineRule: "exact" },
    run: { faceRole: "mono", b: false, color: tokenColor(t, "ink900"), szHalfPt: 14 },
  }),
  // KT-36 / RS44 + RS55: nilai Mono 7 pt rata kanan + glif DejaVu 6,5 pt ink900.
  "derivation.value": (t) => ({
    para: { spacingBeforeTw: 0, spacingAfterTw: 0, lineTw: 220, lineRule: "exact", jc: "right" },
    run: { faceRole: "mono", b: false, color: tokenColor(t, "ink900"), szHalfPt: 14 },
  }),
};

/** Glif DejaVu bawaan baris turunan dan baris sumber (RS55). */
export function defaultGlyphRun(tpl: ResolvedTemplate): RunProps {
  return { faceRole: "symbolGlyph", b: false, color: tokenColor(tpl, "ink900"), szHalfPt: 13 };
}

/**
 * Format peran lengkap: templat utuh per sub-objek; tanpa templat, katalog
 * ditumpuk di atas bawaan modul per atribut.
 */
export function figureRole(tpl: ResolvedTemplate, role: RoleKey): RoleFormat {
  const resolved = resolveRoleFormat(tpl, role);
  const explicit = tpl.roleFormats[role];
  const fallback = ROLE_DEFAULTS[role]?.(tpl) ?? {};
  const keys = new Set<keyof RoleFormat>([
    ...(Object.keys(fallback) as Array<keyof RoleFormat>),
    ...(Object.keys(resolved) as Array<keyof RoleFormat>),
  ]);
  const out: RoleFormat = {};
  for (const k of keys) {
    const r = resolved[k];
    const f = fallback[k];
    if (explicit?.[k] !== undefined) {
      (out as Record<string, unknown>)[k] = r;
    } else if (r !== undefined && f !== undefined && typeof r === "object" && typeof f === "object") {
      (out as Record<string, unknown>)[k] = { ...f, ...r };
    } else {
      (out as Record<string, unknown>)[k] = r ?? f;
    }
  }
  return out;
}

/** Gabung format paragraf berlapis (kiri ke kanan, yang kanan menang per atribut). */
export function mergePara(...layers: Array<ParaFormat | undefined>): ParaFormat {
  const out: ParaFormat = {};
  for (const l of layers) if (l) Object.assign(out, l);
  return out;
}

export function mergeRun(...layers: Array<RunProps | undefined>): RunProps {
  const out: RunProps = {};
  for (const l of layers) {
    if (!l) continue;
    Object.assign(out, l);
    // face XOR faceRole (§3.2): lapisan yang lebih spesifik menang.
    if (l.face) delete out.faceRole;
    else if (l.faceRole) delete out.face;
  }
  return out;
}

/** Glif tanda provenans: param `marks.<tanda>.glyph` (P5-30..36) > glif kontrak. */
export function markGlyph(params: ParamMap, mark: ProvenanceMark): string {
  const v = params[`marks.${mark.toLowerCase()}.glyph`];
  return typeof v === "string" && v.length > 0 ? v : PROVENANCE_GLYPHS[mark];
}
