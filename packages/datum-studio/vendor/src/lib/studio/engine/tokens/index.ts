/**
 * Mesin token (I01, 01_specs.md §8.2; baris S11).
 *
 * - `resolveParams`: default registri (profil DATUM-kanonik) <- profil `base`
 *   (kanonik atau turunan, mis. Manual 000) <- override dokumen, lalu semua
 *   turunan (kelas T) dihitung ulang.
 * - `computeDerived`: fullSpan, kisi X/Y, lebar figur sah, cek lebar halaman,
 *   moda rel A/B (KT-07), kolom rel twip, rederivasi non-A4, turunan tier, dst.
 *   Turunan yang butuh konteks dokumen memakai `computeDerivedWith`.
 * - `checkOverrideRights`: kelas K hanya ADMIN_SESSION (KT-16), kelas T
 *   ditolak untuk siapa pun, kunci tak dikenal ditolak.
 * - `resolveRoleFormat`: `roleFormats[role]` templat > turunan katalog.
 *
 * Parameter dibaca lewat registri `params/*` (tanpa menyalin nilai). Modul
 * murni: tanpa I/O, tanpa jalur galat yang perlu dicatat; galat kontrak
 * dikembalikan sebagai `ParamIssue` atau dilempar `StudioEngineError`
 * (`assertOverrideRights`).
 */
import type {
  CallerKind,
  Hex,
  ParamDef,
  ParamIssue,
  ParamMap,
  ResolvedTemplate,
  RoleFormat,
  RoleKey,
} from "../../contract";
import { StudioEngineError } from "../../contract/errors";
import { ALL_PARAMS } from "../../params";
import { derivedColorTokens, resolveColorToken } from "./color";
import { type DeriveContext, deriveAll, K, pageSize, resolveRailMode } from "./grid";
import { deriveLayered, type PinPolicy } from "./layer";
import { checkOverrides, mergeLayers } from "./merge";
import { catalogRoleFormat, overlayRoleFormat } from "./roles";

export type { DeriveContext } from "./grid";
export type { LayerDeriveInput, PinPolicy } from "./layer";
export { canonicalProfile, validateParamValue } from "./merge";
export { derivedColorTokens, normalizeHex, resolveColorToken, tintHex } from "./color";
export { mmToTw, resolveRailMode } from "./grid";
export { applyLayerDerivations, applySpanScaledSubfields, DENSITY_FACTOR, deriveLayered } from "./layer";
export { PAGE_KNOB, pageSizeFromPaper } from "./paper";
export { catalogRoleFormat } from "./roles";

/** Toleransi cek lebar halaman (mm). */
const WIDTH_TOLERANCE_MM = 0.05;

function freeze(p: Record<string, ParamMap[string]>): ParamMap {
  return Object.freeze(p);
}

/** Galat kontrak bila jumlah komponen grid tidak sama dengan lebar halaman (P4G-15). */
function pageWidthIssues(p: ParamMap): ParamIssue[] {
  const size = pageSize(p);
  const issues: ParamIssue[] = [];
  const sum = p[K.pageWidthCheck];
  if (size && typeof sum === "number" && Math.abs(sum - size[0]) > WIDTH_TOLERANCE_MM) {
    issues.push({
      key: K.pageWidthCheck,
      code: "SCHEMA_INVALID",
      message: `Grid tidak sama dengan lebar halaman: ${sum} mm (margin dalam + kolom teks + gutter + rel + margin luar) vs ${size[0]} mm`,
      pointer: `/params/${K.pageWidthCheck}`,
    });
  }
  // D-33: margin bawah = tinggi halaman - margin atas - blok teks; negatif = blok teks tidak muat.
  const bottom = p[K.bottomMargin];
  if (typeof bottom === "number" && bottom < 0) {
    issues.push({
      key: K.bottomMargin,
      code: "SCHEMA_INVALID",
      message: `Blok teks tidak muat di tinggi halaman: margin bawah turunan ${bottom} mm`,
      pointer: `/params/${K.bottomMargin}`,
    });
  }
  // SR-60: kolom/blok teks turunan harus positif (kertas kecil + margin lega).
  for (const key of [K.text, K.textBlockHeight]) {
    const v = p[key];
    if (typeof v === "number" && v <= 0) {
      issues.push({
        key,
        code: "SCHEMA_INVALID",
        message: `Ukuran halaman terlalu kecil untuk margin: ${key} turunan ${v} mm`,
        pointer: `/params/${key}`,
      });
    }
  }
  return issues;
}

