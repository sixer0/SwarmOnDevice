/**
 * Swarm template service (row 66; masterplan/01_specs_studio_templates.md §2-§4 and §6 with the C13
 * and U16 amendments; decisions C54, C58).
 *
 * - Create a user template by **copy** (`from {slug, version?}`: version 1 = the source definition byte
 *   for byte, `base_version_id` = the source version) or **from scratch** (`template`: a full
 *   `studio.template/v2` on a builtin preset).
 * - **Update** a user template: a full `template`, a new `skeleton` (slots, section types, slot params
 *   and slot role formats), or `changes` (template-level params, role formats, unset). Every change is
 *   a new immutable `template_version` row (store triggers, row 64); `baseVersionNo` must be the
 *   latest (`BASE_CONFLICT`).
 * - Every candidate passes, in order: input limits (§6) -> `studio.template/v2` schema -> contract-
 *   record skeleton rule -> builtin preset -> the form lock P1-P9 + §3.2 + §3.3 (`./form-lock`) ->
 *   Studio's fold (`foldTemplateDefinition`, the same code that folds the builtins) -> the template
 *   guard (seam for row 67) -> one short store job (insert + `BASE_CONFLICT` re-check).
 * - The local caller is a non-admin INTERNAL_AGENT (C58). It may create, update and archive `user-`
 *   templates within the lock. No caller kind opens the lock.
 *
 * Guard seam: row 67 installs the guard with `configureTemplateGuard`. Until one is installed every
 * save is refused before any other check (FORBIDDEN, `swarmCode` GUARD_UNAVAILABLE, reason
 * `GUARD_NOT_CONFIGURED`), so no unguarded user version can exist (spec §5.2: "A stored user version has
 * therefore always passed the guard").
 */
import { randomUUID } from "node:crypto";
import type { ParamValue, StudioCaller, StudioSkeletonV1, StudioTemplateV2, StudioTier } from "../../contract";
import type { StudioErrorCode } from "../../contract/enums";
import { StudioEngineError } from "../../contract/errors";
import { contractRecordSkeletonIssues } from "../../registry/slots";
import {
  findTemplateById,
  findTemplateBySlug,
  findTemplateVersionById,
  findTemplateVersionByNo,
  isStoreError,
  isUniqueViolation,
  readWith,
  studioStore,
  withStudioTx,
  type StudioTemplate,
  type StudioTemplateVersion,
  type StudioTx,
} from "../_swarm-store";
import { skeletonForInsert } from "../skeleton/repository";
import { assertTemplateUsable } from "./access";
import {
  collectParamChanges,
  type LockIssue,
  paramLockIssues,
  roleFormatLockIssues,
  skeletonLockIssues,
  sortLockIssues,
  templateTierOf,
} from "./form-lock";
import {
  type CreateTemplateV2Input,
  type CreateTemplateVersionV2Input,
  ensureBuiltinTemplates,
  foldTemplateDefinition,
  presetFoldBase,
  toSummary,
  toVersionDto,
  type TemplateSummaryAccess,
  type TemplateV2SaveResult,
  type TemplateVersionDtoAccess,
} from "./index";
import { templatesLog } from "./log";
import { DATUM_CANONICAL_SLUG, isPlainObject, sha256Hex, stableStringify, TEMPLATE_NAME_MAX, type VersionPayload } from "./profile";
import { parseTemplateV2, throwSchemaIssues } from "./v2";

type ParamRecord = Record<string, ParamValue>;

// ── Errors ───────────────────────────────────────────────────────────────

/** Swarm codes of the templates spec §6 ("new in this spec"), plus the kept store codes. */
export type TemplateServiceCode =
  | "TEMPLATE_FORM_LOCKED"
  | "TEMPLATE_KIND_UNSUPPORTED"
  | "TEMPLATE_ARCHIVED"
  | "TEMPLATE_LIMIT"
  | "TEMPLATE_SLUG_TAKEN"
  | "TEMPLATE_READ_ONLY"
  | "BASE_CONFLICT"
  | "GUARD_REJECTED"
  | "GUARD_UNAVAILABLE"
  | "INPUT_TOO_LARGE";

/** Studio code (HTTP status of the local API, row 31) per Swarm code; the Swarm code rides in `details.swarmCode`. */
const STUDIO_CODE_OF: Record<TemplateServiceCode, StudioErrorCode> = {
  TEMPLATE_FORM_LOCKED: "FORBIDDEN",
  TEMPLATE_KIND_UNSUPPORTED: "SCHEMA_INVALID",
  TEMPLATE_ARCHIVED: "FORBIDDEN",
  TEMPLATE_LIMIT: "FORBIDDEN",
  TEMPLATE_SLUG_TAKEN: "TEMPLATE_SLUG_EXISTS",
  TEMPLATE_READ_ONLY: "FORBIDDEN",
  BASE_CONFLICT: "VERSION_CONFLICT",
  GUARD_REJECTED: "BY_CONSTRUCTION_FAILED",
  GUARD_UNAVAILABLE: "FORBIDDEN",
  INPUT_TOO_LARGE: "PAYLOAD_TOO_LARGE",
};

/**
 * A StudioEngineError (so every existing mapper, e.g. `studioErrorFrom`, keeps a valid HTTP status)
 * that carries the Swarm code of the templates spec. `templateErrorCode(e)` gives the tool code.
 */
export class TemplateServiceError extends StudioEngineError {
  readonly swarmCode: TemplateServiceCode;
  constructor(swarmCode: TemplateServiceCode, message: string, details: Record<string, unknown> = {}) {
    super(STUDIO_CODE_OF[swarmCode], message, { swarmCode, ...details });
    this.name = "TemplateServiceError";
    this.swarmCode = swarmCode;
  }
}

/** The code a template tool reports: the Swarm code when there is one, else the Studio code. */
export function templateErrorCode(e: unknown): string | undefined {
  if (e instanceof TemplateServiceError) return e.swarmCode;
  if (e instanceof StudioEngineError) return e.code;
  return undefined;
}

