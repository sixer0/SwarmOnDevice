/**
 * Generator `md2contract/v1`: laporan kerja agen Markdown lama -> `studio.doc/v2` jenis
 * kontrak (DC-24; register masterplan/05_document_contract_specs.md §15 I64, §16; KD-42; BA-24).
 *
 * Pemetaan (alias dibaca dari registri C58 `registry/contracts.ts`, tidak didefinisikan ulang):
 *   kepala (frontmatter + baris `Kunci: nilai` di 40 baris pertama) -> payload `contractRecord`
 *     lewat GF; status lewat GS, vonis lewat GV. Tanpa alias -> CW-02 / CW-04, TIDAK ditebak.
 *   judul `##` -> bab outline lewat GA (ternormalisasi `norm_h` DC-01); tanpa alias -> CW-03,
 *     isinya bab tambahan kunci 6, 7, ... (tidak ada teks yang dibuang).
 *   tabel ber-kolom {id|kartu|card|key} + `status` -> `items[]` (+ `cardIds` untuk id C34);
 *     status butir tanpa alias -> CW-02 `scope: item`, baris tidak dimasukkan; tabel tetap di teks.
 *   prosa -> importer md/v1 yang ada (`../markdown.ts`, baca saja), satu panggilan per bab.
 *   F2 (entri PHASE-REPORTS): `## YYYY-MM-DD HH:MM` -> `reportedAt` (GL-13), `[FASE]` -> `phase`
 *     (GL-12), label baris -> bab / `status` / `evidence[]` (GL-01..GL-11).
 *
 * KD-42: status laporan atau `reportedAt` hilang/tanpa alias dan tanpa fallback opsi ->
 * `ContractImportError` `MD2CONTRACT_REQUIRED_MISSING` (exit 3 CLI), tidak pernah diisi bawaan.
 * Murni dan deterministik: keluaran hanya fungsi dari (markdown, opsi); tanpa cap waktu/acak.
 */
import type {
  AgentWorkReportStatus,
  ChapterV2,
  ContractEvidenceV2,
  ContractItemV2,
  ContractKindDefV2,
  ContractPhaseV2,
  ContractRecordPayloadV2,
  ContractVerdict,
  InlineV2,
  StudioDocV2,
} from "../../../contract";
import { CONTRACT_LIMITS } from "../../../contract/env";
import { StudioEngineError } from "../../../contract/errors";
import { getContractKindDef } from "../../../registry/contracts";
import { checkContractRecord } from "../../contracts";
import { validateV2Against } from "../../ingest/validate";
import { parseInline, type InlineSink } from "../inline";
import { importMarkdownChapter, MD_IMPORT_MAX_CHARS } from "../markdown";
import {
  actorValueOf,
  aliasTokenOf,
  CARD_ID_RE,
  cardIdsIn,
  cleanValue,
  contractKeyOf,
  evidenceSegments,
  fenceMask,
  findTables,
  frontMatterEnd,
  frontMatterKeyValue,
  HEADER_SCAN_LINES,
  headingAt,
  keyValueOf,
  normalizeHeading,
  normalizeSource,
  parsePhaseLine,
  parseReportedAt,
  type SourceTable,
  taskRefValueOf,
} from "./parse";
import {
  ContractImportError,
  MD2CONTRACT_GENERATOR,
  type ContractImportMapping,
  type ContractImportOptions,
  type ContractImportReport,
  type ContractImportResult,
  type ContractImportValidation,
  type ContractImportWarning,
} from "./types";

export * from "./types";

/** Judul bila sumber tidak punya `#` dan opsi `docTitle` tidak diberikan (dicatat `TITLE_FALLBACK`). */
const FALLBACK_TITLE = "Laporan kerja agen";
/** Kunci bab tambahan pertama (CW-03; kunci CO = 1..5). */
const FIRST_EXTRA_CHAPTER_KEY = 6;
const REFERENCE_MAX_ENTRIES = 500;

/**
 * Tujuan medan kepala yang dipetakan `applyField` (GF). Satu sumber untuk alias tambahan md-report
 * (R3-F #9). `initiator` (R3-F, D-440) hanya tercapai bila alias kepala mengarah ke sana (registri GF
 * tidak memetakannya, jadi keluaran md2contract tanpa `extraAliases` tidak berubah).
 */
export const MD2CONTRACT_RECORD_TARGETS = ["status", "verdict", "owner", "initiator", "taskRef", "reportedAt", "cardIds"] as const;

