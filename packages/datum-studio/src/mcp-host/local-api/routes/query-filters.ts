/**
 * Validasi filter dan kursor layanan retrieval (DC-14; register
 * 05_document_contract_specs.md §8.1-§8.2, §9.1-§9.2, C34-C36, C43, C45).
 *
 * Murni (tanpa DB). Dua lapis:
 * - `parseContractQuery` / `parseSearchQuery`: query string mentah (R21/R22)
 *   -> filter bertipe. Parameter tak dikenal, ganda, atau tidak sah -> isu
 *   berpointer `/query/<nama>`.
 * - `contractFilterIssues` / `searchFilterIssues`: pengaman filter bertipe yang
 *   dipanggil ulang oleh layanan (pemanggil non-route tidak bisa melewatinya).
 * Kegagalan dilempar sebagai `StudioEngineError("SCHEMA_INVALID", ..., issues)`.
 *
 * FIX-SEC (D-402): dokumen terarsip dikecualikan secara bawaan; `includeArchived=1` (R21/R22)
 * menyertakannya (`0` = bawaan). Nilai teks apa pun yang memuat byte NUL (U+0000) -> isu
 * `/query/<nama>` keyword `pattern` (Postgres menolak NUL dengan 22021 = 500; L-1).
 */
import {
  AGENT_WORK_REPORT_STATUSES,
  CARD_ID_PATTERN,
  CONTENT_BLOCK_TYPES,
  CONTRACT_ACTOR_PATTERN,
  CONTRACT_KEY_PATTERN,
  CONTRACT_KINDS,
  CONTRACT_QUERY_LIMITS,
  DOC_KEY_PATTERN,
  SEARCH_LIMITS,
  SLOT_KEY_PATTERN,
  type AgentWorkReportStatus,
  type ContractKind,
  type ValidationIssue,
} from "@/lib/studio/contract";
import { StudioEngineError } from "@/lib/studio/contract/errors";
import { SLOT_SECTION_TYPES } from "@/lib/studio/registry/slots";
import { isCalendarDay } from "@/lib/studio/services/contracts/dates";

// ── Batas lokal (register §9.1/§9.2) ─────────────────────────────────────

export const MISSION_MAX = 120;
export const DOC_KEY_MAX = 64;
export const DOC_NUMBER_MAX = 80;
export const SEARCH_TYPE_LIST_MAX = 8;
export const DOCUMENT_ID_PATTERN = "^[a-z0-9]{20,40}$";
/** Batas panjang kursor opak (base64url `{ r, id }`); di atasnya pasti bukan kursor sah. */
export const SEARCH_CURSOR_MAX = 200;

/** Set status gabungan semua jenis kontrak aktif (tahap 1: E45). */
export const CONTRACT_STATUS_SET: ReadonlySet<string> = new Set<string>([...AGENT_WORK_REPORT_STATUSES]);
/** `CONTENT_BLOCK_TYPES` ∪ C33 ∪ { sourceRegisterEntry, contractItem } (§9.2). */
export const SEARCH_TYPE_SET: ReadonlySet<string> = new Set<string>([
  ...CONTENT_BLOCK_TYPES,
  ...SLOT_SECTION_TYPES,
  "sourceRegisterEntry",
  "contractItem",
]);

const RE_CARD = new RegExp(CARD_ID_PATTERN);
const RE_KEY = new RegExp(CONTRACT_KEY_PATTERN);
const RE_ACTOR = new RegExp(CONTRACT_ACTOR_PATTERN);
const RE_DOC_KEY = new RegExp(DOC_KEY_PATTERN);
const RE_SLOT_KEY = new RegExp(SLOT_KEY_PATTERN);
const RE_DOCUMENT_ID = new RegExp(DOCUMENT_ID_PATTERN);
const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_UINT = /^[0-9]{1,9}$/;
const KIND_SET: ReadonlySet<string> = new Set<string>(CONTRACT_KINDS);

// ── Tipe filter ───────────────────────────────────────────────────────────

export interface ContractQueryFilter {
  mission?: string;
  docKey?: string;
  docNumber?: string;
  kind?: ContractKind;
  status?: AgentWorkReportStatus[];
  cardId?: string;
  owner?: string;
  taskRef?: string;
  /** `YYYY-MM-DD`, inklusif. */
  dueBefore?: string;
  /** `YYYY-MM-DD`, inklusif. */
  dueAfter?: string;
  take?: number;
  /** id dokumen dari `nextCursor`. */
  cursor?: string;
  /** FIX-SEC: `true` = sertakan dokumen terarsip; tidak diisi = dikecualikan (bawaan). */
  includeArchived?: true;
}

