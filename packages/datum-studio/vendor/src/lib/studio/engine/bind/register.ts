/**
 * Register besaran bernama (port `Register` datumbind.py).
 *
 * Setiap entri divalidasi saat konstruksi (semantik `Register.emit` Python):
 * tanda provenans wajib dan dikenal DATUM §8 (glif boleh disertakan), satuan
 * wajib tidak kosong (DATUM-09 rev B), nilai wajib bilangan hingga, `dec`
 * bilangan bulat 0..3 (kontrak `RegisterEntry`).
 *
 * Angka tercetak mengikuti konvensi bahasa dokumen (S17, research/33 D-04):
 * bawaan ID; EN memakai ribuan ",", desimal ".", rupiah "IDR" (tabel
 * `NUMBER_CONVENTIONS`). Bahasa datang dari data dokumen, bukan slug/jenis.
 */
import type { RegisterApi, RegisterEntry } from "../../contract";
import { PROVENANCE_GLYPHS, PROVENANCE_MARKS, type ProvenanceMark } from "../../contract/enums";
import { BindDefect } from "./defect";
import {
  DEFAULT_NUMBER_LANGUAGE,
  formatWith,
  numberConvention,
  numberLanguageOf,
  withUnitFor,
  type NumberConvention,
  type NumberLanguage,
} from "./format";

/** Bentuk masukan `Register.emit`: tuple Python `(value, dec, unit, mark, source)` atau objek. */
export type RegisterEmitInput =
  | readonly [unknown, unknown?, unknown?, unknown?, unknown?]
  | { v?: unknown; dec?: unknown; unit?: unknown; mark?: unknown; src?: unknown };

const GLYPHS = Object.values(PROVENANCE_GLYPHS);

function normalizeMark(key: string, mark: unknown): ProvenanceMark {
  let m: string | null = null;
  if (typeof mark === "string") {
    let s = mark;
    for (const g of GLYPHS) s = s.split(g).join("");
    s = s.trim().toUpperCase();
    m = s === "" ? null : s;
  } else if (mark !== null && mark !== undefined) {
    throw new BindDefect(`besaran "${key}" membawa tanda asal "${String(mark)}" yang tidak dikenal DATUM §8`, key);
  }
  if (m === null) {
    throw new BindDefect(`besaran "${key}" tanpa tanda asal. Angka penting tanpa tanda adalah cacat.`, key);
  }
  if (!(PROVENANCE_MARKS as readonly string[]).includes(m)) {
    throw new BindDefect(`besaran "${key}" membawa tanda asal "${m}" yang tidak dikenal DATUM §8`, key);
  }
  return m as ProvenanceMark;
}

/** Validasi dan normalisasi satu entri; melempar BindDefect pada cacat. */
export function normalizeRegisterEntry(key: string, raw: RegisterEmitInput | RegisterEntry): RegisterEntry {
  let v: unknown, dec: unknown, unit: unknown, mark: unknown, src: unknown;
  if (Array.isArray(raw)) {
    [v, dec, unit, mark, src] = raw as readonly unknown[];
  } else if (raw && typeof raw === "object") {
    ({ v, dec, unit, mark, src } = raw as { v?: unknown; dec?: unknown; unit?: unknown; mark?: unknown; src?: unknown });
  } else {
    throw new BindDefect(`besaran "${key}" bukan entri register yang sah.`, key);
  }
  const normMark = normalizeMark(key, mark);
  if (typeof unit !== "string" || unit.trim() === "") {
    throw new BindDefect(
      `besaran "${key}" tanpa satuan. Nilai penting tanpa satuan adalah cacat (DATUM-09 rev B): ` +
        `daftarkan satuannya, mis. "poin bobot", "%", "rasio".`,
      key,
    );
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new BindDefect(`besaran "${key}" bernilai "${String(v)}", bukan bilangan hingga.`, key);
  }
  const d = dec === undefined || dec === null || dec === 0 ? 0 : dec;
  if (d !== 0 && d !== 1 && d !== 2 && d !== 3) {
    throw new BindDefect(`besaran "${key}" membawa dec "${String(dec)}"; kontrak hanya menerima 0..3.`, key);
  }
  if (src !== undefined && src !== null && typeof src !== "string") {
    throw new BindDefect(`besaran "${key}" membawa sumber yang bukan teks.`, key);
  }
  return { v, dec: d, unit, mark: normMark, src: typeof src === "string" ? src : "" };
}

function firstWord(s: string): string | undefined {
  const parts = s.trim().split(/\s+/);
  return parts[0] === "" ? undefined : parts[0];
}

/** Register tunggal setiap angka beban keputusan dalam satu set dokumen. */
export class Register implements RegisterApi {
  private readonly d: Readonly<Record<string, Readonly<RegisterEntry>>>;
  private readonly usedKeys = new Set<string>();
  /** Bahasa konvensi angka (bawaan ID). */
  readonly language: NumberLanguage;
  private readonly conv: NumberConvention;

