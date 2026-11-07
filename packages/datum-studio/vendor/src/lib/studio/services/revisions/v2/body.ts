/**
 * Validasi badan PATCH per pid (R16) dan PATCH struktur (R14) (SR-14; register
 * 03_structural_sections_specs.md §9.2, §10, §11.1, §12 R14/R16; D-06, KD-27).
 *
 * Fragmen konten (blok/section/bab/outline/meta) divalidasi lewat skema kontrak
 * v2 dengan membungkusnya ke `studio.chapter/v2` / `studio.slot/v2` /
 * `studio.doc/v2`, lalu galat ajv dipetakan oleh pemeta TUNGGAL
 * `classifySchemaV2Errors` (D-172) dan pointer dipetakan balik ke badan PATCH.
 * Ajv = instans bersama (SR-55 M8, `ingest/validate` `studioValidator`).
 * D-247: medan `render` ditolak (400 `SCHEMA_INVALID`, `checkId: "RENDER_FIELD"`).
 */
import {
  CHAPTER_V2_SCHEMA_ID,
  classifySchemaV2Errors,
  DOC_V2_SCHEMA_ID,
  PID_OPS,
  PID_PATTERN,
  SLOT_V2_SCHEMA_ID,
  STRUCTURE_OPS,
  renderFieldIssue,
  schemaInvalidMessage,
  type BlockV2,
  type ChangeV2,
  type ChapterV2,
  type DocMetaV2,
  type OutlineEntryV2,
  type PidOp,
  type SchemaV2RootId,
  type SectionV2,
  type StructureOp,
  type ValidationIssue,
} from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { studioValidator } from "../../ingest/validate";

/** Batas medan apa/mengapa/dampak di kontrak v2 (`$defs.ChangeV2`, 2000 karakter). */
export const CHANGE_V2_FIELD_MAX = 2000;

export interface PidMoveTarget {
  before?: string;
  after?: string;
  /** `at` = posisi paragraf 1-based di section sasaran (len + 1 = akhir). sectionNo 0 = intro. */
  section?: { chapterKey: string; sectionNo: number; at: number };
}

export interface PatchPidBody {
  op: PidOp;
  baseRevisionNo: number;
  block?: BlockV2;
  section?: SectionV2;
  chapter?: ChapterV2;
  to?: PidMoveTarget;
  change: ChangeV2;
}

export type PatchStructureBody = {
  op: StructureOp;
  baseRevisionNo: number;
  change: ChangeV2;
} & (
  | { op: "reorder"; order: string[] }
  | { op: "omitSlot"; slot: string }
  | { op: "restoreSlot"; slot: string; position?: number }
  | { op: "setOutline"; slot?: string; outline: OutlineEntryV2[] | null }
  | { op: "setMeta"; meta: DocMetaV2 }
  | { op: "renumberChapters"; slot?: string; map: Record<string, string> }
  | { op: "templateVersion"; versionNo: number }
);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function issue(pointer: string, keyword: string, message: string, checkId?: string): ValidationIssue {
  return checkId ? { pointer, keyword, message, checkId } : { pointer, keyword, message };
}

function fail(code: ConstructorParameters<typeof StudioEngineError>[0], message: string, details?: unknown): never {
  throw new StudioEngineError(code, message, details);
}

/** Validasi pembungkus, kembalikan issue dengan pointer dipetakan `fromPrefix` -> `toPrefix`. */
function validateWrapped(rootId: SchemaV2RootId, schemaUrl: string, wrapper: unknown, fromPrefix: string, toPrefix: string): ValidationIssue[] {
  const v = studioValidator(schemaUrl);
  if (v(wrapper)) return [];
  return classifySchemaV2Errors(rootId, wrapper, v.errors).map((i) => ({
    ...i,
    pointer: i.pointer.startsWith(fromPrefix) ? `${toPrefix}${i.pointer.slice(fromPrefix.length)}` : i.pointer,
  }));
}

const WRAP_TARGET = { documentId: "x" };