export interface SearchQueryFilter {
  q: string;
  mission?: string;
  kind?: ContractKind;
  documentId?: string;
  /** Hanya bersama `documentId`. */
  revisionNo?: number;
  type?: string[];
  slotKey?: string;
  take?: number;
  /** Kursor opak dari `nextCursor`. */
  cursor?: string;
  /** FIX-SEC: `true` = sertakan dokumen terarsip; tidak diisi = dikecualikan (bawaan). */
  includeArchived?: true;
}

export interface SearchCursor {
  r: number;
  id: string;
}

const CONTRACT_PARAMS = ["mission", "docKey", "docNumber", "kind", "status", "cardId", "owner", "taskRef", "dueBefore", "dueAfter", "take", "cursor", "includeArchived"] as const;
const SEARCH_PARAMS = ["q", "mission", "kind", "documentId", "revisionNo", "type", "slotKey", "take", "cursor", "includeArchived"] as const;

// ── Pembantu ──────────────────────────────────────────────────────────────

function issue(name: string, keyword: string, message: string): ValidationIssue {
  return { pointer: `/query/${name}`, keyword, message };
}

/** Tanggal kalender sah `YYYY-MM-DD` (menolak 2026-02-30); aturan hari = `isCalendarDay` (FIX-R40-3). */
export function isCalendarDate(s: string): boolean {
  const m = RE_DATE.exec(s);
  return m !== null && isCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Daftar dipisah koma: dipangkas, butir kosong dibuang, urutan pertama dipertahankan, tanpa ganda. */
export function splitList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function lenIssue(out: ValidationIssue[], name: string, v: string | undefined, min: number, max: number): void {
  if (v !== undefined && (v.length < min || v.length > max)) out.push(issue(name, "length", `${name} harus ${min}..${max} karakter`));
}

function patternIssue(out: ValidationIssue[], name: string, v: string | undefined, re: RegExp, desc: string): void {
  if (v !== undefined && !re.test(v)) out.push(issue(name, "pattern", `${name} tidak sah: ${desc}`));
}

function takeIssue(out: ValidationIssue[], take: number | undefined, max: number): void {
  if (take !== undefined && !(Number.isInteger(take) && take >= 1 && take <= max)) out.push(issue("take", "range", `take harus bilangan bulat 1..${max}`));
}

/**
 * Ambil parameter dari query string: tolak nama tak dikenal dan nama ganda.
 * Nilai dipangkas; nilai kosong sesudah pangkas dianggap tidak diisi.
 */
function collect(sp: URLSearchParams, allowed: readonly string[], out: ValidationIssue[]): Map<string, string> {
  const allow = new Set(allowed);
  const seen = new Map<string, string>();
  const dup = new Set<string>();
  for (const [k, v] of sp.entries()) {
    if (!allow.has(k)) {
      out.push(issue(k, "additionalProperties", `parameter ${k} tidak dikenal; yang diterima: ${allowed.join(", ")}`));
      continue;
    }
    if (seen.has(k) || dup.has(k)) {
      if (!dup.has(k)) out.push(issue(k, "duplicate", `parameter ${k} hanya boleh muncul sekali`));
      dup.add(k);
      continue;
    }
    seen.set(k, v);
  }
  for (const k of dup) seen.delete(k);
  const vals = new Map<string, string>();
  for (const [k, v] of seen) {
    const t = v.trim();
    if (t) vals.set(k, t);
  }
  return vals;
}

/** `includeArchived`: `1` -> true, `0` -> tidak diisi (bawaan: arsip dikecualikan), lainnya -> isu enum. */
function parseIncludeArchived(raw: string | undefined, out: ValidationIssue[]): true | undefined {
  if (raw === undefined || raw === "0") return undefined;
  if (raw === "1") return true;
  out.push(issue("includeArchived", "enum", "includeArchived harus 0 atau 1"));
  return undefined;
}

/** L-1: setiap nilai teks (atau butir daftar) yang memuat U+0000 -> satu isu per medan. */
function nulIssues(out: ValidationIssue[], f: object): void {
  for (const [k, v] of Object.entries(f)) {
    const vals = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    if (vals.some((x) => x.includes("\u0000"))) out.push(issue(k, "pattern", `${k} tidak boleh memuat byte NUL (U+0000)`));
  }
}

/** Isu `includeArchived` bertipe (pemanggil non-route). */
function includeArchivedIssue(out: ValidationIssue[], v: unknown): void {
  if (v !== undefined && v !== true) out.push(issue("includeArchived", "enum", "includeArchived harus true atau tidak diisi"));
}

function parseUint(name: string, raw: string | undefined, out: ValidationIssue[]): number | undefined {
  if (raw === undefined) return undefined;
  if (!RE_UINT.test(raw)) {
    out.push(issue(name, "type", `${name} harus bilangan bulat positif`));
    return undefined;
  }
  return Number(raw);
}

function fail(issues: ValidationIssue[]): never {
  throw new StudioEngineError("SCHEMA_INVALID", "Parameter kueri tidak sah", issues);
}

// ── Filter kontrak (R21, I65) ─────────────────────────────────────────────

/** Isu filter kontrak bertipe (kosong = sah). */
export function contractFilterIssues(f: ContractQueryFilter): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  nulIssues(out, f);
  includeArchivedIssue(out, f.includeArchived);
  lenIssue(out, "mission", f.mission, 1, MISSION_MAX);
  lenIssue(out, "docKey", f.docKey, 1, DOC_KEY_MAX);
  patternIssue(out, "docKey", f.docKey, RE_DOC_KEY, "huruf kecil/angka dipisah tanda hubung");
  lenIssue(out, "docNumber", f.docNumber, 1, DOC_NUMBER_MAX);
  if (f.kind !== undefined && !KIND_SET.has(f.kind)) out.push(issue("kind", "enum", `kind harus salah satu dari: ${CONTRACT_KINDS.join(", ")}`));
  if (f.status !== undefined) {
    if (f.status.length < 1 || f.status.length > CONTRACT_QUERY_LIMITS.statusListMax) {
      out.push(issue("status", "length", `status harus 1..${CONTRACT_QUERY_LIMITS.statusListMax} butir`));
    }
    for (const s of f.status) {
      if (!CONTRACT_STATUS_SET.has(s)) out.push(issue("status", "enum", `status "${s.slice(0, 40)}" tidak dikenal; yang diterima: ${[...CONTRACT_STATUS_SET].join(", ")}`));
    }
  }
  patternIssue(out, "cardId", f.cardId, RE_CARD, "bentuk t_ diikuti 8 heksadesimal");
  patternIssue(out, "owner", f.owner, RE_ACTOR, "huruf kecil/angka/._-, maks 64");
  patternIssue(out, "taskRef", f.taskRef, RE_KEY, "huruf/angka/._-, maks 64");
  for (const name of ["dueBefore", "dueAfter"] as const) {
    const v = f[name];
    if (v !== undefined && !isCalendarDate(v)) out.push(issue(name, "format", `${name} harus tanggal YYYY-MM-DD yang sah`));
  }
  takeIssue(out, f.take, CONTRACT_QUERY_LIMITS.takeMax);
  patternIssue(out, "cursor", f.cursor, RE_DOCUMENT_ID, "id dokumen dari nextCursor");
  return out;
}

