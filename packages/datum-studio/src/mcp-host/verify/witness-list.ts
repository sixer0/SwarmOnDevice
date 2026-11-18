/**
 * Patch 1.3.3 row 59 (ST-9 item 1, second half): the host tool `studio_witness_list` (register section 8).
 *
 * `{documentId, revisionNo?}` -> `{dpi: 150, pages: [{page, png, figures}]}`: one existing PNG path per page that
 * carries a figure or chart, from the witness list a render left behind (row 58, `readWitnessManifest`). No cap of 12.
 *
 * READ ONLY. The tool never renders and never rasterises: it reads `<store>/verify/<htmlOutputId>/witness.json` and
 * checks that each PNG still exists. When the revision has no witness list (never rendered with page images, or the
 * folder was pruned: only the newest 20 render folders stay), it says so and names the one call that makes it
 * (`studio_render`); that is a normal result with `witness: "none"`, not a refusal.
 *
 * Which render: the newest PRIMARY HTML output of that document revision that still has a folder under
 * `<store>/verify/`. The folder name is the output id; the output row (store) decides document and revision, never
 * the fields inside the JSON file.
 *
 * Paths: `png` is an ABSOLUTE path inside the Studio store (`<store>/verify/<htmlOutputId>/pNNN.png`), outside the
 * session's project folder. They are witnesses to look at, not deliverables, and a later render may prune them.
 *
 * `figures` (labels) are document text: untrusted. In the text they appear only when they are a safe token; the
 * structured result carries them neutralised and marked untrusted (as render-wrapper does).
 *
 * Refusals follow `studio_asset_put` (same host, same shape): `isError`, `{ok:false, tool, code, error:{code,
 * message, details, correlationId}}`, codes INVALID_ARGUMENT, DOCUMENT_NOT_FOUND, REVISION_NOT_FOUND, INTERNAL_ERROR.
 * Every refusal and failure is logged as one JSON line (host log sink, else `<store>/logs/mcp-host/`).
 */
import { randomUUID } from "node:crypto"
import { lstatSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { appendJsonlDaily } from "../../../vendor/src/lib/studio/http/jsonl"
import { neutralizeDeep, tok, untrustedFields } from "../../../vendor/scripts/studio/mcp/tool-kit"
import { sessionLogRef, type HostToolExtension, type HostToolSession } from "../tool-table.ts"
import { readWitnessManifest, VERIFY_WITNESS_DPI, type WitnessManifest } from "./verify-outputs.ts"

type Rec = Record<string, unknown>
type WitnessListLog = (level: "info" | "warn" | "error", source: string, message: string, context?: Rec) => void

/** @internal test seam */
export const WITNESS_LIST_TOOL = "studio_witness_list"
const SOURCE = "datum-studio-host.witness-list"
const ID_MAX = 64
const KEYS: ReadonlySet<string> = new Set(["documentId", "revisionNo"])
const FOLDER_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Folders looked at per call (the render keeps the newest 20; anything beyond this is not read). */
const MAX_FOLDERS = 200
/** Pages listed in the text; the structured result always carries all of them. */
const MAX_TEXT_PAGES = 400

/** @internal test seam */
export const WITNESS_LIST_DESCRIPTION =
  "List the page images (PNG, 150 dpi) of every page of a document revision that carries a figure or chart, to look at them. Read only: the images are made by studio_render; when there are none yet, the reply names that call. Paths are absolute files in the Studio store (witness images, not deliverables). `missing` lists figure pages without an image."

const INPUT_SCHEMA: Rec = {
  type: "object",
  properties: {
    documentId: { type: "string", minLength: 1, maxLength: ID_MAX, description: "The document." },
    revisionNo: { type: "integer", minimum: 1, description: "Optional: a revision number. Default: the current revision." },
  },
  required: ["documentId"],
  additionalProperties: false,
}

/** The store calls the tool needs (SqliteStudioStore). */
export interface WitnessListStore {
  readonly rootDir: string
  getDocument(id: string): Promise<{ document: { current_revision_no: number } } | null>
  getRevision(documentId: string, n: number | "latest"): Promise<{ revision: { id: string; revision_no: number } } | null>
  getOutput(id: string): Promise<{ id: string; document_id: string | null; revision_id: string | null; format: string; role: string; time_created: number } | null>
}

class WitnessListRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Rec = {},
  ) {
    super(message)
  }
}

