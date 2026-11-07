/**
 * The five template tools of the Studio host server (row 68; decision U10; masterplan/01_specs_studio_templates.md
 * §2-§6 with the C13 and U16 amendments; names register §7.2):
 *
 *   studio_template_create   copy ({from}) or from scratch ({template}) -> user template v1 (row 66 + row 67 guard)
 *   studio_template_update   new immutable version from {template | skeleton | changes} (baseVersionNo, BASE_CONFLICT)
 *   studio_template_check    form check + guard run, saves nothing; with {slug} it re-checks a stored version against
 *                            the version it was made from and lists every version (versions[], guard verdicts)
 *   studio_template_preview  render the Swarm sample with a stored version or an unsaved definition (docx|html|pdf)
 *   studio_template_archive  hide / unhide a user template (never deletes)
 *
 * "List versions" (spec §4) and "re-render a document on a newer version" (spec §4: `studio_document_structure`
 * op templateVersion -> new revision, then `studio_render`) use these outputs and the kept row 31 tools; no sixth tool.
 *
 * Every call: the §6 limits run first (C13 M4), then the JSON schema of the tool, then the row 66/67 service. The
 * caller is `localStudioCaller(<session agent>)` (C54/C58: a non-admin INTERNAL_AGENT; the agent comes from the MCP
 * session, never from the arguments, as row 31 D2). Refusals the agent can fix are normal results `{ok:false, code}`;
 * only an unexpected failure is `isError`. Every call is logged as one JSON line: the host runner's log (if given)
 * plus `<store>/logs/mcp-host/datum-studio-template-tools-<day>.jsonl`, with a correlation id; no template content.
 */
import { randomUUID } from "node:crypto"
import path from "node:path"
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { neutralizeDeep, untrustedBlock, untrustedFields } from "../../../vendor/scripts/studio/mcp/tool-kit"
import { localStudioCaller } from "../../../vendor/src/lib/studio/contract/auth"
import { StudioEngineError } from "../../../vendor/src/lib/studio/contract/errors"
import { getStudioEnv } from "../../../vendor/src/lib/studio/contract/env"
import { appendJsonlDaily } from "../../../vendor/src/lib/studio/http/jsonl"
import { findTemplateVersionById, readWith } from "../../../vendor/src/lib/studio/services/_swarm-store"
import { getTemplate, getTemplateV2 } from "../../../vendor/src/lib/studio/services/templates"
import type { GuardCheckEntry } from "../../../vendor/src/lib/studio/services/templates/guard"
import { checkTemplateWithGuard, previewTemplate, type TemplatePreviewInput } from "../../../vendor/src/lib/studio/services/templates/preview"
import {
  archiveUserTemplate,
  assertInputLimits,
  checkTemplateForm,
  createUserTemplateV2,
  listTemplateVersionHistory,
  templateErrorCode,
  updateUserTemplateV2,
  type TemplateVersionListItem,
  type UserTemplateSaveResult,
} from "../../../vendor/src/lib/studio/services/templates/service"
import type { HostToolExtension, HostToolSession } from "../tool-table.ts"
import { TEMPLATE_TOOL_NAMES, TEMPLATE_TOOL_SCHEMAS, type TemplateToolName } from "./schemas.ts"

type Rec = Record<string, unknown>
export type TemplateToolLog = (level: "info" | "warn" | "error", source: string, message: string, context?: Rec) => void

export interface TemplateHostExtensionOptions {
  /** The host runner's log channel (start.ts `write`); the tools also keep their own daily JSONL under the store. */
  log?: TemplateToolLog
}

const SOURCE = "datum-studio-host.templates"
const MAX_ISSUES = 200
const MAX_MESSAGE = 300

// ── Results ────────────────────────────────────────────────────────────────────────────────────

/** A refusal the agent can fix (schema, lock, conflict, guard): a normal result `ok:false`, not `isError`. */
class ToolRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Rec = {},
  ) {
    super(message)
  }
}

