/**
 * Fase lapis: turunan berskala-acuan (SR-60; research/09 §4.2, §6.2 butir 2, 6,
 * 13, 14 dan syarat idempotensi R2; D-165).
 *
 * Kunci turunan beracuan (TA) menyimpan ACUAN: nilai preset (lapis `base`) bila
 * disematkan, selain itu default registri. Nilai efektif = f(kenop, acuan); pada
 * kenop bernilai acuan f = identitas, sehingga nilai sematan preset dipakai
 * persis. Fungsi di sini TIDAK idempoten bila kenop != acuan (hasil yang sudah
 * diskalakan akan diskalakan lagi), karena itu dijalankan SEKALI per resolusi
 * lapis (`resolveParamsWith` / `deriveLayered`), tidak pernah di
 * `computeDerivedWith`.
 *
 * Kebijakan sematan (`pinPolicy`):
 * - `"reference"` (bawaan, research/09 §4.2, D-165): sematan preset = acuan
 *   skala; kenop yang diubah menskalakan dari sematan itu.
 * - `"absolute"` (register §13.5 langkah 7): kunci yang disematkan preset tidak
 *   dihitung ulang sama sekali.
 * Pada kenop bernilai acuan kedua kebijakan memberi hasil sama (nilai sematan).
 * Kunci yang ditetapkan eksplisit di atas acuan (`explicit`) tidak diskalakan.
 *
 * Modul murni: tanpa I/O.
 */
import type { ParamDef, ParamMap, ParamValue } from "../../contract";
import { normalizeHex, resolveColorToken } from "./color";
import { type DeriveContext, deriveAll, ensureBottomMargin, K } from "./grid";

export type PinPolicy = "reference" | "absolute";

export interface LayerDeriveInput {
  /** Acuan: default registri <- preset/profil `base` (sebelum lapis templat/slot). */
  reference: ParamMap;
  /** Gabungan semua lapis sebelum turunan (kenop efektif). */
  merged: ParamMap;
  /** Kunci yang ditetapkan lapis di atas acuan (override templat/slot): tidak diskalakan. */
  explicit?: Iterable<string>;
  /** Kunci yang disematkan preset (dipakai `pinPolicy: "absolute"`). */
  pinned?: Iterable<string>;
  registry: readonly ParamDef[];
  pinPolicy?: PinPolicy;
}

/** Kenop esensial yang dibaca fase lapis (nama register R-47; research/09 N4/N6). */
export const LAYER_KNOB = {
  marginDensity: "grid.marginDensity",
  /** research/09 N6; register PC-06 memakai `type.scale.body.size` sebagai kenop. */
  baseSizePt: "type.baseSizePt",
  bodySize: "type.scale.body.size",
  signal: "color.interior.signal",
  roleBody: "color.role.body",
} as const;

/** KT-1 (D-165): rapat 0,75, sedang 1, lega 1,25. Nilai register E43 + alias research/09. */
export const DENSITY_FACTOR: Readonly<Record<string, number>> = Object.freeze({
  compact: 0.75,
  standard: 1,
  wide: 1.25,
  rapat: 0.75,
  sedang: 1,
  lega: 1.25,
});

const R = {
  normalStyle: "render.docx.normalStyle",
  bulletMarker: "render.list.bulletMarker",
  numberMarker: "render.list.numberMarker",
  symbolGlyphByRole: "render.run.symbolGlyphByRole",
  headerFooterStyles: "render.docx.headerFooterStyles",
} as const;

const TYPE_TA_RE = /^type\.scale\.[A-Za-z0-9]+\.(size|leading)$/;
const EPS = 1e-9;

export const r05 = (x: number): number => Math.round(x * 2) / 2;
export const r1 = (x: number): number => Math.round(x * 10) / 10;

type Mutable = Record<string, ParamValue>;

