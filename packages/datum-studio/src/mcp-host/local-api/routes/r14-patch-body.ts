/**
 * Validasi badan PATCH R14 `/api/studio/documents/[id]/structure` (SR-22;
 * register 03 §12 R14, E33 `STRUCTURE_OPS`, §9.2, §11.1 butir 2).
 *
 * Hanya BENTUK (400 `SCHEMA_INVALID`): op dikenal, `baseRevisionNo` bulat
 * positif, medan per op wajib/dilarang, fragmen v2 (`DocMetaV2`,
 * `OutlineEntryV2`) lewat `$defs` common/v2 (Ajv bersama SR-55 M8) + pemeta tunggal
 * `classifySchemaV2Errors` (DISPLAY_FIELD / V1_FIELD). D-247: `render` ditolak
 * (`checkId: "RENDER_FIELD"`, build lewat endpoint render). Aturan struktur
 * (422 `SLOT_*`, `CHAPTER_KEY_INVALID`) dan konflik lingkup (409) milik layanan
 * (`patchStructure`, SR-14 -> `validateStructure`, SR-08).
 *
 * Swarm port (row 31b): clone C/src/app/api/studio/documents/[id]/structure/_lib/patch-body.ts, verbatim
 * (its imports are all vendored).
 */
import type { ErrorObject } from "ajv/dist/2020";
import {
  COMMON_V2_SCHEMA_ID,
  STRUCTURE_OPS,
  SLOT_KEY_PATTERN,
  classifySchemaV2Errors,
  renderFieldIssue,
  type ChangeV2,
  type DocMetaV2,
  type OutlineEntryV2,
  type StructureOp,
} from "@/lib/studio/contract";
import type { ValidationIssue } from "@/lib/studio/contract/types/api";
import { isPlainObject } from "@/lib/studio/http";
import { studioValidator } from "@/lib/studio/services/ingest/validate";

/** Batas bentuk lokal (bukan aturan struktur). */
export const STRUCTURE_ORDER_MAX = 64;
export const RENUMBER_MAP_MAX = 999;
export const OUTLINE_MAX = 999;
export const CHAPTER_KEY_MAX = 16;
export const AGENT_ID_MAX = 80;

/** Badan PATCH tervalidasi bentuk; diteruskan apa adanya ke `patchStructure` (I50). */
export interface StructurePatchInput {
  op: StructureOp;
  baseRevisionNo: number;
  change: ChangeV2;
  /** reorder */
  order?: string[];
  /** omitSlot / restoreSlot (wajib); setOutline / renumberChapters (opsional) */
  slot?: string;
  /** restoreSlot */
  position?: number;
  /** setOutline (`null` = hapus outline) */
  outline?: OutlineEntryV2[] | null;
  /** setMeta */
  meta?: DocMetaV2;
  /** renumberChapters (ADMIN) */
  map?: Record<string, string>;
  /** templateVersion */
  versionNo?: number;
}

const COMMON_FIELDS = ["op", "baseRevisionNo", "change", "agentId"] as const;

/** Medan per op: wajib + opsional (selain COMMON_FIELDS). */
const OP_FIELDS: Readonly<Record<StructureOp, { required: readonly string[]; optional: readonly string[] }>> = {
  reorder: { required: ["order"], optional: [] },
  omitSlot: { required: ["slot"], optional: [] },
  restoreSlot: { required: ["slot"], optional: ["position"] },
  setOutline: { required: ["outline"], optional: ["slot"] },
  setMeta: { required: ["meta"], optional: [] },
  renumberChapters: { required: ["map"], optional: ["slot"] },
  templateVersion: { required: ["versionNo"], optional: [] },
};

const SLOT_KEY_RE = new RegExp(SLOT_KEY_PATTERN);

/** Fragmen kontrak hilang = cacat server (`studioValidator` melempar Error -> 500 oleh failure()). */
function fragment(def: "DocMetaV2" | "OutlineEntryV2") {
  return studioValidator(`${COMMON_V2_SCHEMA_ID}#/$defs/${def}`);
}

/**
 * Validasi fragmen; galat ajv diberi awalan pointer lalu diklasifikasi terhadap
 * akar `studio.doc/v2` (lokasi `/meta` = DocMetaV2, sama dengan dokumen).
 */
function checkFragment(def: "DocMetaV2" | "OutlineEntryV2", value: unknown, pointer: string): ValidationIssue[] {
  const v = fragment(def);
  if (v(value)) return [];
  const errors = (v.errors ?? []).map((e: ErrorObject) => ({ ...e, instancePath: `${pointer}${e.instancePath}` }));
  // Data dibungkus agar pointer berawalan `pointer` menunjuk nilai yang sama.
  const wrapped = pointer === "/meta" ? { meta: value } : setAt(pointer, value);
  return classifySchemaV2Errors("studio.doc/v2", wrapped, errors);
}

/** `{a: {b: [value]}}` untuk pointer `/a/b/0` (hanya untuk lokasi pemeta). */
function setAt(pointer: string, value: unknown): unknown {
  const segs = pointer.split("/").slice(1);
  let out: unknown = value;
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (/^\d+$/.test(s)) {
      const arr: unknown[] = [];
      arr[Number(s)] = out;
      out = arr;
    } else {
      out = { [s]: out };
    }
  }
  return out;
}

function issue(pointer: string, keyword: string, message: string): ValidationIssue {
  return { pointer, keyword, message };
}