function refused(cid: string, code: string, message: string, details: Rec): CallToolResult {
  return {
    content: [{ type: "text", text: `galat ${code}: ${message}\ncorrelationId: ${cid}` }],
    structuredContent: { ok: false, tool: WITNESS_LIST_TOOL, code, error: { code, message, details, correlationId: cid }, correlationId: cid },
    isError: true,
  }
}

function validate(raw: Rec): { documentId: string; revisionNo?: number } {
  const extra = Object.keys(raw).filter((k) => !KEYS.has(k))
  if (extra.length > 0) throw new WitnessListRefusal("INVALID_ARGUMENT", "unknown argument (allowed: documentId, revisionNo)", { unknown: extra.slice(0, 10).map((k) => tok(k, "?")) })
  if (typeof raw.documentId !== "string" || raw.documentId === "" || raw.documentId.length > ID_MAX) {
    throw new WitnessListRefusal("INVALID_ARGUMENT", `documentId must be a non-empty string of at most ${ID_MAX} characters`, { field: "documentId" })
  }
  if (raw.revisionNo !== undefined && (typeof raw.revisionNo !== "number" || !Number.isInteger(raw.revisionNo) || raw.revisionNo < 1)) {
    throw new WitnessListRefusal("INVALID_ARGUMENT", "revisionNo must be an integer of at least 1 (omit it for the current revision)", { field: "revisionNo" })
  }
  return { documentId: raw.documentId, ...(typeof raw.revisionNo === "number" ? { revisionNo: raw.revisionNo } : {}) }
}

/** Names of the render folders under `<store>/verify/` (plain directories only, never a symlink). Never throws. */
function renderFolders(verifyDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(verifyDir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    if (!FOLDER_RE.test(name)) continue
    const st = lstatSync(join(verifyDir, name), { throwIfNoEntry: false })
    if (st && st.isDirectory() && !st.isSymbolicLink()) out.push(name)
    if (out.length >= MAX_FOLDERS) break
  }
  return out
}

interface WitnessLookup {
  revisionNo: number
  /** The witness list of the newest render of the revision that has one; null = none. */
  witness: WitnessManifest | null
}

/**
 * The witness list of one document revision, or `witness: null`. Read only.
 * Throws WitnessListRefusal DOCUMENT_NOT_FOUND / REVISION_NOT_FOUND.
 */
async function lookupWitness(store: WitnessListStore, documentId: string, revisionNo?: number): Promise<WitnessLookup> {
  const doc = await store.getDocument(documentId)
  if (!doc) throw new WitnessListRefusal("DOCUMENT_NOT_FOUND", "Document not found", { documentId: tok(documentId, "?") })
  const n = revisionNo ?? doc.document.current_revision_no
  const rev = await store.getRevision(documentId, n)
  if (!rev) throw new WitnessListRefusal("REVISION_NOT_FOUND", "Revision not found", { documentId: tok(documentId, "?"), revisionNo: n, currentRevisionNo: doc.document.current_revision_no })
  const renders: Array<{ id: string; at: number }> = []
  for (const name of renderFolders(join(store.rootDir, "verify"))) {
    const o = await store.getOutput(name)
    if (o && o.document_id === documentId && o.revision_id === rev.revision.id && o.format === "HTML" && o.role === "PRIMARY") renders.push({ id: o.id, at: Number(o.time_created) || 0 })
  }
  renders.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
  for (const r of renders) {
    const witness = readWitnessManifest(store.rootDir, r.id)
    if (witness) return { revisionNo: rev.revision.revision_no, witness }
  }
  return { revisionNo: rev.revision.revision_no, witness: null }
}

/** The one call that makes the witness images of a revision. */
/** @internal test seam */
export function witnessRenderCall(documentId: string, revisionNo?: number): string {
  return `call the tool datum-studio_studio_render with documentId "${tok(documentId, "<documentId>")}"${revisionNo !== undefined ? `, revisionNo ${revisionNo}` : ""}, formats "html" and "pdf"`
}