// ── Guard seam (row 67) ──────────────────────────────────────────────────

export interface TemplateGuardInput {
  op: "create" | "update" | "check";
  slug: string;
  /** Lint tier (U.1 step 4): TERBIT, or SERAH when the candidate's tier is SERAH. */
  lintTier: "TERBIT" | "SERAH";
  /** Base version (copy or update) or `datum-kanonik` latest (from scratch). */
  reference: { slug: string; versionNo: number; versionId: string };
  candidate: { definition: StudioTemplateV2; payload: VersionPayload; skeleton: StudioSkeletonV1; skeletonSha256: string };
  correlationId: string;
}

export type TemplateGuardOutcome =
  | { verdict: "pass" | "warn"; report: unknown; skillSha: string }
  | { verdict: "reject"; report: unknown }
  | { verdict: "unavailable"; reason: string };

export type TemplateGuard = (input: TemplateGuardInput) => Promise<TemplateGuardOutcome>;

let guard: TemplateGuard | null = null;

/** Installed by the host with row 67's guard; `null` removes it (every save is refused again). */
export function configureTemplateGuard(g: TemplateGuard | null): void {
  guard = g;
}

/** Row 67 (additive): the installed guard, or null (the host checks and uninstalls only its own). */
export function installedTemplateGuard(): TemplateGuard | null {
  return guard;
}

function requireGuard(): TemplateGuard {
  if (!guard) {
    throw new TemplateServiceError("GUARD_UNAVAILABLE", "Template writes need the DATUM template guard, which is not installed", { reason: "GUARD_NOT_CONFIGURED" });
  }
  return guard;
}

// ── Limits (spec §6; C13 M4: before schema validation) ───────────────────

export const TEMPLATE_INPUT_LIMITS = {
  argsBytes: 1 << 20,
  templateBytes: 512 * 1024,
  depth: 12,
  arrayItems: 1000,
  stringChars: 4000,
  nameChars: TEMPLATE_NAME_MAX,
  descriptionChars: 2000,
  changeNoteChars: 4000,
  issues: 200,
  issueMessageChars: 300,
  userTemplates: 1000,
  versionsPerTemplate: 1000,
} as const;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// C0 controls except \t \n, DEL, bidi embeddings/overrides U+202A-202E and isolates U+2066-2069.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const USER_SLUG_RE = /^user-[a-z0-9]+(-[a-z0-9]+)*$/;
const ANY_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function limitIssue(pointer: string, message: string): never {
  throwSchemaIssues([{ pointer, keyword: "limit", message }], "Masukan templat tidak sah");
}

function stringProblem(s: string): string | null {
  if (CONTROL_RE.test(s)) return "memuat karakter kendali atau bidi";
  if (LONE_SURROGATE_RE.test(s)) return "memuat surrogate tunggal";
  if (s.normalize("NFC") !== s) return "harus NFC";
  return null;
}