  constructor(entries: Readonly<Record<string, RegisterEntry>>, language: NumberLanguage = DEFAULT_NUMBER_LANGUAGE) {
    this.conv = numberConvention(language);
    this.language = language;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new BindDefect("register harus berupa objek {nama: entri}.");
    }
    const out: Record<string, Readonly<RegisterEntry>> = {};
    for (const [k, e] of Object.entries(entries)) {
      out[k] = Object.freeze(normalizeRegisterEntry(k, e));
    }
    this.d = Object.freeze(out);
  }

  /**
   * Port `Register.emit` tanpa I/O berkas: validasi semua entri dan kembalikan
   * peta ternormalisasi (penyimpanan milik layanan pemanggil).
   */
  static emit(entries: Readonly<Record<string, RegisterEmitInput>>): Record<string, RegisterEntry> {
    const out: Record<string, RegisterEntry> = {};
    for (const [k, t] of Object.entries(entries)) out[k] = normalizeRegisterEntry(k, t);
    return out;
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.d, key);
  }

  /** Melempar BindDefect bila kunci tidak terdaftar; menandai kunci terpakai. */
  get(key: string): RegisterEntry {
    if (!this.has(key)) {
      const fw = firstWord(key);
      const near = Object.keys(this.d)
        .filter((x) => firstWord(x) === fw)
        .slice(0, 4);
      throw new BindDefect(
        `besaran "${key}" tidak terdaftar pada register. Daftarkan pada rantai perhitungan, jangan diketik.` +
          (near.length ? ` Mirip: ${near.join(", ")}` : ""),
        key,
      );
    }
    this.usedKeys.add(key);
    return this.d[key];
  }

  keys(): readonly string[] {
    return Object.keys(this.d);
  }

  /** Python `n()`: nilai terformat dengan `dec` entri atau override. */
  format(key: string, dec?: number): string {
    const e = this.get(key);
    return formatWith(e.v, dec ?? e.dec, this.conv);
  }

  value(key: string): number {
    return this.get(key).v;
  }

  mark(key: string): ProvenanceMark {
    return this.get(key).mark;
  }

  src(key: string): string {
    return this.get(key).src || "";
  }

  /** Nilai dan satuan dipisah spasi (DATUM §10); mata uang mendahului. */
  u(key: string, dec?: number): string {
    const e = this.get(key);
    return withUnitFor(formatWith(e.v, dec ?? e.dec, this.conv), e.unit, this.conv);
  }

  /** Rupiah mendahului nilai; satuannya dari tabel konvensi (ID "Rp", EN "IDR"). */
  rp(key: string): string {
    const e = this.get(key);
    return this.conv.currencyUnit + " " + formatWith(e.v, e.dec, this.conv);
  }

  pct(key: string, dec = 2): string {
    return formatWith(this.get(key).v, dec, this.conv) + " %";
  }

  /** Kunci terdaftar yang belum pernah dirujuk lewat get(). */
  unused(): string[] {
    return Object.keys(this.d)
      .filter((k) => !this.usedKeys.has(k))
      .sort();
  }

  /** Salinan nilai per kunci untuk evaluasi ekspresi (tidak menandai kunci terpakai). */
  values(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, e] of Object.entries(this.d)) out[k] = e.v;
    return out;
  }

  /**
   * Bentuk tercetak yang diakui audit (Python `_known`): setiap nilai pada
   * dec 0..3 plus pembulatan bulat. LIMIT E-12 dipertahankan: berhenti di 3.
   * `fmt(round(v), 0)` Python identik dengan `fmt(v, 0)` (keduanya half-even
   * eksak) sehingga tidak ditambahkan terpisah.
   */
  knownForms(): Set<string> {
    const out = new Set<string>();
    for (const e of Object.values(this.d)) {
      for (let dec = 0; dec < 4; dec++) out.add(formatWith(e.v, dec, this.conv));
    }
    return out;
  }
}

/** Bentuk minimum snapshot yang dibaca `registerForSnapshot` (v1 dan v2). */
export interface RegisterSource {
  register?: Readonly<Record<string, RegisterEntry>> | null;
  doc: { meta?: { language?: unknown } | null };
}

/**
 * Register satu snapshot dokumen dengan konvensi angka bahasa dokumen
 * (`doc.meta.language`, resolusi sama dengan renderer). Satu pabrik untuk
 * titik konstruksi render/pratinjau (S18, research/33 D-07).
 */
export function registerForSnapshot(snapshot: RegisterSource): Register {
  return new Register(snapshot.register ?? {}, numberLanguageOf(snapshot.doc.meta?.language));
}
