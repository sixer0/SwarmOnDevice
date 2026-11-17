/**
 * W-13 (N-106, 1.2.6 row 50c): the host tool `studio_asset_put` (01f §4.1, as amended by 01_specs W-13 / R3).
 *
 * Takes one PNG or JPEG, either `path` (absolute, inside the session file root only, N-108 / D5) or `dataBase64`
 * (plain base64 or a png/jpeg data URI), and stores it through the in-process `storeAsset` (dedupe by sha256,
 * `created: false` on a repeat, D2). It does not go through R18 (01f alternative E rejected: base64 inflation and
 * the 5 MiB JSON cap). The read side reuses row 50b's `readAssetFile` (vendored guard purpose "read-asset"), and
 * the SEC-10 metadata notice reuses `assetMetadataWarning` (report only, nothing stripped, C8).
 *
 * - Type by content only (PNG/JPEG); SVG, GIF and the rest -> ASSET_TYPE_UNSUPPORTED (vendored decoder).
 * - Limits live in the service: 20 MiB, 20,000 px side, 80 MP (ASSET_TOO_LARGE). `dataBase64` is practically
 *   capped at ~6 MiB by the 8 MiB MCP message limit, so the description sends larger images to `path`.
 * - Read side refusals keep the MCP codes (D1): PATH_INVALID, PATH_OUTSIDE_ROOTS, FILE_UNREADABLE.
 * - `documentId` (D4): checked to exist (DOCUMENT_NOT_FOUND) and written to the log context only; assets are
 *   global by sha and are never bound to a document.
 * - SEC-11: the suggested `Sumber:` text names the basename of `path`, never the absolute path.
 * - Main agent only: NOT in STUDIO_SUBAGENT_TOOLS (01_specs W-13 / Q2 default); a subagent references a sha.
 *
 * - Swarm 1.3.3 row 116 (ST-8, Q4): `svg` + `width` converts a framed SVG sheet (frame script output) to a PNG at
 *   the printed width (svg-intake.ts: sanitised, refused by name, 300 dpi through the render bridge). Only the PNG is
 *   stored; the result carries `fromSvg` and says which block `width` to cite. `width` without `svg` is refused.
 *
 * Every refusal is an `isError` result `{ok:false, tool, code, error:{code, message, details}}` without a stack.
 * Every call is logged as one JSON line to the runner log (if given) and to
 * `<store>/logs/mcp-host/datum-studio-asset-tool-<day>.jsonl` with a correlation id; never bytes or full paths.
 */
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { localStudioCaller } from "../../vendor/src/lib/studio/contract/auth"
import { StudioEngineError } from "../../vendor/src/lib/studio/contract/errors"
import { appendJsonlDaily } from "../../vendor/src/lib/studio/http/jsonl"
import { assetRefOf, decodeImageDetailed, storeAsset } from "../../vendor/src/lib/studio/services/images"
import { McpToolError } from "../../vendor/scripts/studio/mcp/safety"
import { docById } from "./local-api/db.ts"
import { framedSvgToPng, svgInputProblem, SvgIntakeRefusal, type FramedSvgPng } from "./svg-intake.ts"
import type { FigureWidthV2 } from "../../vendor/src/lib/studio/contract/types/v2/doc"
import { FIGURE_WIDTH_VALUES } from "../../vendor/src/lib/studio/contract/schema/v2/common.schema"
import { assetMetadataWarning, readAssetFile } from "./local-api/routes/r18-asset-path.ts"
import { loadFigureContext } from "./local-api/routes/figure-preview-load.ts"
import { storedComposeContext } from "../../vendor/src/lib/studio/services/compose"
import type { ParamMap, ResolvedTemplate } from "../../vendor/src/lib/studio/contract"
import { sessionLogRef, type HostToolExtension, type HostToolSession } from "./tool-table.ts"

type Rec = Record<string, unknown>
export type AssetToolLog = (level: "info" | "warn" | "error", source: string, message: string, context?: Rec) => void

export const ASSET_TOOL_NAME = "studio_asset_put"
const SOURCE = "datum-studio-host.asset-tool"
const ID_MAX = 64
const KEYS: ReadonlySet<string> = new Set(["path", "dataBase64", "documentId", "svg", "width"])
const MAX_MESSAGE = 300

