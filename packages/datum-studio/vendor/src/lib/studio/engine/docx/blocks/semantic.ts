/**
 * Run semantik dokumen konten-saja (RT-01, D-119).
 *
 * Dokumen konten-saja tidak membawa wajah/ukuran/warna run; run hanya membawa
 * makna: `b`/`i` (penekanan), `faceRole: "mono"` (kode/numeral) dan
 * `faceRole: "symbolGlyph"` (glif provenans ■◈◇△ dan simbol ≥ ≤ σ → ...).
 * Tampilannya milik templat, sekali per peran:
 *
 * - `render.run.strong` (R-36): RunProps tambahan untuk run tebal semantik
 *   di atas run dasar yang tidak tebal (Manual 000: tebal = ink900);
 * - `glyphRun[tanda]` peran (bila templat menulisnya): glif provenans;
 * - `render.run.symbolGlyphByRole[peran]` (R-37): glif simbol sebaris
 *   (paragraf yang juga memuat teks lain) di peran inang itu.
 *
 * Semua aturan opt-in: tanpa parameter/peran eksplisit run dirender apa
 * adanya (profil kanonik dan dokumen verbatim tidak berubah). Properti run
 * itu sendiri selalu menang.
 */
import type { ParamMap, ProvenanceMark, RoleFormat, RoleKey, Run, RunProps } from "../../../contract";
import { PROVENANCE_GLYPHS } from "../../../contract/enums";

/** Glif provenans -> tanda (U+25A0 TERUKUR, U+25C8 DITURUNKAN, U+25C7 PEMASOK, U+25B3 ASUMSI). */
export const GLYPH_MARK: ReadonlyMap<string, ProvenanceMark> = new Map(
  (Object.entries(PROVENANCE_GLYPHS) as Array<[ProvenanceMark, string]>).map(([m, g]) => [g, m]),
);
const GLYPH_SPLIT_RE = new RegExp(`([${[...GLYPH_MARK.keys()].join("")}])`);

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** `render.run.strong` atau undefined bila kosong. */
export function strongProps(params: ParamMap): RunProps | undefined {
  const o = obj(params["render.run.strong"]);
  return o && Object.keys(o).length > 0 ? (o as RunProps) : undefined;
}

/** `render.run.symbolGlyphByRole[role]` atau undefined. */
export function symbolGlyphProps(params: ParamMap, role: RoleKey | undefined): RunProps | undefined {
  if (!role) return undefined;
  const o = obj(obj(params["render.run.symbolGlyphByRole"])?.[role]);
  return o && Object.keys(o).length > 0 ? (o as RunProps) : undefined;
}

/** Pisahkan glif provenans dari teks run (properti run disalin ke setiap potongan). */
export function splitGlyphRun(r: Extract<Run, { t: string }>): Run[] {
  if (!GLYPH_SPLIT_RE.test(r.t)) return [r];
  const { t, ...props } = r;
  return t
    .split(GLYPH_SPLIT_RE)
    .filter((piece) => piece !== "")
    .map((piece) => ({ ...props, t: piece }) as Run);
}

function isSymbolRun(r: Run): boolean {
  return "t" in r && (r.faceRole === "symbolGlyph" || GLYPH_MARK.has(r.t));
}

/** Paragraf memuat teks selain glif simbol (glif = simbol sebaris, bukan isi sel glif). */
export function hasPlainText(runs: readonly Run[]): boolean {
  return runs.some((r) => "t" in r && !isSymbolRun(r) && r.t.trim() !== "");
}

function withoutFaceRole(r: Run): Run {
  if (!("faceRole" in r)) return r;
  const { faceRole: _f, ...rest } = r as Run & { faceRole?: string };
  void _f;
  return rest as Run;
}

/**
 * Terapkan aturan semantik templat ke daftar run di atas `base` (run dasar
 * peran `role`). `glyph` = `glyphRun` peran yang DITULIS templat (atau
 * undefined).
 */
export function applySemanticRuns(
  runs: readonly Run[],
  base: RunProps,
  params: ParamMap,
  role: RoleKey | undefined,
  glyph: RoleFormat["glyphRun"] | undefined,
): Run[] {
  const strong = base.b === true ? undefined : strongProps(params);
  const symbol = symbolGlyphProps(params, role);
  if (!strong && !glyph && !symbol) return [...runs];
  const pieces: Run[] = [];
  for (const r of runs) {
    if ("t" in r && (glyph || symbol) && !r.face && (!r.faceRole || r.faceRole === "symbolGlyph")) pieces.push(...splitGlyphRun(r));
    else pieces.push(r);
  }
  const mixed = hasPlainText(pieces);
  return pieces.map((p) => {
    if (!("t" in p)) return p;
    let q: Run = p;
    const mark = GLYPH_MARK.get(p.t);
    const g = mark && !p.face ? glyph?.[mark] : undefined;
    if (g) q = { ...g, ...withoutFaceRole(p) } as Run;
    else if (symbol && mixed && !p.face && isSymbolRun(p)) {
      q = { faceRole: "symbolGlyph", ...symbol, ...p } as Run;
      if ("face" in q && q.face) q = withoutFaceRole(q);
    }
    if (strong && q.b === true) q = { ...strong, ...q } as Run;
    return q;
  });
}