function clip(s: unknown, n = MAX_MESSAGE): string {
  const t = typeof s === "string" ? s : String(s)
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function ok(tool: TemplateToolName, cid: string, text: string, data: Rec, untrusted: string[] = []): CallToolResult {
  const structured = { ok: true, tool, ...(neutralizeDeep(data) as Rec), ...(untrusted.length > 0 ? untrustedFields(untrusted) : {}), correlationId: cid }
  return { content: [{ type: "text", text: `${text}\ncorrelationId: ${cid}` }], structuredContent: structured }
}

function refused(tool: TemplateToolName, cid: string, code: string, message: string, details: Rec): CallToolResult {
  const d = neutralizeDeep(details) as Rec
  const lines = [`ditolak (dapat diperbaiki) ${code}: ${clip(neutralizeDeep(message))}`, `correlationId: ${cid}`]
  if (Object.keys(d).length > 0) lines.push(`rincian:\n${untrustedBlock(clip(JSON.stringify(d), 20000), { jenis: "rincian-galat" })}`)
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { ok: false, tool, code, error: { code, message: clip(neutralizeDeep(message)), correlationId: cid, ...(Object.keys(d).length > 0 ? { details: d } : {}) }, ...untrustedFields(["error.message", "error.details"]), correlationId: cid },
  }
}

// ── Argument validation (§6 limits first, then the schema) ────────────────────────────────────

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true })
const VALIDATORS = new Map<TemplateToolName, ValidateFunction>(TEMPLATE_TOOL_NAMES.map((n) => [n, ajv.compile(TEMPLATE_TOOL_SCHEMAS[n])]))

function schemaIssues(errors: ErrorObject[] | null | undefined): Array<{ pointer: string; keyword: string; message: string }> {
  const out: Array<{ pointer: string; keyword: string; message: string }> = []
  for (const e of errors ?? []) {
    // `oneOf` children repeat the reason as `required`; keep the parent line only.
    if (e.keyword === "required" && (errors ?? []).some((x) => x.keyword === "oneOf" && x.instancePath === e.instancePath)) continue
    let message = e.message ?? e.keyword
    if (e.keyword === "enum") message = `must be one of: ${((e.params as { allowedValues?: unknown[] }).allowedValues ?? []).join(", ")} (supported)`
    if (e.keyword === "additionalProperties") message = `unknown field ${String((e.params as { additionalProperty?: string }).additionalProperty)}`
    if (e.keyword === "oneOf") message = "give exactly one of the alternative fields (see the tool schema oneOf)"
    out.push({ pointer: e.instancePath || "/", keyword: e.keyword, message })
    if (out.length >= MAX_ISSUES) break
  }
  return out
}

function validateArgs(tool: TemplateToolName, raw: Record<string, unknown>): Rec {
  // C13 M4: the size, depth, key and character limits run before any schema sees the input.
  assertInputLimits(raw)
  const args = structuredClone(raw) as Rec
  const v = VALIDATORS.get(tool)!
  if (!v(args)) throw new ToolRefusal("SCHEMA_INVALID", "argumen tidak sah menurut skema alat", { issues: schemaIssues(v.errors) })
  return args
}

// ── Output shaping ─────────────────────────────────────────────────────────────────────────────

type CompactCheck = { id: string; class: string; outcome: string; reason?: string; key?: string; reference: string; candidate: string; issues?: Array<{ status: string; detail: string }> }

/** The guard report, compact: verdict, counts, and every check that is not a plain pass (reject / warn first). */
function compactReport(report: unknown): Rec | null {
  if (!report || typeof report !== "object") return null
  const r = report as { verdict?: string; checks?: GuardCheckEntry[]; unregistered?: GuardCheckEntry[]; reference?: unknown; lintTier?: string; renderTier?: string; language?: string; releaseStatus?: unknown; classCounts?: unknown; lintParamPin?: string; lintParamDiffs?: unknown; ingest?: unknown; registryCount?: number }
  const all = [...(r.checks ?? []), ...(r.unregistered ?? [])]
  const counts: Record<string, number> = {}
  for (const c of all) counts[c.outcome] = (counts[c.outcome] ?? 0) + 1
  const rank = (o: string) => (o === "reject" ? 0 : o === "warn" ? 1 : 2)
  const checks: CompactCheck[] = all
    .filter((c) => c.outcome === "reject" || c.outcome === "warn")
    .sort((a, b) => rank(a.outcome) - rank(b.outcome))
    .slice(0, MAX_ISSUES)
    .map((c) => ({
      id: c.id,
      class: String(c.class),
      outcome: c.outcome,
      ...(c.reason ? { reason: c.reason } : {}),
      ...(c.key ? { key: c.key } : {}),
      reference: c.reference?.status ?? "-",
      candidate: c.candidate?.status ?? "-",
      ...(c.issues && c.issues.length > 0 ? { issues: c.issues.slice(0, 3).map((i) => ({ status: i.status, detail: clip(i.detail) })) } : {}),
    }))
  return {
    verdict: r.verdict ?? null,
    reference: r.reference ?? null,
    lintTier: r.lintTier ?? null,
    renderTier: r.renderTier ?? null,
    language: r.language ?? null,
    releaseStatus: r.releaseStatus ?? null,
    registryCount: r.registryCount ?? null,
    classCounts: r.classCounts ?? null,
    outcomeCounts: counts,
    lintParamPin: r.lintParamPin ?? null,
    ...(r.lintParamDiffs ? { lintParamDiffs: r.lintParamDiffs } : {}),
    ...(r.ingest ? { ingest: r.ingest } : {}),
    checks,
  }
}

