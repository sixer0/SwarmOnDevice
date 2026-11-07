/**
 * Blok turunan yang aritmetikanya DIPERIKSA terhadap register (port
 * `Derivation` datumbind.py). `result()` menghitung ekspresi lewat parser
 * aman (`evalArith`) dan menolak membangun bila hasilnya tidak cocok dengan
 * besaran kesimpulan bernama.
 *
 * Selain baris mono Python (`lines`, lebar uraian 54, nilai rata kanan 18),
 * kelas ini menyimpan baris terstruktur (`rows`) agar renderer DOCX/HTML
 * (`render.derivation.renderer` monoLines | nestedTable) tidak mengurai ulang.
 */
import type { DerivationBlock, Inline, ProvenanceMark } from "../../contract";
import { evalArith } from "./arith";
import { BindDefect } from "./defect";
import { DEFAULT_NUMBER_LANGUAGE, fmt, withUnit, type NumberLanguage } from "./format";
import { Register } from "./register";
import { APPARATUS_TEXT } from "../front/texts";
import type { RegisterApi } from "../../contract";

/** Toleransi bawaan Python `Derivation.result(tol=0.51)`. */
export const DERIVATION_DEFAULT_TOL = 0.51;
/** Lebar kolom uraian bawaan Python (`width=54`). */
export const DERIVATION_DEFAULT_WIDTH = 54;
/** Lebar kolom nilai Python (`{s:>18s}`). */
export const DERIVATION_VALUE_WIDTH = 18;

export interface DerivationRow {
  kind: "text" | "line" | "result" | "verdict";
  label: string;
  /** Nilai terformat (dengan satuan bila diminta). */
  value?: string;
  key?: string;
  mark?: ProvenanceMark;
  expr?: string;
  /** Hanya `verdict`: label vonis dan lulus/tidak. */
  tag?: string;
  pass?: boolean;
  /** Baris mono padanan Python. */
  mono: string;
}

export interface DerivationBuild {
  id: string;
  title: string;
  label: string;
  lines: string[];
  rows: DerivationRow[];
  note: string;
}

export interface ResultCheck {
  ok: boolean;
  got: number;
  want: number;
  diff: number;
  tol: number;
}

function padEndCp(s: string, w: number): string {
  const cps = Array.from(s).slice(0, w);
  return cps.join("") + " ".repeat(Math.max(0, w - cps.length));
}

function padStartCp(s: string, w: number): string {
  const n = Array.from(s).length;
  return " ".repeat(Math.max(0, w - n)) + s;
}

/** Python `f'{uraian:<{w}.{w}s}{s:>18s}'`. */
export function monoLine(label: string, value: string, width = DERIVATION_DEFAULT_WIDTH): string {
  return padEndCp(label, width) + padStartCp(value, DERIVATION_VALUE_WIDTH);
}

function registerValues(reg: RegisterApi): Record<string, number> {
  if (reg instanceof Register) return reg.values();
  const out: Record<string, number> = {};
  for (const k of reg.keys()) out[k] = reg.get(k).v;
  return out;
}

/**
 * Hitung `expr` atas nilai register dan bandingkan dengan besaran `key`.
 * Tidak melempar pada ketidakcocokan (lihat `ok`); melempar BindDefect bila
 * ekspresi tidak dapat dihitung atau `key` tidak terdaftar.
 */
export function checkResult(reg: RegisterApi, expr: string, key: string, tol = DERIVATION_DEFAULT_TOL): ResultCheck {
  const got = evalArith(expr, registerValues(reg));
  const want = reg.get(key).v;
  const diff = got - want;
  return { ok: !(Math.abs(diff) > tol), got, want, diff, tol };
}

export class Derivation {
  readonly id: string;
  readonly title: string;
  readonly width: number;
  readonly rows: DerivationRow[] = [];
  note?: string;
  /**
   * Bahasa konvensi angka baris tercetak (S17): bahasa `Register`, selain itu
   * `opts.language`, bawaan ID. Pesan cacat tetap berangka ID (teks operator
   * berbahasa Indonesia, sama dengan pesan lint D-11).
   */
  readonly language: NumberLanguage;
  private checked = false;

  constructor(
    id: string,
    title: string,
    private readonly register: RegisterApi,
    opts: { width?: number; note?: string; language?: NumberLanguage } = {},
  ) {
    this.id = id;
    this.title = title;
    this.width = opts.width ?? DERIVATION_DEFAULT_WIDTH;
    this.note = opts.note;
    this.language = register instanceof Register ? register.language : (opts.language ?? DEFAULT_NUMBER_LANGUAGE);
  }

  /** Label untuk pesan cacat: `<id> · <judul>` (renderer menyusun caption sendiri). */
  get label(): string {
    return this.title ? `${this.id} · ${this.title}` : this.id;
  }

  /** Baris mono (Python `d.lines`). */
  get lines(): string[] {
    return this.rows.map((r) => r.mono);
  }

  text(s: string): this {
    this.rows.push({ kind: "text", label: s, mono: s });
    return this;
  }