/**
 * Seperti `resolveParams`, dengan konteks dokumen untuk turunan (moda rel auto, bulan Romawi, nomor terbitan).
 *
 * SR-60: acuan turunan beracuan = default registri <- `base` (preset/profil);
 * kunci `overrides` yang diterima = eksplisit (tidak diskalakan). Fase lapis
 * (kerapatan margin, skala huruf, literal warna, tab R-30) dijalankan sekali di
 * sini; `computeDerivedWith` hanya menjalankan turunan idempoten.
 */
export function resolveParamsWith(
  i: { base: ParamMap; overrides: ParamMap; registry: readonly ParamDef[]; pinPolicy?: PinPolicy },
  ctx: DeriveContext,
): { params: ParamMap; errors: ParamIssue[] } {
  const { merged, errors } = mergeLayers(i);
  const reference = mergeLayers({ base: i.base, overrides: {}, registry: i.registry }).merged;
  const rejected = new Set(errors.filter((e) => e.pointer?.startsWith("/overrides/")).map((e) => e.key));
  const explicit = Object.keys(i.overrides).filter((k) => !rejected.has(k));
  const rejectedBase = new Set(errors.filter((e) => e.pointer?.startsWith("/base/")).map((e) => e.key));
  const pinned = Object.keys(i.base).filter((k) => !rejectedBase.has(k));
  const params = deriveLayered({ reference, merged, explicit, pinned, registry: i.registry, pinPolicy: i.pinPolicy, ctx });
  return { params: freeze(params), errors: [...errors, ...pageWidthIssues(params)] };
}

export function resolveParams(i: { base: ParamMap; overrides: ParamMap; registry: readonly ParamDef[]; pinPolicy?: PinPolicy }): {
  params: ParamMap;
  errors: ParamIssue[];
} {
  return resolveParamsWith(i, {});
}

/** Seperti `computeDerived`, dengan konteks dokumen dan registri eksplisit. */
export function computeDerivedWith(p: ParamMap, ctx: DeriveContext, registry: readonly ParamDef[] = ALL_PARAMS): ParamMap {
  return freeze(deriveAll(p, registry, ctx));
}

export function computeDerived(p: ParamMap): ParamMap {
  return computeDerivedWith(p, {});
}

export function checkOverrideRights(o: ParamMap, caller: CallerKind, registry: readonly ParamDef[]): ParamIssue[] {
  return checkOverrides(o, caller, registry);
}

/**
 * Lempar `StudioEngineError` dengan kode isu pertama bila ada override yang
 * ditolak (urutan: K terlarang, T hanya-baca, kunci tak dikenal); semua isu di
 * `details.issues`.
 */
export function assertOverrideRights(o: ParamMap, caller: CallerKind, registry: readonly ParamDef[]): void {
  const issues = checkOverrides(o, caller, registry);
  if (issues.length === 0) return;
  const rank: Record<ParamIssue["code"], number> = {
    PARAM_CLASS_K_FORBIDDEN: 0,
    PARAM_CLASS_T_READONLY: 1,
    PARAM_UNKNOWN_KEY: 2,
    SCHEMA_INVALID: 3,
  };
  const first = [...issues].sort((a, b) => rank[a.code] - rank[b.code])[0];
  throw new StudioEngineError(first.code, first.message, { issues });
}

export function resolveRoleFormat(tpl: ResolvedTemplate, role: RoleKey): RoleFormat {
  return overlayRoleFormat(catalogRoleFormat(tpl.params, role), tpl.roleFormats[role]);
}

/** Warna hex untuk tokenRef/peran (mis. `color.role.zebra` -> `zebra15` -> hex turunan). */
export function resolveTokenColor(tpl: ResolvedTemplate, ref: string): Hex | undefined {
  return resolveColorToken(tpl.params, ref);
}

/** Token warna turunan templat (selalu memuat `zebra15`, D-31). */
export function templateColorTokens(tpl: ResolvedTemplate): Readonly<Record<string, Hex>> {
  return derivedColorTokens(tpl.params);
}

/** Moda rel efektif untuk dokumen dengan `railCitations` sitasi rel (KT-07). */
export function railModeFor(tpl: ResolvedTemplate, railCitations: number): "A" | "B" {
  const m = resolveRailMode(tpl.params, railCitations);
  return m === "B" ? "B" : "A";
}
