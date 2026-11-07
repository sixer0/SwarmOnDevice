/**
 * Resolusi parameter ambang pemindai bahasa.
 *
 * Urutan: `params[key]` (peta parameter templat terselesaikan, sudah memuat
 * override dokumen) -> `default` ParamDef katalog (params/governance-language,
 * P11). Nilai bertipe salah tidak ditebak: pemanggil menerima `ParamError`
 * dan pemeriksaan dilaporkan NOT_RUN dengan nama kunci (tanpa PASS palsu).
 */
import type { ParamMap, ParamValue } from "../../../contract";
import { PARAMS_GOVERNANCE_LANGUAGE } from "../../../params/governance-language";

const DEFAULTS: ReadonlyMap<string, ParamValue> = new Map(PARAMS_GOVERNANCE_LANGUAGE.map((p) => [p.key, p.default]));

export class ParamError extends Error {
  constructor(
    readonly key: string,
    readonly expected: string,
    readonly got: unknown,
  ) {
    super(`parameter ${key} tidak sah (diharapkan ${expected}, didapat ${JSON.stringify(got) ?? String(got)})`);
    this.name = "ParamError";
  }
}

function raw(params: ParamMap, key: string): ParamValue | undefined {
  const v = params[key];
  return v !== undefined && v !== null ? v : DEFAULTS.get(key) ?? undefined;
}

export function numberParam(params: ParamMap, key: string): number {
  const v = raw(params, key);
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  throw new ParamError(key, "angka >= 0", v);
}

export function rangeParam(params: ParamMap, key: string): readonly [number, number] {
  const v = raw(params, key);
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number" && v[0] <= v[1]) {
    return [v[0], v[1]];
  }
  throw new ParamError(key, "rentang [min, max]", v);
}

export function stringParam(params: ParamMap, key: string): string {
  const v = raw(params, key);
  if (typeof v === "string" && v.trim() !== "") return v;
  throw new ParamError(key, "teks tidak kosong", v);
}