  /**
   * Baris nilai: dari register (`key`) atau nilai literal (`opts.value`, teks
   * apa adanya atau angka yang diformat DATUM).
   */
  line(
    uraian: string,
    key?: string | null,
    opts: { dec?: number; unit?: boolean; value?: string | number; mark?: ProvenanceMark } = {},
  ): this {
    const unit = opts.unit ?? true;
    let s: string;
    let mark = opts.mark;
    if (key !== undefined && key !== null) {
      const e = this.register.get(key);
      s = withUnit(fmt(e.v, opts.dec ?? e.dec, this.language), unit ? e.unit : null, this.language);
      mark = mark ?? e.mark;
    } else if (typeof opts.value === "string") {
      s = opts.value;
    } else if (typeof opts.value === "number") {
      s = fmt(opts.value, opts.dec ?? 0, this.language);
    } else {
      throw new BindDefect(`${this.label}: baris "${uraian}" tanpa kunci register maupun nilai.`);
    }
    this.rows.push({ kind: "line", label: uraian, value: s, key: key ?? undefined, mark, mono: monoLine(uraian, s, this.width) });
    return this;
  }

  /** `expr` = aritmetika atas nama register, mis. `nilai basis - nilai skenario`. */
  result(uraian: string, expr: string, key: string, opts: { dec?: number; tol?: number; unit?: boolean } = {}): this {
    let chk: ResultCheck;
    try {
      chk = checkResult(this.register, expr, key, opts.tol ?? DERIVATION_DEFAULT_TOL);
    } catch (ex) {
      if (ex instanceof BindDefect && ex.key === key) throw ex;
      throw new BindDefect(
        `${this.label}: ekspresi "${expr}" tidak dapat dihitung (${ex instanceof Error ? ex.message : String(ex)})`,
        key,
      );
    }
    if (!chk.ok) {
      throw new BindDefect(
        `${this.label}: aritmetika blok derivasi tidak cocok. "${expr}" menghasilkan ${fmt(chk.got, 2)} ` +
          `sedangkan besaran "${key}" bernilai ${fmt(chk.want, 2)}; selisih ${fmt(chk.diff, 2)}. ` +
          `Perbaiki modelnya atau perbaiki ekspresinya, jangan perbaiki tampilannya.`,
        key,
      );
    }
    const e = this.register.get(key);
    const s = withUnit(fmt(e.v, opts.dec ?? e.dec, this.language), (opts.unit ?? true) ? e.unit : null, this.language);
    this.rows.push({ kind: "result", label: uraian, value: s, key, mark: e.mark, expr, mono: monoLine(uraian, s, this.width) });
    this.checked = true;
    return this;
  }

  /**
   * Vonis batas. Python hanya `v <= limit`; `direction: "greaterOrEqual"`
   * mengikuti medan kontrak `DerivationBlock.verdict.direction`.
   */
  verdict(
    uraian: string,
    key: string,
    limit: number,
    opts: { ok?: string; bad?: string; dec?: number; direction?: "lessOrEqual" | "greaterOrEqual" } = {},
  ): this {
    const e = this.register.get(key);
    const s = withUnit(fmt(e.v, opts.dec ?? e.dec, this.language), e.unit, this.language);
    const pass = (opts.direction ?? "lessOrEqual") === "lessOrEqual" ? e.v <= limit : e.v >= limit;
    const tag = pass ? (opts.ok ?? APPARATUS_TEXT.verdictPass[this.language]) : (opts.bad ?? APPARATUS_TEXT.verdictFail[this.language]); // S13/F-2: tabel teks berbahasa
    this.rows.push({ kind: "verdict", label: uraian, value: s, key, mark: e.mark, tag, pass, mono: `${monoLine(uraian, s, this.width)}   ${tag}` });
    return this;
  }

  /** DATUM §8: setiap turunan ditutup dengan akibat bila asumsinya gagal. */
  closes(note: string): this {
    this.note = note;
    return this;
  }

  build(): DerivationBuild {
    if (!this.checked) {
      throw new BindDefect(`${this.label}: blok derivasi tanpa satu pun baris result(); aritmetikanya tidak pernah diuji.`);
    }
    if (!this.note) {
      throw new BindDefect(
        `${this.label}: blok derivasi tidak ditutup dengan pernyataan apa yang terjadi bila asumsinya gagal (DATUM §8).`,
      );
    }
    return { id: this.id, title: this.title, label: this.label, lines: this.lines, rows: [...this.rows], note: this.note };
  }
}

/** Teks polos `Inline` (text md-lite apa adanya atau gabungan run `t`). */
export function inlineText(x: Inline | undefined): string {
  if (!x) return "";
  if ("text" in x) return x.text;
  return x.runs.map((r) => ("t" in r ? r.t : "tab" in r ? "\t" : "br" in r ? "\n" : "")).join("");
}

/**
 * Bangun dan periksa blok `derivation` kontrak terhadap register. Melempar
 * BindDefect pada cacat pertama (kunci tak terdaftar, aritmetika tidak cocok,
 * tanpa `result`, tanpa `closing`). Dipakai ingest (by-construction), lint
 * struktur (turunan dihitung ulang), dan renderer.
 */
export function buildDerivationBlock(block: DerivationBlock, reg: RegisterApi, id?: string): DerivationBuild {
  const d = new Derivation(id ?? block.id ?? "", inlineText(block.title), reg);
  if (block.intro) d.text(inlineText(block.intro));
  for (const ln of block.lines) {
    const label = inlineText(ln.label);
    const v = ln.value;
    if (v && "registerKey" in v) d.line(label, v.registerKey, { dec: v.dec, mark: ln.mark });
    else d.line(label, null, { value: v ? inlineText(v) : "", mark: ln.mark });
  }
  if (block.result) {
    d.result(inlineText(block.result.label), block.result.expr, block.result.registerKey, { tol: block.result.tol });
  }
  if (block.verdict) {
    d.verdict(inlineText(block.verdict.label), block.verdict.registerKey, block.verdict.limit, {
      direction: block.verdict.direction,
    });
  }
  d.closes(inlineText(block.closing));
  return d.build();
}
