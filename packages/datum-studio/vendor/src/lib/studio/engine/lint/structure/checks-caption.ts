/**
 * Swarm 1.3.3 row 86 (ST-12; register 03 s7): `D23`, a warning when a number or a name in a figure caption is not
 * found in the figure, its key, or the table block directly below it (the companion-table pattern).
 *
 * Precision before recall: only claims that can be checked mechanically are read, and every doubt resolves to
 * "found". Claim grammar (implementation/86_st12_caption_evidence.md):
 *   - number: digits with Indonesian or English decimal and thousands separators ("1 000", "22,06", "40.8", "3,5"),
 *     a following unit or percent sign is not part of the match; digits that belong to a code ("SW-01", "L2",
 *     "SHA-256") are a code, not a number; "ke-27" is the number 27. A number is found when one of its readings
 *     (decimal comma or thousands dot, and the reverse) equals a number in the figure text or a numeric data value.
 *   - count: a number (digits, or the Indonesian words satu..dua puluh) followed by a mapped element word
 *     (tugas, milestone, zona, wadah, lajur, fase, kolam and English forms) is satisfied by counting those
 *     elements; when the figure has none of that kind, by the number or the phrase appearing literally, and "satu"
 *     (one, also an article) by the element word appearing in the figure text. Nodes are NOT counted: a caption
 *     qualifies them ("empat node GPU" in a rack of five nodes), so "N simpul" is an ordinary number claim.
 *   - name: a code (letters and digits mixed, or joined by a hyphen: "SW-01", "A1", "FIDO2", "SHA-256"), an acronym
 *     (two or more capitals: "UPS", "BSrE") or a capitalised word that does not open the sentence ("Discern").
 *     Units after a number ("GB", "kW") and the figure or table number are not claims. A name is found when it
 *     appears as a whole token (case-insensitive) in the figure text or the table below.
 * Figure text: printed strings of the spec (node and edge labels, sub lines, tags, notes, key rows and legend,
 * container labels, chart categories, series names, axis titles, units) plus numeric data values, and the block's
 * key row. The caption itself, the spec title (a copy of the caption) and source lines are never evidence.
 * Scope: inline `diagram` and `chart` specs. A block that refers to an artefact has no spec here and is not read;
 * image and symbol-sheet blocks are not read (no text to prove against).
 */
import { findings, type CheckOutcome, type Finding, type StructCtx } from "./context";
import { isTableType, tableText, textOf, type WalkItem } from "./walk";
import type { TableBlock } from "../../../contract";

export const CAPTION_EVIDENCE_ID = "D23";

// ── Normalisation ──────────────────────────────────────────────────────────

const SPACE_IN_NUMBER = "[ \\u00a0\\u2009\\u202f]";
function norm(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-")
    .replace(/[   ]/g, " ")
    .toLowerCase();
}

// ── Numbers ────────────────────────────────────────────────────────────────

/** Grouped by spaces ("1 000", "50 000,5") or a plain run with separators ("22,06", "1.000", "40.8"). */
const NUMBER_RE = new RegExp(`\\d{1,3}(?:${SPACE_IN_NUMBER}\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)*`, "gu");

/** Every reading of a written number: decimal comma or decimal point, dot or comma as thousands separator. */
export function numberReadings(raw: string): number[] {
  const s = raw.replace(new RegExp(SPACE_IN_NUMBER, "g"), "");
  const out = new Set<number>();
  const seps = s.match(/[.,]/g) ?? [];
  if (seps.length === 0) out.add(Number(s));
  else {
    for (const [dec, thou] of [
      [",", "."],
      [".", ","],
    ] as const) {
      const parts = s.split(dec);
      if (parts.length > 2) continue;
      const intPart = parts[0];
      const groups = intPart.split(thou);
      if (groups.length > 1 && !groups.slice(1).every((g) => g.length === 3)) continue;
      const v = Number(groups.join("") + (parts.length === 2 ? "." + parts[1] : ""));
      if (Number.isFinite(v)) out.add(v);
    }
    // thousands only, no decimal part ("1.000" / "1,000")
    for (const thou of [".", ","]) {
      const g = s.split(thou);
      if (g.length > 1 && !s.includes(thou === "." ? "," : ".") && g.slice(1).every((x) => x.length === 3)) out.add(Number(g.join("")));
    }
  }
  return [...out].filter((v) => Number.isFinite(v));
}