function versionList(rows: readonly TemplateVersionListItem[]): Rec[] {
  return rows.map((v) => ({
    versionNo: v.versionNo,
    versionId: v.versionId,
    baseVersionId: v.baseVersionId,
    definitionSha256: v.definitionSha256,
    skeletonSha256: v.skeletonSha256,
    guardVerdict: v.guardVerdict,
    revisionCount: v.revisionCount,
    documentCount: v.documentCount,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    changeNote: clip(v.changeNote, 500),
  }))
}

function versionLines(rows: readonly TemplateVersionListItem[]): string[] {
  return rows.map((v) => `  v${v.versionNo} ${v.versionId} guard=${v.guardVerdict ?? "-"} dokumen=${v.documentCount} revisi=${v.revisionCount}`)
}

async function saved(tool: TemplateToolName, cid: string, r: UserTemplateSaveResult): Promise<CallToolResult> {
  const slug = String(r.template.slug)
  const history = await listTemplateVersionHistory(slug)
  const report = compactReport(r.guard.report)
  const head = r.unchanged
    ? `templat ${slug}: definisi sama dengan v${r.version.versionNo}; hanya nama/deskripsi diubah (tanpa versi baru)`
    : `templat ${slug} v${r.version.versionNo} disimpan (${r.version.id}); guard ${r.guard.verdict ?? "-"}; kunci berubah ${r.changedKeys}`
  return ok(
    tool,
    cid,
    [head, `versi (${history.length}):`, ...versionLines(history), `pratinjau: studio_template_preview { slug: "${slug}", version: ${r.version.versionNo} }`, `dokumen ke versi ini: studio_document_structure op templateVersion { versionNo: ${r.version.versionNo} } lalu studio_render`].join("\n"),
    {
      slug,
      origin: "user",
      versionNo: r.version.versionNo,
      versionId: r.version.id,
      definitionSha256: (r.version as { definitionSha256?: string }).definitionSha256 ?? history.find((v) => v.versionId === r.version.id)?.definitionSha256 ?? null,
      skeletonSha256: r.skeletonSha256,
      unchanged: r.unchanged,
      changedKeys: r.changedKeys,
      guard: { verdict: r.guard.verdict, ...(report ? { report } : {}) },
      versions: versionList(history),
    },
    ["versions[].changeNote", "guard.report.checks[].issues"],
  )
}

// ── Tool bodies ────────────────────────────────────────────────────────────────────────────────

type Body = (args: Rec, session: HostToolSession, cid: string) => Promise<CallToolResult>

const create: Body = async (a, s, cid) => {
  const r = await createUserTemplateV2(
    { slug: a.slug as string, name: a.name as string, kind: a.kind as string, description: (a.description as string | undefined) ?? null, changeNote: a.changeNote as string, ...(a.from !== undefined ? { from: a.from as { slug: string; version?: number } } : {}), ...(a.template !== undefined ? { template: a.template } : {}) },
    localStudioCaller(s.agentId),
  )
  return saved("studio_template_create", cid, r)
}

