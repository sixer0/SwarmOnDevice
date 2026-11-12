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
import { assetMetadataWarning, readAssetFile } from "./local-api/routes/r18-asset-path.ts"
import type { HostToolExtension, HostToolSession } from "./tool-table.ts"

type Rec = Record<string, unknown>
export type AssetToolLog = (level: "info" | "warn" | "error", source: string, message: string, context?: Rec) => void

export const ASSET_TOOL_NAME = "studio_asset_put"
const SOURCE = "datum-studio-host.asset-tool"
const ID_MAX = 64
const KEYS: ReadonlySet<string> = new Set(["path", "dataBase64", "documentId"])
const MAX_MESSAGE = 300

const DESCRIPTION = [
  "Upload one PNG or JPEG image into the Studio asset store and get its sha256 reference. Give exactly one of `path` (absolute path to a .png/.jpg/.jpeg file inside the project folder of this session) or `dataBase64` (base64 or a data:image/png|jpeg;base64 URI).",
  "For images above ~6 MiB use `path` (an MCP message is capped at 8 MiB). Limits: 20 MiB, 20,000 px per side, 80 MP. SVG, GIF and other types are refused (ASSET_TYPE_UNSUPPORTED): export the figure as PNG first.",
  "The same bytes uploaded again return the same sha256 with created:false. The result reports embedded metadata (GPS, EXIF, PNG text); Studio stores the bytes unchanged.",
  'Reference the asset in a block as {"type":"image","asset":"sha256:<hex>","caption":"...","source":"Sumber: ..."} or in Markdown as ![caption](sha256:<hex> "Sumber: <tool and input file>"). The caption carries no "Gambar n.m" number.',
].join(" ")

const INPUT_SCHEMA: Rec = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute path of a .png/.jpg/.jpeg file inside the session's project folder." },
    dataBase64: { type: "string", description: "Base64 image bytes or a data:image/png|jpeg;base64 URI (up to ~6 MiB)." },
    documentId: { type: "string", description: "Optional: the document the image is for (logged only; assets are shared by sha256)." },
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

function validate(raw: Rec): { path?: string; dataBase64?: string; documentId?: string } {
  const extra = Object.keys(raw).filter((k) => !KEYS.has(k))
  if (extra.length > 0) throw new AssetToolRefusal("INVALID_ARGUMENT", `unknown argument: ${extra.join(", ")}`, { unknown: extra })
  const hasPath = raw.path !== undefined
  const hasData = raw.dataBase64 !== undefined
  if (hasPath === hasData) throw new AssetToolRefusal("INVALID_ARGUMENT", "give exactly one of path and dataBase64", { oneOf: ["path", "dataBase64"] })
  if (hasData && typeof raw.dataBase64 !== "string") throw new AssetToolRefusal("INVALID_ARGUMENT", "dataBase64 must be a string")
  if (raw.documentId !== undefined && (typeof raw.documentId !== "string" || raw.documentId === "" || raw.documentId.length > ID_MAX)) {
    throw new AssetToolRefusal("INVALID_ARGUMENT", `documentId must be a non-empty string of at most ${ID_MAX} characters`)
  }
  return {
    ...(hasPath ? { path: raw.path as string } : {}),
    ...(hasData ? { dataBase64: raw.dataBase64 as string } : {}),
    ...(typeof raw.documentId === "string" ? { documentId: raw.documentId } : {}),
  }
}

/** SEC-11: the suggested source names the file's basename only (never a full path), else a placeholder. */
function sourceHint(p: string | undefined): string {
  return p ? `Sumber: <alat dan versinya> dari ${path.basename(p)}` : "Sumber: <alat dan versinya> dari <berkas masukan>"
}

async function put(args: { path?: string; dataBase64?: string; documentId?: string }, session: HostToolSession, cid: string) {
  if (args.documentId !== undefined && !(await docById(args.documentId))) {
    throw new AssetToolRefusal("DOCUMENT_NOT_FOUND", "Document not found", { documentId: args.documentId })
  }
  // Decode once for the SEC-10 metadata scan (header-first pixel guard, row 50a); storeAsset stores the same bytes.
  const img = args.path !== undefined ? decodeImageDetailed({ bytes: readAssetFile(args.path, session.fileRoot ? [session.fileRoot] : []).bytes }) : decodeImageDetailed({ base64: args.dataBase64 as string })
  const stored = await storeAsset(localStudioCaller(session.agentId), { file: img.bytes }, undefined, { correlationId: cid })
  return { stored, metadata: img.metadata, warning: assetMetadataWarning(img.metadata) }
}

export interface AssetHostExtensionOptions {
  /** The host runner's log channel; the tool also keeps its own daily JSONL under the store. */
  log?: AssetToolLog
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
        sessionId: session.sessionId,
        source: typeof a.path === "string" ? "path" : a.dataBase64 !== undefined ? "base64" : "none",
        ...(typeof a.path === "string" ? { file: path.basename(a.path) } : {}),
        ...(typeof a.documentId === "string" ? { documentId: a.documentId.slice(0, ID_MAX) } : {}),
      }
      try {
        const args = validate(a)
        const { stored, metadata, warning } = await put(args, session, cid)
        const s = stored.asset
        const ref = assetRefOf(s.sha256)
        log("info", stored.created ? "asset uploaded" : "asset upload deduplicated", { ...ctx, ok: true, sha256: s.sha256, bytes: s.bytes, created: stored.created, metadata, durationMs: Date.now() - t0 })
        const line = `asset ${ref} (${s.widthPx}×${s.heightPx} px, ${s.bytes} B, ${stored.created ? "baru" : "sudah ada"}). Rujuk: ![<keterangan>](${ref} "${sourceHint(args.path)}")`
        return {
          content: [{ type: "text", text: warning ? `${line}\n${warning}` : line }],
          structuredContent: { ok: true, tool: ASSET_TOOL_NAME, sha256: s.sha256, ref, mime: s.mime, widthPx: s.widthPx, heightPx: s.heightPx, bytes: s.bytes, created: stored.created, metadata, ...(warning ? { warning } : {}) },
        }
      } catch (e) {
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