const isLetter = (c: string | undefined): boolean => c !== undefined && /[\p{L}]/u.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && /\d/.test(c);

interface NumberHit {
  raw: string;
  start: number;
  end: number;
  values: number[];
}

/** Numbers of a text that stand alone (not inside a code such as "SW-01", "L2", "25G", "SHA-256"). */
export function standaloneNumbers(text: string): NumberHit[] {
  const out: NumberHit[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const start = m.index ?? 0;
    let raw = m[0];
    // a trailing separator is punctuation ("10." at a sentence end, "3, 4")
    raw = raw.replace(/[.,]+$/, "");
    const end = start + raw.length;
    const prev = text[start - 1];
    const next = text[end];
    if (isLetter(prev) || isDigit(prev)) continue;
    if (prev === "-" || prev === "+" || prev === "/" || prev === "_") {
      // "ke-27" is an ordinal (Indonesian), every other joined form is a code ("C-10", "0+900", "Gb/s")
      if (!(prev === "-" && /(^|[^\p{L}])ke$/iu.test(text.slice(Math.max(0, start - 4), start - 1)))) continue;
    }
    if (isLetter(next) && !/^\p{L}{2,}/u.test(text.slice(end))) continue; // "25G", "4x" (unit glued as one letter or code)
    if (next === "-" && isLetter(text[end + 1])) continue; // "2-way"? leave to the name rule
    if (next === "x" || next === "×") continue;
    out.push({ raw, start, end, values: numberReadings(raw) });
  }
  return out;
}

// ── Counts ─────────────────────────────────────────────────────────────────

export type CountKind = "task" | "milestone" | "zone" | "container" | "lane" | "phase" | "pool";

/** Element words whose count can be taken from a spec without interpretation (implementation/86, section 3). */
export const COUNT_WORDS: Readonly<Record<string, CountKind>> = {
  tugas: "task",
  task: "task",
  tasks: "task",
  milestone: "milestone",
  milestones: "milestone",
  tonggak: "milestone",
  zona: "zone",
  zone: "zone",
  zones: "zone",
  wadah: "container",
  container: "container",
  containers: "container",
  lajur: "lane",
  lane: "lane",
  lanes: "lane",
  fase: "phase",
  phase: "phase",
  phases: "phase",
  kolam: "pool",
  pool: "pool",
  pools: "pool",
};

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  satu: 1,
  dua: 2,
  tiga: 3,
  empat: 4,
  lima: 5,
  enam: 6,
  tujuh: 7,
  delapan: 8,
  sembilan: 9,
  sepuluh: 10,
  sebelas: 11,
  "dua belas": 12,
  "tiga belas": 13,
  "empat belas": 14,
  "lima belas": 15,
  "enam belas": 16,
  "tujuh belas": 17,
  "delapan belas": 18,
  "sembilan belas": 19,
  "dua puluh": 20,
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Count of one element kind in a spec, or undefined when the spec has no such kind at all. */
export function countOf(spec: unknown, kind: CountKind): number | undefined {
  if (!isObj(spec)) return undefined;
  const data = isObj(spec.data) ? spec.data : undefined;
  const items = data && data.shape === "intervals" ? arr(data.items).filter(isObj) : [];
  const lanes = new Set(arr(spec.nodes).filter(isObj).map((n) => n.lane).filter((l): l is string => typeof l === "string"));
  const n = (v: number): number | undefined => (v > 0 ? v : undefined);
  switch (kind) {
    case "task":
      return n(items.filter((i) => i.milestone !== true).length);
    case "milestone":
      return n(items.filter((i) => i.milestone === true).length);
    case "zone":
      return n(arr(spec.zones).length);
    case "lane":
      return n(lanes.size);
    case "phase":
      return n(arr(spec.phases).length);
    case "pool":
      return n(arr(spec.pools).length);
    case "container":
      return n(arr(spec.zones).length + arr(spec.phases).length + arr(spec.pools).length + lanes.size);
  }
}