/** Walk untrusted input: byte size, depth, array and string sizes, forbidden keys, control characters. */
export function assertInputLimits(input: unknown): void {
  const raw = JSON.stringify(input ?? null);
  if (Buffer.byteLength(raw, "utf8") > TEMPLATE_INPUT_LIMITS.argsBytes) {
    throw new TemplateServiceError("INPUT_TOO_LARGE", `Masukan lebih dari ${TEMPLATE_INPUT_LIMITS.argsBytes} byte`);
  }
  if (isPlainObject(input) && input.template !== undefined && Buffer.byteLength(stableStringify(input.template), "utf8") > TEMPLATE_INPUT_LIMITS.templateBytes) {
    throw new TemplateServiceError("INPUT_TOO_LARGE", `template lebih dari ${TEMPLATE_INPUT_LIMITS.templateBytes} byte`);
  }
  const walk = (v: unknown, pointer: string, depth: number): void => {
    if (depth > TEMPLATE_INPUT_LIMITS.depth) limitIssue(pointer, `kedalaman lebih dari ${TEMPLATE_INPUT_LIMITS.depth}`);
    if (typeof v === "string") {
      if (v.length > TEMPLATE_INPUT_LIMITS.stringChars) limitIssue(pointer, `string lebih dari ${TEMPLATE_INPUT_LIMITS.stringChars} karakter`);
      const p = stringProblem(v);
      if (p) limitIssue(pointer, `string ${p}`);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > TEMPLATE_INPUT_LIMITS.arrayItems) limitIssue(pointer, `larik lebih dari ${TEMPLATE_INPUT_LIMITS.arrayItems} butir`);
      v.forEach((x, i) => walk(x, `${pointer}/${i}`, depth + 1));
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.has(k)) limitIssue(`${pointer}/${k}`, `kunci terlarang: ${k}`);
        const p = stringProblem(k);
        if (p || k.length > TEMPLATE_INPUT_LIMITS.stringChars) limitIssue(pointer, `kunci ${p ?? "terlalu panjang"}`);
        walk(x, `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1);
      }
    }
  };
  walk(input, "", 0);
}

// ── Input checks ─────────────────────────────────────────────────────────

function assertCaller(caller: StudioCaller | null | undefined): asserts caller is StudioCaller {
  if (!caller || typeof caller.requester !== "string" || caller.requester.length === 0) {
    throw new StudioEngineError("UNAUTHORIZED", "Pemanggil tidak dikenal");
  }
}

function assertUserSlug(slug: unknown): string {
  if (typeof slug !== "string" || slug.length > 64 || !USER_SLUG_RE.test(slug)) {
    throwSchemaIssues([{ pointer: "/slug", keyword: "pattern", message: "slug templat pengguna harus ^user-[a-z0-9]+(-[a-z0-9]+)*$, maks 64" }], "Templat tidak sah");
  }
  return slug;
}

function assertAnySlug(slug: unknown, pointer: string): string {
  if (typeof slug !== "string" || slug.length > 64 || !ANY_SLUG_RE.test(slug)) {
    throwSchemaIssues([{ pointer, keyword: "pattern", message: "slug harus ^[a-z0-9]+(-[a-z0-9]+)*$, maks 64" }], "Templat tidak sah");
  }
  return slug;
}

function assertVersionNo(v: unknown, pointer: string): number {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > TEMPLATE_INPUT_LIMITS.versionsPerTemplate) {
    throwSchemaIssues([{ pointer, keyword: "type", message: `nomor versi harus bilangan bulat 1-${TEMPLATE_INPUT_LIMITS.versionsPerTemplate}` }], "Templat tidak sah");
  }
  return v as number;
}

function assertChangeNote(note: unknown): string {
  if (typeof note !== "string" || note.trim().length === 0) throw new StudioEngineError("CHANGE_NOTE_REQUIRED", "Versi templat wajib memiliki catatan perubahan");
  if (note.length > TEMPLATE_INPUT_LIMITS.changeNoteChars) {
    throwSchemaIssues([{ pointer: "/changeNote", keyword: "maxLength", message: `changeNote maks ${TEMPLATE_INPUT_LIMITS.changeNoteChars} karakter` }], "Templat tidak sah");
  }
  return note.trim();
}

function assertLabels(input: { name?: unknown; description?: unknown }, nameRequired: boolean): void {
  const issues = [];
  if ((nameRequired || input.name !== undefined) && (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > TEMPLATE_INPUT_LIMITS.nameChars)) {
    issues.push({ pointer: "/name", keyword: "maxLength", message: `name wajib, 1-${TEMPLATE_INPUT_LIMITS.nameChars} karakter` });
  }
  if (input.description !== undefined && input.description !== null && (typeof input.description !== "string" || input.description.length > TEMPLATE_INPUT_LIMITS.descriptionChars)) {
    issues.push({ pointer: "/description", keyword: "maxLength", message: `description maks ${TEMPLATE_INPUT_LIMITS.descriptionChars} karakter` });
  }
  if (issues.length > 0) throwSchemaIssues(issues, "Templat tidak sah");
}

function storedDefinition(v: Pick<StudioTemplateVersion, "definition">, slug: string): StudioTemplateV2 {
  const d = v.definition;
  if (!isPlainObject(d) || d.$schema !== "studio.template/v2") {
    throw new StudioEngineError("SCHEMA_INVALID", `Templat ${slug}: versi ini tidak menyimpan definisi studio.template/v2`, { slug });
  }
  return parseTemplateV2(d, "/source");
}

// ── Candidate: schema -> contract rule -> preset -> form lock -> fold ────

interface Candidate {
  definition: StudioTemplateV2;
  definitionSha256: string;
  payload: VersionPayload;
  skeleton: StudioSkeletonV1;
  skeletonSha256: string;
  tier: StudioTier;
  changedKeys: number;
}

const clip = (s: string): string => (s.length > TEMPLATE_INPUT_LIMITS.issueMessageChars ? `${s.slice(0, TEMPLATE_INPUT_LIMITS.issueMessageChars - 1)}…` : s);

function throwLockIssues(issues: readonly LockIssue[]): never {
  const sorted = sortLockIssues(issues);
  const first = sorted[0];
  const list = sorted.slice(0, TEMPLATE_INPUT_LIMITS.issues).map((i) => ({ ...i, message: clip(i.message) }));
  const more = sorted.length > 1 ? ` (+${sorted.length - 1} isu lain)` : "";
  if (first.code === "TEMPLATE_FORM_LOCKED") {
    throw new TemplateServiceError("TEMPLATE_FORM_LOCKED", `Bentuk DATUM terkunci: ${first.message}${more}`, { reason: first.reason, rule: first.rule, issues: list });
  }
  throw new StudioEngineError(first.code, `Templat tidak sah: ${first.message}${more}`, { rule: first.rule, issues: list });
}

/**
 * The full check chain of spec §3 for one candidate. `base` = the definition the changes are
 * measured against (null = from scratch, every key counts); `skeletonBase` = the reference skeleton
 * for §3.3 when `base` is null (datum-kanonik).
 */
export function prepareCandidate(
  definition: StudioTemplateV2,
  base: StudioTemplateV2 | null,
  skeletonBase: Pick<StudioTemplateV2, "skeleton"> | null,
  contractKind: string | null,
): Candidate {
  const contract = contractRecordSkeletonIssues(definition.skeleton.slots, contractKind);
  if (contract.length > 0) throwSchemaIssues(contract, "Templat tidak sah");
  if (!definition.preset) {
    throwSchemaIssues([{ pointer: "/template/preset", keyword: "required", message: "templat pengguna wajib memakai preset gaya bawaan" }], "Templat tidak sah");
  }
  const presetBase = presetFoldBase(definition.preset.slug, definition.preset.version);
  const tier = templateTierOf(definition);
  const changes = collectParamChanges(base, definition);
  const issues = [
    ...paramLockIssues(changes, tier),
    ...roleFormatLockIssues(base, definition, presetBase.roleFormats as Record<string, unknown>),
    ...skeletonLockIssues(base ?? skeletonBase, definition, tier.tier),
  ];
  if (issues.length > 0) throwLockIssues(issues);
  const fold = foldTemplateDefinition(definition, presetBase);
  // The version row is immutable, so the skeleton goes in at insert (row 109 file request).
  const sk = skeletonForInsert(fold.skeleton);
  if (sk.skeletonSha256 !== fold.skeletonSha256) throw new Error("skeleton fold and skeletonForInsert disagree");
  return {
    definition,
    definitionSha256: sha256Hex(stableStringify(definition)),
    payload: fold.payload,
    skeleton: sk.skeleton,
    skeletonSha256: sk.skeletonSha256,
    tier: tier.tier,
    changedKeys: changes.length,
  };
}

// ── Changes (spec §6 `changes`) ──────────────────────────────────────────

export interface TemplateChanges {
  essentials?: Record<string, ParamValue>;
  advanced?: Record<string, ParamValue>;
  roleFormats?: Record<string, unknown>;
  unset?: string[];
}

const CHANGES_FIELDS = ["essentials", "advanced", "roleFormats", "unset"];

/**
 * Base definition + `changes` -> full candidate. A key goes to the layer it is sent in (and leaves the
 * other); `unset` removes a template-level override. A role format change is merged sub-object by
 * sub-object onto the base version's resolved role format (spec §3.2: "base resolved sub-object +
 * changed fields"), because Studio's `overlayRoleFormat` replaces whole sub-objects.
 */
export function applyTemplateChanges(base: StudioTemplateV2, changes: unknown, baseResolvedRoleFormats: Record<string, unknown>): StudioTemplateV2 {
  if (!isPlainObject(changes) || Object.keys(changes).length === 0 || Object.keys(changes).some((k) => !CHANGES_FIELDS.includes(k))) {
    throwSchemaIssues([{ pointer: "/changes", keyword: "additionalProperties", message: `changes harus objek dengan ${CHANGES_FIELDS.join(", ")}` }], "Perubahan tidak sah");
  }
  const c = changes as TemplateChanges;
  for (const f of ["essentials", "advanced", "roleFormats"] as const) {
    if (c[f] !== undefined && !isPlainObject(c[f])) throwSchemaIssues([{ pointer: `/changes/${f}`, keyword: "type", message: `changes.${f} harus objek` }], "Perubahan tidak sah");
  }
  if (c.unset !== undefined && (!Array.isArray(c.unset) || c.unset.length > 200 || c.unset.some((k) => typeof k !== "string" || k.length === 0 || k.length > 200))) {
    throwSchemaIssues([{ pointer: "/changes/unset", keyword: "type", message: "changes.unset harus larik kunci (maks 200)" }], "Perubahan tidak sah");
  }
  const e = { ...(c.essentials ?? {}) };
  const a = { ...(c.advanced ?? {}) };
  const unset = new Set(c.unset ?? []);
  const clash = [...Object.keys(e).filter((k) => k in a || unset.has(k)), ...Object.keys(a).filter((k) => unset.has(k))];
  if (clash.length > 0) throwSchemaIssues(clash.map((k) => ({ pointer: `/changes`, keyword: "duplicateKey", message: `kunci ${k} dikirim lebih dari sekali` })), "Perubahan tidak sah");
  const essentials: ParamRecord = { ...base.essentials };
  const advanced: ParamRecord = { ...(base.advanced ?? {}) };
  for (const k of unset) {
    delete essentials[k];
    delete advanced[k];
  }
  for (const [k, v] of Object.entries(e)) {
    delete advanced[k];
    essentials[k] = v;
  }
  for (const [k, v] of Object.entries(a)) {
    delete essentials[k];
    advanced[k] = v;
  }
  const roleFormats: Record<string, unknown> = { ...((base.roleFormats ?? {}) as Record<string, unknown>) };
  for (const [role, fmt] of Object.entries(c.roleFormats ?? {})) {
    if (!isPlainObject(fmt)) throwSchemaIssues([{ pointer: `/changes/roleFormats/${role}`, keyword: "type", message: `roleFormats.${role} harus objek` }], "Perubahan tidak sah");
    const from = (isPlainObject(roleFormats[role]) ? roleFormats[role] : isPlainObject(baseResolvedRoleFormats[role]) ? baseResolvedRoleFormats[role] : {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = JSON.parse(JSON.stringify(from));
    for (const [sub, val] of Object.entries(fmt)) {
      merged[sub] = isPlainObject(val) && isPlainObject(merged[sub]) ? { ...(merged[sub] as Record<string, unknown>), ...val } : val;
    }
    roleFormats[role] = merged;
  }
  return {
    $schema: "studio.template/v2",
    ...(base.preset ? { preset: base.preset } : {}),
    essentials,
    ...(base.advanced !== undefined || Object.keys(advanced).length > 0 ? { advanced } : {}),
    ...(base.roleFormats !== undefined || Object.keys(roleFormats).length > 0 ? { roleFormats: roleFormats as StudioTemplateV2["roleFormats"] } : {}),
    skeleton: base.skeleton,
  } as StudioTemplateV2;
}

// ── Run, log, map store errors ───────────────────────────────────────────

function mapStoreError(err: unknown): unknown {
  if (isStoreError(err, "BASE_CONFLICT")) return new TemplateServiceError("BASE_CONFLICT", "Versi dasar bukan versi terbaru; muat ulang lalu simpan", { store: (err as { details?: unknown }).details ?? null });
  if (isStoreError(err, "TEMPLATE_READ_ONLY")) return new TemplateServiceError("TEMPLATE_READ_ONLY", "Templat bawaan hanya-baca; salin dulu ke templat user-");
  if (isUniqueViolation(err, "slug")) return new TemplateServiceError("TEMPLATE_SLUG_TAKEN", "Slug templat sudah dipakai");
  if (isStoreError(err, "NOT_FOUND")) return new StudioEngineError("TEMPLATE_NOT_FOUND", "Templat tidak ditemukan");
  if (isStoreError(err, "SCHEMA_INVALID")) return new StudioEngineError("SCHEMA_INVALID", (err as Error).message);
  return err;
}

/** Correlated op: contract errors log warn, unexpected errors log error + stack (persistent sink: `setTemplatesLogSink`). */
async function runServiceOp<T>(op: string, context: Record<string, unknown>, fn: (cid: string) => Promise<T>): Promise<T> {
  const cid = randomUUID();
  try {
    return await fn(cid);
  } catch (raw) {
    const err = mapStoreError(raw);
    if (err instanceof StudioEngineError) {
      templatesLog({ level: "warn", message: `${op}: ${err.message}`, code: templateErrorCode(err), correlationId: cid, context: { op, ...context } });
      throw err;
    }
    templatesLog({
      level: "error",
      message: `${op}: galat tak terduga`,
      code: "INTERNAL",
      correlationId: cid,
      stack_trace: err instanceof Error ? err.stack : undefined,
      context: { op, ...context, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

async function runGuard(g: TemplateGuard, input: TemplateGuardInput): Promise<{ verdict: "pass" | "warn"; report: unknown; skillSha: string }> {
  let out: TemplateGuardOutcome;
  try {
    out = await g(input);
  } catch (err) {
    templatesLog({ level: "error", message: "template guard failed", code: "GUARD_UNAVAILABLE", correlationId: input.correlationId, stack_trace: err instanceof Error ? err.stack : undefined, context: { slug: input.slug, error: err instanceof Error ? err.message : String(err) } });
    throw new TemplateServiceError("GUARD_UNAVAILABLE", "Pemeriksa templat gagal berjalan; tidak ada yang disimpan", { reason: "GUARD_ERROR" });
  }
  if (out?.verdict === "pass" || out?.verdict === "warn") return out;
  if (out?.verdict === "reject") throw new TemplateServiceError("GUARD_REJECTED", "Templat ditolak pemeriksa DATUM; tidak ada yang disimpan", { report: out.report });
  throw new TemplateServiceError("GUARD_UNAVAILABLE", "Pemeriksa templat tidak tersedia; tidak ada yang disimpan", { reason: out && "reason" in out ? out.reason : "GUARD_INVALID_OUTCOME" });
}

function lintTierOf(tier: StudioTier): "TERBIT" | "SERAH" {
  return tier === "SERAH" ? "SERAH" : "TERBIT";
}

function referenceOf(t: Pick<StudioTemplate, "slug">, v: Pick<StudioTemplateVersion, "id" | "versionNo">): TemplateGuardInput["reference"] {
  return { slug: t.slug, versionNo: v.versionNo, versionId: v.id };
}

function canonicalLatest(tx: StudioTx): { t: StudioTemplate; v: StudioTemplateVersion } {
  const t = findTemplateBySlug(tx, DATUM_CANONICAL_SLUG);
  const v = t ? findTemplateVersionByNo(tx, t.id, t.latestVersionNo) : null;
  if (!t || !v) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Templat acuan ${DATUM_CANONICAL_SLUG} tidak ada`);
  return { t, v };
}

