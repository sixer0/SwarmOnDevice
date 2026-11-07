/**
 * engine/chart/core — SATU API baca parameter chart untuk inti dan 11 keluarga (S84 #8).
 *
 * Urutan nilai efektif: `spec.params[kunci penuh]` -> `tpl.params[kunci penuh]` -> default
 * ParamDef registri (alias pendek sudah dipindah resolver `./params`). Mode "eksplisit"
 * (D-77, resep acuan gaya datum): hanya nilai yang diset di spec, atau di templat dan
 * berbeda dari default registri; selain itu `undefined` sehingga pemanggil memakai resep
 * acuan. Satu definisi, dipakai semua keluarga.
 *
 * Pembaca bertipe memvalidasi tipe dan `range` ParamDef dengan SATU bentuk pesan:
 * `<nomor gambar> — parameter <kunci> = <nilai> bukan <harapan>` (SCHEMA_INVALID,
 * details `{ key, code? }`); nilai salah tidak diam-diam diganti default.
 *
 * Petunjuk data non-registri (`CHART_DATA_HINT_KEYS`, dibaca dari `spec.params[<nama>]`)
 * memakai `hint*`; kuncinya dilaporkan sebagai `params.<nama>`.
 */
import { StudioEngineError } from "../../../contract/errors";
import type { ChartCode, ParamValue, ResolvedTemplate, StudioChartV1 } from "../../../contract";
import { PARAMS_BY_KEY } from "../../../params";

export type ChartSpecLike = Pick<StudioChartV1, "params"> & Partial<Pick<StudioChartV1, "id">>;

/** Konteks pembaca parameter kode (struktur cocok dengan ctx/prep keluarga). */
export interface KindCtx {
  spec: ChartSpecLike;
  tpl: ResolvedTemplate;
  code: ChartCode;
}

export function kindKey(code: ChartCode, name: string): string {
  return `chart.kind.${code}.${name}`;
}

const present = (v: ParamValue | undefined): v is Exclude<ParamValue, null> => v !== undefined && v !== null;

function fid(spec: ChartSpecLike): string {
  return spec.id ?? "(tanpa nomor)";
}

/** Nilai parameter efektif; `undefined` bila tidak ada di spec, templat, maupun registri. */
export function chartParam(spec: ChartSpecLike, tpl: ResolvedTemplate, key: string): ParamValue | undefined {
  const own = spec.params?.[key];
  if (present(own)) return own;
  const t = tpl.params[key];
  if (present(t)) return t;
  const d = PARAMS_BY_KEY.get(key)?.default;
  return present(d) ? d : undefined;
}

/** Nilai yang diset eksplisit (D-77): spec, atau templat yang berbeda dari default registri. */
export function explicitParam(spec: ChartSpecLike, tpl: ResolvedTemplate, key: string): ParamValue | undefined {
  const own = spec.params?.[key];
  if (present(own)) return own;
  const t = tpl.params[key];
  if (present(t) && JSON.stringify(t) !== JSON.stringify(PARAMS_BY_KEY.get(key)?.default)) return t;
  return undefined;
}

/** Nilai efektif (`explicit` = false) atau eksplisit saja (D-77). */
export function paramValue(spec: ChartSpecLike, tpl: ResolvedTemplate, key: string, explicit = false): ParamValue | undefined {
  return explicit ? explicitParam(spec, tpl, key) : chartParam(spec, tpl, key);
}

/** Galat parameter seragam (SCHEMA_INVALID). */
export function invalidParam(spec: ChartSpecLike, key: string, v: unknown, expected: string, code?: ChartCode): StudioEngineError {
  return new StudioEngineError("SCHEMA_INVALID", `${fid(spec)} — parameter ${key} = ${JSON.stringify(v)} bukan ${expected}`, {
    key,
    ...(code ? { code } : {}),
  });
}

function inRange(key: string, v: number): string | null {
  const r = PARAMS_BY_KEY.get(key)?.range;
  if (!r) return null;
  if ((r.min !== undefined && v < r.min) || (r.max !== undefined && v > r.max)) return `${r.min ?? "-inf"}..${r.max ?? "inf"}`;
  return null;
}

// ── Pembaca bertipe berkunci penuh ───────────────────────────────────────────