const update: Body = async (a, s, cid) => {
  const r = await updateUserTemplateV2(
    {
      slug: a.slug as string,
      baseVersionNo: a.baseVersionNo as number,
      changeNote: a.changeNote as string,
      ...(a.name !== undefined ? { name: a.name as string } : {}),
      ...(a.description !== undefined ? { description: a.description as string } : {}),
      ...(a.template !== undefined ? { template: a.template } : {}),
      ...(a.skeleton !== undefined ? { skeleton: a.skeleton as { slots: unknown } } : {}),
      ...(a.changes !== undefined ? { changes: a.changes as never } : {}),
    },
    localStudioCaller(s.agentId),
  )
  return saved("studio_template_update", cid, r)
}

/** The version a stored version was made from: vN-1, the copy source of v1, or null (from scratch: datum-kanonik). */
async function parentOf(versionId: string, baseVersionId: string | null): Promise<{ slug: string; version: number } | null> {
  if (!baseVersionId || baseVersionId === versionId) return null
  return readWith(undefined, (tx) => {
    const b = findTemplateVersionById(tx, baseVersionId)
    return b ? { slug: b.template.slug, version: b.versionNo } : null
  })
}

const check: Body = async (a, _s, cid) => {
  const guard = a.guard !== false
  let template: unknown = a.template
  let base: { slug: string; version?: number } | undefined = a.baseSlug !== undefined ? { slug: a.baseSlug as string, ...(a.baseVersion !== undefined ? { version: a.baseVersion as number } : {}) } : undefined
  let stored: Rec | null = null
  let history: TemplateVersionListItem[] | null = null
  if (template === undefined) {
    // A stored version, re-checked on demand (spec §5.5) against the version it was made from.
    const slug = a.slug as string
    const d = await getTemplateV2(slug, a.version as number | undefined, { includeAdvanced: true })
    if (!d.definition) throw new ToolRefusal("TEMPLATE_V1_UNSUPPORTED", `versi ${d.version.versionNo} templat ${slug} tidak punya definisi studio.template/v2`)
    history = await listTemplateVersionHistory(slug)
    const row = history.find((v) => v.versionId === d.version.id)
    const builtin = d.template.origin !== "user"
    template = d.definition
    if (!base) base = builtin ? { slug, version: d.version.versionNo } : (await parentOf(d.version.id, row?.baseVersionId ?? null)) ?? undefined
    const storedVerdict = row?.guardVerdict ?? null
    stored = {
      slug,
      origin: builtin ? "builtin" : "user",
      versionNo: d.version.versionNo,
      versionId: d.version.id,
      guardVerdict: storedVerdict,
      ...(storedVerdict === null && !builtin ? { code: "GUARD_MISSING" } : {}),
      reference: base ?? { slug: "datum-kanonik", version: null },
    }
  }
  const input = { template, ...(base ? { base } : {}) }
  let valid: boolean
  let code: string | undefined
  let issues: unknown[]
  let changedKeys: number | undefined
  let verdict: "pass" | "warn" | "reject"
  let guardOut: Rec | null = null
  if (guard) {
    const r = await checkTemplateWithGuard(input)
    valid = r.valid
    code = r.code
    issues = r.issues
    changedKeys = r.changedKeys
    verdict = r.guard?.verdict === "pass" || r.guard?.verdict === "warn" ? r.guard.verdict : "reject"
    guardOut = r.guard ? { verdict: r.guard.verdict, ...(r.guard.reason ? { reason: r.guard.reason } : {}), ...(r.guard.report ? { report: compactReport(r.guard.report) } : {}) } : null
    if (!r.guard) verdict = "reject"
  } else {
    const r = await checkTemplateForm(input)
    valid = r.valid
    code = r.code
    issues = r.issues
    changedKeys = r.changedKeys
    verdict = r.valid ? "pass" : "reject"
    guardOut = { verdict: "skipped" }
  }
  const cut = issues.slice(0, MAX_ISSUES)
  const lines = [
    `${stored ? `templat ${String(stored.slug)} v${String(stored.versionNo)}` : "definisi (tidak disimpan)"}: ${verdict}${code ? ` ${code}` : ""}${guard ? "" : " (bentuk saja, guard dilewati)"}; ${cut.length} isu`,
    ...(stored && stored.code === "GUARD_MISSING" ? ["  versi tersimpan tanpa putusan guard: GUARD_MISSING"] : []),
    ...(history ? [`versi (${history.length}):`, ...versionLines(history)] : []),
  ]
  return ok(
    "studio_template_check",
    cid,
    lines.join("\n"),
    { valid, verdict, ...(code ? { code } : {}), issues: cut, ...(changedKeys !== undefined ? { changedKeys } : {}), guard: guardOut, checks: (guardOut?.report as { checks?: unknown[] } | undefined)?.checks ?? [], saved: false, ...(stored ? { stored } : {}), ...(history ? { versions: versionList(history) } : {}) },
    ["issues", "versions[].changeNote", "guard.report.checks[].issues"],
  )
}