const GL13_RE = /^(\d{4}-\d{2}-\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)/;
const LABEL_RE = /^([A-Z][A-Z_]*):(?:\s+(.*))?$/;
const DISPLAY_NUMBER_RE = /^[([]?(?:\d{1,3}|[A-Za-z])[.)\]]\s+/;
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;
const URL_RE = /https?:\/\/[^\s<>)\]`"']+/;

/** Item kolom tabel butir (§16.6). */
const ITEM_KEY_COLUMNS = ["id", "kartu", "card", "key"] as const;
const ITEM_COLUMN_ALIASES: Readonly<Record<string, "title" | "owner" | "phase" | "dependsOn" | "evidence">> = {
  judul: "title",
  title: "title",
  assignee: "owner",
  owner: "owner",
  agen: "owner",
  fase: "phase",
  phase: "phase",
  dep: "dependsOn",
  depends: "dependsOn",
  bukti: "evidence",
  evidence: "evidence",
};

interface SrcLine {
  text: string;
  /** 1-based; 0 = baris sintetis. */
  line: number;
}

interface Piece {
  heading: string;
  line: number;
  body: SrcLine[];
}

interface Bucket {
  key: string;
  title: string;
  outlineKey: string | null;
  intro: SrcLine[];
  pieces: Piece[];
}

/** Penampung keadaan satu jalan generator (tidak dibagi antar panggilan). */
class Run {
  readonly warnings: ContractImportWarning[] = [];
  readonly mapping: ContractImportMapping;
  status: AgentWorkReportStatus | null = null;
  verdict: ContractVerdict | null = null;
  owner: string | null = null;
  initiator: string | null = null;
  taskRef: string | null = null;
  reportedAt: string | null = null;
  phase: ContractPhaseV2 | null = null;
  readonly cardIds: string[] = [];
  readonly evidence: ContractEvidenceV2[] = [];
  readonly items: ContractItemV2[] = [];

  constructor(
    readonly def: ContractKindDefV2,
    form: "F1" | "F2",
  ) {
    this.mapping = {
      form,
      entry: null,
      title: { source: "fallback", line: 0 },
      record: [],
      headings: [],
      chapters: [],
      missingChapters: [],
      references: null,
      itemTables: [],
      prose: [],
      notes: [],
    };
  }

  warn(code: ContractImportWarning["code"], line: number, message: string, details?: unknown): void {
    this.warnings.push({ code, line, message, ...(details !== undefined ? { details } : {}) });
  }

  note(code: string, line: number, message: string): void {
    this.mapping.notes.push({ code, line, message });
  }

  map(field: string, source: string, line: number, value: unknown, raw?: string): void {
    this.mapping.record.push({ field, source, line, ...(raw !== undefined ? { raw } : {}), value });
  }

  addCardIds(ids: readonly string[], source: string, line: number): void {
    for (const id of ids) {
      if (this.cardIds.includes(id)) continue;
      if (this.cardIds.length >= CONTRACT_LIMITS.cardIds) {
        this.note("CARD_IDS_LIMIT", line, `cardIds limit ${CONTRACT_LIMITS.cardIds} reached; ${id} not recorded`);
        continue;
      }
      this.cardIds.push(id);
      this.map("cardIds", source, line, id);
    }
  }

  addEvidence(e: ContractEvidenceV2, line: number): void {
    if (this.evidence.some((x) => x.ref === e.ref && x.item === e.item)) return;
    if (this.evidence.length >= CONTRACT_LIMITS.evidence) {
      this.note("EVIDENCE_LIMIT", line, `evidence limit ${CONTRACT_LIMITS.evidence} reached; ${e.ref} not recorded`);
      return;
    }
    this.evidence.push(e);
    this.map("evidence", "label", line, e.ref);
  }

  /**
   * Satu medan kepala (tujuan GF/GL). `true` = nilai tersimpan (baris kepala boleh diganti
   * catatan); `false` = tidak tersimpan, teks sumber tetap dipertahankan.
   */
  applyField(target: string, key: string, raw: string, line: number, source: string): boolean {
    const a = this.def.aliases;
    switch (target) {
      case "status": {
        const tok = aliasTokenOf(raw, (x) => a.statuses[x.toLowerCase()] !== undefined);
        if (tok.compound) return this.compound("status", key, raw, line);
        const code = a.statuses[tok.token.toLowerCase()];
        if (!code) {
          this.warn("CONTRACT_STATUS_UNMAPPED", line, `status "${cleanValue(raw)}" has no alias; not guessed (KD-42)`, { scope: "record", field: "status", key, value: cleanValue(raw) });
          return false;
        }
        return this.setOnce("status", code, key, raw, line, source);
      }
      case "verdict": {
        const tok = aliasTokenOf(raw, (x) => a.verdicts[x] !== undefined);
        if (tok.compound) return this.compound("verdict", key, raw, line);
        const code = a.verdicts[tok.token];
        if (!code) {
          this.warn("CONTRACT_STATUS_UNMAPPED", line, `verdict "${cleanValue(raw)}" has no alias; not guessed`, { scope: "record", field: "verdict", key, value: cleanValue(raw) });
          return false;
        }
        return this.setOnce("verdict", code, key, raw, line, source);
      }
      case "owner": {
        const v = actorValueOf(raw);
        if (v.value === null) return this.patternUnmapped("owner", key, raw, line, v.reason, "C36 actor pattern");
        return this.setOnce("owner", v.value, key, raw, line, source);
      }
      case "initiator": {
        // R3-F (D-440): pemberi tugas = pola aktor C36, aturan majemuk sama dengan owner.
        const v = actorValueOf(raw);
        if (v.value === null) return this.patternUnmapped("initiator", key, raw, line, v.reason, "C36 actor pattern");
        return this.setOnce("initiator", v.value, key, raw, line, source);
      }
      case "taskRef": {
        const v = taskRefValueOf(raw);
        if (v.value === null) return this.patternUnmapped("taskRef", key, raw, line, v.reason, "C35 key pattern");
        return this.setOnce("taskRef", v.value, key, raw, line, source);
      }
      case "reportedAt": {
        const p = parseReportedAt(raw);
        if (!p) return this.invalid("reportedAt", key, raw, line, "C37 date/time");
        if (p.timeDropped) this.note("REPORTED_AT_TIME_DROPPED", line, `time without zone in "${cleanValue(raw)}": date only kept (zone not guessed)`);
        return this.setOnce("reportedAt", p.value, key, raw, line, source);
      }
      case "cardIds": {
        // GF-10: cocok C34 -> cardIds, selain itu taskRef.
        const ids = cardIdsIn(raw);
        if (ids.length > 0) {
          this.addCardIds(ids, source, line);
          return true;
        }
        return this.applyField("taskRef", key, raw, line, source);
      }
      default:
        this.note("FIELD_TARGET_UNSUPPORTED", line, `header key "${key}" targets "${target}", which this generator does not map`);
        return false;
    }
  }

  private setOnce<F extends "status" | "verdict" | "owner" | "initiator" | "taskRef" | "reportedAt">(field: F, value: NonNullable<Run[F]>, key: string, raw: string, line: number, source: string): boolean {
    if (this[field] !== null) {
      this.note("FIELD_DUPLICATE", line, `${field} already set; "${key}" value kept as text`);
      return false;
    }
    (this as Run)[field] = value as Run[F];
    this.map(field, source, line, value, cleanValue(raw));
    return true;
  }

  /** DC35-F1: nilai majemuk (`PASS/FAIL`, `complete/blocked`) -> CW-02, tidak ditebak (KD-42); teks sumber tetap. */
  private compound(field: "status" | "verdict", key: string, raw: string, line: number): boolean {
    const value = cleanValue(raw);
    this.warn("CONTRACT_STATUS_UNMAPPED", line, `${field} "${value}" is compound (several alternatives); not guessed (KD-42)`, { scope: "record", field, key, value, reason: "compound" });
    return false;
  }

  /**
   * D-405: medan berpola (owner C36, taskRef C35) bernilai majemuk atau tak cocok pola -> medan kosong +
   * CW-04 (skema tidak menampung teks utuh: pola tanpa `/`, `,`, spasi); baris sumber tetap teks (bab 1
   * untuk kepala/label), tidak dipotong ke token pertama (KD-42).
   */
  private patternUnmapped(field: "owner" | "initiator" | "taskRef", key: string, raw: string, line: number, reason: "compound" | "pattern", rule: string): boolean {
    const value = cleanValue(raw);
    const why = reason === "compound" ? "is compound (several values)" : `does not match ${rule}`;
    this.warn("CONTRACT_FIELD_UNMAPPED", line, `${field} from "${key}" ${why}: "${value}"; not guessed (KD-42), kept as text`, { scope: "record", field, key, value, reason });
    return false;
  }

  private invalid(field: string, key: string, raw: string, line: number, rule: string): boolean {
    this.note("FIELD_VALUE_INVALID", line, `${field} from "${key}" does not match ${rule}: "${cleanValue(raw)}"; kept as text`);
    return false;
  }
}

// ── Bab ──────────────────────────────────────────────────────────────────

function bucketFor(run: Run, buckets: Map<string, Bucket>, target: string): Bucket {
  const key = target.slice("content:".length);
  let b = buckets.get(key);
  if (!b) {
    const o = run.def.outline.find((x) => x.chapterKey === key);
    b = { key, title: o?.title ?? key, outlineKey: o?.outlineKey ?? null, intro: [], pieces: [] };
    buckets.set(key, b);
  }
  return b;
}

const NOOP_SINK: InlineSink = { warn: () => undefined, drop: () => undefined };

function buildChapter(run: Run, b: Bucket): ChapterV2 {
  const md: string[] = [`# ${b.title}`, ""];
  const origin: number[] = [b.pieces[0]?.line ?? b.intro[0]?.line ?? 0, 0];
  const push = (text: string, line: number) => {
    md.push(text);
    origin.push(line);
  };
  for (const l of b.intro) push(l.text, l.line);
  for (const p of b.pieces) {
    push("", 0);
    push(`## ${p.heading}`, p.line);
    push("", 0);
    for (const l of p.body) push(l.text, l.line);
  }
  const res = importMarkdownChapter(md.join("\n") + "\n", { chapterKey: b.key });
  const at = (n: number) => (n > 0 && n <= origin.length ? origin[n - 1] : 0);
  run.mapping.prose.push({
    chapterKey: b.key,
    warnings: res.report.warnings.map((w) => ({ ...w, line: at(w.line) })),
    dropped: res.report.dropped.map((d) => ({ ...d, line: at(d.line) })),
  });
  run.mapping.chapters.push({ key: b.key, title: b.title, outlineKey: b.outlineKey, sources: b.pieces.map((p) => ({ line: p.line, heading: p.heading })) });
  // Judul bab = judul outline (mapped) atau judul sumber (bab tambahan); kunci bab dari generator.
  return { ...res.chapter, key: b.key };
}

