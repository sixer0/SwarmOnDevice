/**
 * engine/chart/family-g — grid petak tetap 38 provinsi Indonesia (S43, G-01..G-03).
 *
 * Kode petak Studio: 4 huruf kapital (kecuali DKI, DIY, NTB, NTT, PBD yang sudah lazim),
 * unik per provinsi. Posisi baris/kolom mengikuti panel G-01 Gambar 8.5 Manual 000
 * (benchmark `bm-fig-21`), dengan tiga singkatan ganda manual dipisah:
 * Kalimantan Utara KAUT (manual: KALT), Kalimantan Tengah KATE (manual: KALT),
 * Sulawesi Tengah SUTE (manual: SULT), Sulawesi Tenggara SUTR (manual: SULT),
 * Maluku Utara MAUT (manual: MALU). Grid 8 baris x 14 kolom, (0, 0) kiri atas.
 *
 * Grid ini adalah acuan `chart.kind.G-01.standardAbbrev` (label petak di luar daftar
 * dilaporkan, tidak ditolak) dan bahan siap pakai untuk agen: `indonesiaTiles()`
 * membangun `data.tiles` dari peta kode -> nilai. G-02/G-03 memakai grid yang sama
 * secara skematis (D-22 KT-12, tanpa peta dasar/GeoJSON).
 */
import type { ChartData } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";

export interface ProvinceTile {
  /** Kode petak Studio. */
  code: string;
  /** Nama resmi provinsi. */
  name: string;
  row: number;
  col: number;
}

export const INDONESIA_TILE_ROWS = 8;
export const INDONESIA_TILE_COLS = 14;

/** 38 provinsi, urut barat ke timur per pulau besar. */
export const INDONESIA_PROVINCES: readonly ProvinceTile[] = Object.freeze([
  { code: "ACEH", name: "Aceh", row: 0, col: 0 },
  { code: "SUMU", name: "Sumatera Utara", row: 1, col: 1 },
  { code: "SUMB", name: "Sumatera Barat", row: 2, col: 1 },
  { code: "RIAU", name: "Riau", row: 1, col: 2 },
  { code: "KEPR", name: "Kepulauan Riau", row: 0, col: 3 },
  { code: "JAMB", name: "Jambi", row: 2, col: 2 },
  { code: "BENG", name: "Bengkulu", row: 3, col: 1 },
  { code: "SUMS", name: "Sumatera Selatan", row: 3, col: 2 },
  { code: "BABE", name: "Kepulauan Bangka Belitung", row: 2, col: 3 },
  { code: "LAMP", name: "Lampung", row: 4, col: 2 },
  { code: "BANT", name: "Banten", row: 5, col: 3 },
  { code: "DKI", name: "DKI Jakarta", row: 5, col: 4 },
  { code: "JABA", name: "Jawa Barat", row: 6, col: 4 },
  { code: "JATE", name: "Jawa Tengah", row: 6, col: 5 },
  { code: "DIY", name: "DI Yogyakarta", row: 7, col: 5 },
  { code: "JATI", name: "Jawa Timur", row: 6, col: 6 },
  { code: "BALI", name: "Bali", row: 6, col: 7 },
  { code: "NTB", name: "Nusa Tenggara Barat", row: 6, col: 8 },
  { code: "NTT", name: "Nusa Tenggara Timur", row: 6, col: 9 },
  { code: "KALB", name: "Kalimantan Barat", row: 2, col: 4 },
  { code: "KATE", name: "Kalimantan Tengah", row: 3, col: 5 },
  { code: "KALS", name: "Kalimantan Selatan", row: 3, col: 6 },
  { code: "KALT", name: "Kalimantan Timur", row: 2, col: 6 },
  { code: "KAUT", name: "Kalimantan Utara", row: 1, col: 6 },
  { code: "SULU", name: "Sulawesi Utara", row: 1, col: 9 },
  { code: "GORO", name: "Gorontalo", row: 1, col: 8 },
  { code: "SUTE", name: "Sulawesi Tengah", row: 2, col: 7 },
  { code: "SULB", name: "Sulawesi Barat", row: 3, col: 7 },
  { code: "SULS", name: "Sulawesi Selatan", row: 4, col: 7 },
  { code: "SUTR", name: "Sulawesi Tenggara", row: 4, col: 8 },
  { code: "MALU", name: "Maluku", row: 4, col: 10 },
  { code: "MAUT", name: "Maluku Utara", row: 2, col: 10 },
  { code: "PABA", name: "Papua Barat", row: 3, col: 11 },
  { code: "PBD", name: "Papua Barat Daya", row: 2, col: 11 },
  { code: "PAPU", name: "Papua", row: 3, col: 12 },
  { code: "PTEN", name: "Papua Tengah", row: 4, col: 12 },
  { code: "PPEG", name: "Papua Pegunungan", row: 4, col: 13 },
  { code: "PSEL", name: "Papua Selatan", row: 5, col: 13 },
]);

export const INDONESIA_PROVINCE_COUNT = 38;

export const PROVINCE_BY_CODE: ReadonlyMap<string, ProvinceTile> = new Map(INDONESIA_PROVINCES.map((p) => [p.code, p]));

export function isStandardProvinceCode(code: string): boolean {
  return PROVINCE_BY_CODE.has(code);
}

type TileList = Extract<ChartData, { shape: "tiles" }>["tiles"];

/**
 * `data.tiles` 38 provinsi dari peta kode -> nilai (provinsi tanpa nilai tetap digambar
 * sebagai petak "tanpa data"). Kode asing -> galat pemanggil (bukan bagian grid).
 */
export function indonesiaTiles(values: Readonly<Record<string, number>> = {}): TileList {
  for (const k of Object.keys(values)) {
    if (!PROVINCE_BY_CODE.has(k)) {
      throw new StudioEngineError("SCHEMA_INVALID", `kode provinsi "${k}" tidak ada di grid petak Studio`, { code: k });
    }
  }
  return INDONESIA_PROVINCES.map((p) => ({
    code: p.code,
    row: p.row,
    col: p.col,
    label: p.code,
    ...(Object.prototype.hasOwnProperty.call(values, p.code) ? { value: values[p.code] } : {}),
  }));
}
