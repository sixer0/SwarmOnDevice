/**
 * Tabel spec preset gaya turunan (baris C21 ronde cakupan; GF-08 mekanisme M2: research/35 §6 M2 (a)-(e),
 * research/38 §4.4; D-609, D-627, D-635). Data murni: tidak membuka DB dan tidak memeriksa izin DB; diiterasi
 * helper bersama `ensureDerivedPreset` lewat `runGuardedTemplateTx` (opsi `presets`). Tanpa cabang slug.
 *
 * Disambung ke `prisma/seed-studio.ts --doc-type-templates` (bukan flag baru): templat jenis dokumen akan merujuk
 * preset ini (C23), jadi preset wajib ada di transaksi yang sama sebelum templat, dan slugnya wajib sasaran penjaga
 * (selain itu `addedTemplates` gagal, research/35 §6 M2 (b)). Flag terpisah butuh dua transaksi dengan urutan wajib
 * dan uji-run (C24) yang berubah; di sini jalan ulang tetap satu perintah dan idempoten.
 *
 * `datum-gsp-preset` (basis) tidak disentuh: bukan sasaran, jadi penjaga runner menuntutnya tidak berubah.
 * PRESET_MIGRATIONS `seed-studio.ts` tidak diubah (M2 (e)).
 */
import { DATUM_SKELETON_SLOTS, type DerivedPresetSpec, type GuardedTemplateTxOptions } from "./seed-studio-templates";

/**
 * GSP DATUM Rev A: Tabel 8.2 Manual DATUM Rev A (`ID:2633-2635`, `EN:2703-2705`). Tiga ukuran adalah kunci turunan
 * (P4T-S06/S07/S08-size, surface derived: hanya ADMIN pada preset, `services/skeleton/access.ts:235`);
 * `datum-gsp-preset` menyematkan 7 / 6,5 / 7,5 pt (nilai Manual 000). Tracking kepala tabel +0,09 em (`ID:2634`;
 * preset dasar 0,0923) disematkan agar seluruh baris Tabel 8.2 ada di satu tempat (research/38 §4.4, D-635).
 * Kerangka = kerangka preset datum-gsp-preset (7 slot tanpa kenop).
 */
export const DERIVED_PRESET_SPECS: readonly DerivedPresetSpec[] = [
  {
    slug: "datum-gsp-rev-a-preset",
    name: "GSP DATUM Rev A",
    description: "Gaya GSP DATUM dengan skala huruf tabel Manual DATUM Rev A (Tabel 8.2: numeral 7,8 pt, kepala 6,8 pt, caption 7,6 pt).",
    baseSlug: "datum-gsp-preset",
    slots: DATUM_SKELETON_SLOTS,
    pins: {
      "type.scale.tableNumerals.size": 7.8,
      "type.scale.tableHeader.size": 6.8,
      "type.scale.caption.size": 7.6,
      "type.scale.tableHeader.trackEm": 0.09,
    },
    // GF-08 (verification/22 §9): the measured Manual 000 role formats inherited from the base print fixed run sizes
    // (caption label 7 pt, header 6.5 pt, numerals 7.5 pt, mono 7 pt) and win whole over the pins above
    // (`engine/tokens/roles.ts`), so the Table 8.2 sizes are written here as run-size patches. Sizes are the pins at
    // the nearest DOCX half-point (`w:sz`; the same rounding as the catalog `scaleRun` and the scorer's GF-07):
    // caption 7.6 pt -> 15 (7.5 pt), header 6.8 pt -> 14 (7.0 pt), numerals 7.8 pt -> 16 (8.0 pt). Header tracking
    // 0.09 em x 6.8 pt = 12.24 tw -> 12 (equal to the base value; kept explicit). Caption leading 11 pt (para 220
    // exact), faces, weights, caps, colours and cells stay the base's. The helper rejects a size that differs from
    // the catalog size of the role at these pins, so the patches cannot drift from the pins.
    roleFormatOverrides: {
      caption: { run: { szHalfPt: 15 }, labelRun: { szHalfPt: 15 } },
      "table.headerLeft": { run: { szHalfPt: 14, spacingTw: 12 } },
      "table.headerRight": { run: { szHalfPt: 14, spacingTw: 12 } },
      "controlTable.header": { run: { szHalfPt: 14, spacingTw: 12 } },
      "table.cellNumeralRight": { run: { szHalfPt: 16 } },
      "table.cellMono": { run: { szHalfPt: 16 } },
    },
    changeNote: (c) => `C21 (GF-08, M2): preset GSP DATUM Rev A = preset dasar v${c.baseVersionNo} + ${c.pinCount} sematan Tabel 8.2 Manual DATUM Rev A (ID:2633-2635)`,
  },
];

/**
 * Opsi runner + tabel preset turunan sebagai sasaran tambahan (ditulis sebelum templat di transaksi yang sama);
 * hitungan bukti ditambah jumlah baris preset turunan. Opsi lain (label, penjaga, section type beku) apa adanya.
 */
export function withDerivedPresets(opts: GuardedTemplateTxOptions, specs: readonly DerivedPresetSpec[] = DERIVED_PRESET_SPECS): GuardedTemplateTxOptions {
  return {
    ...opts,
    presets: specs,
    counts: async (tx) => ({
      ...(await opts.counts(tx)),
      derivedPresets: await tx.studioTemplate.count({ where: { slug: { in: specs.map((s) => s.slug) } } }),
    }),
  };
}