function referenceEntries(run: Run, pieces: Piece[]): Array<{ id: string; citation: InlineV2; url?: string }> {
  const out: Array<{ id: string; citation: InlineV2; url?: string }> = [];
  for (const p of pieces) {
    for (const l of p.body) {
      let t = l.text.trim();
      if (t === "" || FENCE_LINE_RE.test(t) || /^\|?\s*:?-{3,}/.test(t)) continue;
      if (t.startsWith("|")) {
        t = t
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim())
          .filter((c) => c !== "")
          .join(" | ");
      }
      t = t.replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, "").trim();
      if (t === "") continue;
      if (out.length >= REFERENCE_MAX_ENTRIES) {
        run.note("REFERENCES_LIMIT", l.line, `references limit ${REFERENCE_MAX_ENTRIES} reached; line not recorded`);
        continue;
      }
      const u = URL_RE.exec(t)?.[0].replace(/[.,;:]+$/, "");
      out.push({ id: `R${out.length + 1}`, citation: parseInline(t, NOOP_SINK), ...(u && u.length <= 2000 ? { url: u } : {}) });
    }
  }
  return out;
}

// ── Tabel butir (§16.6) ──────────────────────────────────────────────────

function headerCell(c: string): string {
  return cleanValue(c).replace(/[*_`]/g, "").trim().toLowerCase();
}

/**
 * Keunikan kunci butir lewat I54 `checkContractRecord` (EC27 `CONTRACT_ITEM_KEY_DUPLICATE`; D-375, D-377 butir 7):
 * butir yang sudah diterima tidak pernah ganda, jadi galat ganda berarti calon butir mengulang kunci yang ada.
 */
function itemKeyRepeats(run: Run, key: string, status: string): boolean {
  const payload = {
    type: "contractRecord",
    status: "complete",
    reportedAt: "2000-01-01",
    items: [...run.items, { key, title: [], status }],
  } as unknown as ContractRecordPayloadV2;
  return checkContractRecord(payload, run.def.kind).error?.details.key === key;
}

function itemsFromTable(run: Run, t: SourceTable): void {
  const cols = t.header.map(headerCell);
  const keyIdx = cols.findIndex((c) => (ITEM_KEY_COLUMNS as readonly string[]).includes(c));
  const statusIdx = cols.indexOf("status");
  if (keyIdx < 0 || statusIdx < 0) return;
  const colOf = (f: string) => cols.findIndex((c) => ITEM_COLUMN_ALIASES[c] === f);
  const titleIdx = colOf("title");
  const ownerIdx = colOf("owner");
  const phaseIdx = colOf("phase");
  const depIdx = colOf("dependsOn");
  const evIdx = colOf("evidence");
  let admitted = 0;
  for (const r of t.rows) {
    const cell = (i: number) => (i >= 0 && i < r.cells.length ? r.cells[i] : "");
    const key = contractKeyOf(cell(keyIdx));
    if (!key) {
      run.note("ITEM_KEY_INVALID", r.line, `item key "${cleanValue(cell(keyIdx))}" does not match C35; row not admitted`);
      continue;
    }
    const rawStatus = cleanValue(cell(statusIdx));
    const itemStatuses = run.def.aliases.itemStatuses;
    const tok = aliasTokenOf(rawStatus, (x) => itemStatuses[x.toLowerCase()] !== undefined);
    if (tok.compound) {
      run.warn("CONTRACT_STATUS_UNMAPPED", r.line, `item ${key} status "${rawStatus}" is compound (several alternatives); not guessed (KD-42), row not admitted (table kept in text)`, { scope: "item", key, value: rawStatus, reason: "compound" });
      continue;
    }
    const status = itemStatuses[tok.token.toLowerCase()];
    if (!status) {
      run.warn("CONTRACT_STATUS_UNMAPPED", r.line, `item ${key} status "${rawStatus}" has no alias; row not admitted (table kept in text)`, { scope: "item", key, value: rawStatus });
      continue;
    }
    if (itemKeyRepeats(run, key, status)) {
      run.note("ITEM_KEY_DUPLICATE", r.line, `item key ${key} repeats; first row kept`);
      continue;
    }
    if (run.items.length >= CONTRACT_LIMITS.items) {
      run.note("ITEMS_LIMIT", r.line, `items limit ${CONTRACT_LIMITS.items} reached; ${key} not admitted`);
      continue;
    }
    const titleText = cleanValue(cell(titleIdx));
    if (titleIdx < 0 || titleText === "") run.note("ITEM_TITLE_FROM_KEY", r.line, `item ${key} has no title cell; key used as title`);
    const item: ContractItemV2 = { key, title: parseInline(titleText !== "" ? titleText : key, NOOP_SINK), status };
    const ownerRaw = ownerIdx >= 0 ? cleanValue(cell(ownerIdx)) : "";
    if (ownerRaw !== "") {
      // D-405: owner butir majemuk/tak cocok C36 -> tidak diisi + CW-04; sel tetap utuh di tabel teks bab.
      const owner = actorValueOf(ownerRaw);
      if (owner.value !== null) item.owner = owner.value;
      else {
        const why = owner.reason === "compound" ? "is compound (several values)" : "does not match C36";
        run.warn("CONTRACT_FIELD_UNMAPPED", r.line, `item ${key} owner "${ownerRaw}" ${why}; omitted, not guessed (KD-42), table kept in text`, { scope: "item", field: "owner", key, value: ownerRaw, reason: owner.reason });
      }
    }
    const phase = cleanValue(cell(phaseIdx));
    if (phase !== "" && phase.length <= 64) item.phase = phase;
    if (depIdx >= 0) {
      const deps: string[] = [];
      for (const d of cell(depIdx).split(",")) {
        const k = contractKeyOf(d);
        if (k && !deps.includes(k) && deps.length < CONTRACT_LIMITS.dependsOn) deps.push(k);
      }
      if (deps.length > 0) item.dependsOn = deps;
    }
    run.items.push(item);
    run.map("items", "table", r.line, key);
    admitted++;
    if (CARD_ID_RE.test(key)) run.addCardIds([key], "table", r.line);
    if (evIdx >= 0) for (const e of evidenceSegments(cell(evIdx))) run.addEvidence({ kind: "file", ...e, item: key }, r.line);
  }
  run.mapping.itemTables.push({ line: t.line, keyColumn: cols[keyIdx], statusColumn: cols[statusIdx], rows: t.rows.length, admitted });
}

// ── F1 laporan tunggal ───────────────────────────────────────────────────

function atxLevel(line: string): number | null {
  for (let n = 1; n <= 6; n++) if (headingAt(line, n) !== null) return n;
  return null;
}

function firstTitle(lines: readonly string[], mask: readonly boolean[], from: number, to: number): { text: string; line: number } | null {
  for (let i = from; i < to; i++) {
    if (mask[i]) continue;
    const h = headingAt(lines[i], 1);
    if (h !== null && h.trim() !== "") return { text: h.trim(), line: i + 1 };
  }
  return null;
}

function runF1(run: Run, lines: readonly string[], mask: readonly boolean[], buckets: Map<string, Bucket>, extras: Bucket[], refPieces: Piece[]): { text: string; line: number } | null {
  const def = run.def;
  const ch1 = bucketFor(run, buckets, "content:1");
  const fmEnd = frontMatterEnd(lines);
  const start = fmEnd >= 0 ? fmEnd + 1 : 0;
  let firstH2 = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (!mask[i] && headingAt(lines[i], 2) !== null) {
      firstH2 = i;
      break;
    }
  }
  const title = firstTitle(lines, mask, start, firstH2);

  // Kandidat kepala: frontmatter + baris `Kunci: nilai` di 40 baris pertama (urut baris).
  // Tanpa alias di frontmatter/pembuka -> CW-04 (baris tetap teks bab 1); di dalam ruas `##`
  // baris itu prosa biasa (hanya kunci ber-alias yang dibaca, teksnya tetap di ruasnya).
  const cands: Array<{ i: number; key: string; value: string; target: string; source: string }> = [];
  const fmLines: number[] = [];
  for (let i = 1; i < fmEnd; i++) {
    const kv = frontMatterKeyValue(lines[i]);
    if (!kv || kv.value === "") continue;
    fmLines.push(i);
    const target = def.aliases.headerKeys[kv.key];
    if (target === undefined) run.warn("CONTRACT_FIELD_UNMAPPED", i + 1, `header key "${kv.key}" has no alias; kept as text in chapter 1`, { key: kv.key });
    else cands.push({ i, key: kv.key, value: kv.value, target, source: "frontmatter" });
  }
  for (let i = start; i < Math.min(lines.length, HEADER_SCAN_LINES); i++) {
    const l = lines[i];
    if (mask[i] || l.trim().startsWith("|") || atxLevel(l) !== null) continue;
    const kv = keyValueOf(l);
    if (!kv) continue;
    const target = def.aliases.headerKeys[kv.key];
    if (target !== undefined) cands.push({ i, key: kv.key, value: kv.value, target, source: "header" });
    else if (i < firstH2) run.warn("CONTRACT_FIELD_UNMAPPED", i + 1, `header key "${kv.key}" has no alias; kept as text in chapter 1`, { key: kv.key });
  }
  const stored = new Set<number>();
  for (const c of cands) if (c.key !== "created" && run.applyField(c.target, c.key, c.value, c.i + 1, c.source)) stored.add(c.i);
  // GF-07 `created` -> reportedAt hanya bila GF-05/GF-06 absen.
  for (const c of cands) if (c.key === "created" && run.reportedAt === null && run.applyField(c.target, c.key, c.value, c.i + 1, c.source)) stored.add(c.i);
  // Semua id C34 di 40 baris pertama -> cardIds (unik, urut kemunculan).
  for (let i = 0; i < Math.min(lines.length, HEADER_SCAN_LINES); i++) run.addCardIds(cardIdsIn(lines[i]), "scan", i + 1);

  // Frontmatter yang tidak tersimpan -> satu paragraf per baris di bab 1 (CW-04 §13.2).
  for (const i of fmLines) {
    if (!stored.has(i)) ch1.intro.push({ text: lines[i].trim(), line: i + 1 }, { text: "", line: 0 });
  }
  // Pembuka (antara judul dan `##` pertama) -> intro bab 1; baris kepala yang nilainya tersimpan di record tidak diulang.
  for (let i = start; i < firstH2; i++) {
    if (stored.has(i) || (title && i === title.line - 1)) continue;
    ch1.intro.push({ text: lines[i], line: i + 1 });
  }
  while (ch1.intro.length > 0 && ch1.intro[0].text.trim() === "") ch1.intro.shift();

  // Ruas `##`.
  let i = firstH2;
  while (i < lines.length) {
    const heading = headingAt(lines[i], 2) ?? "";
    let j = i + 1;
    while (j < lines.length && (mask[j] || headingAt(lines[j], 2) === null)) j++;
    // Nomor tampilan awal (`2.`, `A.`, `(3)`) bukan isi (D-139): dibuang dari judul section/bab.
    const shown = heading.trim().replace(DISPLAY_NUMBER_RE, "").trim();
    const piece: Piece = { heading: shown !== "" ? shown : heading.trim() !== "" ? heading.trim() : "(tanpa judul)", line: i + 1, body: [] };
    for (let k = i + 1; k < j; k++) piece.body.push({ text: lines[k], line: k + 1 });
    const normalized = normalizeHeading(heading);
    const target = def.aliases.headings[normalized] ?? null;
    run.mapping.headings.push({ line: i + 1, heading: heading.trim(), normalized, target });
    if (target === "references") refPieces.push(piece);
    else if (target !== null && target.startsWith("content:")) bucketFor(run, buckets, target).pieces.push(piece);
    else {
      const key = String(FIRST_EXTRA_CHAPTER_KEY + extras.length);
      run.warn("CONTRACT_HEADING_UNMAPPED", i + 1, `heading "${heading.trim()}" has no alias; content kept as extra chapter ${key}`, { heading: heading.trim(), normalized, chapterKey: key });
      extras.push({ key, title: piece.heading, outlineKey: null, intro: [], pieces: [piece] });
    }
    i = j;
  }

  for (const t of findTables(lines, mask)) itemsFromTable(run, t);
  return title;
}

// ── F2 entri PHASE-REPORTS ───────────────────────────────────────────────

function runF2(run: Run, lines: readonly string[], mask: readonly boolean[], entryOpt: number | "last", buckets: Map<string, Bucket>): void {
  const def = run.def;
  const starts: number[] = [];
  const h2: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const h = headingAt(lines[i], 2);
    if (h === null) continue;
    h2.push(i);
    if (GL13_RE.test(h.trim())) starts.push(i);
  }
  if (starts.length === 0) throw new ContractImportError("MD2CONTRACT_USAGE", "no phase-report entry (`## YYYY-MM-DD HH:MM`) found");
  const idx = entryOpt === "last" ? starts.length : entryOpt;
  if (!Number.isInteger(idx) || idx < 1 || idx > starts.length) {
    throw new ContractImportError("MD2CONTRACT_USAGE", `entry ${String(entryOpt)} out of range 1..${starts.length}`);
  }
  const s = starts[idx - 1];
  const end = h2.find((x) => x > s) ?? lines.length;
  const heading = (headingAt(lines[s], 2) ?? "").trim();

  // GL-13: judul entri -> reportedAt (`WIB` -> +07:00; akhiran sesudah menit dibuang).
  const g = GL13_RE.exec(heading)!;
  const wib = /\bWIB\b/.test(heading.slice(g[0].length));
  run.applyField("reportedAt", "## entry heading", `${g[1]} ${g[2]}:${g[3]}${wib ? " WIB" : ""}`, s + 1, "entryHeading");

  const ch1 = bucketFor(run, buckets, "content:1");
  let current: Piece | null = null;
  const evidenceBlocks: Piece[] = [];
  let mission: string | null = null;
  for (let i = s + 1; i < end; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === "" || FENCE_LINE_RE.test(raw)) {
      continue;
    }
    if (t.startsWith("[FASE]")) {
      const m = parsePhaseLine(t);
      if (m && run.phase === null && m.from.length <= 64 && m.to.length <= 64) {
        mission = m.mission;
        run.phase = { from: m.from, to: m.to };
        run.map("phase", "phaseLine", i + 1, run.phase, t);
        continue;
      }
      run.note("PHASE_LINE_UNPARSED", i + 1, "[FASE] line does not match `[FASE] <misi> | <dari> -> <ke> | HH:MM`; kept as text in chapter 1");
      ch1.intro.push({ text: t, line: i + 1 });
      current = null;
      continue;
    }
    const lm = LABEL_RE.exec(t);
    if (lm) {
      const label = `${lm[1]}:`;
      const rest = lm[2] ?? "";
      const target = def.aliases.lineLabels[label];
      if (target === undefined) {
        run.warn("CONTRACT_FIELD_UNMAPPED", i + 1, `line label "${label}" has no alias; kept as text in chapter 1`, { key: label });
        ch1.intro.push({ text: t, line: i + 1 });
        current = null;
        continue;
      }
      if (!target.startsWith("content:")) {
        if (!run.applyField(target, label, rest, i + 1, "label")) ch1.intro.push({ text: t, line: i + 1 });
        current = null;
        continue;
      }
      const [chapterTarget, extra] = target.split("+");
      current = { heading: lm[1], line: i + 1, body: rest !== "" ? [{ text: rest, line: i + 1 }] : [] };
      bucketFor(run, buckets, chapterTarget).pieces.push(current);
      if (extra === "evidence") {
        evidenceBlocks.push(current);
      }
      continue;
    }
    if (current) current.body.push({ text: t, line: i + 1 });
    else ch1.intro.push({ text: t, line: i + 1 });
  }
  for (const b of evidenceBlocks) {
    const text = b.body.map((l) => l.text).join(" ");
    for (const e of evidenceSegments(text)) run.addEvidence({ kind: "file", ...e }, b.line);
  }
  for (let i = s; i < end; i++) run.addCardIds(cardIdsIn(lines[i]), "scan", i + 1);
  run.mapping.entry = { index: idx, count: starts.length, line: s + 1, mission };
}

