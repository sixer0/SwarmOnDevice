/**
 * Sembilan pemindai bahasa grup C yang definisinya ada di manual (D-34):
 * C-20, C-26b, C-26c, C-27, C-31, C-34, C-INFO-OPENER, C-SG-L2-09, C-SG-L2-04.
 * Ambang dibaca dari parameter (P11-11, P11-12, P11-13, P11-16, P11-25..P11-28,
 * P11-32; research/04 T119 Tabel 14.2, label DIAGNOSIS), tidak di-hardcode.
 * Konstanta di berkas ini hanya definisi aturan (bentuk sapaan terlarang,
 * glif provenans, cakupan INFO > 2.000 kalimat), masing-masing bersumber.
 *
 * Kanal (doc/etalase, K2 panjang) tidak tercatat di DocMeta, jadi metrik
 * diterapkan ke seluruh lapisan prosa dokumen; detail menyebut hal ini.
 */
import type { LintIssue } from "../../../contract";
import { PROVENANCE_GLYPHS, PROVENANCE_MARKS } from "../../../contract/enums";
import type { ParamMap } from "../../../contract";
import { fmtFixed, numberConvention } from "../../bind/format";
import { numberParam, rangeParam, stringParam } from "./params";
import type { Layers, TextUnit } from "./prose";
import { countSemicolons, countSentenceCommas, countWords, opener, splitSentences, wholeWordRe } from "./tokenize";

export interface ScanContext {
  layers: Layers;
  params: ParamMap;
  language: "ID" | "EN";
  /** Kalimat prosa beserta unit asalnya (dihitung sekali). */
  sentences: ReadonlyArray<{ text: string; unit: TextUnit }>;
  /** Total kata lapisan prosa. */
  proseWords: number;
}

export type Scanner = (ctx: ScanContext) => LintIssue[];

/** Plafon jumlah isu per blok untuk satu pemeriksaan; sisanya diringkas. */
const MAX_BLOCK_ISSUES = 50;
/** Plafon alamat contoh di detail pemeriksaan agregat. */
const MAX_EXAMPLES = 5;
/** Kalimat berantai = kalimat dengan >= 4 koma (Tabel 14.2 baris 2; registri C-26b). */
const CHAINED_MIN_COMMAS = 4;
/** C-INFO-OPENER berlaku pada dokumen > 2.000 kalimat (Tabel 14.2 baris 5; P11-28 classNote). */
const INFO_OPENER_MIN_SENTENCES = 2000;
/** Bentuk sapaan terlarang (SG-L5-08 L3471-3473; P11-13/P11-14 classNote: bukan "Kepada Yth.", Halo, Hai). */
const FORBIDDEN_SALUTATIONS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "Kepada Yth.", re: /(?<![\p{L}\p{N}])kepada\s+yth(?![\p{L}\p{N}])/iu },
  { label: "Halo", re: /^\s*halo(?![\p{L}\p{N}])/iu },
  { label: "Hai", re: /^\s*hai(?![\p{L}\p{N}])/iu },
];
/** Rujukan pembaca terlarang (SG-L5-08, R-17; P11-16 classNote: bukan kamu). */
const FORBIDDEN_READER_WORDS: readonly string[] = ["kamu"];
const DIAG = "DIAGNOSIS; kanal tidak tercatat di meta, diterapkan ke seluruh prosa";

/** Angka pesan lint: semantik toFixed (bukan half-even), desimal entri ID tabel konvensi. */
export function fmt(n: number, digits = 2): string {
  return fmtFixed(n, digits, numberConvention("ID"));
}

function where(u: { address?: string; blockId: string }): string {
  return u.address ?? `blok ${u.blockId}`;
}

function examples(units: ReadonlyArray<{ address?: string; blockId: string }>): string {
  const seen: string[] = [];
  for (const u of units) {
    const w = where(u);
    if (!seen.includes(w)) seen.push(w);
    if (seen.length === MAX_EXAMPLES) break;
  }
  return seen.length ? `; contoh: ${seen.join(", ")}` : "";
}

/** Isu per blok, dibatasi MAX_BLOCK_ISSUES; selalu satu PASS bila bersih. */
function perBlock(
  checkId: string,
  hits: ReadonlyArray<{ unit: { address?: string; blockId: string }; detail: string }>,
  passDetail: string,
): LintIssue[] {
  if (hits.length === 0) return [{ checkId, status: "PASS", detail: passDetail }];
  const out: LintIssue[] = hits.slice(0, MAX_BLOCK_ISSUES).map((h) => ({
    checkId,
    status: "FAIL",
    detail: h.detail,
    ...(h.unit.address ? { address: h.unit.address } : {}),
  }));
  if (hits.length > MAX_BLOCK_ISSUES) {
    out.push({ checkId, status: "FAIL", detail: `dan ${hits.length - MAX_BLOCK_ISSUES} temuan lain tidak dirinci` });
  }
  return out;
}