/** Lempar `SCHEMA_INVALID` bila filter kontrak bertipe tidak sah. */
export function assertContractFilter(f: ContractQueryFilter): void {
  const issues = contractFilterIssues(f);
  if (issues.length > 0) fail(issues);
}

/** Query string R21 -> filter kontrak tervalidasi (melempar `SCHEMA_INVALID`). */
export function parseContractQuery(sp: URLSearchParams): ContractQueryFilter {
  const pre: ValidationIssue[] = [];
  const v = collect(sp, CONTRACT_PARAMS, pre);
  const take = parseUint("take", v.get("take"), pre);
  const statusRaw = v.get("status");
  const f: ContractQueryFilter = {
    mission: v.get("mission"),
    docKey: v.get("docKey"),
    docNumber: v.get("docNumber"),
    kind: v.get("kind") as ContractKind | undefined,
    status: statusRaw === undefined ? undefined : (splitList(statusRaw) as AgentWorkReportStatus[]),
    cardId: v.get("cardId"),
    owner: v.get("owner"),
    taskRef: v.get("taskRef"),
    dueBefore: v.get("dueBefore"),
    dueAfter: v.get("dueAfter"),
    take,
    cursor: v.get("cursor"),
    includeArchived: parseIncludeArchived(v.get("includeArchived"), pre),
  };
  for (const k of Object.keys(f) as Array<keyof ContractQueryFilter>) if (f[k] === undefined) delete f[k];
  const issues = [...pre, ...contractFilterIssues(f)];
  if (issues.length > 0) fail(issues);
  return f;
}

