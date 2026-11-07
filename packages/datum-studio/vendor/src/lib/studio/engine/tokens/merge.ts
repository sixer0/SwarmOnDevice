/**
 * Penggabungan profil + override dan hak override (S11; 01_specs.md §5.1,
 * §8.2 I01; KT-16).
 *
 * Lapisan: default registri (profil DATUM-kanonik) <- `base` (profil turunan,
 * mis. Manual 000; tepercaya, boleh memuat kelas K/T) <- `overrides` dokumen
 * (divalidasi: kunci dikenal, tipe sah, kelas T ditolak). Hak kelas K per
 * pemanggil diperiksa `checkOverrides`; hanya ADMIN_SESSION (peran
 * ADMINISTRATOR) boleh menimpa kelas K.
 */
import type { CallerKind, ParamDef, ParamIssue, ParamMap, ParamValue, StudioTier } from "../../contract";

const TIERS: readonly StudioTier[] = ["NOTA", "TERBIT", "SERAH"];
const NUMERIC_TYPES = new Set<ParamDef["type"]>(["int", "number", "mm", "pt", "em", "deg", "percent", "cm", "rp"]);
/** Kelas bersyarat "B (>= 0,18: K)": nilai di bawah ambang memerlukan hak kelas K. */
const K_FLOOR_RE = /^B\s*\(\s*>=\s*(\d+(?:[.,]\d+)?)\s*:\s*K\s*\)/;
/** Kelas bersyarat "T (B hanya untuk TERBIT)": boleh ditimpa hanya pada tier itu. */
const T_EXCEPT_RE = /^T\s*\(\s*B hanya untuk (NOTA|TERBIT|SERAH)\s*\)/;

/** Escape segmen JSON Pointer (RFC 6901). */
export function pointerSegment(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function cloneValue<T extends ParamValue>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => cloneValue(x)) as T;
  const out: Record<string, ParamValue> = {};
  for (const [k, x] of Object.entries(v)) out[k] = cloneValue(x);
  return out as T;
}

export function indexRegistry(registry: readonly ParamDef[]): ReadonlyMap<string, ParamDef> {
  return new Map(registry.map((d) => [d.key, d]));
}

/** Profil DATUM-kanonik: default setiap ParamDef registri. */
export function canonicalProfile(registry: readonly ParamDef[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const d of registry) out[d.key] = cloneValue(d.default);
  return out;
}

function isPlainObject(v: ParamValue): v is { [k: string]: ParamValue } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Validasi struktural nilai terhadap ParamDef. `null` = sah, string = alasan tolak. */
export function validateParamValue(def: ParamDef, v: ParamValue): string | null {
  if (v === null) return def.default === null ? null : "null tidak diizinkan untuk parameter ini";
  const t = def.type;
  if (t === "bool") return typeof v === "boolean" ? null : "harus boolean";
  if (NUMERIC_TYPES.has(t)) {
    if (typeof v !== "number" || !Number.isFinite(v)) return "harus angka";
    if (t === "int" && !Number.isInteger(v)) return "harus bilangan bulat";
    if (def.range?.min !== undefined && v < def.range.min) return `di bawah minimum ${def.range.min}`;
    if (def.range?.max !== undefined && v > def.range.max) return `di atas maksimum ${def.range.max}`;
    return null;
  }
  if (t === "ratio") {
    if (typeof v === "number" && Number.isFinite(v)) return null;
    return typeof v === "string" && /^\s*\d+(?:[.,]\d+)?\s*\/\s*\d+(?:[.,]\d+)?\s*$/.test(v) ? null : "harus rasio (angka atau a/b)";
  }
  if (t === "hex") return typeof v === "string" && /^#?[0-9A-Fa-f]{6}$/.test(v) ? null : "harus hex 6 digit";
  if (t === "char") return typeof v === "string" && [...v].length === 1 ? null : "harus satu karakter";
  if (t === "string" || t === "tokenRef") {
    if (typeof v !== "string") return "harus string";
    if (def.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(def.pattern);
      } catch {
        return null; // pola registri rusak: bukan kesalahan pemanggil
      }
      if (!re.test(v)) return `tidak cocok pola ${def.pattern}`;
    }
    return null;
  }
  if (t === "enum") {
    if (typeof v !== "string") return "harus string enum";
    return !def.enum || def.enum.includes(v) ? null : `harus salah satu dari ${def.enum.join(", ")}`;
  }
  if (t === "list") {
    if (!Array.isArray(v)) return "harus larik";
    if (def.enum && v.some((x) => typeof x !== "string" || !def.enum!.includes(x))) return `anggota harus dari ${def.enum.join(", ")}`;
    return null;
  }
  if (t === "pair") return Array.isArray(v) && v.length === 2 ? null : "harus pasangan dua nilai";
  if (t === "range") {
    if (Array.isArray(v)) return v.length === 2 && v.every((x) => typeof x === "number") ? null : "harus [min, maks]";
    return isPlainObject(v) ? null : "harus [min, maks] atau objek";
  }
  if (t === "map" || t === "object") return isPlainObject(v) ? null : "harus objek";
  return null;
}