export function validateBlockV2(block: unknown, pointer = "/block"): ValidationIssue[] {
  const wrapper = { $schema: "studio.chapter/v2", target: WRAP_TARGET, chapter: { key: "1", title: { text: "x" }, sections: [{ title: { text: "x" }, blocks: [block] }] } };
  return validateWrapped("studio.chapter/v2", CHAPTER_V2_SCHEMA_ID, wrapper, "/chapter/sections/0/blocks/0", pointer);
}

export function validateSectionV2(section: unknown, pointer = "/section"): ValidationIssue[] {
  const wrapper = { $schema: "studio.chapter/v2", target: WRAP_TARGET, chapter: { key: "1", title: { text: "x" }, sections: [section] } };
  return validateWrapped("studio.chapter/v2", CHAPTER_V2_SCHEMA_ID, wrapper, "/chapter/sections/0", pointer);
}

export function validateChapterV2(chapter: unknown, pointer = "/chapter"): ValidationIssue[] {
  const wrapper = { $schema: "studio.chapter/v2", target: WRAP_TARGET, chapter };
  return validateWrapped("studio.chapter/v2", CHAPTER_V2_SCHEMA_ID, wrapper, "/chapter", pointer);
}

export function validateMetaV2(meta: unknown, pointer = "/meta"): ValidationIssue[] {
  const wrapper = { $schema: "studio.slot/v2", target: WRAP_TARGET, slot: "x", payload: { type: "ruleIndex" }, meta };
  return validateWrapped("studio.slot/v2", SLOT_V2_SCHEMA_ID, wrapper, "/meta", pointer);
}

export function validateOutlineV2(outline: unknown, pointer = "/outline"): ValidationIssue[] {
  const wrapper = { $schema: "studio.doc/v2", template: { slug: "x" }, meta: { title: "x" }, sections: { x: { type: "chapter", outline } } };
  return validateWrapped("studio.doc/v2", DOC_V2_SCHEMA_ID, wrapper, "/sections/x/outline", pointer);
}

// ── Bagian bersama ───────────────────────────────────────────────────────

/** 400 CHANGE_FIELDS_REQUIRED bila apa/mengapa/dampak kosong (D-06: PATCH wajib `change`). */
export function requireChangeV2(raw: unknown, max = CHANGE_V2_FIELD_MAX): ChangeV2 {
  const c = isObj(raw) ? raw : {};
  const missing: ValidationIssue[] = [];
  const val = (k: "what" | "why" | "impact") => {
    const v = typeof c[k] === "string" ? (c[k] as string).trim() : "";
    if (!v) missing.push(issue(`/change/${k}`, "required", `change.${k} wajib diisi (apa/mengapa/dampak perubahan)`));
    return v;
  };
  const out = { what: val("what"), why: val("why"), impact: val("impact") };
  if (missing.length) fail("CHANGE_FIELDS_REQUIRED", "Sunting wajib membawa change.what, change.why, dan change.impact", missing);
  const tooLong = (["what", "why", "impact"] as const).filter((k) => out[k].length > max);
  if (tooLong.length) {
    fail("SCHEMA_INVALID", "Badan PATCH tidak sah", tooLong.map((k) => issue(`/change/${k}`, "maxLength", `change.${k} maksimal ${max} karakter`)));
  }
  return out;
}

function baseRevision(raw: unknown, issues: ValidationIssue[]): number {
  if (!Number.isInteger(raw) || (raw as number) < 1) {
    issues.push(issue("/baseRevisionNo", "type", "baseRevisionNo wajib bilangan bulat positif (revisi yang dibaca sebelum menyunting)"));
    return 0;
  }
  return raw as number;
}

/** D-247: sunting tidak memicu build; `render` di badan ditolak dengan arahan endpoint render. */
function rejectRender(raw: unknown, issues: ValidationIssue[]): void {
  if (raw !== undefined) issues.push(renderFieldIssue("/render"));
}

