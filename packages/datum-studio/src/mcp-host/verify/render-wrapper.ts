/**
 * Row 154 (decision U24 A, C130, C147): `studio_render` returns the output verification report and records the
 * verified / unverified state of every output it made (masterplan/01_specs_output_verification.md §6).
 *
 * A wrapping HostToolExtension (row 119b hook: tool-table.ts `wraps`, mcp-server.ts `next`), so the vendored
 * tools.ts stays byte-identical. One wrapper per tool; `missionHostExtension` (mission/index.ts) lists it.
 *
 * Before `next` (§6.1, D-4): an explicit `formats` with pdf or docx but no html gets `html` (the measured source,
 * F3); an explicit `figures` with png but no svg gets `svg`. Both are named in `formatsAdded`. Absent lists are left
 * alone (a missing source then reads UNKNOWN SOURCE_MISSING).
 * After `next`: an error or a result without outputs is returned unchanged. Otherwise every output row and its
 * sha256-checked bytes are read, `verifyOutputs` runs §3 over the job, and ONE store transaction writes one
 * `output_verification` record per output (row 149 `putOutputVerification`). The report goes into
 * `structuredContent.verification` (through the vendor's `neutralizeDeep`; findings listed as untrusted) and a few
 * safe-token lines are appended (vendor rule MCP-D4 L-5, tools.ts:866).
 * Failures (§6.1): if verification or its store write throws, every check is UNKNOWN VERIFY_INTERNAL, the outputs are
 * recorded unverified (newest wins, D-7), the error goes to the host JSONL, and the render result is still returned.
 * Verification never turns a successful render into `isError`.
 *
 * The fault seam of §9 exists only through `renderVerifyWrapper(store, { seam })` in tests; the production list
 * (`missionHostExtension`) never passes it, and the returned extension says so in `faultSeam`.
 */
import path from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { TOOLS } from "../../../vendor/scripts/studio/mcp/tools"
import { neutralizeDeep } from "../../../vendor/scripts/studio/mcp/tool-kit"
import { renderLintLimitsFor } from "../../../vendor/src/lib/studio/services/render/lint"
import type { StoreTx } from "../../store/index.ts"
import type { MissionLog } from "../mission/tool-result.ts"
import type { HostToolExtension, HostToolNext, HostToolSession } from "../tool-table.ts"
import type { VerifyFormat } from "./static-checks.ts"
import type { OutputVerificationReport, VerifiedOutput } from "./types.ts"
import { clientEntries, clientFindingsBlock } from "./client-findings.ts"
import { allUnknownOutput, isVerifyFormat, outputState, verifyOutputs, type VerifyOptions, type VerifyOutputFile } from "./verify-outputs.ts"

export const RENDER_VERIFY_TOOL = "studio_render"
export const RENDER_VERIFY_DESCRIPTION_SUFFIX = "Returns a verification report; each output is verified or unverified (U24). Read it before you report the work."
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/

/** The store calls the wrapper needs (SqliteStudioStore; row 149 for the verification records). */
export interface RenderVerifyStore {
  readonly rootDir: string
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
  getOutput(id: string): Promise<{
    id: string
    document_id: string | null
    revision_id: string | null
    render_job_id: string | null
    format: string
    role: string
    figure_label: string | null
    rel_path: string
    sha256: string
    lint_verdict: string
    scope_kind: string
    draft: number
  } | null>
  readOutputVerified(id: string): Promise<Uint8Array>
  getDocument(id: string): Promise<{ document: { tier: string } } | null>
  getRevision(documentId: string, n: number): Promise<{ revision: { snapshot: unknown; lint_report: unknown; completeness: string; completeness_report: unknown }; template: { slug: string; version_no: number } } | null>
  getTemplateVersion(slug: string, versionNo?: number): Promise<{ resolved_params?: unknown } | null>
  putOutputVerification(tx: StoreTx, rec: { outputFileId: string; outputSha256: string; renderJobId?: string | null; state: "verified" | "unverified"; checksVersion: number; failCount: number; unknownCount: number; report: Record<string, unknown>; verifiedBy: string }): Promise<unknown>
  revisionVerification(documentId: string, revisionNo: number | "latest"): Promise<{ outputs: Array<{ format: string; role: string; state: string }> }>
}

export interface RenderVerifyOptions {
  log: MissionLog
  /** TEST ONLY (§9): the fault seam and bridge stubs of `verifyOutputs`, and B13's "do not add html". Never set in production. */
  seam?: VerifyOptions & { addFormats?: false }
}

