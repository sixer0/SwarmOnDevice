/**
 * services/adapt-v1 — run, inline, caption, sumber, rel (register §14.3 baris Run).
 *
 * Run v1 → `RunV2`:
 * - `b`/`i` → `strong`/`em`; `vertAlign` → `sup`/`sub`; `faceRole: "mono"` → `code`.
 * - `faceRole: "symbolGlyph"` dibuang (teks tetap; mesin mendeteksi ulang glif
 *   lewat `render.run.symbolGlyphs`, R-40) → `dropped.symbolGlyphRuns`.
 * - Run `field` (PAGE/NUMPAGES) dibuang seluruhnya → `dropped.fieldRuns`.
 * - `face`, `faceRole` lain, `szHalfPt`, `color`, `caps`, `smallCaps`,
 *   `spacingTw`, `u` dibuang (format inline R-38).
 *
 * Label aparatus (`source`/`keyRow`, RQ-10, D-145/D-216): v1 membawa label
 * "SUMBER  " / "KUNCI  " sebagai run pertama, sedangkan v2 membangkitkannya dari
 * jenis medan (compose `apparatusInline`). Run pertama yang teksnya persis label
 * medan itu dibuang (+ run pemisah berisi spasi saja) dan dihitung di
 * `stripped["source.labelRun"]` / `stripped["keyRow.labelRun"]`.
 */
import type {
  CaptionV2,
  Inline,
  RailLine,
  RailLineV2,
  Run,
  RunV2,
  SourceLine,
  SourceV2,
  InlineV2,
} from "@/lib/studio/contract";
import { FIGURE_LABELS } from "@/lib/studio/engine/docx/figures/defaults";
import { escapePointer, type AdaptRecorder } from "./report";

const RUN_TEXT_CONSUMED = ["t", "b", "i", "vertAlign"] as const;

type RunLike = Record<string, unknown>;

/** Run v1 → run v2, atau `null` bila run dibuang (field). */
export function adaptRun(run: Run, p: string, rec: AdaptRecorder): RunV2 | null {
  const r = run as unknown as RunLike;
  if (r.field !== undefined) {
    rec.drop("fieldRuns");
    return null;
  }
  const consumed: string[] = [];
  let out: RunV2;
  if (r.tab !== undefined) {
    out = { tab: true };
    consumed.push("tab");
  } else if (r.br !== undefined) {
    out = { br: "line" };
    consumed.push("br");
  } else {
    const t: { t: string; strong?: boolean; em?: boolean; code?: boolean; sup?: boolean; sub?: boolean } = { t: String(r.t ?? "") };
    consumed.push(...RUN_TEXT_CONSUMED);
    if (r.b !== undefined) {
      rec.rename("b->strong");
      if (r.b === true) t.strong = true;
    }
    if (r.i !== undefined) {
      rec.rename("i->em");
      if (r.i === true) t.em = true;
    }
    if (r.vertAlign === "superscript") {
      t.sup = true;
      rec.rename("vertAlign->sup");
    } else if (r.vertAlign === "subscript") {
      t.sub = true;
      rec.rename("vertAlign->sub");
    }
    if (r.faceRole === "mono") {
      t.code = true;
      consumed.push("faceRole");
      rec.rename("faceRole:mono->code");
    } else if (r.faceRole === "symbolGlyph") {
      consumed.push("faceRole");
      rec.drop("symbolGlyphRuns");
    }
    out = t;
  }
  rec.rest(r, consumed, p);
  return out;
}

export function adaptRuns(runs: readonly Run[], p: string, rec: AdaptRecorder): RunV2[] {
  const out: RunV2[] = [];
  runs.forEach((run, i) => {
    const v = adaptRun(run, `${p}/${i}`, rec);
    if (v) out.push(v);
  });
  return out;
}

/**
 * Bagian inline (`text` XOR `runs`) dari objek v1 apa pun. Mengembalikan kunci
 * yang dikonsumsi agar pemanggil dapat menghitung sisa medan.
 */
export function inlinePart(x: object, p: string, rec: AdaptRecorder): InlineV2 {
  const o = x as { text?: unknown; runs?: unknown };
  if (Array.isArray(o.runs)) return { runs: adaptRuns(o.runs as Run[], `${p}/runs`, rec) };
  return { text: typeof o.text === "string" ? o.text : "" };
}

export const INLINE_KEYS = ["text", "runs"] as const;

/** `Inline` v1 murni (wadah tanpa medan lain selain mungkin `format`). */
export function adaptInline(x: Inline, p: string, rec: AdaptRecorder): InlineV2 {
  const out = inlinePart(x, p, rec);
  rec.rest(x, INLINE_KEYS, p);
  return out;
}