function num(p: ParamMap, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isRecord(v: ParamValue | undefined): v is { [k: string]: ParamValue } {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

/** Target fungsi menurut registri (`derive`), selain itu cadangan. */
function targetsOf(registry: readonly ParamDef[], id: string, fallback: readonly string[]): string[] {
  const fromRegistry = registry.filter((d) => (d.derive as string | undefined) === id).map((d) => d.key);
  return fromRegistry.length > 0 ? fromRegistry : [...fallback];
}

interface Gate {
  explicit: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
  policy: PinPolicy;
}

/** Boleh diskalakan: tidak eksplisit, dan (kebijakan absolut) tidak disematkan preset. */
function scalable(g: Gate, key: string): boolean {
  if (g.explicit.has(key)) return false;
  return !(g.policy === "absolute" && g.pinned.has(key));
}

/** `marginsFromDensity` (butir 2): eff = r05(acuan x f); sedang = acuan apa adanya. */
function applyDensity(out: Mutable, registry: readonly ParamDef[], g: Gate): void {
  const knob = out[LAYER_KNOB.marginDensity];
  const f = typeof knob === "string" ? DENSITY_FACTOR[knob] : undefined;
  if (f === undefined || Math.abs(f - 1) < EPS) return;
  const keys = targetsOf(registry, "marginsFromDensity", [K.inner, K.outer, K.topMargin, K.bottomMargin]);
  // Margin bawah (N5) selalu ikut, juga saat masih kunci bayangan tanpa ParamDef.
  if (!keys.includes(K.bottomMargin)) keys.push(K.bottomMargin);
  for (const key of keys) {
    const v = num(out, key);
    if (v !== undefined && scalable(g, key)) out[key] = r05(v * f);
  }
}

/** Sub-medan `szHalfPt` suatu objek RunProps diskalakan k (bila ada). */
function scaleHalfPt(v: ParamValue | undefined, k: number): ParamValue | undefined {
  if (!isRecord(v) || typeof v.szHalfPt !== "number") return undefined;
  return { ...v, szHalfPt: Math.round(v.szHalfPt * k) };
}

/** `typeScaleFromBase` (butir 6): k = kenop efektif / kenop acuan; eff = r1(acuan x k). */
function applyTypeScale(out: Mutable, reference: ParamMap, registry: readonly ParamDef[], g: Gate): void {
  const hasBaseKnob = registry.some((d) => d.key === LAYER_KNOB.baseSizePt) || LAYER_KNOB.baseSizePt in out;
  const knobKey = hasBaseKnob ? LAYER_KNOB.baseSizePt : LAYER_KNOB.bodySize;
  const ref = num(reference, knobKey);
  const eff = num(out, knobKey);
  if (ref === undefined || eff === undefined || ref <= 0 || Math.abs(eff - ref) < EPS) return;
  const k = eff / ref;

  const fromRegistry = registry.filter((d) => (d.derive as string | undefined) === "typeScaleFromBase").map((d) => d.key);
  const pool = fromRegistry.length > 0 ? fromRegistry : [...registry.map((d) => d.key), ...Object.keys(out)].filter((key) => TYPE_TA_RE.test(key));
  for (const key of new Set(pool)) {
    if (key === knobKey) continue;
    const v = num(out, key);
    if (v !== undefined && scalable(g, key)) out[key] = r1(v * k);
  }

  // R-07 Normal: 2 x ukuran badan efektif, 20 x leading badan efektif (sub-medan yang ada saja).
  const normal = out[R.normalStyle];
  if (isRecord(normal) && scalable(g, R.normalStyle)) {
    const next: Mutable = { ...normal };
    const size = num(out, LAYER_KNOB.bodySize);
    const leading = num(out, K.bodyLeading);
    if (typeof normal.szHalfPt === "number" && size !== undefined) next.szHalfPt = Math.round(2 * size);
    if (typeof normal.lineTw === "number" && leading !== undefined) next.lineTw = Math.round(20 * leading);
    out[R.normalStyle] = next;
  }
  for (const key of [R.bulletMarker, R.numberMarker]) {
    if (!scalable(g, key)) continue;
    const next = scaleHalfPt(out[key], k);
    if (next !== undefined) out[key] = next;
  }
  const glyphs = out[R.symbolGlyphByRole];
  if (isRecord(glyphs) && scalable(g, R.symbolGlyphByRole)) {
    const next: Mutable = {};
    for (const [role, props] of Object.entries(glyphs)) next[role] = scaleHalfPt(props, k) ?? props;
    out[R.symbolGlyphByRole] = next;
  }
}

/**
 * `colorLiterals` (butir 14): salinan literal hex mengikuti token bila token
 * berubah dari acuan. Literal yang sejak acuan sudah berbeda dari token
 * (pilihan sendiri) dipertahankan.
 */
function applyColorLiterals(out: Mutable, reference: ParamMap, g: Gate): void {
  const pairs: ReadonlyArray<[target: string, token: string]> = [
    [R.numberMarker, LAYER_KNOB.signal],
    [R.normalStyle, LAYER_KNOB.roleBody],
  ];
  for (const [target, token] of pairs) {
    const refHex = resolveColorToken(reference, token);
    const effHex = resolveColorToken(out, token);
    const v = out[target];
    if (!refHex || !effHex || refHex === effHex || !isRecord(v) || !scalable(g, target)) continue;
    if (normalizeHex(v.color) === refHex) out[target] = { ...v, color: effHex };
  }
}

/**
 * Fase lapis sebelum `deriveAll`: margin bawah bentuk lama dipastikan ada,
 * kerapatan margin, skala tipografi, literal warna. Mengembalikan salinan baru.
 */
export function applyLayerDerivations(i: LayerDeriveInput): Record<string, ParamValue> {
  const out: Mutable = { ...i.merged };
  const g: Gate = {
    explicit: new Set(i.explicit ?? []),
    pinned: new Set(i.pinned ?? []),
    policy: i.pinPolicy ?? "reference",
  };
  ensureBottomMargin(out);
  applyDensity(out, i.registry, g);
  applyTypeScale(out, i.reference, i.registry, g);
  applyColorLiterals(out, i.reference, g);
  return out;
}

/**
 * `headerFooterTabsFromSpan` (butir 13), sesudah `deriveAll`: posTw' =
 * round(posTw x bentang efektif / bentang acuan) untuk tab R-30. Identitas bila
 * bentang tidak berubah. Bentang acuan = `grid.fullSpanMm` turunan peta acuan.
 */
export function applySpanScaledSubfields(
  derived: Record<string, ParamValue>,
  referenceDerived: ParamMap,
  explicit: Iterable<string> = [],
): Record<string, ParamValue> {
  const refSpan = num(referenceDerived, K.fullSpan);
  const effSpan = num(derived, K.fullSpan);
  const styles = derived[R.headerFooterStyles];
  if (refSpan === undefined || effSpan === undefined || refSpan <= 0 || Math.abs(refSpan - effSpan) < EPS) return derived;
  if (!isRecord(styles) || new Set(explicit).has(R.headerFooterStyles)) return derived;
  const ratio = effSpan / refSpan;
  const next: Mutable = { ...styles };
  for (const [name, style] of Object.entries(styles)) {
    if (!isRecord(style) || !Array.isArray(style.tabs)) continue;
    next[name] = {
      ...style,
      tabs: style.tabs.map((t) => (isRecord(t) && typeof t.posTw === "number" ? { ...t, posTw: Math.round(t.posTw * ratio) } : t)),
    };
  }
  return { ...derived, [R.headerFooterStyles]: next };
}

/**
 * Resolusi lapis lengkap untuk pemanggil berlapis banyak (SR-06 per slot):
 * fase lapis -> `deriveAll` -> sub-medan berskala bentang. Panggil SEKALI per
 * resolusi; turunan ulang berikutnya cukup `computeDerivedWith` (idempoten).
 */
export function deriveLayered(i: LayerDeriveInput & { ctx?: DeriveContext }): Record<string, ParamValue> {
  const ctx = i.ctx ?? {};
  const explicit = [...(i.explicit ?? [])];
  const layered = applyLayerDerivations({ ...i, explicit });
  const derived = deriveAll(layered, i.registry, ctx);
  const referenceDerived = deriveAll(i.reference, i.registry, ctx);
  return applySpanScaledSubfields(derived, referenceDerived, explicit);
}