export function readBool(spec: ChartSpecLike, tpl: ResolvedTemplate, key: string, fallback: boolean, explicit = false): boolean {
  const v = paramValue(spec, tpl, key, explicit);
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw invalidParam(spec, key, v, "boolean");
  return v;
}

/** Angka hingga dalam `range` ParamDef. */
export function readNum(spec: ChartSpecLike, tpl: ResolvedTemplate, key: string, fallback: number, explicit = false): number {
  const v = paramValue(spec, tpl, key, explicit);
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalidParam(spec, key, v, "bilangan hingga");
  const r = inRange(key, v);
  if (r) throw invalidParam(spec, key, v, `dalam rentang ${r}`);
  return v;
}

/** Bilangan bulat dalam `range` ParamDef. */
export function readInt(spec: ChartSpecLike, tpl: ResolvedTemplate, key: string, fallback: number, explicit = false): number {
  const v = paramValue(spec, tpl, key, explicit);
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v)) throw invalidParam(spec, key, v, "bilangan bulat");
  const r = inRange(key, v);
  if (r) throw invalidParam(spec, key, v, `dalam rentang ${r}`);
  return v;
}

export function readEnum<T extends string>(
  spec: ChartSpecLike,
  tpl: ResolvedTemplate,
  key: string,
  allowed: readonly T[],
  fallback: T,
  explicit = false,
): T {
  const v = paramValue(spec, tpl, key, explicit);
  if (v === undefined) return fallback;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw invalidParam(spec, key, v, `salah satu ${allowed.join(" | ")}`);
}

/** String tidak kosong; `undefined` bila tidak diset atau kosong. */
export function readStr(spec: ChartSpecLike, tpl: ResolvedTemplate, key: string, explicit = false): string | undefined {
  const v = paramValue(spec, tpl, key, explicit);
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw invalidParam(spec, key, v, "string");
  return v.length ? v : undefined;
}

/** Larik string tidak kosong; `undefined` bila tidak diset. */
export function readStrList(spec: ChartSpecLike, tpl: ResolvedTemplate, key: string, explicit = false): string[] | undefined {
  const v = paramValue(spec, tpl, key, explicit);
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw invalidParam(spec, key, v, "larik string");
  return v as string[];
}

/** Pasangan `[min, maks]` bilangan hingga, min < maks (validator nilai apa pun). */
export function asRange(spec: ChartSpecLike, v: ParamValue | undefined, key: string): [number, number] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number" && Number.isFinite(x)) || !((v[0] as number) < (v[1] as number))) {
    throw invalidParam(spec, key, v, "pasangan [min, maks] dengan min < maks");
  }
  return [v[0] as number, v[1] as number];
}

export function readRange(spec: ChartSpecLike, tpl: ResolvedTemplate, key: string, explicit = false): [number, number] | undefined {
  return asRange(spec, paramValue(spec, tpl, key, explicit), key);
}

// ── Gula konteks kode (`chart.kind.<KODE>.<nama>`) ───────────────────────────

export function kindValue(c: KindCtx, name: string, explicit = false): ParamValue | undefined {
  return paramValue(c.spec, c.tpl, kindKey(c.code, name), explicit);
}

export function kindBool(c: KindCtx, name: string, fallback: boolean, explicit = false): boolean {
  return readBool(c.spec, c.tpl, kindKey(c.code, name), fallback, explicit);
}

export function kindNum(c: KindCtx, name: string, fallback: number, explicit = false): number {
  return readNum(c.spec, c.tpl, kindKey(c.code, name), fallback, explicit);
}

export function kindInt(c: KindCtx, name: string, fallback: number, explicit = false): number {
  return readInt(c.spec, c.tpl, kindKey(c.code, name), fallback, explicit);
}

export function kindEnum<T extends string>(c: KindCtx, name: string, allowed: readonly T[], fallback: T, explicit = false): T {
  return readEnum(c.spec, c.tpl, kindKey(c.code, name), allowed, fallback, explicit);
}

export function kindStr(c: KindCtx, name: string, explicit = false): string | undefined {
  return readStr(c.spec, c.tpl, kindKey(c.code, name), explicit);
}