function pidRef(raw: unknown, pointer: string, issues: ValidationIssue[]): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !new RegExp(PID_PATTERN).test(raw)) {
    issues.push(issue(pointer, "pattern", `pid harus cocok dengan pola ${PID_PATTERN}`));
    return undefined;
  }
  return raw;
}

// ── R16 ──────────────────────────────────────────────────────────────────

const PID_BODY_KEYS = new Set(["op", "baseRevisionNo", "block", "section", "chapter", "to", "change"]);

/** Bentuk badan R16 (tanpa cek jenis identitas; itu di layanan, `PID_OP_KIND`). */
export function parsePatchPidBody(raw: unknown, changeMax = CHANGE_V2_FIELD_MAX): PatchPidBody {
  if (!isObj(raw)) fail("SCHEMA_INVALID", "Badan PATCH harus objek", [issue("", "type", "objek diharapkan")]);
  const issues: ValidationIssue[] = [];
  for (const k of Object.keys(raw)) {
    if (k === "render") continue;
    if (!PID_BODY_KEYS.has(k)) issues.push(issue(`/${k}`, "additionalProperties", `medan tidak dikenal: ${k}`));
  }
  if (!(PID_OPS as readonly string[]).includes(raw.op as string)) {
    issues.push(issue("/op", "enum", `op harus salah satu dari ${PID_OPS.join(", ")}`));
  }
  const base = baseRevision(raw.baseRevisionNo, issues);
  if (raw.block !== undefined) issues.push(...validateBlockV2(raw.block));
  if (raw.section !== undefined) issues.push(...validateSectionV2(raw.section));
  if (raw.chapter !== undefined) issues.push(...validateChapterV2(raw.chapter));
  const filled = ["block", "section", "chapter"].filter((k) => raw[k] !== undefined);
  if (filled.length > 1) issues.push(issue(`/${filled[1]}`, "oneOf", "isi hanya satu dari block, section, atau chapter"));
  let to: PidMoveTarget | undefined;
  if (raw.to !== undefined) {
    if (!isObj(raw.to)) {
      issues.push(issue("/to", "type", "to harus objek {before?, after?, section?}"));
    } else {
      const t = raw.to;
      to = { before: pidRef(t.before, "/to/before", issues), after: pidRef(t.after, "/to/after", issues) };
      for (const k of Object.keys(t)) {
        if (!["before", "after", "section"].includes(k)) issues.push(issue(`/to/${k}`, "additionalProperties", `medan tidak dikenal: ${k}`));
      }
      if (t.section !== undefined) {
        const s = t.section;
        if (!isObj(s) || typeof s.chapterKey !== "string" || !s.chapterKey || !Number.isInteger(s.sectionNo) || (s.sectionNo as number) < 0 || !Number.isInteger(s.at) || (s.at as number) < 1) {
          issues.push(issue("/to/section", "type", "to.section = {chapterKey: string, sectionNo: bilangan bulat >= 0 (0 = intro), at: posisi 1-based}"));
        } else {
          to.section = { chapterKey: s.chapterKey, sectionNo: s.sectionNo as number, at: s.at as number };
        }
      }
      const ways = [to.before, to.after, to.section].filter((x) => x !== undefined).length;
      if (ways !== 1) issues.push(issue("/to", "oneOf", "to harus memuat tepat satu dari before, after, atau section"));
    }
  }
  rejectRender(raw.render, issues);
  if (issues.length) fail("SCHEMA_INVALID", schemaInvalidMessage(issues, "Badan PATCH per pid tidak sah"), issues);
  const change = requireChangeV2(raw.change, changeMax);
  return {
    op: raw.op as PidOp,
    baseRevisionNo: base,
    block: raw.block as BlockV2 | undefined,
    section: raw.section as SectionV2 | undefined,
    chapter: raw.chapter as ChapterV2 | undefined,
    to,
    change,
  };
}

// ── R14 ──────────────────────────────────────────────────────────────────

