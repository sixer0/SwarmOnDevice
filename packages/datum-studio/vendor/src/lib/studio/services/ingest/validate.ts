/**
 * Validasi skema JSON v1 (KS-01, §3.10) dan batas masukan (C11-C14) untuk
 * layanan ingest (S48).
 *
 * Ajv dibangun SEKALI dari `STUDIO_SCHEMA_LOAD_ORDER` dan `STUDIO_AJV_OPTIONS`
 * milik kontrak (permintaan S03 yang dirutekan ke S48): tidak ada konfigurasi
 * ajv lokal. Galat dikembalikan sebagai `ValidationIssue` berpointer
 * (`instancePath`, JSON Pointer).
 */
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import {
  STUDIO_AJV_OPTIONS,
  STUDIO_MAX_ASSETS_PER_DOC,
  STUDIO_MAX_RUN_CHARS,
  STUDIO_MAX_TABLE_CELLS,
  STUDIO_SCHEMA_IDS,
  STUDIO_SCHEMA_LOAD_ORDER,
  TABLE_BLOCK_TYPES,
  classifySchemaV2Errors,
  figureTextErrorsV2,
  type SchemaV2RootId,
  type StudioSchemaId,
  type ValidationIssue,
} from "../../contract";
import { STUDIO_SCHEMA_URL_BASE } from "../../contract/schema/common.schema";
import { StudioEngineError } from "../../contract/errors";
import { isObject, joinPointer } from "./util";

/** Batas jumlah isu yang dikembalikan per validasi (allErrors bisa meledak pada oneOf). */
export const MAX_SCHEMA_ISSUES = 500;
/** A6: agentId maks 80 karakter. */
export const AGENT_ID_MAX = 80;

let ajvInstance: Ajv2020 | null = null;
const validators = new Map<string, ValidateFunction>();

/**
 * SR-55 M8 (FIX-S): SATU instans Ajv Studio per proses (lazy), dipakai ingest,
 * sunting v2, dan route R08/R12/R13/R14. Opsi dan urutan muat dari kontrak.
 */
export function studioAjv(): Ajv2020 {
  if (ajvInstance) return ajvInstance;
  const ajv = new Ajv2020({ ...STUDIO_AJV_OPTIONS });
  for (const schema of STUDIO_SCHEMA_LOAD_ORDER) ajv.addSchema(schema as unknown as AnySchema);
  ajvInstance = ajv;
  return ajv;
}

const refValidators = new Map<string, ValidateFunction>();