export function adaptInlineOpt(x: Inline | undefined, p: string, rec: AdaptRecorder): InlineV2 | undefined {
  return x === undefined ? undefined : adaptInline(x, p, rec);
}

export function adaptInlineList(xs: readonly Inline[], p: string, rec: AdaptRecorder): InlineV2[] {
  return xs.map((x, i) => adaptInline(x, `${p}/${i}`, rec));
}

/** `Caption {label, separator, inline, labelProps, format}` → `CaptionV2` = inline (label milik mesin, DF-53). */
export function adaptCaption(c: { inline?: Inline } & object, p: string, rec: AdaptRecorder): CaptionV2 {
  rec.rename("caption.inline->inline");
  rec.rest(c, ["inline"], p);
  return c.inline ? adaptInline(c.inline, `${p}/inline`, rec) : { text: "" };
}

/** Medan aparatus yang labelnya dibangkitkan mesin di v2. */
export type ApparatusField = "source" | "keyRow";

const APPARATUS_LABEL_RE: Record<ApparatusField, RegExp> = {
  source: new RegExp(`^\\s*${FIGURE_LABELS.source}\\s*:?\\s*$`),
  keyRow: new RegExp(`^\\s*${FIGURE_LABELS.key}\\s*:?\\s*$`),
};

const WHITESPACE_ONLY = /^\s*$/;

/**
 * Buang run label aparatus di POSISI LABEL (run pertama) bila teksnya persis
 * label medan ("SUMBER"/"KUNCI" + spasi/titik dua), beserta run pemisah yang
 * hanya berisi spasi. Kata label di dalam teks konten, run label di posisi lain
 * (mis. "   PROVENANS " di tengah baris SUMBER, yang tidak dibangkitkan compose),
 * dan bentuk `text` tidak disentuh. Tidak membuang bila tidak ada konten tersisa.
 */
export function stripApparatusLabelRun(inline: InlineV2, field: ApparatusField, rec: AdaptRecorder): InlineV2 {
  if (!("runs" in inline)) return inline;
  const runs = inline.runs;
  const first = runs[0];
  if (!first || !("t" in first) || !APPARATUS_LABEL_RE[field].test(first.t)) return inline;
  let cut = 1;
  while (cut < runs.length && isWhitespaceTextRun(runs[cut])) cut++;
  if (cut >= runs.length) return inline;
  rec.strip(`${field}.labelRun`, "");
  return { ...inline, runs: runs.slice(cut) };
}

function isWhitespaceTextRun(r: RunV2): boolean {
  return "t" in r && WHITESPACE_ONLY.test(r.t);
}

/** `SourceLine {inline, provenance, format}` → `SourceV2` (run label "SUMBER" dibuang, RQ-10). */
export function adaptSource(s: SourceLine, p: string, rec: AdaptRecorder): SourceV2 {
  rec.rename("source.inline->inline");
  rec.rest(s, ["inline", "provenance"], p);
  const base = s.inline ? stripApparatusLabelRun(adaptInline(s.inline, `${p}/inline`, rec), "source", rec) : { text: "" };
  return s.provenance && s.provenance.length > 0 ? { ...base, provenance: [...s.provenance] } : base;
}

/** `keyRow` figur → `InlineV2` (run label "KUNCI" dibuang, RQ-10). */
export function adaptKeyRow(k: Inline | undefined, p: string, rec: AdaptRecorder): InlineV2 | undefined {
  const out = adaptInlineOpt(k, p, rec);
  return out === undefined ? undefined : stripApparatusLabelRun(out, "keyRow", rec);
}

/** `RailLine` → `RailLineV2` (`label`, `format` dibuang; DF-62). */
export function adaptRail(rail: readonly RailLine[], p: string, rec: AdaptRecorder): RailLineV2[] {
  return rail.map((r, i) => {
    const pi = `${p}/${i}`;
    rec.rest(r, ["kind", "mark", ...INLINE_KEYS], pi);
    const out: RailLineV2 = { kind: r.kind };
    if (r.mark !== undefined) out.mark = r.mark;
    if (Array.isArray(r.runs)) out.runs = adaptRuns(r.runs, `${pi}/runs`, rec);
    else if (typeof r.text === "string") out.text = r.text;
    return out;
  });
}

export function ptr(p: string, ...segs: Array<string | number>): string {
  return segs.reduce<string>((acc, s) => `${acc}/${escapePointer(s)}`, p);
}