const STRUCTURE_KEYS: Record<StructureOp, string[]> = {
  reorder: ["order"],
  omitSlot: ["slot"],
  restoreSlot: ["slot", "position"],
  setOutline: ["slot", "outline"],
  setMeta: ["meta"],
  renumberChapters: ["slot", "map"],
  templateVersion: ["versionNo"],
};

const SLOT_KEY_RE = /^[a-z][a-zA-Z0-9]{0,31}$/;

export function parsePatchStructureBody(raw: unknown): PatchStructureBody {
  if (!isObj(raw)) fail("SCHEMA_INVALID", "Badan PATCH harus objek", [issue("", "type", "objek diharapkan")]);
  const issues: ValidationIssue[] = [];
  const op = raw.op as StructureOp;
  if (!(STRUCTURE_OPS as readonly string[]).includes(op)) {
    fail("SCHEMA_INVALID", "Badan PATCH struktur tidak sah", [issue("/op", "enum", `op harus salah satu dari ${STRUCTURE_OPS.join(", ")}`)]);
  }
  const allowed = new Set(["op", "baseRevisionNo", "change", ...STRUCTURE_KEYS[op]]);
  for (const k of Object.keys(raw)) if (k !== "render" && !allowed.has(k)) issues.push(issue(`/${k}`, "additionalProperties", `medan tidak dikenal untuk op ${op}: ${k}`));
  const base = baseRevision(raw.baseRevisionNo, issues);
  const slotOf = (v: unknown, pointer: string, required: boolean): string | undefined => {
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || !SLOT_KEY_RE.test(v)) {
      issues.push(issue(pointer, "pattern", "kunci slot harus cocok dengan ^[a-z][a-zA-Z0-9]{0,31}$"));
      return undefined;
    }
    return v;
  };
  switch (op) {
    case "reorder":
      if (!Array.isArray(raw.order) || raw.order.length === 0) issues.push(issue("/order", "type", "order wajib larik kunci slot"));
      else raw.order.forEach((s, i) => slotOf(s, `/order/${i}`, true));
      break;
    case "omitSlot":
      slotOf(raw.slot, "/slot", true);
      break;
    case "restoreSlot":
      slotOf(raw.slot, "/slot", true);
      if (raw.position !== undefined && (!Number.isInteger(raw.position) || (raw.position as number) < 1)) {
        issues.push(issue("/position", "type", "position harus bilangan bulat >= 1"));
      }
      break;
    case "setOutline":
      slotOf(raw.slot, "/slot", false);
      if (raw.outline !== null) {
        if (!Array.isArray(raw.outline)) issues.push(issue("/outline", "type", "outline wajib larik OutlineEntryV2 atau null"));
        else issues.push(...validateOutlineV2(raw.outline));
      }
      break;
    case "setMeta":
      if (!isObj(raw.meta) || Object.keys(raw.meta).length === 0) issues.push(issue("/meta", "type", "meta wajib objek DocMetaV2 tidak kosong"));
      else issues.push(...validateMetaV2(raw.meta));
      break;
    case "renumberChapters":
      slotOf(raw.slot, "/slot", false);
      if (!isObj(raw.map) || Object.keys(raw.map).length === 0) issues.push(issue("/map", "type", "map wajib objek {kunciLama: kunciBaru}"));
      else for (const [k, v] of Object.entries(raw.map)) {
        if (typeof v !== "string" || !v || v.length > 16) issues.push(issue(`/map/${k}`, "type", "kunci bab baru wajib string 1..16 karakter"));
      }
      break;
    case "templateVersion":
      if (!Number.isInteger(raw.versionNo) || (raw.versionNo as number) < 1) issues.push(issue("/versionNo", "type", "versionNo wajib bilangan bulat positif"));
      break;
  }
  rejectRender(raw.render, issues);
  if (issues.length) fail("SCHEMA_INVALID", schemaInvalidMessage(issues, "Badan PATCH struktur tidak sah"), issues);
  const change = requireChangeV2(raw.change);
  return { ...(raw as object), op, baseRevisionNo: base, change } as PatchStructureBody;
}