function noSentences(checkId: string): LintIssue[] {
  return [{ checkId, status: "PASS", detail: "tidak ada kalimat prosa untuk diukur" }];
}

// ── C-20 Sapaan institusional ──────────────────────────────────────────────

const c20: Scanner = (ctx) => {
  const expected = stringParam(ctx.params, "letter.salutation.address");
  const opening = stringParam(ctx.params, "letter.salutation.opening");
  const hits: Array<{ unit: TextUnit; detail: string }> = [];
  for (const u of ctx.layers.narrative) {
    const bad = FORBIDDEN_SALUTATIONS.find((f) => f.re.test(u.text));
    if (bad) {
      hits.push({
        unit: u,
        detail: `sapaan "${bad.label}" tidak baku; pakai "${expected}" dan pembuka "${opening}" (letter.salutation.address, letter.salutation.opening)`,
      });
    }
  }
  return perBlock("C-20", hits, `${ctx.layers.narrative.length} paragraf naratif tanpa sapaan tidak baku`);
};

// ── C-34 Kamu dan Yth. ─────────────────────────────────────────────────────

const c34: Scanner = (ctx) => {
  const readers = stringParam(ctx.params, "letter.readerReference")
    .split(/,|\/|\s+dan\s+/u)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w !== "");
  const forbidden = FORBIDDEN_READER_WORDS.map((w) => ({ w, re: wholeWordRe(w, "iu") }));
  const yth = /(?<![\p{L}\p{N}])yth\.?\s+([\p{L}]+)/giu;
  const hits: Array<{ unit: TextUnit; detail: string }> = [];
  for (const u of ctx.layers.narrative) {
    const found = forbidden.filter((f) => f.re.test(u.text)).map((f) => f.w);
    if (found.length) {
      hits.push({ unit: u, detail: `rujukan pembaca "${found.join('", "')}" dilarang; pakai ${readers.join("/")} (letter.readerReference)` });
    }
    for (const m of u.text.matchAll(yth)) {
      if (!readers.includes(m[1].toLowerCase())) {
        hits.push({ unit: u, detail: `"Yth. ${m[1]}" tidak diikuti ${readers.join("/")} + jabatan (letter.readerReference)` });
      }
    }
  }
  return perBlock("C-34", hits, `${ctx.layers.narrative.length} paragraf naratif tanpa kamu; sapaan Yth. sesuai`);
};

// ── C-26b Kalimat berantai ─────────────────────────────────────────────────

const c26b: Scanner = (ctx) => {
  const key = "threshold.chainedSentencesPercent.max";
  const max = numberParam(ctx.params, key);
  const n = ctx.sentences.length;
  if (n === 0) return noSentences("C-26b");
  const chained = ctx.sentences.filter((s) => countSentenceCommas(s.text) >= CHAINED_MIN_COMMAS);
  const pct = (chained.length / n) * 100;
  const fail = pct > max;
  return [
    {
      checkId: "C-26b",
      status: fail ? "FAIL" : "PASS",
      detail: `${chained.length} dari ${n} kalimat (${fmt(pct, 1)} %) memuat >= ${CHAINED_MIN_COMMAS} koma; plafon ${fmt(max, 1)} % (${key}; ${DIAG})${fail ? examples(chained.map((s) => s.unit)) : ""}`,
    },
  ];
};

// ── C-26c Titik-koma per 1.000 kata ───────────────────────────────────────

const c26c: Scanner = (ctx) => {
  const key = "threshold.semicolonsPer1000Words.max";
  const max = numberParam(ctx.params, key);
  if (ctx.proseWords === 0) return noSentences("C-26c");
  const units = ctx.layers.prose.filter((u) => countSemicolons(u.text) > 0);
  const count = units.reduce((a, u) => a + countSemicolons(u.text), 0);
  const rate = (count / ctx.proseWords) * 1000;
  const fail = rate > max;
  return [
    {
      checkId: "C-26c",
      status: fail ? "FAIL" : "PASS",
      detail: `${count} titik-koma dalam ${ctx.proseWords} kata = ${fmt(rate)} per 1.000 kata; plafon ${fmt(max)} (${key}; ${DIAG})${fail ? examples(units) : ""}`,
    },
  ];
};

// ── C-27 Kata per kalimat ──────────────────────────────────────────────────

const c27: Scanner = (ctx) => {
  const key = "threshold.wordsPerSentenceAvg";
  const [lo, hi] = rangeParam(ctx.params, key);
  const n = ctx.sentences.length;
  if (n === 0) return noSentences("C-27");
  const total = ctx.sentences.reduce((a, s) => a + countWords(s.text), 0);
  const avg = total / n;
  const fail = avg < lo || avg > hi;
  return [
    {
      checkId: "C-27",
      status: fail ? "FAIL" : "PASS",
      detail: `rata-rata ${fmt(avg, 1)} kata per kalimat (${total} kata, ${n} kalimat); koridor ${lo}-${hi} (${key}; ${DIAG})`,
    },
  ];
};

