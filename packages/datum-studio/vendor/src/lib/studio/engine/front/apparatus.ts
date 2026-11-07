/**
 * FIX-SERAH (D-295): aparatus halaman depan milik templat (D-139), satu sumber
 * untuk perakit DOCX (`docx/wrapper/pages.ts`), renderer HTML
 * (`html/blocks/wrapper.ts`), dan lint struktur (`lint/structure/checks-d.ts`).
 *
 * 1. Sampul `explicit`: badan konten-saja (D-248/D-256 membuang perangkat
 *    tampilan) tidak lagi membawa logo, pita segel, Datum Rule, dan string
 *    punggung. Perangkat itu milik templat, maka mesin memasangnya menurut
 *    `cover.elementOrder` dan parameter penempatan yang sama dengan sampul
 *    `auto`, hanya untuk jenis yang TIDAK ada di badan (badan yang sudah
 *    membawanya, mis. `benchmark/manual000/doc.verbatim.json`, tidak berubah).
 * 2. Label bagian bawaan ("Bagian I"): dipakai pembatas bagian dan entri daftar
 *    isi yang diturunkan, sehingga keduanya sama bila konten tidak mengirim label
 *    (compose v2 mengisi `label` kosong, `services/compose/snapshot.ts`).
 */
import type { DeviceKind, ParamMap } from "../../contract";

// FIX-2 (F-055): label bagian bawaan pindah ke tabel teks bersama `./texts`; ekspor ulang agar impor lama tetap sah.
export { defaultPartLabelText } from "./texts";

/** Aparatus sampul yang dipasang templat (D16 tier SERAH + D06 logo). */
export type CoverApparatusKind = Extract<DeviceKind, "sealBand" | "logo" | "datumRule" | "spineString">;

/** Urutan bawaan P4V-03 `cover.elementOrder` (sama dengan DOCX dan HTML). */
export const COVER_ELEMENT_ORDER_DEFAULT: readonly string[] = [
  "pita segel",
  "logo",
  "baris alamat di atas garis rambut",
  "ruang putih",
  "Datum Rule 166 mm",
  "kicker jenis dokumen",
  "judul",
  "standfirst",
  "baris cakupan",
  "blok kendali",
  "kolofon",
  "string punggung",
];

const APPARATUS_OF_ELEMENT: Readonly<Record<string, CoverApparatusKind>> = {
  "pita segel": "sealBand",
  logo: "logo",
  "Datum Rule 166 mm": "datumRule",
  "string punggung": "spineString",
};

/** Butir urutan yang membuka isi judul sampul: aparatus sebelumnya diletakkan di atas badan explicit. */
const TITLE_GROUP = new Set(["kicker jenis dokumen", "judul"]);

function bool(p: ParamMap, key: string, fallback: boolean): boolean {
  const v = p[key];
  return typeof v === "boolean" ? v : fallback;
}

function strList(p: ParamMap, key: string, fallback: readonly string[]): string[] {
  const v = p[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [...fallback];
}

export function coverElementOrder(params: ParamMap): string[] {
  return strList(params, "cover.elementOrder", COVER_ELEMENT_ORDER_DEFAULT);
}

/** Penempatan Datum Rule (kosakata registri `device.datumRule.placements`). */
export type DatumRulePlacement = "sampul" | "pembatas" | "atas judul bab";
/** Penempatan string punggung (kosakata registri `device.spine.placements`). */
export type SpinePlacement = "margin luar sampul" | "pembatas";

const DATUM_RULE_PLACEMENTS_DEFAULT: readonly DatumRulePlacement[] = ["atas judul bab", "sampul", "pembatas"];
const SPINE_PLACEMENTS_DEFAULT: readonly SpinePlacement[] = ["margin luar sampul", "pembatas"];

/**
 * FIX-F C2 (D-313, kelas F-055): Datum Rule bangkitan templat dipasang di `where` bila
 * `device.datumRule.enabled` dan `where` ada di `device.datumRule.placements`. Predikat sama
 * dengan DOCX `rulePlaced` (`docx/wrapper/pages.ts`) dan `datumRuleEnabled` (`docx/blocks/structure.ts`);
 * dipakai HTML (sampul auto/explicit, pembatas, kepala bab/lampiran) agar kenop berpengaruh di kedua format.
 */
export function datumRulePlaced(params: ParamMap, where: DatumRulePlacement): boolean {
  return bool(params, "device.datumRule.enabled", true) && strList(params, "device.datumRule.placements", DATUM_RULE_PLACEMENTS_DEFAULT).includes(where);
}

/**
 * FIX-F C2: string punggung bangkitan templat di `where` bila `device.spine.enabled` (kenop esensial USER
 * "Tampilkan string punggung") dan `where` ada di `device.spine.placements`. Sama dengan DOCX `spinePlaced`.
 */
export function spinePlaced(params: ParamMap, where: SpinePlacement): boolean {
  return bool(params, "device.spine.enabled", true) && strList(params, "device.spine.placements", SPINE_PLACEMENTS_DEFAULT).includes(where);
}

/** Aparatus sampul aktif menurut parameter (predikat sama dengan `autoCoverItems` DOCX). */
export function coverApparatusEnabled(params: ParamMap, kind: CoverApparatusKind): boolean {
  switch (kind) {
    case "sealBand":
      return bool(params, "device.sealBand.enabled", true);
    case "logo":
      return true;
    case "datumRule":
      return datumRulePlaced(params, "sampul");
    case "spineString":
      return spinePlaced(params, "margin luar sampul");
  }
}

export interface ExplicitCoverApparatus {
  /** Butir `cover.elementOrder` yang dipasang di atas badan explicit (urutan templat). */
  before: string[];
  /** Butir `cover.elementOrder` yang dipasang di bawah badan explicit. */
  after: string[];
  /** Jenis aparatus yang dipasang (gabungan before + after). */
  kinds: Set<CoverApparatusKind>;
}

/** Jenis perangkat yang sudah dibawa badan explicit. */
function bodyDevices(body: readonly unknown[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const it of body ?? []) {
    const b = it as { type?: unknown; device?: unknown } | null;
    if (b && b.type === "device" && typeof b.device === "string") out.add(b.device);
  }
  return out;
}

/**
 * Aparatus templat yang dipasang mesin pada sampul `explicit`: butir aparatus
 * `cover.elementOrder` yang aktif dan belum dibawa badan. Butir sebelum
 * kelompok judul (kicker/judul) di atas badan, sisanya di bawah. Tiap jenis
 * paling banyak sekali (logo tepat sekali, DT-14).
 */
export function explicitCoverApparatus(params: ParamMap, body: readonly unknown[] | undefined): ExplicitCoverApparatus {
  const present = bodyDevices(body);
  const order = coverElementOrder(params);
  const titleAt = order.findIndex((el) => TITLE_GROUP.has(el));
  const out: ExplicitCoverApparatus = { before: [], after: [], kinds: new Set() };
  order.forEach((el, i) => {
    const kind = APPARATUS_OF_ELEMENT[el];
    if (!kind || present.has(kind) || out.kinds.has(kind) || !coverApparatusEnabled(params, kind)) return;
    out.kinds.add(kind);
    (titleAt === -1 || i < titleAt ? out.before : out.after).push(el);
  });
  return out;
}