/** Kelas efektif untuk satu nilai override (kelas bersyarat dari `classNote`). */
export function effectiveClass(def: ParamDef, v: ParamValue, tier?: StudioTier): "B" | "K" | "T" {
  const note = def.classNote ?? "";
  if (def.class === "B") {
    const m = K_FLOOR_RE.exec(note);
    if (m && typeof v === "number" && v < Number(m[1].replace(",", "."))) return "K";
    return "B";
  }
  if (def.class === "T") {
    const m = T_EXCEPT_RE.exec(note);
    // Tanpa tier diketahui, pengecualian dianggap mungkin; resolveParams menegakkan tier.
    if (m && (tier === undefined || tier === m[1])) return "B";
    return "T";
  }
  return "K";
}

function tierFrom(v: ParamValue | undefined): StudioTier | undefined {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v) ? (v as StudioTier) : undefined;
}

/** Hak override per pemanggil (I01 `checkOverrideRights`). */
export function checkOverrides(o: ParamMap, caller: CallerKind, registry: readonly ParamDef[]): ParamIssue[] {
  const byKey = indexRegistry(registry);
  const tier = tierFrom(o["artifact.tier"]);
  const issues: ParamIssue[] = [];
  for (const key of Object.keys(o).sort()) {
    const pointer = `/overrides/${pointerSegment(key)}`;
    const def = byKey.get(key);
    if (!def) {
      issues.push({ key, code: "PARAM_UNKNOWN_KEY", message: `Parameter tidak dikenal: ${key}`, pointer });
      continue;
    }
    const cls = effectiveClass(def, o[key], tier);
    if (cls === "T") {
      issues.push({ key, code: "PARAM_CLASS_T_READONLY", message: `Parameter ${key} (kelas T) dihitung mesin dan tidak dapat ditimpa`, pointer });
    } else if (cls === "K" && caller !== "ADMIN_SESSION") {
      issues.push({
        key,
        code: "PARAM_CLASS_K_FORBIDDEN",
        message: `Parameter ${key} (kelas K) hanya dapat diubah peran ADMINISTRATOR`,
        pointer,
      });
    }
  }
  return issues;
}

/**
 * Gabungkan default registri, profil `base`, dan `overrides`. Override yang
 * ditolak tidak diterapkan dan dilaporkan; hak kelas K TIDAK diperiksa di sini
 * (pemanggil menjalankan `checkOverrideRights` lebih dulu).
 */
export function mergeLayers(i: { base: ParamMap; overrides: ParamMap; registry: readonly ParamDef[] }): {
  merged: Record<string, ParamValue>;
  errors: ParamIssue[];
} {
  const byKey = indexRegistry(i.registry);
  const merged = canonicalProfile(i.registry);
  const errors: ParamIssue[] = [];

  for (const key of Object.keys(i.base).sort()) {
    const pointer = `/base/${pointerSegment(key)}`;
    const def = byKey.get(key);
    if (!def) {
      errors.push({ key, code: "PARAM_UNKNOWN_KEY", message: `Parameter profil tidak dikenal: ${key}`, pointer });
      continue;
    }
    const v = i.base[key];
    const bad = validateParamValue(def, v);
    if (bad) {
      errors.push({ key, code: "SCHEMA_INVALID", message: `Nilai profil ${key} tidak sah: ${bad}`, pointer });
      continue;
    }
    merged[key] = cloneValue(v);
  }

  const overrideTier = tierFrom(i.overrides["artifact.tier"]);
  const tier = byKey.has("artifact.tier") && overrideTier ? overrideTier : tierFrom(merged["artifact.tier"]);

  for (const key of Object.keys(i.overrides).sort()) {
    const pointer = `/overrides/${pointerSegment(key)}`;
    const def = byKey.get(key);
    if (!def) {
      errors.push({ key, code: "PARAM_UNKNOWN_KEY", message: `Parameter tidak dikenal: ${key}`, pointer });
      continue;
    }
    const v = i.overrides[key];
    if (effectiveClass(def, v, tier) === "T") {
      errors.push({ key, code: "PARAM_CLASS_T_READONLY", message: `Parameter ${key} (kelas T) dihitung mesin dan tidak dapat ditimpa`, pointer });
      continue;
    }
    const bad = validateParamValue(def, v);
    if (bad) {
      errors.push({ key, code: "SCHEMA_INVALID", message: `Nilai ${key} tidak sah: ${bad}`, pointer });
      continue;
    }
    merged[key] = cloneValue(v);
  }
  return { merged, errors };
}