// ── Figure text ────────────────────────────────────────────────────────────

/** Spec keys whose strings are not printed text (ids, references, enums, metadata) or are not evidence. */
const NOT_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  "$schema", "id", "from", "to", "members", "family", "classification", "shape", "kind", "mark", "event_type", "dash",
  "weight", "route", "arrow_start", "arrow_end", "arrow_start_size", "arrow_end_size", "label_at", "direction",
  "lane_orientation", "jumps", "style", "apparatus", "from_side", "to_side", "from_slot", "to_slot", "title", "source",
  "sources", "caption", "x", "ref", "accent", "type", "code", "riwayat", "params", "stacked", "inDocument",
]);
/** Numeric keys that are layout, not printed values. */
const LAYOUT_NUMBER_KEYS: ReadonlySet<string> = new Set([
  "widthMm", "heightMm", "width_mm", "height_mm", "dec", "col", "row", "tier", "per_row", "u", "span", "order",
]);

export interface FigureEvidence {
  /** Normalised printed text, one string. */
  text: string;
  /** Numeric data values (values, starts, ends, floats, status) of the spec. */
  values: number[];
}

export function figureEvidence(spec: unknown, extraTexts: readonly string[] = []): FigureEvidence {
  const texts: string[] = [...extraTexts];
  const values: number[] = [];
  const walk = (v: unknown, key: string, depth: number): void => {
    if (depth > 12 || NOT_EVIDENCE_KEYS.has(key)) return;
    if (typeof v === "string") texts.push(v);
    else if (typeof v === "number") {
      if (!LAYOUT_NUMBER_KEYS.has(key) && Number.isFinite(v)) values.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key, depth + 1));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  if (isObj(spec)) for (const [k, x] of Object.entries(spec)) walk(x, k, 0);
  const text = norm(texts.join("\n"));
  for (const h of standaloneNumbers(text)) values.push(...h.values);
  return { text, values };
}

// ── Claims ─────────────────────────────────────────────────────────────────

export type CaptionClaim =
  | { kind: "number"; text: string; values: number[] }
  | { kind: "count"; text: string; n: number; element: CountKind; values: number[] }
  | { kind: "name"; text: string };

/** Words never read as a name: figure apparatus and the figure number words. */
const NOT_NAMES: ReadonlySet<string> = new Set(["gambar", "tabel", "figure", "table", "bab", "lampiran", "sumber", "kunci", "key"]);
/** Units written in capitals that follow a number ("600 GB", "10 000 EPS"): never names when after a number. */
const UNIT_AFTER_NUMBER = /^[    ]?(?:[%‰°]|[\p{L}µ][\p{L}\d/²³·]*)/u;