// ── API ──────────────────────────────────────────────────────────────────

function assertInput(markdown: unknown, opts: ContractImportOptions): ContractKindDefV2 {
  if (typeof markdown !== "string" || markdown.trim() === "") throw new ContractImportError("MD2CONTRACT_USAGE", "markdown must be a non-empty string");
  if (markdown.length > MD_IMPORT_MAX_CHARS) {
    throw new StudioEngineError("PAYLOAD_TOO_LARGE", `markdown exceeds ${MD_IMPORT_MAX_CHARS} characters`, {
      pointer: "/markdown",
      reason: "MD_TOO_LONG",
      limit: MD_IMPORT_MAX_CHARS,
      actual: markdown.length,
    });
  }
  const def = getContractKindDef(opts?.kind);
  if (!def) throw new ContractImportError("MD2CONTRACT_USAGE", `unknown contract kind "${String(opts?.kind)}"`);
  if (opts.entry !== undefined && opts.entry !== "last" && !(Number.isInteger(opts.entry) && opts.entry >= 1)) {
    throw new ContractImportError("MD2CONTRACT_USAGE", `entry must be a positive integer or "last"`);
  }
  const extra = opts.extraAliases;
  if (!extra || (!extra.headerKeys && !extra.headings)) return def;
  // R3-01: alias tambahan di bawah alias registri (registri menang); def registri tidak diubah.
  return {
    ...def,
    aliases: {
      ...def.aliases,
      headerKeys: { ...(extra.headerKeys ?? {}), ...def.aliases.headerKeys },
      headings: { ...(extra.headings ?? {}), ...def.aliases.headings },
    },
  };
}