function versionContent(c: Candidate, changeNote: string, createdBy: string, guardRecord: { verdict: "pass" | "warn"; report: unknown; skillSha: string }, source: Record<string, unknown> | null) {
  return {
    definition: c.definition,
    definitionSha256: c.definitionSha256,
    overrides: c.payload.overrides,
    resolvedParams: c.payload.resolvedParams,
    paramsSha256: c.payload.paramsSha256,
    roleFormats: c.payload.roleFormats,
    sectionPlan: c.payload.sectionPlan,
    assets: c.payload.assets,
    provenance: { ...c.payload.provenance, origin: "user", preset: c.definition.preset ?? null, source },
    skeleton: c.skeleton,
    skeletonSha256: c.skeletonSha256,
    changeNote,
    createdBy,
    guard: { verdict: guardRecord.verdict, report: guardRecord.report, skillSha: guardRecord.skillSha },
  };
}

export interface UserTemplateSaveResult extends TemplateV2SaveResult {
  /** Verdict saved with the version (null only when an unchanged-definition update returns an older, unguarded version). */
  guard: { verdict: "pass" | "warn" | null; report: unknown };
  changedKeys: number;
  /** true = the definition equals the base: no version was added (only name/description changed). */
  unchanged: boolean;
}

function readSaved(slug: string, versionId: string): Promise<{ template: TemplateSummaryAccess; version: TemplateVersionDtoAccess; row: StudioTemplateVersion }> {
  return readWith(undefined, (tx) => {
    const t = findTemplateBySlug(tx, slug);
    const v = findTemplateVersionById(tx, versionId);
    if (!t || !v) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Templat tidak ditemukan: ${slug}`);
    return { template: toSummary(t, v), version: toVersionDto(v), row: v };
  });
}

// ── Create (copy or from scratch) ────────────────────────────────────────

export interface UserTemplateCreateInput {
  slug: string;
  name: string;
  kind: string;
  description?: string | null;
  changeNote: string;
  from?: { slug: string; version?: number };
  template?: unknown;
}

/** `studio_template_create`: a new `user-` template, version 1 (copy or from scratch). */
export async function createUserTemplateV2(input: UserTemplateCreateInput, caller: StudioCaller): Promise<UserTemplateSaveResult> {
  return runServiceOp("createUserTemplateV2", { slug: input?.slug, from: input?.from ?? null, requester: caller?.requester }, async (cid) => {
    assertCaller(caller);
    const g = requireGuard();
    assertInputLimits(input);
    if (!isPlainObject(input)) throwSchemaIssues([{ pointer: "", keyword: "type", message: "Badan permintaan harus objek" }], "Templat tidak sah");
    const slug = assertUserSlug(input.slug);
    assertLabels(input, true);
    const changeNote = assertChangeNote(input.changeNote);
    if (input.kind !== "DOCUMENT") throw new TemplateServiceError("TEMPLATE_KIND_UNSUPPORTED", "Templat pengguna 1.2.0 hanya jenis DOCUMENT", { kind: input.kind ?? null });
    if ((input.from === undefined) === (input.template === undefined)) {
      throwSchemaIssues([{ pointer: "", keyword: "oneOf", message: "isi tepat satu dari from atau template" }], "Templat tidak sah");
    }
    await ensureBuiltinTemplates();
    const plan = await readWith(undefined, (tx) => {
      if (findTemplateBySlug(tx, slug)) throw new TemplateServiceError("TEMPLATE_SLUG_TAKEN", `Slug templat sudah dipakai: ${slug}`);
      if (input.from !== undefined) {
        if (!isPlainObject(input.from)) throwSchemaIssues([{ pointer: "/from", keyword: "type", message: "from harus objek {slug, version?}" }], "Templat tidak sah");
        const fromSlug = assertAnySlug(input.from.slug, "/from/slug");
        const fromVersion = input.from.version === undefined ? undefined : assertVersionNo(input.from.version, "/from/version");
        const st = findTemplateBySlug(tx, fromSlug);
        if (!st) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Templat sumber tidak ditemukan: ${fromSlug}`);
        const sv = findTemplateVersionByNo(tx, st.id, fromVersion ?? st.latestVersionNo);
        if (!sv) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi ${fromVersion} templat ${fromSlug} tidak ada`);
        if (st.isPreset) {
          throwSchemaIssues([{ pointer: "/from/slug", keyword: "preset", message: `${fromSlug} adalah preset gaya; pakai sebagai preset, jangan disalin` }], "Templat tidak sah");
        }
        if (st.kind !== "DOCUMENT") throw new TemplateServiceError("TEMPLATE_KIND_UNSUPPORTED", "Templat pengguna 1.2.0 hanya jenis DOCUMENT", { kind: st.kind });
        assertTemplateUsable(
          { params: (isPlainObject(sv.resolvedParams) ? sv.resolvedParams : {}) as never, templateId: st.id, versionId: sv.id, versionNo: sv.versionNo },
          caller,
          { slug: st.slug, purpose: "copy", correlationId: cid },
        );
        const definition = storedDefinition(sv, st.slug);
        return { definition, base: definition, skeletonBase: null, contractKind: st.contractKind ?? null, lineage: sv.id, reference: referenceOf(st, sv), source: { slug: st.slug, versionNo: sv.versionNo, versionId: sv.id, definitionSha256: sv.definitionSha256 } };
      }
      const definition = parseTemplateV2(input.template, "/template");
      const canon = canonicalLatest(tx);
      return { definition, base: null, skeletonBase: storedDefinition(canon.v, canon.t.slug), contractKind: null, lineage: null, reference: referenceOf(canon.t, canon.v), source: null };
    });
    const cand = prepareCandidate(plan.definition, plan.base, plan.skeletonBase, plan.contractKind);
    if (plan.source && cand.definitionSha256 !== plan.source.definitionSha256) {
      templatesLog({ level: "error", message: "copy definition sha differs from its source", code: "TEMPLATE_COPY_SHA_MISMATCH", correlationId: cid, context: { slug, source: plan.source, computed: cand.definitionSha256 } });
    }
    const verdict = await runGuard(g, { op: "create", slug, lintTier: lintTierOf(cand.tier), reference: plan.reference, candidate: { definition: cand.definition, payload: cand.payload, skeleton: cand.skeleton, skeletonSha256: cand.skeletonSha256 }, correlationId: cid });
    const store = studioStore();
    const row = await withStudioTx(async (tx) => {
      if (findTemplateBySlug(tx, slug)) throw new TemplateServiceError("TEMPLATE_SLUG_TAKEN", `Slug templat sudah dipakai: ${slug}`);
      const n = Number(tx.get<{ n: number }>("SELECT count(*) AS n FROM template WHERE origin = 'user'")?.n ?? 0);
      if (n >= TEMPLATE_INPUT_LIMITS.userTemplates) throw new TemplateServiceError("TEMPLATE_LIMIT", `Paling banyak ${TEMPLATE_INPUT_LIMITS.userTemplates} templat pengguna`);
      return store.createUserTemplate(tx, {
        slug,
        name: input.name.trim(),
        kind: "DOCUMENT",
        description: input.description ?? null,
        contractKind: plan.contractKind,
        baseVersionId: plan.lineage,
        createdBy: caller.requester,
        version: versionContent(cand, changeNote, caller.requester, verdict, plan.source),
      });
    });
    const saved = await readSaved(slug, row.id);
    templatesLog({
      level: "info",
      message: "Templat pengguna dibuat",
      code: "TEMPLATE_CREATED",
      correlationId: cid,
      context: { slug, versionNo: 1, mode: plan.source ? "copy" : "scratch", source: plan.source, definitionSha256: cand.definitionSha256, skeletonSha256: cand.skeletonSha256, changedKeys: cand.changedKeys, guard: verdict.verdict, callerKind: caller.kind },
    });
    return { template: saved.template, version: saved.version, skeletonSha256: cand.skeletonSha256, guard: { verdict: verdict.verdict, report: verdict.report }, changedKeys: cand.changedKeys, unchanged: false };
  });
}

// ── Update (new immutable version) ───────────────────────────────────────

export interface UserTemplateUpdateInput {
  slug: string;
  baseVersionNo: number;
  changeNote: string;
  name?: string;
  description?: string | null;
  template?: unknown;
  skeleton?: { slots: unknown };
  changes?: TemplateChanges;
}

/** `studio_template_update`: version latest+1 of a `user-` template (template | skeleton | changes). */
export async function updateUserTemplateV2(input: UserTemplateUpdateInput, caller: StudioCaller): Promise<UserTemplateSaveResult> {
  return runServiceOp("updateUserTemplateV2", { slug: input?.slug, baseVersionNo: input?.baseVersionNo, requester: caller?.requester }, async (cid) => {
    assertCaller(caller);
    const g = requireGuard();
    assertInputLimits(input);
    if (!isPlainObject(input)) throwSchemaIssues([{ pointer: "", keyword: "type", message: "Badan permintaan harus objek" }], "Templat tidak sah");
    const slug = assertAnySlug(input.slug, "/slug");
    const baseVersionNo = assertVersionNo(input.baseVersionNo, "/baseVersionNo");
    const changeNote = assertChangeNote(input.changeNote);
    assertLabels(input, false);
    const sent = (["template", "skeleton", "changes"] as const).filter((k) => input[k] !== undefined);
    if (sent.length !== 1) throw new StudioEngineError("CHANGE_FIELDS_REQUIRED", "isi tepat satu dari template, skeleton atau changes");
    await ensureBuiltinTemplates();
    const plan = await readWith(undefined, (tx) => {
      const t = findTemplateBySlug(tx, slug);
      if (!t) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Templat tidak ditemukan: ${slug}`);
      if (t.origin !== "user") throw new TemplateServiceError("TEMPLATE_READ_ONLY", `Templat bawaan ${slug} hanya-baca; salin dulu ke templat user-`);
      if (t.archived) throw new TemplateServiceError("TEMPLATE_ARCHIVED", `Templat ${slug} diarsipkan; batalkan arsip dulu`);
      if (baseVersionNo !== t.latestVersionNo) {
        throw new TemplateServiceError("BASE_CONFLICT", `Versi dasar ${baseVersionNo} bukan versi terbaru (${t.latestVersionNo}); muat ulang lalu simpan`, { latestVersionNo: t.latestVersionNo });
      }
      if (t.latestVersionNo >= TEMPLATE_INPUT_LIMITS.versionsPerTemplate) throw new TemplateServiceError("TEMPLATE_LIMIT", `Paling banyak ${TEMPLATE_INPUT_LIMITS.versionsPerTemplate} versi per templat`);
      const prev = findTemplateVersionByNo(tx, t.id, t.latestVersionNo);
      if (!prev) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Versi ${t.latestVersionNo} templat ${slug} tidak ada`);
      const prevDef = storedDefinition(prev, slug);
      const definition =
        input.template !== undefined
          ? parseTemplateV2(input.template, "/template")
          : input.skeleton !== undefined
            ? parseTemplateV2({ ...prevDef, skeleton: input.skeleton }, "/template")
            : parseTemplateV2(applyTemplateChanges(prevDef, input.changes, (isPlainObject(prev.roleFormats) ? prev.roleFormats : {}) as Record<string, unknown>), "/template");
      return { t, prev, prevDef, definition };
    });
    const cand = prepareCandidate(plan.definition, plan.prevDef, null, plan.t.contractKind ?? null);
    const labels = {
      ...(input.name !== undefined && input.name.trim() !== plan.t.name ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined && (input.description ?? null) !== plan.t.description ? { description: input.description ?? null } : {}),
    };
    if (cand.definitionSha256 === plan.prev.definitionSha256) {
      if (Object.keys(labels).length === 0) throw new StudioEngineError("CHANGE_FIELDS_REQUIRED", "Tidak ada perubahan terhadap versi dasar", { reason: "TEMPLATE_UNCHANGED" });
      await withStudioTx(async (tx) => setLabels(tx, plan.t.id, labels));
      const saved = await readSaved(slug, plan.prev.id);
      templatesLog({ level: "info", message: "Label templat pengguna diubah (tanpa versi baru)", code: "TEMPLATE_LABELS_UPDATED", correlationId: cid, context: { slug, fields: Object.keys(labels) } });
      return { template: saved.template, version: saved.version, skeletonSha256: cand.skeletonSha256, guard: { verdict: plan.prev.guardVerdict, report: plan.prev.guardReport }, changedKeys: 0, unchanged: true };
    }
    const verdict = await runGuard(g, { op: "update", slug, lintTier: lintTierOf(cand.tier), reference: referenceOf(plan.t, plan.prev), candidate: { definition: cand.definition, payload: cand.payload, skeleton: cand.skeleton, skeletonSha256: cand.skeletonSha256 }, correlationId: cid });
    const store = studioStore();
    const row = await withStudioTx(async (tx) => {
      const now = findTemplateById(tx, plan.t.id);
      if (now?.archived) throw new TemplateServiceError("TEMPLATE_ARCHIVED", `Templat ${slug} diarsipkan; batalkan arsip dulu`);
      // The guard ran outside the job: the store re-checks the base (BASE_CONFLICT) in the insert.
      const v = await store.addTemplateVersion(tx, { slug, baseVersionNo, ...versionContent(cand, changeNote, caller.requester, verdict, null) });
      if (Object.keys(labels).length > 0) setLabels(tx, plan.t.id, labels);
      return v;
    });
    const saved = await readSaved(slug, row.id);
    templatesLog({
      level: "info",
      message: "Versi templat pengguna dibuat",
      code: "TEMPLATE_VERSION_CREATED",
      correlationId: cid,
      context: { slug, versionNo: saved.version.versionNo, baseVersionNo, via: sent[0], definitionSha256: cand.definitionSha256, skeletonSha256: cand.skeletonSha256, changedKeys: cand.changedKeys, guard: verdict.verdict, callerKind: caller.kind },
    });
    return { template: saved.template, version: saved.version, skeletonSha256: cand.skeletonSha256, guard: { verdict: verdict.verdict, report: verdict.report }, changedKeys: cand.changedKeys, unchanged: false };
  });
}

/** name/description live on the mutable `template` row (spec §3.4: labels, not versioned). */
function setLabels(tx: StudioTx, templateId: string, labels: { name?: string; description?: string | null }): void {
  if (labels.name !== undefined) tx.run("UPDATE template SET name = ?, time_updated = ? WHERE id = ? AND origin = 'user'", [labels.name, tx.now, templateId]);
  if (labels.description !== undefined) tx.run("UPDATE template SET description = ?, time_updated = ? WHERE id = ? AND origin = 'user'", [labels.description, tx.now, templateId]);
}

// ── Archive, versions, check ─────────────────────────────────────────────

/** `studio_template_archive`: archive or restore a `user-` template; builtins are read-only. Never deletes. */
export async function archiveUserTemplate(input: { slug: string; archived: boolean }, caller: StudioCaller): Promise<{ slug: string; archived: boolean }> {
  return runServiceOp("archiveUserTemplate", { slug: input?.slug, archived: input?.archived, requester: caller?.requester }, async (cid) => {
    assertCaller(caller);
    const slug = assertAnySlug(input?.slug, "/slug");
    if (typeof input.archived !== "boolean") throwSchemaIssues([{ pointer: "/archived", keyword: "type", message: "archived harus boolean" }], "Masukan tidak sah");
    await ensureBuiltinTemplates();
    await withStudioTx((tx) => studioStore().setTemplateArchived(tx, slug, input.archived));
    templatesLog({ level: "info", message: input.archived ? "Templat pengguna diarsipkan" : "Arsip templat pengguna dibatalkan", code: "TEMPLATE_ARCHIVED_SET", correlationId: cid, context: { slug, archived: input.archived, callerKind: caller.kind } });
    return { slug, archived: input.archived };
  });
}

export interface TemplateVersionListItem {
  versionNo: number;
  versionId: string;
  baseVersionId: string | null;
  definitionSha256: string;
  paramsSha256: string;
  skeletonSha256: string | null;
  changeNote: string;
  createdBy: string;
  createdAt: string;
  guardVerdict: "pass" | "warn" | null;
  revisionCount: number;
  documentCount: number;
}

/** Full version history of one template (oldest first) with guard verdicts and document links (row 64 store API). */
export async function listTemplateVersionHistory(slug: string): Promise<TemplateVersionListItem[]> {
  return runServiceOp("listTemplateVersionHistory", { slug }, async () => {
    const s = assertAnySlug(slug, "/slug");
    await ensureBuiltinTemplates();
    const rows = await studioStore().listTemplateVersions(s);
    if (rows.length === 0) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Templat tidak ditemukan: ${s}`);
    return rows.map((r) => ({
      versionNo: r.version_no,
      versionId: r.id,
      baseVersionId: r.base_version_id,
      definitionSha256: r.definition_sha256,
      paramsSha256: r.params_sha256,
      skeletonSha256: r.skeleton_sha256,
      changeNote: r.change_note,
      createdBy: r.created_by,
      createdAt: new Date(r.time_created).toISOString(),
      guardVerdict: r.guard_verdict,
      revisionCount: r.revision_count,
      documentCount: r.document_count,
    }));
  });
}