type Sc = Record<string, unknown>
const isRec = (v: unknown): v is Sc => typeof v === "object" && v !== null && !Array.isArray(v)
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null)

/** §6.1 before `next`: add html / svg when the measured source is missing from an explicit list. */
export function addMeasuredSources(args: Sc): { args: Sc; formatsAdded: Array<"html" | "svg"> } {
  const a: Sc = structuredClone(args ?? {})
  const formatsAdded: Array<"html" | "svg"> = []
  const formats = strList(a.formats)
  if (formats && formats.length < 3 && (formats.includes("pdf") || formats.includes("docx")) && !formats.includes("html")) {
    a.formats = [...formats, "html"]
    formatsAdded.push("html")
  }
  const figures = strList(a.figures)
  if (figures && figures.length < 2 && figures.includes("png") && !figures.includes("svg")) {
    a.figures = [...figures, "svg"]
    formatsAdded.push("svg")
  }
  return { args: a, formatsAdded }
}

/** Counts the store cross-checks (row 149 R149-1): FAIL and UNKNOWN statuses of the output's checks. */
function counts(v: VerifiedOutput): { failCount: number; unknownCount: number } {
  return { failCount: v.checks.filter((c) => c.status === "FAIL").length, unknownCount: v.checks.filter((c) => c.status === "UNKNOWN").length }
}

/** The stored record's report: the output plus the report header fields (§5). */
function recordReport(r: OutputVerificationReport, v: VerifiedOutput): Record<string, unknown> {
  return { $schema: r.$schema, checksVersion: r.checksVersion, documentId: r.documentId, revisionNo: r.revisionNo, renderJobId: r.renderJobId, scope: r.scope, draft: r.draft, layout: r.layout, ...v }
}