function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function checkSlotKey(v: unknown, pointer: string, out: ValidationIssue[]): void {
  if (typeof v !== "string" || !SLOT_KEY_RE.test(v)) out.push(issue(pointer, "pattern", `must be a slot key matching ${SLOT_KEY_PATTERN}`));
}

export type ParseResult = { ok: true; value: StructurePatchInput; agentId?: string } | { ok: false; issues: ValidationIssue[] };

/**
 * Validasi bentuk badan PATCH. `change` sudah dicek lengkap oleh route
 * (400 CHANGE_FIELDS_REQUIRED, D-06) sebelum fungsi ini dipanggil.
 */
export function parseStructurePatch(b: Record<string, unknown>, change: ChangeV2): ParseResult {
  const issues: ValidationIssue[] = [];

  const op = b.op;
  const opOk = typeof op === "string" && (STRUCTURE_OPS as readonly string[]).includes(op);
  if (!opOk) issues.push(issue("/op", "enum", `must be one of ${STRUCTURE_OPS.join(", ")}`));

  if (!isPosInt(b.baseRevisionNo)) {
    issues.push(issue("/baseRevisionNo", "required", "must be a positive integer (revision the change is based on)"));
  }
  if (b.agentId !== undefined && (typeof b.agentId !== "string" || b.agentId.length === 0 || b.agentId.length > AGENT_ID_MAX)) {
    issues.push(issue("/agentId", "type", `must be a non-empty string of at most ${AGENT_ID_MAX} characters`));
  }
  // D-247: sunting struktur tidak memicu build.
  if (b.render !== undefined) issues.push(renderFieldIssue("/render"));

  if (!opOk) return { ok: false, issues };
  const o = op as StructureOp;
  const spec = OP_FIELDS[o];
  const allowed = new Set<string>([...COMMON_FIELDS, ...spec.required, ...spec.optional]);
  for (const k of Object.keys(b)) {
    if (k !== "render" && !allowed.has(k)) issues.push(issue(`/${k}`, "additionalProperties", `is not accepted for op ${o}`));
  }
  for (const k of spec.required) {
    if (b[k] === undefined) issues.push(issue(`/${k}`, "required", `is required for op ${o}`));
  }

  if (b.order !== undefined && allowed.has("order")) {
    if (!Array.isArray(b.order) || b.order.length === 0 || b.order.length > STRUCTURE_ORDER_MAX) {
      issues.push(issue("/order", "type", `must be a non-empty array of at most ${STRUCTURE_ORDER_MAX} slot keys`));
    } else {
      // Kunci ganda bukan galat bentuk: 422 SLOT_DUPLICATE dari layanan (EC03).
      b.order.forEach((k, i) => checkSlotKey(k, `/order/${i}`, issues));
    }
  }
  if (b.slot !== undefined && allowed.has("slot")) checkSlotKey(b.slot, "/slot", issues);
  if (b.position !== undefined && allowed.has("position") && !isPosInt(b.position)) {
    issues.push(issue("/position", "type", "must be a positive integer (1-based slot position)"));
  }
  if (b.outline !== undefined && b.outline !== null && allowed.has("outline")) {
    if (!Array.isArray(b.outline) || b.outline.length > OUTLINE_MAX) {
      issues.push(issue("/outline", "type", `must be null or an array of at most ${OUTLINE_MAX} outline entries`));
    } else {
      b.outline.forEach((e, i) => issues.push(...checkFragment("OutlineEntryV2", e, `/outline/${i}`)));
    }
  }
  if (b.meta !== undefined && allowed.has("meta")) {
    if (!isPlainObject(b.meta) || Object.keys(b.meta).length === 0) {
      issues.push(issue("/meta", "minProperties", "must be a non-empty meta object"));
    } else {
      issues.push(...checkFragment("DocMetaV2", b.meta, "/meta"));
    }
  }
  if (b.map !== undefined && allowed.has("map")) {
    const entries = isPlainObject(b.map) ? Object.entries(b.map) : null;
    if (!entries || entries.length === 0 || entries.length > RENUMBER_MAP_MAX) {
      issues.push(issue("/map", "type", `must be an object of 1..${RENUMBER_MAP_MAX} "oldKey": "newKey" pairs`));
    } else {
      for (const [from, to] of entries) {
        if (from.length === 0 || from.length > CHAPTER_KEY_MAX || typeof to !== "string" || to.length === 0 || to.length > CHAPTER_KEY_MAX) {
          issues.push(issue(`/map/${from.replace(/~/g, "~0").replace(/\//g, "~1")}`, "type", `chapter keys must be strings of 1..${CHAPTER_KEY_MAX} characters`));
        }
      }
    }
  }
  if (b.versionNo !== undefined && allowed.has("versionNo") && !isPosInt(b.versionNo)) {
    issues.push(issue("/versionNo", "type", "must be a positive integer (template version number)"));
  }

  if (issues.length > 0) return { ok: false, issues };

  const value: StructurePatchInput = { op: o, baseRevisionNo: b.baseRevisionNo as number, change };
  if (b.order !== undefined) value.order = b.order as string[];
  if (b.slot !== undefined) value.slot = b.slot as string;
  if (b.position !== undefined) value.position = b.position as number;
  if (b.outline !== undefined) value.outline = b.outline as OutlineEntryV2[] | null;
  if (b.meta !== undefined) value.meta = b.meta as DocMetaV2;
  if (b.map !== undefined) value.map = b.map as Record<string, string>;
  if (b.versionNo !== undefined) value.versionNo = b.versionNo as number;
  return { ok: true, value, ...(typeof b.agentId === "string" ? { agentId: b.agentId } : {}) };
}