export interface TemplateFormCheck {
  valid: boolean;
  /** Tool code of the first failure (Swarm or Studio code). */
  code?: string;
  issues: unknown[];
  changedKeys?: number;
}

/**
 * Form part of `studio_template_check` (spec §5.2 step 1, saves nothing, no render): the candidate
 * against `base {slug, version?}` or, without a base, as from scratch on datum-kanonik. Row 67 adds the
 * guard run on top.
 */
export async function checkTemplateForm(input: { template: unknown; base?: { slug: string; version?: number } }): Promise<TemplateFormCheck> {
  return runServiceOp("checkTemplateForm", { base: input?.base ?? null }, async () => {
    assertInputLimits(input);
    await ensureBuiltinTemplates();
    try {
      const plan = await readWith(undefined, (tx) => {
        const definition = parseTemplateV2(input?.template, "/template");
        if (!input.base) {
          const canon = canonicalLatest(tx);
          return { definition, base: null, skeletonBase: storedDefinition(canon.v, canon.t.slug), contractKind: null as string | null };
        }
        const bs = assertAnySlug(input.base.slug, "/base/slug");
        const t = findTemplateBySlug(tx, bs);
        const v = t ? findTemplateVersionByNo(tx, t.id, input.base.version ?? t.latestVersionNo) : null;
        if (!t || !v) throw new StudioEngineError("TEMPLATE_NOT_FOUND", `Templat acuan tidak ditemukan: ${bs}`);
        return { definition, base: storedDefinition(v, t.slug), skeletonBase: null, contractKind: t.contractKind ?? null };
      });
      const cand = prepareCandidate(plan.definition, plan.base, plan.skeletonBase, plan.contractKind);
      return { valid: true, issues: [], changedKeys: cand.changedKeys };
    } catch (err) {
      if (!(err instanceof StudioEngineError) || err.code === "TEMPLATE_NOT_FOUND") throw err;
      const d = (err.details ?? {}) as { issues?: unknown[] };
      return { valid: false, code: templateErrorCode(err), issues: Array.isArray(d.issues) ? d.issues : [{ message: err.message }] };
    }
  });
}