/** Safe-token text lines of §6.2. */
export function verificationLines(r: OutputVerificationReport, pageImages: { made: number; reason: string | null; note?: string | null }): string[] {
  const ok = r.outputs.filter((v) => v.state === "verified").length
  const tok = (s: string) => (SAFE.test(s) ? s : "?")
  const lines = [`verification: ${r.overall === "verified" ? "VERIFIED" : "UNVERIFIED"} (${ok}/${r.outputs.length} outputs verified)`]
  for (const v of r.outputs) {
    if (v.state === "verified") {
      lines.push(`  ${v.format} ${tok(v.outputId)} VERIFIED`)
      continue
    }
    const fail = v.checks.filter((c) => c.status === "FAIL").map((c) => c.id)
    const unknown = v.checks.filter((c) => c.status === "UNKNOWN").map((c) => `${c.id}:${c.reason ?? "?"}`)
    lines.push(`  ${v.format} ${tok(v.outputId)} UNVERIFIED fail=${fail.join(",") || "-"} unknown=${unknown.join(",") || "-"}`)
  }
  if (r.scope === "DOCUMENT" && !r.layoutWitness) lines.push("  layout witness: none (a verified PDF or HTML of this revision is needed)")
  const pngs = [...new Set(r.outputs.flatMap((v) => v.pages.map((p) => p.png)).filter((p): p is string => typeof p === "string"))]
  if (pngs.length > 0) {
    lines.push(`  pages: ${pngs.join(" ")}`)
    // Row 151c (DEFECT-157-1): a listed page without an image, or approximate images, is said, never silent.
    if (pageImages.note && /^[A-Za-z0-9 _.,:;()@'-]{1,400}$/.test(pageImages.note)) lines.push(`  pages note: ${pageImages.note}`)
  } else if (r.outputs.some((v) => v.format === "HTML" || v.format === "PDF")) {
    const why = pageImages.reason && /^[A-Za-z0-9 _.,:()-]{1,120}$/.test(pageImages.reason) ? pageImages.reason : "not made"
    lines.push(`  pages: none imaged (${why}); open the PDF or HTML output and look at every page`)
  }
  // Row 206 (1.2.3, AC-2): the checks of every unverified output, in the text (short MCP clients never see
  // structuredContent). One fenced block; document-derived parts stay inside it (MCP-D4).
  const block = clientFindingsBlock(
    r.outputs.filter((v) => v.state !== "verified").map((v) => ({ format: v.format, outputId: SAFE.test(v.outputId) ? v.outputId : null, ...clientEntries(v.checks) })),
    { documentId: SAFE.test(r.documentId) ? r.documentId : "" },
  )
  if (block) lines.push("  checks (per unverified output: check, verdict, page, address, measured, expected, rule, message):", block)
  if (r.overall !== "verified") lines.push("  next: fix the source at the page/address of each check above, look at the pages, render again (DATUM skill §15); full report: structuredContent.verification")
  return lines
}

/** The `studio_render` wrapper (§6.1). Production: `renderVerifyWrapper(store, { log })` only. */
export function renderVerifyWrapper(store: RenderVerifyStore, opts: RenderVerifyOptions): HostToolExtension & { readonly faultSeam: boolean } {
  const def = TOOLS.find((t) => t.name === RENDER_VERIFY_TOOL)
  if (!def) throw new Error("vendored MCP tool studio_render is missing")
  const seam = opts.seam
  const log = opts.log
  return {
    name: RENDER_VERIFY_TOOL,
    title: def.annotations && typeof def.annotations.title === "string" ? def.annotations.title : RENDER_VERIFY_TOOL,
    description: `${def.description} ${RENDER_VERIFY_DESCRIPTION_SUFFIX}`,
    inputSchema: def.inputSchema as Record<string, unknown>,
    ...(def.annotations ? { annotations: def.annotations as unknown as Record<string, unknown> } : {}),
    toolsets: def.toolsets,
    wraps: true,
    faultSeam: seam?.fault !== undefined,
    async call(args: Record<string, unknown>, session: HostToolSession, next?: HostToolNext): Promise<CallToolResult> {
      if (!next) throw new Error("studio_render: wrapper called without the vendored tool")
      const pre = seam?.addFormats === false ? { args: structuredClone(args ?? {}), formatsAdded: [] as Array<"html" | "svg"> } : addMeasuredSources(args)
      const out = await next(pre.args)
      const sc = out.structuredContent as Sc | undefined
      const listed = isRec(sc) && Array.isArray(sc.outputs) ? sc.outputs.filter(isRec) : []
      if (out.isError === true || !isRec(sc) || listed.length === 0) return out
      const documentId = typeof args?.documentId === "string" ? args.documentId : ""
      const scope = (String(args?.scope ?? "document").toUpperCase() as OutputVerificationReport["scope"])
      const verifiedBy = `studio_render/${SAFE.test(session.agentId) ? session.agentId : "agent"}`
      const ids = listed.map((o) => o.id).filter((x): x is string => typeof x === "string")

      let report: OutputVerificationReport | null = null
      let pageImages = { made: 0, reason: null as string | null }
      let files: VerifyOutputFile[] = []
      let base: { revisionNo: number; renderJobId: string | null; draft: boolean } = { revisionNo: 0, renderJobId: null, draft: scope !== "DOCUMENT" }
      try {
        const rows = (await Promise.all(ids.map((id) => store.getOutput(id)))).filter((r): r is NonNullable<typeof r> => r !== null)
        files = await Promise.all(
          rows
            .filter((r) => isVerifyFormat(r.format))
            .map(async (r) => ({
              id: r.id,
              format: r.format as VerifyFormat,
              role: r.role === "FIGURE" ? ("FIGURE" as const) : ("PRIMARY" as const),
              figureLabel: r.figure_label,
              sha256: r.sha256,
              lintVerdict: r.lint_verdict ?? null,
              bytes: await store.readOutputVerified(r.id).catch(() => null),
              absPath: path.join(store.rootDir, r.rel_path),
            })),
        )
        const revisionId = rows.find((r) => r.revision_id)?.revision_id ?? null
        const revisionNo = revisionId
          ? await store.transaction(async (tx) => tx.get<{ revision_no: number }>("SELECT revision_no FROM revision WHERE id = ?", [revisionId])?.revision_no ?? 0)
          : 0
        base = { revisionNo, renderJobId: rows.find((r) => r.render_job_id)?.render_job_id ?? null, draft: rows.some((r) => r.draft === 1) || scope !== "DOCUMENT" }
        const rev = revisionNo > 0 ? await store.getRevision(documentId, revisionNo) : null
        const doc = await store.getDocument(documentId)
        const tv = rev ? await store.getTemplateVersion(rev.template.slug, rev.template.version_no) : null
        const params = tv && isRec(tv.resolved_params) ? tv.resolved_params : undefined
        const limits = renderLintLimitsFor({ warn: (m: string) => log("warn", "studio_render.verify", m, { documentId }) }, params as never)
        let priorLayoutWitness = false
        if (scope === "DOCUMENT" && revisionNo > 0) {
          const set = await store.revisionVerification(documentId, revisionNo).catch(() => null)
          priorLayoutWitness = !!set?.outputs.some((o) => o.role === "PRIMARY" && (o.format === "PDF" || o.format === "HTML") && o.state === "verified" && !ids.includes((o as { outputId?: string }).outputId ?? ""))
        }
        const res = await verifyOutputs(
          {
            documentId,
            revisionNo,
            renderJobId: base.renderJobId,
            scope,
            draft: base.draft,
            formatsAdded: pre.formatsAdded,
            tier: doc?.document.tier ?? null,
            lintReport: rev?.revision.lint_report ?? null,
            completeness: rev?.revision.completeness ?? null,
            completenessReport: rev?.revision.completeness_report ?? null,
            snapshot: rev?.revision.snapshot ?? null,
            limits,
            outputs: files,
            storeRoot: store.rootDir,
            priorLayoutWitness,
          },
          seam ?? {},
        )
        report = res.report
        pageImages = res.pageImages
        await writeRecords(store, report, verifiedBy)
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        log("error", "studio_render.verify", "output verification failed; outputs recorded unverified (VERIFY_INTERNAL)", { documentId, outputs: ids, message: err.message, stack_trace: err.stack })
        report = internalReport(documentId, base, scope, pre.formatsAdded, files.length > 0 ? files : listedFiles(listed))
        try {
          await writeRecords(store, report, verifiedBy)
        } catch (e2) {
          const err2 = e2 instanceof Error ? e2 : new Error(String(e2))
          log("error", "studio_render.verify", "unverified records could not be stored", { documentId, outputs: ids, message: err2.message, stack_trace: err2.stack })
        }
      }
      log("info", "studio_render.verify", `verification ${report.overall}`, {
        documentId,
        renderJobId: report.renderJobId,
        outputs: report.outputs.map((v) => ({ id: v.outputId, format: v.format, state: v.state })),
        bridgeJobs: report.bridgeJobs,
        ms: report.ms,
      })
      const untrusted = Array.isArray(sc.untrustedFields) ? [...(sc.untrustedFields as string[])] : []
      untrusted.push("verification.outputs[].checks[].findings")
      return {
        ...out,
        content: [...(out.content ?? []), { type: "text", text: verificationLines(report, pageImages).join("\n") }],
        structuredContent: { ...sc, verification: neutralizeDeep(report), untrustedFields: untrusted },
      }
    },
  }
}

/** ONE transaction: one record per output (§6.1). Throws on any refusal, which rolls all of them back. */
async function writeRecords(store: RenderVerifyStore, report: OutputVerificationReport, verifiedBy: string): Promise<void> {
  await store.transaction(async (tx) => {
    for (const v of report.outputs) {
      await store.putOutputVerification(tx, {
        outputFileId: v.outputId,
        outputSha256: v.sha256,
        renderJobId: report.renderJobId,
        state: v.state,
        checksVersion: report.checksVersion,
        ...counts(v),
        report: recordReport(report, v),
        verifiedBy,
      })
    }
  })
}

function listedFiles(listed: Sc[]): VerifyOutputFile[] {
  return listed
    .filter((o) => typeof o.id === "string" && isVerifyFormat(o.format) && typeof o.sha256 === "string")
    .map((o) => ({ id: o.id as string, format: o.format as VerifyFormat, role: o.role === "FIGURE" ? "FIGURE" : "PRIMARY", figureLabel: null, sha256: o.sha256 as string, lintVerdict: null, bytes: null, absPath: null }))
}

function internalReport(
  documentId: string,
  base: { revisionNo: number; renderJobId: string | null; draft: boolean },
  scope: OutputVerificationReport["scope"],
  formatsAdded: OutputVerificationReport["formatsAdded"],
  files: VerifyOutputFile[],
): OutputVerificationReport {
  const outputs = files.map((f) => allUnknownOutput(f, "VERIFY_INTERNAL"))
  return {
    $schema: "studio.output-verification/v1",
    checksVersion: 1,
    documentId,
    revisionNo: base.revisionNo,
    renderJobId: base.renderJobId,
    scope,
    draft: base.draft,
    layout: "none",
    formatsAdded,
    layoutWitness: false,
    overall: outputs.length > 0 && outputs.every((v) => outputState(v.checks) === "verified") ? "verified" : "unverified",
    outputs,
    bridgeJobs: 0,
    ms: 0,
  }
}