/** Spec §6 `language`: the sample follows `doc.language`, so another language is previewed as that one change. */
async function withLanguage(a: Rec): Promise<{ input: TemplatePreviewInput; languageOf: Rec | null }> {
  const formats = a.formats as string[] | undefined
  const common = { ...(formats ? { formats } : {}), ...(a.lint !== undefined ? { lint: a.lint as boolean } : {}), ...(a.tier !== undefined ? { tier: a.tier as string } : {}) }
  const lang = a.language as "ID" | "EN" | undefined
  if (a.template === undefined) {
    const slug = a.slug as string
    if (!lang) return { input: { slug, ...(a.version !== undefined ? { version: a.version as number } : {}), ...common }, languageOf: null }
    const d = await getTemplate(slug, a.version as number | undefined)
    const params = (d.version.resolvedParams ?? {}) as Rec
    if (params["doc.language"] === lang) return { input: { slug, version: d.version.versionNo, ...common }, languageOf: null }
    const full = await getTemplateV2(slug, d.version.versionNo, { includeAdvanced: true })
    if (!full.definition) throw new ToolRefusal("TEMPLATE_V1_UNSUPPORTED", `templat ${slug} tidak punya definisi studio.template/v2`)
    return { input: { template: setLanguage(full.definition as unknown as Rec, lang), base: { slug, version: d.version.versionNo }, ...common }, languageOf: { slug, versionNo: d.version.versionNo, language: lang } }
  }
  return { input: { template: lang ? setLanguage(a.template as Rec, lang) : a.template, ...common }, languageOf: lang ? { language: lang } : null }
}

function setLanguage(def: Rec, lang: "ID" | "EN"): Rec {
  const copy = structuredClone(def) as Rec & { essentials?: Rec; advanced?: Rec }
  copy.essentials = { ...(copy.essentials ?? {}), "doc.language": lang }
  if (copy.advanced && "doc.language" in copy.advanced) {
    const { ["doc.language"]: _drop, ...rest } = copy.advanced
    copy.advanced = rest
  }
  return copy
}

const preview: Body = async (a, s, cid) => {
  const { input, languageOf } = await withLanguage(a)
  // Row 70a (M1): the session's agent is the render rate bucket (as R17); RATE_LIMITED / RENDER_QUEUE_FULL keep nothing.
  const r = await previewTemplate(input, { caller: localStudioCaller(s.agentId) })
  // Preview rows have no revision, so R10 (studio_file_verify) cannot name them yet (file request I-2); the absolute
  // path under the store lets a local caller (Swarm file tab, Claude) open the file read-only.
  const root = getStudioEnv().workspaceRoot
  const outputs = r.files.map((f) => ({ id: f.outputId, format: f.format, fileName: f.fileName, relPath: f.relPath, path: path.join(root, f.relPath), sha256: f.sha256, bytes: f.bytes, mime: f.mime }))
  const checks = r.lint ? r.lint.checks.filter((c) => c.status !== "PASS" && c.status !== "NOT_RUN").slice(0, MAX_ISSUES) : undefined
  const counts: Record<string, number> = {}
  for (const c of r.lint?.checks ?? []) counts[c.status] = (counts[c.status] ?? 0) + 1
  const who = r.template.unsaved ? (languageOf?.slug ? `${String(languageOf.slug)} v${String(languageOf.versionNo)} dalam bahasa ${String(languageOf.language)}` : "definisi tidak disimpan") : `${r.template.slug} v${r.template.versionNo}`
  return ok(
    "studio_template_preview",
    cid,
    [
      `pratinjau ${who}: tier ${r.tier}, bahasa ${r.language}, ${outputs.length} berkas${r.failed.length > 0 ? `, gagal ${r.failed.join(",")}` : ""}${r.lint ? `; lint ${r.lint.releaseStatus}` : ""}`,
      ...outputs.map((o) => `  ${o.format} ${o.id} sha256 ${o.sha256.slice(0, 16)} ${o.bytes} B`),
      ...outputs.map((o) => `  berkas: ${o.path}`),
      "berkas pratinjau di toko (baca saja); tidak ada versi yang disimpan",
    ].join("\n"),
    {
      previewId: r.previewId,
      template: r.template,
      ...(languageOf ? { languageOverride: languageOf } : {}),
      tier: r.tier,
      language: r.language,
      sampleSha256: r.sampleSha256,
      outputs,
      failed: r.failed,
      errors: r.errors,
      ...(r.lint ? { lint: { tier: r.lint.tier, releaseStatus: r.lint.releaseStatus, statusCounts: counts }, checks } : {}),
      saved: false,
      durationMs: r.durationMs,
    },
    ["checks[].detail"],
  )
}