/** Spans of the figure or table number ("Gambar 1.2", "Tabel 21.2") and of their numbers. */
function apparatusSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(/\b(?:Gambar|Tabel|Figure|Table|Bab|Lampiran)\s+[A-Z]?\d+(?:\.\d+)*/giu)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/** The checkable claims of a caption, in reading order, without duplicates. */
export function captionClaims(caption: string): CaptionClaim[] {
  const text = caption.normalize("NFKC").replace(/[‐-―−]/g, "-");
  const skip = apparatusSpans(text);
  const inSkip = (i: number): boolean => skip.some(([a, b]) => i >= a && i < b);
  const out: CaptionClaim[] = [];
  const seen = new Set<string>();
  const push = (c: CaptionClaim): void => {
    const k = `${c.kind}:${norm(c.text)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  const unitSpans: Array<[number, number]> = [];

  // numbers and digit counts
  for (const h of standaloneNumbers(text)) {
    if (inSkip(h.start)) continue;
    const after = text.slice(h.end);
    const unit = after.match(UNIT_AFTER_NUMBER);
    if (unit) unitSpans.push([h.end, h.end + unit[0].length]);
    const word = after.match(/^[  ]+(\p{L}+)/u)?.[1]?.toLowerCase();
    const element = word ? COUNT_WORDS[word] : undefined;
    if (element && h.values.length === 1 && Number.isInteger(h.values[0])) {
      push({ kind: "count", text: `${h.raw} ${word}`, n: h.values[0], element, values: h.values });
    } else push({ kind: "number", text: h.raw + (after.match(/^ ?%/)?.[0] ?? ""), values: h.values });
  }
  // word counts with a mapped element word only ("tujuh zona", "lima belas tugas")
  const wordAlt = Object.keys(NUMBER_WORDS)
    .sort((a, b) => b.length - a.length)
    .join("|");
  for (const m of text.matchAll(new RegExp(`(?<![\\p{L}])(${wordAlt})[ \\u00a0]+(\\p{L}+)`, "giu"))) {
    const element = COUNT_WORDS[m[2].toLowerCase()];
    if (!element) continue;
    const n = NUMBER_WORDS[m[1].toLowerCase()];
    push({ kind: "count", text: `${m[1]} ${m[2]}`, n, element, values: [n] });
  }
  // names: codes, acronyms, capitalised words not opening a sentence
  for (const m of text.matchAll(/[\p{L}\d]+(?:[-+/][\p{L}\d]+)*/gu)) {
    // a lower-case prefix joined by a hyphen is a word, not part of the name ("antar-VRF" names VRF)
    const lead = m[0].match(/^(?:\p{Ll}+-)+/u)?.[0] ?? "";
    const tok = m[0].slice(lead.length);
    const at = (m.index ?? 0) + lead.length;
    if (tok === "") continue;
    if (inSkip(at) || unitSpans.some(([a, b]) => at >= a && at < b)) continue;
    if (NOT_NAMES.has(tok.toLowerCase())) continue;
    const hasDigit = /\d/.test(tok);
    const hasLetter = /\p{L}/u.test(tok);
    const capitals = (tok.match(/\p{Lu}/gu) ?? []).length;
    const before = text.slice(0, at).trimEnd();
    const opensSentence = before === "" || /[.!?:;]$/.test(before);
    const ordinal = /^ke-\d+$/i.test(tok);
    let isName = false;
    if (ordinal) isName = false;
    else if (hasDigit && hasLetter) {
      // a code needs a capital ("SW-01", "A1", "FIDO2", "SHA-256"); "1024-d", "8x" and "ke-27" are not names
      isName = capitals >= 1 && /^\p{Lu}/u.test(tok.replace(/^\d+[-+/]?/, ""));
    } else if (hasLetter && !hasDigit) {
      if (capitals >= 2) isName = true; // acronym or mixed-case name ("UPS", "BSrE", "SOAR")
      else if (capitals === 1 && /^\p{Lu}\p{Ll}+$/u.test(tok) && !opensSentence) isName = true; // "Discern"
    }
    if (isName) push({ kind: "name", text: tok });
  }
  return out;
}

const hasToken = (hay: string, needle: string): boolean => {
  const n = norm(needle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\d])${n}(?![\\p{L}\\d])`, "u").test(hay);
};
const valueFound = (values: readonly number[], pool: readonly number[]): boolean =>
  values.some((v) => pool.some((p) => Math.abs(p - v) < 1e-9));

export interface ClaimResult {
  claim: CaptionClaim;
  found: boolean;
  /** How it was found or why not, for the test record. */
  how: string;
}