// ── Studio entry points (index.ts createTemplateV2 / createTemplateVersionV2) ──

/** R01 POST v2 over the service: from scratch only; presets and contract templates are not user-made here. */
export async function createTemplateFromStudioInput(input: CreateTemplateV2Input, caller: StudioCaller): Promise<UserTemplateSaveResult> {
  if (isPlainObject(input) && input.isPreset === true) {
    throw new StudioEngineError("FORBIDDEN", "Templat pengguna tidak pernah preset gaya", { reason: "PRESET_NOT_USER_TEMPLATE" });
  }
  if (isPlainObject(input) && input.contractKind !== undefined && input.contractKind !== null) {
    throw new StudioEngineError("FORBIDDEN", "Templat kontrak dibuat dengan menyalin templat bawaan (from)", { reason: "CONTRACT_TEMPLATE_BY_COPY" });
  }
  return createUserTemplateV2({ slug: input?.slug, name: input?.name, kind: input?.kind, description: input?.description ?? null, changeNote: input?.changeNote, template: input?.template }, caller);
}

/** R02 POST v2 over the service: `id` is a template id or slug. */
export async function createVersionFromStudioInput(id: string, input: CreateTemplateVersionV2Input, caller: StudioCaller): Promise<UserTemplateSaveResult> {
  const slug = await readWith(undefined, (tx) => {
    const t = typeof id === "string" && id.length > 0 && id.length <= 200 ? (findTemplateById(tx, id) ?? findTemplateBySlug(tx, id)) : null;
    if (!t) throw new StudioEngineError("TEMPLATE_NOT_FOUND", "Templat tidak ditemukan");
    return t.slug;
  });
  return updateUserTemplateV2({ slug, baseVersionNo: input?.baseVersionNo, changeNote: input?.changeNote, template: input?.template }, caller);
}