// Row 149: <= 450 characters (rel129 A13) and it teaches both sha256 citation forms again (row 50c pin); the
// `.png/.jpg` detail lives in the `path` property description, the SVG detail in STUDIO-AGENT-GUIDE.md section 10.
const DESCRIPTION = [
  "Store PNG/JPEG; get its sha256 reference. Give `path` (inside the project folder of this session) or `dataBase64`; above ~6 MiB use `path` (messages capped at 8 MiB).",
  "The result reports embedded metadata (GPS, EXIF, PNG text); Studio stores the bytes unchanged.",
  "Framed SVG: `svg`, `width` text|full, `documentId` (template width) -> PNG; unsafe SVG refused.",
  'Cite {"type":"image","asset":"sha256:<hex>",...} or ![caption](sha256:<hex> "Sumber: ...").',
].join(" ")

const INPUT_SCHEMA: Rec = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute path of a .png/.jpg/.jpeg file inside the session's project folder." },
    dataBase64: { type: "string", description: "Base64 image bytes or a data:image/png|jpeg;base64 URI (up to ~6 MiB)." },
    documentId: { type: "string", description: "Optional: the document the image is for; with svg its template sets the width (else A4). Assets are shared by sha256." },
    svg: { type: "string", description: "Framed SVG sheet text (frame script); converted to PNG." },
    width: { type: "string", enum: [...FIGURE_WIDTH_VALUES], description: "With svg: the image block width." },
  },
  additionalProperties: false,
}

class AssetToolRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Rec = {},
  ) {
    super(message)
  }
}