/** Judge every claim of a caption against the figure (spec + key row) and the table directly below. */
export function judgeCaption(caption: string, spec: unknown, keyRow = "", tableBelow = ""): ClaimResult[] {
  const ev = figureEvidence(spec, keyRow ? [keyRow] : []);
  const tbl = norm(tableBelow);
  const tblValues = standaloneNumbers(tbl).flatMap((h) => h.values);
  return captionClaims(caption).map((claim): ClaimResult => {
    if (claim.kind === "name") {
      if (hasToken(ev.text, claim.text)) return { claim, found: true, how: "figure" };
      if (tbl && hasToken(tbl, claim.text)) return { claim, found: true, how: "table" };
      return { claim, found: false, how: "nowhere" };
    }
    if (claim.kind === "count") {
      const c = countOf(spec, claim.element);
      if (c !== undefined) return { claim, found: c === claim.n, how: `count ${claim.element} = ${c}` };
      if (hasToken(ev.text, claim.text) || (tbl && hasToken(tbl, claim.text))) return { claim, found: true, how: "phrase" };
      if (claim.n === 1) {
        const words = Object.entries(COUNT_WORDS).filter(([, k]) => k === claim.element).map(([w]) => w);
        if (words.some((w) => hasToken(ev.text, w) || (tbl !== "" && hasToken(tbl, w)))) return { claim, found: true, how: "element word (satu)" };
      }
      if (valueFound(claim.values, ev.values)) return { claim, found: true, how: "figure value" };
      if (valueFound(claim.values, tblValues)) return { claim, found: true, how: "table value" };
      return { claim, found: false, how: `no ${claim.element} in the figure and no ${claim.n}` };
    }
    if (valueFound(claim.values, ev.values)) return { claim, found: true, how: "figure" };
    if (valueFound(claim.values, tblValues)) return { claim, found: true, how: "table" };
    return { claim, found: false, how: "nowhere" };
  });
}

// ── The check ──────────────────────────────────────────────────────────────

function inlineSpec(block: Record<string, unknown>): unknown {
  const s = block.spec;
  if (!isObj(s)) return undefined;
  if (typeof s.artifactId === "string" && Object.keys(s).length <= 2) return undefined; // reference, no spec here
  return s;
}

/** The table block directly below a figure: the next block of the same list, when it is a table. */
function tableBelow(items: readonly WalkItem[], i: number): string {
  const it = items[i];
  const next = items[i + 1];
  if (!next || !isTableType(next.block.type)) return "";
  const cut = it.pointer.lastIndexOf("/");
  const base = it.pointer.slice(0, cut);
  const idx = Number(it.pointer.slice(cut + 1));
  if (next.pointer !== `${base}/${idx + 1}`) return "";
  return tableText(next.block as unknown as TableBlock);
}

function captionEvidence(ctx: StructCtx): CheckOutcome {
  const items = ctx.walk.items;
  const found: Finding[] = [];
  let read = 0;
  items.forEach((it, i) => {
    if (it.block.type !== "diagram" && it.block.type !== "chart") return;
    const b = it.block as Record<string, unknown>;
    const cap = textOf((b.caption as { inline?: never } | undefined)?.inline);
    const spec = inlineSpec(b);
    if (!cap || spec === undefined) return;
    read++;
    const key = textOf(b.keyRow as never);
    const missing = judgeCaption(cap, spec, key, tableBelow(items, i)).filter((r) => !r.found);
    if (missing.length === 0) return;
    const label = it.artifactLabel ?? it.address ?? it.pointer;
    const names = missing.map((r) => `"${r.claim.text}"${r.claim.kind === "count" ? ` (${r.how})` : ""}`).join(", ");
    found.push({
      pointer: `${it.pointer}/caption`,
      status: "REPORT",
      detail: `${label}: ${names} pada caption tidak ditemukan di gambar, kuncinya, atau tabel tepat di bawahnya. Caption: "${cap}"`,
    });
  });
  return findings(found, `${read} caption gambar: setiap angka dan nama ditemukan di gambar, kunci, atau tabel di bawahnya`);
}

export const STRUCTURE_CAPTION_CHECKS: Readonly<Record<string, (ctx: StructCtx) => CheckOutcome>> = {
  [CAPTION_EVIDENCE_ID]: captionEvidence,
};