function result(documentId: string, asked: number | undefined, found: WitnessLookup): CallToolResult {
  const id = tok(documentId, "?")
  const head = `witness ${id} rev ${found.revisionNo}`
  const next = `${witnessRenderCall(documentId, asked)}, then ${WITNESS_LIST_TOOL} again`
  const w = found.witness
  if (!w) {
    return {
      content: [{ type: "text", text: `${head}: none. This revision has no witness images (not rendered yet, or the images were cleaned up). This tool does not render.\nnext: ${next}` }],
      structuredContent: { ok: true, tool: WITNESS_LIST_TOOL, documentId, revisionNo: found.revisionNo, witness: "none", dpi: VERIFY_WITNESS_DPI, pages: [], missing: [], next },
    }
  }
  const dpi = Number.isFinite(w.dpi) && w.dpi > 0 ? w.dpi : VERIFY_WITNESS_DPI
  const lines = [`${head}: ${w.pages.length} figure page(s) with an image, ${dpi} dpi (absolute paths in the Studio store; witness images, not deliverables)`]
  for (const p of w.pages.slice(0, MAX_TEXT_PAGES)) {
    const labels = p.figures.map((f) => tok(f, "")).filter((f) => f !== "")
    lines.push(`  p${p.page} ${p.png}${p.figures.length > 0 ? ` figures=${p.figures.length}${labels.length > 0 ? ` (${labels.join(", ")})` : ""}` : ""}`)
  }
  if (w.pages.length > MAX_TEXT_PAGES) lines.push(`  ... ${w.pages.length - MAX_TEXT_PAGES} more in the structured result`)
  if (w.basis === "none") lines.push("  figure pages are not known for this render (the layout has no fixed pages)")
  if (w.basis === "markup") lines.push("  pages were chosen from the page markup (every drawing or image, a logo may be included)")
  if (w.missing.length > 0) lines.push(`  figure pages without an image: ${w.missing.slice(0, 100).join(", ")}\nnext: ${next}`)
  if (w.unplaced.length > 0) lines.push(`  figures found on no page: ${w.unplaced.length}`)
  const data = neutralizeDeep({
    documentId,
    revisionNo: found.revisionNo,
    witness: "found",
    htmlOutputId: w.htmlOutputId,
    dpi,
    basis: w.basis,
    pages: w.pages,
    missing: w.missing,
    unplaced: w.unplaced.map((x) => x.slice(0, 80)),
    reason: w.reason === null ? null : w.reason.slice(0, 300),
    ...(w.missing.length > 0 ? { next } : {}),
  }) as Rec
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { ok: true, tool: WITNESS_LIST_TOOL, ...data, ...untrustedFields(["pages.figures", "unplaced", "reason"]) },
  }
}

interface WitnessListOptions {
  /** The host's log channel; without it the tool writes its own daily JSONL under the store. */
  log?: WitnessListLog
}

/** `studio_witness_list` as a host extension (toolset `documents`, beside `studio_render` and `studio_file_verify`). */
export function witnessListExtension(store: WitnessListStore, opts: WitnessListOptions = {}): HostToolExtension {
  const log = (level: "info" | "warn" | "error", message: string, context: Rec) => {
    try {
      if (opts.log) {
        opts.log(level, SOURCE, message, context)
        return
      }
    } catch {
      // a failing host log falls through to the tool's own file
    }
    const entry: { timestamp: string } & Rec = { timestamp: new Date().toISOString(), level, source: SOURCE, message, context }
    void appendJsonlDaily("mcp-host", "datum-studio-witness-list", entry).catch(() => undefined)
  }
  return {
    name: WITNESS_LIST_TOOL,
    title: "List witness page images",
    description: WITNESS_LIST_DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    annotations: { title: "List witness page images", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    toolsets: ["documents"] as const,
    async call(raw: Record<string, unknown>, session: HostToolSession): Promise<CallToolResult> {
      const cid = randomUUID()
      const a = (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Rec
      const ctx: Rec = {
        correlationId: cid,
        tool: WITNESS_LIST_TOOL,
        agentId: session.agentId,
        ...sessionLogRef(session),
        ...(typeof a.documentId === "string" ? { documentId: a.documentId.slice(0, ID_MAX) } : {}),
        ...(typeof a.revisionNo === "number" ? { revisionNo: a.revisionNo } : {}),
      }
      try {
        const args = validate(a)
        return result(args.documentId, args.revisionNo, await lookupWitness(store, args.documentId, args.revisionNo))
      } catch (e) {
        if (e instanceof WitnessListRefusal) {
          log("warn", "witness list refused", { ...ctx, ok: false, code: e.code })
          return refused(cid, e.code, e.message, e.details)
        }
        const err = e instanceof Error ? e : new Error(String(e))
        log("error", "witness list failed", { ...ctx, ok: false, code: "INTERNAL_ERROR", message: err.message.slice(0, 300), stack_trace: err.stack })
        return refused(cid, "INTERNAL_ERROR", "galat internal; rincian ada di log host", {})
      }
    },
  }
}