// ── C-31 Densitas tanda provenans sebaris ─────────────────────────────────

const GLYPHS = Object.values(PROVENANCE_GLYPHS);
const MARK_WORD_RES = PROVENANCE_MARKS.map((m) => wholeWordRe(m, "gu"));

function countMarks(text: string): number {
  let n = 0;
  for (const ch of text) if (GLYPHS.includes(ch)) n += 1;
  for (const re of MARK_WORD_RES) n += (text.match(re) ?? []).length;
  return n;
}

const c31: Scanner = (ctx) => {
  const key = "threshold.inlineProvenanceMarks.max";
  const max = numberParam(ctx.params, key);
  if (ctx.proseWords === 0) return noSentences("C-31");
  const units = ctx.layers.prose.filter((u) => countMarks(u.text) > 0);
  const marks = units.reduce((a, u) => a + countMarks(u.text), 0);
  const ratio = marks / ctx.proseWords;
  const fail = ratio > max;
  return [
    {
      checkId: "C-31",
      status: fail ? "FAIL" : "PASS",
      detail: `${marks} tanda provenans sebaris (glif ${GLYPHS.join(" ")} atau label kapital) dalam ${ctx.proseWords} kata = ${fmt(ratio, 3)} per kata; plafon ${fmt(max, 3)} (${key}; DIAGNOSIS)${fail ? examples(units) : ""}`,
    },
  ];
};

// ── C-INFO-OPENER Rasio pembuka kalimat berbeda (INFO) ────────────────────

const cInfoOpener: Scanner = (ctx) => {
  const key = "threshold.distinctOpenerRatio.min";
  const min = numberParam(ctx.params, key);
  const n = ctx.sentences.length;
  if (n <= INFO_OPENER_MIN_SENTENCES) {
    return [{ checkId: "C-INFO-OPENER", status: "REPORT", detail: `tidak berlaku: ${n} kalimat (berlaku > ${INFO_OPENER_MIN_SENTENCES})` }];
  }
  const distinct = new Set(ctx.sentences.map((s) => opener(s.text)).filter((w) => w !== "")).size;
  const ratio = distinct / n;
  return [
    {
      checkId: "C-INFO-OPENER",
      status: "REPORT",
      detail: `${distinct} pembuka berbeda dari ${n} kalimat = ${fmt(ratio, 3)}; lantai ${fmt(min, 2)} (${key}) ${ratio < min ? "TERLEWATI, variasikan pembuka" : "terpenuhi"}; INFO`,
    },
  ];
};

// ── C-SG-L2-09 Cacah kata per paragraf ────────────────────────────────────

const cL209: Scanner = (ctx) => {
  const key = "paragraph.maxWords";
  const max = numberParam(ctx.params, key);
  const hits = ctx.layers.prose
    .map((u) => ({ u, n: countWords(u.text) }))
    .filter((x) => x.n > max)
    .map((x) => ({ unit: x.u, detail: `paragraf ${x.n} kata; plafon ${max} (${key})` }));
  return perBlock("C-SG-L2-09", hits, `${ctx.layers.prose.length} paragraf prosa <= ${max} kata`);
};

// ── C-SG-L2-04 Butir bernomor bila lebih dari 3 ───────────────────────────

const cL204: Scanner = (ctx) => {
  const key = "list.numberedWhenItemsGreaterThan";
  const n = numberParam(ctx.params, key);
  const hits = ctx.layers.lists
    .filter((l) => l.style !== "number" && l.items > n)
    .map((l) => ({ unit: l, detail: `daftar ${l.items} butir bergaya "${l.style}"; lebih dari ${n} butir wajib bernomor (${key})` }));
  return perBlock("C-SG-L2-04", hits, `${ctx.layers.lists.length} daftar sesuai`);
};

/** Pemindai per checkId; kunci = butir C terimplementasi di registri (D-34). */
export const LANGUAGE_SCANNERS: Readonly<Record<string, Scanner>> = {
  "C-20": c20,
  "C-26b": c26b,
  "C-26c": c26c,
  "C-27": c27,
  "C-31": c31,
  "C-34": c34,
  "C-INFO-OPENER": cInfoOpener,
  "C-SG-L2-09": cL209,
  "C-SG-L2-04": cL204,
};

/** Butir yang leksikonnya khusus bahasa Indonesia (tidak dijalankan pada meta.language EN). */
export const ID_ONLY_CHECKS: ReadonlySet<string> = new Set(["C-20", "C-34"]);

export function buildContext(layers: Layers, params: ParamMap, language: "ID" | "EN"): ScanContext {
  const sentences = layers.prose.flatMap((unit) => splitSentences(unit.text).map((text) => ({ text, unit })));
  const proseWords = layers.prose.reduce((a, u) => a + countWords(u.text), 0);
  return { layers, params, language, sentences, proseWords };
}
