/**
 * Agregat parameter (01_specs.md §12.1 T34; SR-05 penulis tunggal pin hitungan).
 * Katalog 722 = 115 + 134 + 91 + 111 + 135 + 136 (chart: 87 katalog + 12 mesin +
 * 37 petunjuk tergambar galeri: 31 IP-41c + 3 axis P-13/P-14/S-01 FIX-A + 3 axis S-02/S-03/S-04
 * FIX-A2, registry/charts.ts), semua `origin: "catalog"`.
 * Parameter kontrak (`origin: "contract"`) dihitung terpisah (D-24 butir 1): renderer
 * R-01..R-37 + R-59..R-64 (RQ-8) + R-65 (FIX-FIG D-257) + R-66 (FIX-TL `toc.levels`, D-351/D-352) = 45
 * dan struktur R-38..R-58 = 21 (params/structure.ts). Total 788.
 *
 * Setiap ParamDef diberi `scope` (registry/slots.ts PARAM_SCOPE) dan `surface`
 * (registry/essentials.ts PARAM_SURFACE) di sini, satu sumber (SR-01 §13.5).
 */
import type { ParamSurface } from "../contract/enums";
import type { ParamDef } from "../contract/types/params";
import { CHART_PARAMS } from "../registry/charts";
import { paramSurfaceOf } from "../registry/essentials";
import { paramScopeOf, type ParamScope } from "../registry/slots";
import { PARAMS_APPARATUS } from "./apparatus";
import { PARAMS_COLOR_TYPE } from "./color-type";
import { PARAMS_FIGURE } from "./figure";
import { PARAMS_GOVERNANCE_LANGUAGE } from "./governance-language";
import { PARAMS_PAGE } from "./page";
import { PARAMS_RENDER } from "./render";
import { PARAMS_STRUCTURE } from "./structure";

export * from "./apparatus";
export * from "./color-type";
export * from "./figure";
export * from "./governance-language";
export * from "./page";
export * from "./render";
export * from "./structure";

export const CATALOG_PARAM_COUNT = 722;
export const RENDER_PARAM_COUNT = 62;
export const STRUCTURE_PARAM_COUNT = 21;
export const ALL_PARAM_COUNT = CATALOG_PARAM_COUNT + RENDER_PARAM_COUNT + STRUCTURE_PARAM_COUNT;

/**
 * ParamDef dengan `scope` dan `surface` (medan opsional kontrak SR-04) selalu terisi.
 */
export type ScopedParamDef = ParamDef & { scope: ParamScope; surface: ParamSurface | undefined };

function withScopeSurface(defs: readonly ParamDef[]): ScopedParamDef[] {
  return defs.map((d) => ({ ...d, scope: paramScopeOf(d), surface: paramSurfaceOf(d) }));
}

/** Semua parameter katalog (origin "catalog"), termasuk 130 parameter khusus chart. */
export const CATALOG_PARAMS: readonly ScopedParamDef[] = withScopeSurface([
  ...PARAMS_GOVERNANCE_LANGUAGE,
  ...PARAMS_COLOR_TYPE,
  ...PARAMS_PAGE,
  ...PARAMS_APPARATUS,
  ...PARAMS_FIGURE,
  ...CHART_PARAMS,
]);

/** Katalog + parameter kontrak (renderer + struktur). */
export const ALL_PARAMS: readonly ScopedParamDef[] = [
  ...CATALOG_PARAMS,
  ...withScopeSurface([...PARAMS_RENDER, ...PARAMS_STRUCTURE]),
];

/** Indeks kunci -> ParamDef (dibangun sekali). */
export const PARAMS_BY_KEY: ReadonlyMap<string, ScopedParamDef> = new Map(ALL_PARAMS.map((p) => [p.key, p]));