export function kindStrList(c: KindCtx, name: string, explicit = false): string[] | undefined {
  return readStrList(c.spec, c.tpl, kindKey(c.code, name), explicit);
}

export function kindRange(c: KindCtx, name: string, explicit = false): [number, number] | undefined {
  return readRange(c.spec, c.tpl, kindKey(c.code, name), explicit);
}

// ── Petunjuk data non-registri (`spec.params[<nama>]`) ───────────────────────

export function hintValue(spec: ChartSpecLike, name: string): ParamValue | undefined {
  const v = spec.params?.[name];
  return v === null ? undefined : v;
}

export function hintBool(spec: ChartSpecLike, name: string, fallback: boolean): boolean {
  const v = hintValue(spec, name);
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw invalidParam(spec, `params.${name}`, v, "boolean");
  return v;
}

export function hintNum(spec: ChartSpecLike, name: string): number | undefined {
  const v = hintValue(spec, name);
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw invalidParam(spec, `params.${name}`, v, "bilangan hingga");
  return v;
}

export function hintStr(spec: ChartSpecLike, name: string): string | undefined {
  const v = hintValue(spec, name);
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw invalidParam(spec, `params.${name}`, v, "string");
  return v;
}

export function hintEnum<T extends string>(spec: ChartSpecLike, name: string, allowed: readonly T[], fallback: T): T {
  const v = hintValue(spec, name);
  if (v === undefined) return fallback;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw invalidParam(spec, `params.${name}`, v, `salah satu ${allowed.join(" | ")}`);
}

/** Petunjuk `[min, maks]` (mis. `axis`). */
export function hintRange(spec: ChartSpecLike, name: string): [number, number] | undefined {
  return asRange(spec, hintValue(spec, name), `params.${name}`);
}

// ── Petunjuk tergambar panel galeri (IP-39, IP-41c; kunci penuh, lapis lanjutan) ──

/** Domain sumbu `chart.kind.<KODE>.axis` = `[min, maks]`; `undefined` bila tidak diset. */
export function kindAxis(c: KindCtx, name = "axis"): [number, number] | undefined {
  return kindRange(c, name);
}

/**
 * Domain sumbu dua dimensi `chart.kind.<KODE>.axis`: objek `{x?: [min, maks], y?: [min, maks]}`
 * atau satu pasangan `[min, maks]` untuk kedua sumbu.
 */
export function kindAxisXY(c: KindCtx, name = "axis"): { x?: [number, number]; y?: [number, number] } | undefined {
  const key = kindKey(c.code, name);
  const v = paramValue(c.spec, c.tpl, key);
  if (v === undefined) return undefined;
  if (Array.isArray(v)) {
    const r = asRange(c.spec, v, key) as [number, number];
    return { x: r, y: r };
  }
  if (typeof v !== "object" || v === null || Object.keys(v).some((k) => k !== "x" && k !== "y")) {
    throw invalidParam(c.spec, key, v, "objek {x?: [min, maks], y?: [min, maks]} atau [min, maks]", c.code);
  }
  const o = v as Record<string, ParamValue>;
  return {
    ...(o.x !== undefined ? { x: asRange(c.spec, o.x, `${key}.x`) } : {}),
    ...(o.y !== undefined ? { y: asRange(c.spec, o.y, `${key}.y`) } : {}),
  };
}

/** Pasangan dua string tidak kosong (mis. label sisi `[kiri, kanan]`); `undefined` bila tidak diset. */
export function kindStrPair(c: KindCtx, name: string): [string, string] | undefined {
  const key = kindKey(c.code, name);
  const v = paramValue(c.spec, c.tpl, key);
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "string" && x.length > 0)) {
    throw invalidParam(c.spec, key, v, "pasangan dua string tidak kosong", c.code);
  }
  return [v[0] as string, v[1] as string];
}

/** Objek `{nama: angka hingga}`; `undefined` bila tidak diset. */
export function kindNumMap(c: KindCtx, name: string): Record<string, number> | undefined {
  const key = kindKey(c.code, name);
  const v = paramValue(c.spec, c.tpl, key);
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw invalidParam(c.spec, key, v, "objek {nama: angka}", c.code);
  }
  return v as Record<string, number>;
}