/** Rujukan skema v2 yang dapat memuat blok figur (dokumen, kiriman bab/slot, fragmen `common/v2`). */
const FIGURE_V2_REF = /\/(studio\.(doc|chapter|slot)\/v2|common\/v2)\.json(#|$)/;

/**
 * SEC-FIX3 N-5 (D-508): validator v2 + batas teks figur render (`figureTextErrorsV2`) SESUDAH ajv, sehingga setiap
 * pemanggil validator bersama (R04, R08, R12/R13, R16/R06/R14, importer) menolak caption/sumber figur yang akan
 * dilewati render, lewat pola yang sama (`v(data) ? [] : classifySchemaV2Errors(..., v.errors)`). Galat semu
 * ditambahkan juga bila ajv gagal, agar agen melihat semua perbaikan dalam satu respons.
 */
function withFigureText(v: ValidateFunction): ValidateFunction {
  const wrapped = ((data: unknown) => {
    const ok = v(data);
    const extra = figureTextErrorsV2(data) as ErrorObject[];
    const base = ok ? [] : (v.errors ?? []);
    wrapped.errors = base.length + extra.length > 0 ? [...base, ...extra] : null;
    return ok && extra.length === 0;
  }) as ValidateFunction;
  // Medan validator ajv lain (schema, schemaEnv, evaluated, source) diteruskan apa adanya.
  for (const k of Object.keys(v) as Array<keyof ValidateFunction>) if (k !== "errors") (wrapped as unknown as Record<string, unknown>)[k] = v[k];
  return wrapped;
}

/**
 * Validator ter-cache untuk rujukan skema penuh (`<base>/<id>.json` atau
 * `<id skema>#/$defs/<Nama>`) di instans bersama. Skema tidak terdaftar atau gagal
 * dikompilasi = cacat server (Error biasa -> 500 di route), bukan galat masukan.
 */
export function studioValidator(ref: string): ValidateFunction {
  const hit = refValidators.get(ref);
  if (hit) return hit;
  let v: ValidateFunction | undefined;
  try {
    v = studioAjv().getSchema(ref);
  } catch (e) {
    throw new Error(`studio schema ${ref} failed to compile: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!v) throw new Error(`studio schema ${ref} is not registered in ajv`);
  const out = FIGURE_V2_REF.test(ref) ? withFigureText(v) : v;
  refValidators.set(ref, out);
  return out;
}

function getAjv(): Ajv2020 {
  return studioAjv();
}

export function schemaUrl(id: StudioSchemaId): string {
  return `${STUDIO_SCHEMA_URL_BASE}/${id}.json`;
}

export function isStudioSchemaId(id: string): id is StudioSchemaId {
  return (STUDIO_SCHEMA_IDS as readonly string[]).includes(id);
}

function getValidator(id: StudioSchemaId): ValidateFunction {
  const hit = validators.get(id);
  if (hit) return hit;
  let v: ValidateFunction | undefined;
  try {
    v = getAjv().getSchema(schemaUrl(id));
  } catch (e) {
    // Skema kontrak gagal dikompilasi = cacat server, bukan galat masukan.
    throw new StudioEngineError("SCHEMA_INVALID", `Skema ${id} gagal dikompilasi: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!v) throw new StudioEngineError("SCHEMA_INVALID", `Skema ${id} tidak terdaftar di ajv`);
  const out = FIGURE_V2_REF.test(schemaUrl(id)) ? withFigureText(v) : v;
  validators.set(id, out);
  return out;
}

function describe(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  if (e.keyword === "additionalProperties" && typeof p.additionalProperty === "string") {
    return `${e.message ?? "additionalProperties"}: "${p.additionalProperty}"`;
  }
  if (e.keyword === "enum" && Array.isArray(p.allowedValues)) {
    return `${e.message ?? "enum"}: ${p.allowedValues.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  if (e.keyword === "const" && "allowedValue" in p) return `${e.message ?? "const"}: ${JSON.stringify(p.allowedValue)}`;
  return e.message ?? e.keyword;
}

/** Petakan galat ajv ke ValidationIssue (dedup pointer+keyword+pesan, dibatasi). */
export function ajvIssues(errors: readonly ErrorObject[] | null | undefined, prefix = ""): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const e of errors ?? []) {
    const issue: ValidationIssue = { pointer: prefix + e.instancePath, keyword: e.keyword, message: describe(e) };
    const k = `${issue.pointer}\u0000${issue.keyword}\u0000${issue.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(issue);
    if (out.length >= MAX_SCHEMA_ISSUES) {
      out.push({ pointer: prefix, keyword: "maxIssues", message: `Isu skema dipotong pada ${MAX_SCHEMA_ISSUES}` });
      break;
    }
  }
  return out;
}

/** ajv 2020 dengan STUDIO_AJV_OPTIONS; galat -> ValidationIssue berpointer (relatif `data`). */
export function validateAgainst(schemaId: string, data: unknown, prefix = ""): ValidationIssue[] {
  if (!isStudioSchemaId(schemaId)) {
    return [{ pointer: prefix, keyword: "schemaId", message: `Id skema tidak dikenal: ${schemaId}` }];
  }
  const v = getValidator(schemaId);
  return v(data) ? [] : ajvIssues(v.errors, prefix);
}

/**
 * SR-12: validasi skema kontrak v2 (SID01-SID05) dengan ajv yang SAMA, galat
 * dipetakan lewat pemeta tunggal `classifySchemaV2Errors` kontrak (D-172):
 * issue `checkId: "DISPLAY_FIELD"` / `"V1_FIELD"` untuk medan tampilan atau
 * medan v1 berganti nama. Pointer relatif `data` dengan `prefix`.
 */
export function validateV2Against(schemaId: SchemaV2RootId, data: unknown, prefix = ""): ValidationIssue[] {
  const v = getValidator(schemaId);
  if (v(data)) return [];
  const issues = classifySchemaV2Errors(schemaId, data, v.errors, prefix);
  if (issues.length > MAX_SCHEMA_ISSUES) {
    return [...issues.slice(0, MAX_SCHEMA_ISSUES), { pointer: prefix, keyword: "maxIssues", message: `Isu skema dipotong pada ${MAX_SCHEMA_ISSUES}` }];
  }
  return issues;
}

/**
 * Bentuk badan `StudioIngestRequest` (§3.3) di luar dokumen: objek, `agentId`
 * maks 80, `render` sesuai `$defs.StudioIngestRequest`. Pointer relatif badan.
 */
export function validateRequestEnvelope(req: unknown): ValidationIssue[] {
  if (!isObject(req)) return [{ pointer: "", keyword: "type", message: "Badan permintaan harus objek StudioIngestRequest" }];
  const issues: ValidationIssue[] = [];
  const allowed = new Set(["agentId", "document", "render"]);
  for (const k of Object.keys(req)) {
    if (!allowed.has(k)) issues.push({ pointer: "", keyword: "additionalProperties", message: `must NOT have additional properties: "${k}"` });
  }
  if (req.agentId !== undefined && (typeof req.agentId !== "string" || req.agentId.length > AGENT_ID_MAX)) {
    issues.push({ pointer: "/agentId", keyword: "maxLength", message: `agentId harus string maks ${AGENT_ID_MAX} karakter` });
  }
  if (!("document" in req)) issues.push({ pointer: "", keyword: "required", message: "must have required property 'document'" });
  if (req.render !== undefined) {
    const formats = new Set(["docx", "pdf", "html"]);
    const figures = new Set(["svg", "png"]);
    const r = req.render;
    if (!isObject(r)) {
      issues.push({ pointer: "/render", keyword: "type", message: "render harus objek" });
    } else {
      for (const k of Object.keys(r)) {
        if (k !== "formats" && k !== "figures") issues.push({ pointer: "/render", keyword: "additionalProperties", message: `must NOT have additional properties: "${k}"` });
      }
      const checkList = (key: "formats" | "figures", allow: ReadonlySet<string>) => {
        const v = r[key];
        if (v === undefined) return;
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !allow.has(x)) || new Set(v).size !== v.length) {
          issues.push({ pointer: `/render/${key}`, keyword: "enum", message: `render.${key} hanya ${[...allow].join(", ")} tanpa duplikat` });
        }
      };
      checkList("formats", formats);
      checkList("figures", figures);
    }
  }
  return issues;
}

/** Hitung sel (paragraf kosong pun satu sel) tabel termasuk tabel bersarang. */
function countCells(table: Record<string, unknown>): number {
  let n = 0;
  for (const row of Array.isArray(table.rows) ? table.rows : []) {
    if (!isObject(row) || !Array.isArray(row.cells)) continue;
    for (const cell of row.cells) {
      n += 1;
      if (isObject(cell) && isObject(cell.nested)) n += countCells(cell.nested);
    }
  }
  return n;
}

const TABLE_TYPES: ReadonlySet<string> = new Set<string>(TABLE_BLOCK_TYPES);

/**
 * Batas C11 (aset per dokumen), C13 (sel per tabel), C14 (karakter per run
 * atau `text`). C12 (blok per dokumen) dihitung normalisasi. Pointer relatif
 * dokumen dengan `prefix`.
 */
export function limitIssues(doc: unknown, prefix = ""): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isObject(doc)) return issues;
  if (isObject(doc.assets) && Object.keys(doc.assets).length > STUDIO_MAX_ASSETS_PER_DOC) {
    issues.push({ pointer: `${prefix}/assets`, keyword: "maxLimit", message: `Aset per dokumen maks ${STUDIO_MAX_ASSETS_PER_DOC}` });
  }
  const walk = (node: unknown, ptr: string): void => {
    if (issues.length >= MAX_SCHEMA_ISSUES) return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, joinPointer(ptr, i)));
      return;
    }
    if (!isObject(node)) return;
    if (typeof node.type === "string" && TABLE_TYPES.has(node.type) && Array.isArray(node.rows)) {
      const cells = countCells(node);
      if (cells > STUDIO_MAX_TABLE_CELLS) {
        issues.push({ pointer: ptr, keyword: "maxLimit", message: `Tabel memuat ${cells} sel; maks ${STUDIO_MAX_TABLE_CELLS}` });
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if ((k === "t" || k === "text") && typeof v === "string" && v.length > STUDIO_MAX_RUN_CHARS) {
        issues.push({ pointer: joinPointer(ptr, k), keyword: "maxLimit", message: `Teks ${v.length} karakter; maks ${STUDIO_MAX_RUN_CHARS} per run` });
      } else if (k !== "x" && v !== null && typeof v === "object") {
        walk(v, joinPointer(ptr, k));
      }
    }
  };
  walk(doc, prefix);
  return issues;
}