const clip = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}...` : s)

function refused(cid: string, code: string, message: string, details: Rec): CallToolResult {
  return {
    content: [{ type: "text", text: `galat ${code}: ${clip(message)}\ncorrelationId: ${cid}` }],
    structuredContent: { ok: false, tool: ASSET_TOOL_NAME, code, error: { code, message: clip(message), details, correlationId: cid }, correlationId: cid },
    isError: true,
  }
}

type Args = { path?: string; dataBase64?: string; documentId?: string; svg?: string; width?: FigureWidthV2 }

function validate(raw: Rec): Args {
  const extra = Object.keys(raw).filter((k) => !KEYS.has(k))
  if (extra.length > 0) throw new AssetToolRefusal("INVALID_ARGUMENT", `unknown argument: ${extra.join(", ")}`, { unknown: extra })
  const hasPath = raw.path !== undefined
  const hasData = raw.dataBase64 !== undefined
  const hasSvg = raw.svg !== undefined
  if (Number(hasPath) + Number(hasData) + Number(hasSvg) !== 1) {
    throw new AssetToolRefusal("INVALID_ARGUMENT", "give exactly one of path, dataBase64 and svg", { oneOf: ["path", "dataBase64", "svg"] })
  }
  if (raw.width !== undefined && !hasSvg) throw new AssetToolRefusal("INVALID_ARGUMENT", "width is only for svg (a PNG/JPEG takes its width in the image block)", { field: "width" })
  if (hasSvg) {
    const bad = svgInputProblem(raw.svg, raw.width)
    if (bad) throw new AssetToolRefusal("INVALID_ARGUMENT", bad.message, { field: bad.pointer.slice(1) })
  }
  if (hasData && typeof raw.dataBase64 !== "string") throw new AssetToolRefusal("INVALID_ARGUMENT", "dataBase64 must be a string")
  if (raw.documentId !== undefined && (typeof raw.documentId !== "string" || raw.documentId === "" || raw.documentId.length > ID_MAX)) {
    throw new AssetToolRefusal("INVALID_ARGUMENT", `documentId must be a non-empty string of at most ${ID_MAX} characters`)
  }
  return {
    ...(hasPath ? { path: raw.path as string } : {}),
    ...(hasData ? { dataBase64: raw.dataBase64 as string } : {}),
    ...(typeof raw.documentId === "string" ? { documentId: raw.documentId } : {}),
    ...(hasSvg ? { svg: raw.svg as string, width: raw.width as FigureWidthV2 } : {}),
  }
}

/** SEC-11: the suggested source names the file's basename only (never a full path), else a placeholder. */
function sourceHint(p: string | undefined): string {
  return p ? `Sumber: <alat dan versinya> dari ${path.basename(p)}` : "Sumber: <alat dan versinya> dari <berkas masukan>"
}

/**
 * Row 149 (senior S10): the template parameters compose uses for the document's blocks: the compose context stored in
 * the current revision (exactly the keys compose read, COMPOSE_PARAM_KEYS), else the pinned template's parameters
 * (a v1 snapshot without a stored context). Document-level parameters; a slot's own override is not consulted.
 */
/** @internal test seam */
export function figureParamsOf(snapshot: unknown, template: Pick<ResolvedTemplate, "params"> | null | undefined): ParamMap | undefined {
  return storedComposeContext(snapshot)?.params ?? template?.params ?? undefined
}

/** Default resolver: the current revision and its pinned template, read through the figure-preview loader. */
async function documentFigureParams(documentId: string): Promise<ParamMap | undefined> {
  const f = await loadFigureContext(documentId, undefined)
  return figureParamsOf(f.snapshot, f.template)
}

async function put(args: Args, session: HostToolSession, cid: string, templateParams: (documentId: string) => Promise<ParamMap | undefined>) {
  if (args.documentId !== undefined && !(await docById(args.documentId))) {
    throw new AssetToolRefusal("DOCUMENT_NOT_FOUND", "Document not found", { documentId: args.documentId })
  }
  if (args.svg !== undefined) {
    // Row 116: sanitise (refused by name) -> place at the width -> 300 dpi PNG; only the PNG is stored.
    // Row 149 (S10): the column comes from compose for the document's template; without documentId, A4 (said in the reply).
    const params = args.documentId !== undefined ? await templateParams(args.documentId) : undefined
    const fromSvg = await framedSvgToPng(args.svg, args.width as FigureWidthV2, { templateParams: params })
    const img = decodeImageDetailed({ bytes: fromSvg.png })
    const stored = await storeAsset(localStudioCaller(session.agentId), { file: img.bytes }, undefined, { correlationId: cid })
    return { stored, metadata: img.metadata, warning: assetMetadataWarning(img.metadata), fromSvg }
  }
  // Decode once for the SEC-10 metadata scan (header-first pixel guard, row 50a); storeAsset stores the same bytes.
  const img = args.path !== undefined ? decodeImageDetailed({ bytes: readAssetFile(args.path, session.fileRoot ? [session.fileRoot] : []).bytes }) : decodeImageDetailed({ base64: args.dataBase64 as string })
  const stored = await storeAsset(localStudioCaller(session.agentId), { file: img.bytes }, undefined, { correlationId: cid })
  return { stored, metadata: img.metadata, warning: assetMetadataWarning(img.metadata), fromSvg: undefined as FramedSvgPng | undefined }
}

/** Row 116: the conversion facts reported back (no bytes). */
export function fromSvgSummary(f: FramedSvgPng): Rec {
  return { width: f.width, sheetWidthMm: f.sheetWidthMm, sheetHeightMm: f.sheetHeightMm, widthMm: f.widthMm, heightMm: f.heightMm, dpi: f.dpi, widthSource: f.widthSource }
}

export interface AssetHostExtensionOptions {
  /** The host runner's log channel; the tool also keeps its own daily JSONL under the store. */
  log?: AssetToolLog
  /** Row 149: template parameters of a document (svg width). Default: {@link documentFigureParams} over the store. */
  templateParams?: (documentId: string) => Promise<ParamMap | undefined>
}

/** `studio_asset_put` as a host extension (toolset `write`, 01f §4.1). */
export function assetHostExtension(opts: AssetHostExtensionOptions = {}): HostToolExtension {
  const log = (level: "info" | "warn" | "error", message: string, context: Rec) => {
    try {
      opts.log?.(level, SOURCE, message, context)
    } catch {
      // a failing runner log must not break a call
    }
    const entry: { timestamp: string } & Rec = { timestamp: new Date().toISOString(), level, source: SOURCE, message, context }
    void appendJsonlDaily("mcp-host", "datum-studio-asset-tool", entry).catch(() => undefined)
  }
  return {
    name: ASSET_TOOL_NAME,
    title: "Upload an image asset",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    annotations: { title: "Upload an image asset", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    toolsets: ["write"] as const,
    async call(raw: Record<string, unknown>, session: HostToolSession): Promise<CallToolResult> {
      const cid = randomUUID()
      const t0 = Date.now()
      const a = (raw ?? {}) as Rec
      // Identifiers only: never bytes, never the full path (SEC-11), only the basename.
      const ctx: Rec = {
        correlationId: cid,
        tool: ASSET_TOOL_NAME,
        agentId: session.agentId,
        ...sessionLogRef(session),
        source: typeof a.path === "string" ? "path" : a.dataBase64 !== undefined ? "base64" : a.svg !== undefined ? "svg" : "none",
        ...(typeof a.path === "string" ? { file: path.basename(a.path) } : {}),
        ...(typeof a.documentId === "string" ? { documentId: a.documentId.slice(0, ID_MAX) } : {}),
      }
      try {
        const args = validate(a)
        const { stored, metadata, warning, fromSvg } = await put(args, session, cid, opts.templateParams ?? documentFigureParams)
        const s = stored.asset
        const ref = assetRefOf(s.sha256)
        const svgFacts = fromSvg ? fromSvgSummary(fromSvg) : undefined
        log("info", stored.created ? "asset uploaded" : "asset upload deduplicated", { ...ctx, ok: true, sha256: s.sha256, bytes: s.bytes, created: stored.created, metadata, ...(svgFacts ? { fromSvg: svgFacts } : {}), durationMs: Date.now() - t0 })
        const line = `asset ${ref} (${s.widthPx}×${s.heightPx} px, ${s.bytes} B, ${stored.created ? "baru" : "sudah ada"}). Rujuk: ![<keterangan>](${ref} "${sourceHint(args.path)}")`
        const svgLine = fromSvg
          ? `\nlembar SVG ${fromSvg.sheetWidthMm}×${fromSvg.sheetHeightMm} mm -> PNG ${fromSvg.dpi} dpi, cetak ${fromSvg.widthMm}×${fromSvg.heightMm} mm. Blok gambar: {"type":"image","asset":"${ref}","width":"${fromSvg.width}",...}` +
            (fromSvg.widthSource === "a4-default"
              ? `\nlebar ${fromSvg.widthMm} mm memakai nilai A4 (text 128, full 166 mm) karena gambar belum terikat dokumen; kirim documentId agar lebar mengikuti templat dokumen.`
              : `\nlebar ${fromSvg.widthMm} mm dari templat dokumen ${args.documentId}.`)
          : ""
        return {
          content: [{ type: "text", text: (warning ? `${line}\n${warning}` : line) + svgLine }],
          structuredContent: { ok: true, tool: ASSET_TOOL_NAME, sha256: s.sha256, ref, mime: s.mime, widthPx: s.widthPx, heightPx: s.heightPx, bytes: s.bytes, created: stored.created, metadata, ...(warning ? { warning } : {}), ...(svgFacts ? { fromSvg: svgFacts } : {}) },
        }
      } catch (e) {
        if (e instanceof SvgIntakeRefusal) {
          log("warn", "asset tool refused", { ...ctx, ok: false, code: e.code, reason: e.details.reason ?? null, construct: e.details.construct ?? null, durationMs: Date.now() - t0 })
          return refused(cid, e.code, e.message, e.details)
        }
        if (e instanceof AssetToolRefusal || e instanceof McpToolError) {
          const details = e instanceof AssetToolRefusal ? e.details : {}
          log("warn", "asset tool refused", { ...ctx, ok: false, code: e.code, durationMs: Date.now() - t0 })
          return refused(cid, e.code, e.message, details)
        }
        if (e instanceof StudioEngineError) {
          const d = (e.details ?? {}) as Rec
          const details: Rec = {
            ...(d.reason !== undefined ? { reason: d.reason } : {}),
            ...(d.retryAfterSec !== undefined ? { retryAfterSec: d.retryAfterSec } : {}),
            ...(d.limitBytes !== undefined ? { limitBytes: d.limitBytes } : {}),
            ...(d.maxSidePx !== undefined ? { maxSidePx: d.maxSidePx, maxPixels: d.maxPixels } : {}),
          }
          log(e.code === "STORAGE_WRITE_FAILED" ? "error" : "warn", "asset tool refused", { ...ctx, ok: false, code: e.code, reason: d.reason ?? null, durationMs: Date.now() - t0 })
          return refused(cid, e.code, e.message, details)
        }
        const err = e instanceof Error ? e : new Error(String(e))
        log("error", "asset tool failed", { ...ctx, ok: false, code: "INTERNAL_ERROR", message: clip(err.message), stack_trace: err.stack, durationMs: Date.now() - t0 })
        return refused(cid, "INTERNAL_ERROR", "galat internal alat aset; tidak ada yang disimpan", {})
      }
    },
  }
}