const archive: Body = async (a, s, cid) => {
  const r = await archiveUserTemplate({ slug: a.slug as string, archived: a.archived as boolean }, localStudioCaller(s.agentId))
  return ok("studio_template_archive", cid, `templat ${r.slug} ${r.archived ? "diarsipkan (tersembunyi dari studio_templates_list; dokumen tetap dirender)" : "aktif lagi"}`, { slug: r.slug, archived: r.archived })
}

const BODIES: Record<TemplateToolName, Body> = {
  studio_template_create: create,
  studio_template_update: update,
  studio_template_check: check,
  studio_template_preview: preview,
  studio_template_archive: archive,
}

const META: Record<TemplateToolName, { title: string; description: string; annotations: Rec }> = {
  studio_template_create: {
    title: "Buat templat pengguna",
    description:
      "Buat templat pengguna (slug user-...) versi 1: salin dari templat bawaan/pengguna ({from:{slug,version?}}, disarankan) atau dari nol ({template: studio.template/v2}). Bentuk DATUM terkunci (fon, warna, grid, klasifikasi, pemeriksaan) -> TEMPLATE_FORM_LOCKED; guard DATUM merender contoh dan menolak regresi -> GUARD_REJECTED. Hasil: versionNo, versionId, guard, versions[].",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  studio_template_update: {
    title: "Simpan versi templat baru",
    description:
      "Simpan versi baru templat pengguna (baseVersionNo = versi terbaru, else BASE_CONFLICT). Isi tepat satu: changes {essentials|advanced|roleFormats|unset}, skeleton {slots}, atau template lengkap. Versi lama tidak pernah diubah; dokumen tetap pada versinya (pindah: studio_document_structure op templateVersion). Kunci bentuk -> TEMPLATE_FORM_LOCKED.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  studio_template_check: {
    title: "Periksa templat (tanpa simpan)",
    description:
      "Periksa definisi templat ({template}, acuan baseSlug/baseVersion atau datum-kanonik) atau versi tersimpan ({slug, version?}, diperiksa terhadap versi asalnya) dengan kunci bentuk + guard DATUM (guard:false = bentuk saja). Tidak menyimpan apa pun. Dengan slug: daftar semua versi (versions[] dengan putusan guard dan jumlah dokumen).",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  studio_template_preview: {
    title: "Pratinjau templat",
    description:
      "Render dokumen contoh dengan versi templat ({slug, version?}) atau definisi belum disimpan ({template}). formats docx|html|pdf (bawaan pdf), language ID|EN, tier NOTA|TERBIT|SERAH, lint (bawaan true). Definisi yang melanggar kunci bentuk tidak pernah dirender. Hasil: outputs[] (id, format, sha256, path berkas di toko, baca saja); tidak ada versi yang disimpan.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  studio_template_archive: {
    title: "Arsipkan templat pengguna",
    description: "Sembunyikan (archived:true) atau tampilkan lagi (false) templat pengguna. Tidak menghapus apa pun; dokumen yang memakainya tetap dirender. Templat bawaan hanya-baca.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
}

// ── Extension ──────────────────────────────────────────────────────────────────────────────────

function argSummary(tool: TemplateToolName, a: Rec): Rec {
  // Identifiers only; never template content, names, notes or labels.
  const pick = (k: string) => (typeof a[k] === "string" || typeof a[k] === "number" || typeof a[k] === "boolean" ? { [k]: a[k] } : {})
  const from = a.from && typeof a.from === "object" ? { from: { slug: (a.from as Rec).slug ?? null, version: (a.from as Rec).version ?? null } } : {}
  const via = tool === "studio_template_update" ? { via: ["template", "skeleton", "changes"].filter((k) => a[k] !== undefined) } : {}
  return { ...pick("slug"), ...pick("version"), ...pick("baseVersionNo"), ...pick("baseSlug"), ...pick("archived"), ...pick("guard"), ...from, ...via, unsaved: a.template !== undefined }
}

/**
 * The template tools as host extensions (row 31 `HostToolExtension`, toolset `templates`). The host lists them
 * after its kept tools and routes `tools/call` here with the session (agent, file root).
 */
export function templateHostExtension(opts: TemplateHostExtensionOptions = {}): HostToolExtension[] {
  const log = (level: "info" | "warn" | "error", message: string, context: Rec) => {
    try {
      opts.log?.(level, SOURCE, message, context)
    } catch {
      // a failing runner log must not break a call
    }
    const entry: { timestamp: string } & Rec = { timestamp: new Date().toISOString(), level, source: SOURCE, message, context }
    void appendJsonlDaily("mcp-host", "datum-studio-template-tools", entry).catch(() => undefined)
  }
  return TEMPLATE_TOOL_NAMES.map((name) => ({
    name,
    title: META[name].title,
    description: META[name].description,
    inputSchema: TEMPLATE_TOOL_SCHEMAS[name] as unknown as Rec,
    annotations: { title: META[name].title, ...META[name].annotations },
    toolsets: ["templates"] as const,
    async call(raw: Record<string, unknown>, session: HostToolSession): Promise<CallToolResult> {
      const cid = randomUUID()
      const t0 = Date.now()
      const ctx = { correlationId: cid, tool: name, agentId: session.agentId, sessionId: session.sessionId, args: argSummary(name, raw ?? {}) }
      try {
        const args = validateArgs(name, (raw ?? {}) as Rec)
        const out = await BODIES[name](args, session, cid)
        const sc = out.structuredContent as Rec | undefined
        log("info", "template tool call", { ...ctx, ok: true, durationMs: Date.now() - t0, ...(sc?.versionNo !== undefined ? { versionNo: sc.versionNo, versionId: sc.versionId } : {}) })
        return out
      } catch (e) {
        if (e instanceof ToolRefusal) {
          log("warn", "template tool refused", { ...ctx, ok: false, code: e.code, durationMs: Date.now() - t0 })
          return refused(name, cid, e.code, e.message, e.details)
        }
        if (e instanceof StudioEngineError) {
          const code = templateErrorCode(e) ?? e.code
          const d = (e.details ?? {}) as Rec
          const details: Rec = {
            ...(code !== e.code ? { studioCode: e.code } : {}),
            ...(d.reason !== undefined ? { reason: d.reason } : {}),
            ...(Array.isArray(d.issues) ? { issues: d.issues.slice(0, MAX_ISSUES) } : {}),
            ...(d.latestVersionNo !== undefined ? { latestVersionNo: d.latestVersionNo } : {}),
            ...(d.report !== undefined ? { report: compactReport(d.report) } : {}),
            ...(d.kind !== undefined ? { kind: d.kind } : {}),
            ...(d.retryAfterSec !== undefined ? { retryAfterSec: d.retryAfterSec } : {}),
          }
          log(code === "GUARD_UNAVAILABLE" ? "error" : "warn", "template tool refused", { ...ctx, ok: false, code, reason: d.reason ?? null, durationMs: Date.now() - t0 })
          return refused(name, cid, code, e.message, details)
        }
        const err = e instanceof Error ? e : new Error(String(e))
        log("error", "template tool failed", { ...ctx, ok: false, code: "INTERNAL_ERROR", message: clip(err.message), stack_trace: err.stack, durationMs: Date.now() - t0 })
        return {
          content: [{ type: "text", text: `galat INTERNAL_ERROR: galat internal alat templat; tidak ada yang disimpan\ncorrelationId: ${cid}` }],
          structuredContent: { ok: false, tool: name, code: "INTERNAL_ERROR", error: { code: "INTERNAL_ERROR", message: "galat internal", correlationId: cid }, correlationId: cid },
          isError: true,
        }
      }
    },
  }))
}