/** Validasi lokal `studio.doc/v2` dengan validator v2 repo (ajv bersama), tanpa DB. */
export function validateContractDoc(doc: StudioDocV2): ContractImportValidation {
  const issues = validateV2Against("studio.doc/v2", doc);
  return { valid: issues.length === 0, issues };
}

function isF2(lines: readonly string[], mask: readonly boolean[]): boolean {
  let entry = false;
  let fase = false;
  for (let i = 0; i < lines.length && !(entry && fase); i++) {
    if (!mask[i]) {
      const h = headingAt(lines[i], 2);
      if (h !== null && GL13_RE.test(h.trim())) entry = true;
    }
    if (lines[i].trim().startsWith("[FASE]")) fase = true;
  }
  return entry && fase;
}

/**
 * I64 — laporan kerja Markdown -> `{ doc, report, validation }`. Melempar `ContractImportError`
 * (pemakaian / nilai wajib hilang, KD-42) atau `StudioEngineError` (batas ukuran, importer).
 */
export function markdownToContract(markdown: string, opts: ContractImportOptions): ContractImportResult {
  const def = assertInput(markdown, opts);
  const lines = normalizeSource(markdown).split("\n");
  const mask = fenceMask(lines);
  const form: "F1" | "F2" = opts.entry !== undefined || isF2(lines, mask) ? "F2" : "F1";
  const run = new Run(def, form);
  const buckets = new Map<string, Bucket>();
  const extras: Bucket[] = [];
  const refPieces: Piece[] = [];

  let title: { text: string; line: number } | null;
  if (form === "F1") title = runF1(run, lines, mask, buckets, extras, refPieces);
  else {
    runF2(run, lines, mask, opts.entry ?? "last", buckets);
    title = firstTitle(lines, mask, 0, lines.length);
  }

  // Fallback opsi (KD-42): hanya bila sumber tidak memberi nilai berpeta.
  if (run.status === null && opts.status !== undefined) {
    const code = def.aliases.statuses[String(opts.status).trim().toLowerCase()];
    if (!code) throw new ContractImportError("MD2CONTRACT_USAGE", `status option "${opts.status}" is not a status code or alias of ${def.kind}`);
    run.status = code;
    run.map("status", "option", 0, code, opts.status);
  }
  if (run.reportedAt === null && opts.reportedAt !== undefined) {
    const p = parseReportedAt(String(opts.reportedAt), true);
    if (!p || p.timeDropped) throw new ContractImportError("MD2CONTRACT_USAGE", `reportedAt option "${opts.reportedAt}" must be a date or a zoned date-time (C37)`);
    run.reportedAt = p.value;
    run.map("reportedAt", "option", 0, p.value, opts.reportedAt);
  }

  // Bab: CO terurut, lalu bab tambahan berurutan kemunculan.
  const chapters: ChapterV2[] = [];
  for (const o of def.outline) {
    const b = buckets.get(o.chapterKey);
    if (b && (b.intro.some((l) => l.text.trim() !== "") || b.pieces.length > 0)) chapters.push(buildChapter(run, b));
    else if (o.required) run.mapping.missingChapters.push(o.chapterKey);
  }
  for (const b of extras) chapters.push(buildChapter(run, b));

  const entries = referenceEntries(run, refPieces);
  if (refPieces.length > 0) run.mapping.references = { lines: refPieces.map((p) => p.line), entries: entries.length };

  let docTitle: string;
  if (typeof opts.docTitle === "string" && opts.docTitle.trim() !== "") {
    docTitle = opts.docTitle.trim();
    run.mapping.title = { source: "option", line: 0 };
  } else if (title) {
    docTitle = title.text;
    run.mapping.title = { source: "heading", line: title.line };
  } else {
    docTitle = FALLBACK_TITLE;
    run.note("TITLE_FALLBACK", 0, `no # heading and no docTitle option; title "${FALLBACK_TITLE}" used`);
  }

  run.warnings.sort((a, b) => a.line - b.line);
  const report: ContractImportReport = { generator: MD2CONTRACT_GENERATOR, warnings: run.warnings, mapping: run.mapping };

  const missing: Array<"status" | "reportedAt"> = [];
  if (run.status === null) missing.push("status");
  if (run.reportedAt === null) missing.push("reportedAt");
  if (missing.length > 0) {
    throw new ContractImportError("MD2CONTRACT_REQUIRED_MISSING", `required value missing and not guessed (KD-42): ${missing.join(", ")}; pass ${missing.map((m) => (m === "status" ? "status" : "reportedAt")).join(" / ")} option`, { missing, report });
  }

  const record: ContractRecordPayloadV2 = {
    type: "contractRecord",
    status: run.status as AgentWorkReportStatus,
    ...(run.verdict ? { verdict: run.verdict } : {}),
    ...(run.owner ? { owner: run.owner } : {}),
    ...(run.initiator ? { initiator: run.initiator } : {}),
    ...(run.taskRef ? { taskRef: run.taskRef } : {}),
    reportedAt: run.reportedAt as string,
    ...(run.phase ? { phase: run.phase } : {}),
    ...(run.cardIds.length > 0 ? { cardIds: run.cardIds } : {}),
    ...(run.evidence.length > 0 ? { evidence: run.evidence } : {}),
    ...(run.items.length > 0 ? { items: run.items } : {}),
  };
  const doc: StudioDocV2 = {
    $schema: "studio.doc/v2",
    template: { slug: def.templateSlug },
    ...(opts.mission ? { mission: { folder: opts.mission } } : {}),
    ...(opts.docKey ? { docKey: opts.docKey } : {}),
    meta: { title: docTitle, ...(opts.docNumber ? { docNumber: opts.docNumber } : {}) },
    sections: {
      record,
      content: { type: "chapter", chapters },
      ...(entries.length > 0 ? { references: { type: "sourceRegister", entries } } : {}),
    },
  };
  return { doc, report, validation: validateContractDoc(doc) };
}
