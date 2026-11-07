/**
 * Default per jenis keluarga tabel dan preset (S17).
 *
 * Preset hanya mengisi yang tidak dinyatakan blok: peran/rata kolom yang
 * kosong, baris kepala bila blok tidak membawa baris `kind:"header"` (hanya
 * untuk preset yang kolomnya dibakukan parameter katalog), dan gaya baris total
 * AHS. Tidak ada judul kolom yang dikarang: kepala bawaan selalu berasal dari
 * parameter (`assumptionRegister.columns` P5-62, `specTable.columns` P5-26,
 * `sourceRegister.columns` PD-01, `boq.columns` P6-30).
 *
 * `preset` boleh berupa beberapa token dipisah `+`, spasi, atau koma; token
 * `zebra` menyalakan zebra (tokenRef `table.zebra.colour` = zebra15, D-31) bila
 * baris badan > `table.zebra.minRows` (P5-07) dan bukan BoQ cetak (P5-09).
 *
 * FIX-T (D-277 M-2, D-166 KC-6): token yang menjadi kunci profil lebar kolom
 * templat (`render.table.columnProfiles`, R-52) adalah jenis tabel semantik
 * yang sah walau tidak membawa default peran di sini; lebarnya diterapkan
 * compose (`services/compose/blocks.ts` `columnProfile`) sebelum mesin, jadi
 * token itu `profiled`, bukan `unknown` (tidak memicu peringatan).
 */
import type { ColumnSpec, TableBlockType } from "../../../contract";

/** registerTable: 8 preset (registry/sections.ts S16). */
export const REGISTER_TABLE_PRESETS = [
  "assumption",
  "reconciliation",
  "finding",
  "regulation",
  "standardEdition",
  "improvement",
  "revisionHistory",
  "distribution",
] as const;

/** financialTable: 3 preset (01_specs.md §3.4). */
export const FINANCIAL_TABLE_PRESETS = ["boq", "ahs", "recap"] as const;

export type ColumnRole = NonNullable<ColumnSpec["role"]>;

export interface PresetDefaults {
  /** Peran kolom posisional (kolom lebih banyak dari larik = tanpa default). */
  roles?: readonly (ColumnRole | undefined)[];
  /** Kunci parameter berisi daftar judul kolom (kepala bawaan). */
  headerParam?: string;
  /** Larangan zebra (BoQ cetak, P5-09). */
  zebraParam?: string;
}

const ID_FIRST: PresetDefaults = { roles: ["id"] };

const TYPE_DEFAULTS: Readonly<Partial<Record<TableBlockType, PresetDefaults>>> = {
  specTable: { roles: ["text", "text", "numeral", "unit"], headerParam: "specTable.columns" },
  ruleTable: ID_FIRST,
  ruleIndex: ID_FIRST,
  referenceScale: ID_FIRST,
  sourceRegister: { headerParam: "sourceRegister.columns" },
};

const PRESET_DEFAULTS: Readonly<Record<string, PresetDefaults>> = {
  // registerTable
  assumption: { roles: ["id", "text", "text", "text"], headerParam: "assumptionRegister.columns" },
  reconciliation: ID_FIRST,
  finding: ID_FIRST,
  regulation: { roles: ["text"] },
  standardEdition: { roles: ["text"] },
  improvement: ID_FIRST,
  revisionHistory: ID_FIRST,
  distribution: ID_FIRST,
  // financialTable
  boq: { roles: ["id", "text", "numeral", "unit", "numeral", "numeral"], headerParam: "boq.columns", zebraParam: "table.zebra.onPrintedBoq" },
  ahs: ID_FIRST,
  recap: { roles: ["id", "text", "numeral"] },
};

export function presetTokens(preset: string | undefined): string[] {
  if (!preset) return [];
  return preset
    .split(/[+,\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Default efektif: default jenis, lalu preset yang dikenal (yang kemudian menang per medan).
 * `profileNames` = kunci `render.table.columnProfiles` templat: token di sana
 * masuk `profiled` (sah, tanpa default peran), bukan `unknown`.
 */
export function resolvePresetDefaults(
  type: TableBlockType,
  preset: string | undefined,
  profileNames: ReadonlySet<string> = new Set(),
): {
  defaults: PresetDefaults;
  tokens: string[];
  unknown: string[];
  profiled: string[];
} {
  const tokens = presetTokens(preset);
  let defaults: PresetDefaults = { ...(TYPE_DEFAULTS[type] ?? {}) };
  const unknown: string[] = [];
  const profiled: string[] = [];
  for (const t of tokens) {
    if (t === "zebra") continue;
    const allowed =
      type === "registerTable"
        ? (REGISTER_TABLE_PRESETS as readonly string[]).includes(t)
        : type === "financialTable"
          ? (FINANCIAL_TABLE_PRESETS as readonly string[]).includes(t)
          : false;
    if (profileNames.has(t)) profiled.push(t);
    if (!allowed) {
      if (!profileNames.has(t)) unknown.push(t);
      continue;
    }
    defaults = { ...defaults, ...PRESET_DEFAULTS[t] };
  }
  return { defaults, tokens, unknown, profiled };
}