// ── Filter teks penuh (R22, I66) ──────────────────────────────────────────

/** Isu filter pencarian bertipe (kosong = sah). `q` dinilai sesudah trim. */
export function searchFilterIssues(f: SearchQueryFilter): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  nulIssues(out, f);
  includeArchivedIssue(out, f.includeArchived);
  const q = typeof f.q === "string" ? f.q.trim() : "";
  if (q.length < SEARCH_LIMITS.qMin || q.length > SEARCH_LIMITS.qMax) {
    out.push(issue("q", "length", `q wajib, ${SEARCH_LIMITS.qMin}..${SEARCH_LIMITS.qMax} karakter sesudah dipangkas`));
  }
  lenIssue(out, "mission", f.mission, 1, MISSION_MAX);
  if (f.kind !== undefined && !KIND_SET.has(f.kind)) out.push(issue("kind", "enum", `kind harus salah satu dari: ${CONTRACT_KINDS.join(", ")}`));
  patternIssue(out, "documentId", f.documentId, RE_DOCUMENT_ID, "huruf kecil/angka 20..40");
  if (f.revisionNo !== undefined) {
    if (!(Number.isInteger(f.revisionNo) && f.revisionNo >= 1)) out.push(issue("revisionNo", "minimum", "revisionNo harus bilangan bulat >= 1"));
    if (f.documentId === undefined) out.push(issue("revisionNo", "dependentRequired", "revisionNo hanya boleh bersama documentId"));
  }
  if (f.type !== undefined) {
    if (f.type.length < 1 || f.type.length > SEARCH_TYPE_LIST_MAX) out.push(issue("type", "length", `type harus 1..${SEARCH_TYPE_LIST_MAX} butir`));
    for (const t of f.type) {
      if (!SEARCH_TYPE_SET.has(t)) out.push(issue("type", "enum", `type "${t.slice(0, 40)}" tidak dikenal`));
    }
  }
  patternIssue(out, "slotKey", f.slotKey, RE_SLOT_KEY, "huruf kecil di depan, huruf/angka, maks 32");
  takeIssue(out, f.take, SEARCH_LIMITS.takeMax);
  if (f.cursor !== undefined && decodeSearchCursor(f.cursor) === null) out.push(issue("cursor", "format", "cursor tidak sah; pakai nextCursor dari respons sebelumnya"));
  return out;
}

/** Lempar `SCHEMA_INVALID` bila filter pencarian bertipe tidak sah. */
export function assertSearchFilter(f: SearchQueryFilter): void {
  const issues = searchFilterIssues(f);
  if (issues.length > 0) fail(issues);
}

/** Query string R22 -> filter pencarian tervalidasi (melempar `SCHEMA_INVALID`). */
export function parseSearchQuery(sp: URLSearchParams): SearchQueryFilter {
  const pre: ValidationIssue[] = [];
  const v = collect(sp, SEARCH_PARAMS, pre);
  const typeRaw = v.get("type");
  const f: SearchQueryFilter = {
    q: v.get("q") ?? "",
    mission: v.get("mission"),
    kind: v.get("kind") as ContractKind | undefined,
    documentId: v.get("documentId"),
    revisionNo: parseUint("revisionNo", v.get("revisionNo"), pre),
    type: typeRaw === undefined ? undefined : splitList(typeRaw),
    slotKey: v.get("slotKey"),
    take: parseUint("take", v.get("take"), pre),
    cursor: v.get("cursor"),
    includeArchived: parseIncludeArchived(v.get("includeArchived"), pre),
  };
  for (const k of Object.keys(f) as Array<keyof SearchQueryFilter>) if (k !== "q" && f[k] === undefined) delete f[k];
  const issues = [...pre, ...searchFilterIssues(f)];
  if (issues.length > 0) fail(issues);
  return { ...f, q: f.q.trim() };
}

// ── Kursor teks penuh (base64url `{ r, id }`) ─────────────────────────────

export function encodeSearchCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify({ r: c.r, id: c.id }), "utf8").toString("base64url");
}

/** Dekode kursor; `null` bila bentuk/isi tidak sah (rank hingga >= 0, id pola cuid). */
export function decodeSearchCursor(raw: string): SearchCursor | null {
  if (raw.length < 1 || raw.length > SEARCH_CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== 2) return null;
  if (typeof o.r !== "number" || !Number.isFinite(o.r) || o.r < 0) return null;
  if (typeof o.id !== "string" || !RE_DOCUMENT_ID.test(o.id)) return null;
  return { r: o.r, id: o.id };
}
