import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { Effect } from "effect"
import { isDeepStrictEqual } from "node:util"
import { DATUM_STUDIO_MCP } from "./datum-studio"

const DEFAULT_TIMEOUT = 30_000
const MAX_LIST_PAGES = 1_000

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
) {
  const result: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const page = await list(cursor)
    result.push(...items(page))
    if (page.nextCursor === undefined) return result
    if (cursors.has(page.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${page.nextCursor}`)
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
}

/**
 * 1.2.8 row 45 (PROJ-b, N8-456, 01d §7.3): Studio host tools that act for the person. Swarm's own Mission Control
 * client calls them; opencode never lists them to an agent, whatever the server. Other MCP clients still see them
 * (residual S-5; the host's attested-session check is row 45b, SR8-05).
 */
export const PERSON_ONLY_MCP_TOOLS: readonly string[] = ["studio_mission_place"]

export function defs(client: Client, timeout?: number) {
  return listTools(client, timeout ?? DEFAULT_TIMEOUT).pipe(
    Effect.map((tools) => tools.filter((tool) => !PERSON_ONLY_MCP_TOOLS.includes(tool.name))),
    Effect.catch(() => Effect.void),
  )
}

/** Row 188/192 (L51): the `_meta` key datum-studio reads to link a mission write to the calling Swarm session. */
export const CALLER_SESSION_META = "studio/callerSession"

/** The `_meta` a datum-studio tool call carries: the calling session, so missions link without the agent naming it. */
export function callerSessionMeta(sessionID: string): Record<string, unknown> {
  return { [CALLER_SESSION_META]: sessionID }
}

/**
 * Row 197 (S194-01): the `_meta` key that tells datum-studio Swarm's autonomous mode setting is on for the calling
 * session (the person turns it on). Only Swarm's own code sets it, per call; the model writes `arguments`, never `_meta`.
 */
export const AUTONOMOUS_META = "studio/autonomous"

/**
 * 1.2.8 MEM-e (N8-012, 01e §4.2): the `_meta` key that tells datum-studio whether this project's memory holds the
 * mission's index entry, as `{missionId, present}`. Swarm's own code sets it on `studio_mission_set_status {to: done}`
 * only; the host reads it only from agent `swarm` (a compliance gate, not access control: SR8-22).
 */
export const MEMORY_INDEX_META = "studio/memoryIndex"

/**
 * The `_meta` of one call: fixed, or read when the call is made (so a mode switched off holds from the next call). The
 * function gets the call's arguments (MEM-e); callers that ignore them are unchanged.
 */
export type CallMeta =
  | Record<string, unknown>
  | ((args: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>)

/** SEC-21: settle with the signal's reason as soon as it aborts, whichever comes first. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/** N-041 (M-03, U5): the most bytes of structuredContent gate fields appended as text when `content` is present. */
export const STRUCTURED_CONTENT_TEXT_MAX_BYTES = 16384

// Gate fields: identity, status/verification, digests, counts, check codes and file names. Everything else
// (prose, labels, page detail, payloads) stays in structuredContent only.
const GATE_KEY =
  /^(id|outputId|documentId|fileId|jobId|code|format|role|scope|status|state|overall|verified|valid|partial|truncated|revisionNo|sha|sha256|fileName|finalFileName|savedTo|path|correlationIds?)$|Status$|Sha256$|Count$|Verified$|^fail/
// A value under a path the server lists in `untrustedFields` is shown only when it is a plain token (no prose).
const SAFE_TOKEN = /^[\w.\-:/@+=#]{1,200}$/
const UNTRUSTED_OMITTED = "(untrusted, omitted)"
const MAX_STRING = 256
const MAX_DEPTH = 12

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function projectGate(value: unknown, key: string, path: string, untrusted: string[], depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined
  if (Array.isArray(value)) {
    const items = value.map((v) => projectGate(v, key, `${path}[]`, untrusted, depth + 1)).filter((v) => v !== undefined)
    return items.length > 0 ? items : undefined
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).flatMap(([k, v]) => {
      if (k === "untrustedFields") return []
      const projected = projectGate(v, k, path ? `${path}.${k}` : k, untrusted, depth + 1)
      return projected === undefined ? [] : [[k, projected] as const]
    })
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }
  if (!GATE_KEY.test(key)) return undefined
  if (typeof value !== "string") return typeof value === "function" || value === undefined ? undefined : value
  if (untrusted.some((u) => path === u || path.startsWith(`${u}.`) || path.startsWith(`${u}[`)))
    return SAFE_TOKEN.test(value) ? value : UNTRUSTED_OMITTED
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value
}

/** FAIL tallies: per failed check (`id`/`code` of an object with status FAIL) and per finding code inside it. */
function failTally(root: unknown) {
  const perCheck = new Map<string, number>()
  const perFinding = new Map<string, number>()
  let notListed = 0
  const bump = (map: Map<string, number>, k: unknown) => {
    if (typeof k === "string" && SAFE_TOKEN.test(k)) map.set(k, (map.get(k) ?? 0) + 1)
  }
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return
    if (Array.isArray(value)) return value.forEach((v) => walk(v, depth + 1))
    if (!isRecord(value)) return
    if (value.status === "FAIL") {
      bump(perCheck, value.id ?? value.code)
      if (Array.isArray(value.findings)) for (const f of value.findings) if (isRecord(f)) bump(perFinding, f.code)
      if (typeof value.truncated === "number" && value.truncated > 0) notListed += value.truncated
    }
    for (const v of Object.values(value)) walk(v, depth + 1)
  }
  walk(root, 0)
  const list = (map: Map<string, number>) => [...map].map(([k, n]) => `${k}=${n}`).join(", ")
  return [
    ...(perCheck.size > 0 ? [`FAIL per check: ${list(perCheck)}`] : []),
    ...(perFinding.size > 0 || notListed > 0
      ? [`FAIL findings per code: ${list(perFinding)}${notListed > 0 ? ` (+${notListed} not listed)` : ""}`]
      : []),
  ]
}

/**
 * M-03 (1.2.6 row 74, U5): a compact text projection of the gate fields in `structuredContent` (status and
 * verification per output, full sha256, FAIL counts per code, file list), at most STRUCTURED_CONTENT_TEXT_MAX_BYTES.
 * Undefined when the structured content carries no gate field.
 */
export function structuredGateText(structuredContent: unknown): string | undefined {
  if (!isRecord(structuredContent)) return undefined
  const untrusted = Array.isArray(structuredContent.untrustedFields)
    ? structuredContent.untrustedFields.filter((u): u is string => typeof u === "string")
    : []
  const projection = projectGate(structuredContent, "", "", untrusted, 0)
  const tally = failTally(structuredContent)
  if (projection === undefined && tally.length === 0) return undefined
  const text = [
    "structuredContent gate fields (compact; full data stays in structuredContent):",
    ...tally,
    ...(projection === undefined ? [] : [JSON.stringify(projection)]),
  ].join("\n")
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= STRUCTURED_CONTENT_TEXT_MAX_BYTES) return text
  const budget = STRUCTURED_CONTENT_TEXT_MAX_BYTES - 96 // room for the marker
  const head = new TextDecoder().decode(encoded.slice(0, budget)).replace(/�+$/, "")
  const shown = new TextEncoder().encode(head).length
  return `${head}\n… (truncated: ${shown} of ${encoded.length} bytes shown; full data in structuredContent)`
}

export function convertTool(
  mcpTool: MCPToolDef,
  client: Client,
  timeout?: number,
  meta?: CallMeta,
): Tool {
  const inputSchema: JSONSchema7 = {
    ...(mcpTool.inputSchema as JSONSchema7),
    type: "object",
    properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    execute: async (args: unknown, options) => {
      // SEC-21 (1.2.6 row 53b): the session's abort ends the whole call, including the `_meta` lookup that runs
      // before the transport request; `signal` below then cancels the request itself (the SDK sends
      // notifications/cancelled), so a hung server cannot hold the call for the full `timeout`.
      const signal = options.abortSignal
      signal?.throwIfAborted()
      const callArgs = (args || {}) as Record<string, unknown>
      const callMeta = typeof meta === "function" ? await abortable(meta(callArgs), signal) : meta
      const result = await client.callTool(
        {
          name: mcpTool.name,
          arguments: callArgs,
          // The SDK merges its progress token into this object (protocol.js request), so both reach the server.
          ...(callMeta ? { _meta: { ...callMeta } } : {}),
        },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          signal,
          timeout,
          // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
          onprogress: () => {},
        },
      )
      if (result.isError)
        throw new Error(
          result.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((text) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        )
      if (result.structuredContent === undefined || result.structuredContent === null) return result
      if (result.content.length > 0) {
        // M-03 (1.2.6 row 74): the text alone hides gate fields carried only in structuredContent.
        const gate = structuredGateText(result.structuredContent)
        return gate === undefined ? result : { ...result, content: [...result.content, { type: "text" as const, text: gate }] }
      }
      return {
        ...result,
        content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
      }
    },
  })
}

export function fetch<T extends { name: string }>(
  clientName: string,
  client: Client,
  list: (client: Client) => Promise<T[]>,
  label: string,
  key?: (item: T) => string,
) {
  return Effect.tryPromise({
    try: () => list(client),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`failed to get ${label}`, {
        clientName,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.map((items) => {
      const sanitizedClient = sanitize(clientName)
      // Escape both the separator and escape marker so `server:uri` keys remain unambiguous.
      const resourceClient = clientName.replaceAll("%", "%25").replaceAll(":", "%3A")
      return Object.fromEntries(
        items.map((item) => [
          key ? resourceClient + ":" + key(item) : sanitizedClient + ":" + sanitize(item.name),
          { ...item, client: clientName },
        ]),
      )
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export const toolName = (clientName: string, name: string) => sanitize(clientName) + "_" + sanitize(name)

/**
 * SEC-13 (1.2.6 row 56a): whether a server name could compose the built-in DATUM Studio tool keys
 * `datum-studio_<tool>` (which carry the subagent Studio allows, row 56): its sanitised name equals `datum-studio` or
 * starts with `datum-studio_`. Compared case-insensitively, as permission keys match case-insensitively on win32.
 * The one SEC-13 rule: the subagent binding (agent/subagent-permissions.ts studioToolsBound) uses it too (gate M2 S4).
 */
export function reservedServerName(name: string): boolean {
  const sanitised = sanitize(name).toLowerCase()
  return sanitised === DATUM_STUDIO_MCP || sanitised.startsWith(`${DATUM_STUDIO_MCP}_`)
}

/**
 * SEC-13 (1.2.6 row 56a): the refusal message for a server that may not be loaded (`load`, config) or added at
 * runtime (`add`, MCP.add), or undefined when it may. Any reserved name other than the `datum-studio` key itself is
 * refused. The `datum-studio` key at load is the built-in or the user's own replacement (row 33: the user's entry
 * wins; row 56 then drops the subagent allows). At `add` it is refused unless the entry is the built-in one
 * (`builtin`, from DatumStudioMcp.builtin; `enabled` and `timeout` ignored), because row 56 decides the binding at
 * agent setup and cannot see a later add.
 */
export function serverRefusal(
  name: string,
  entry: Readonly<Record<string, unknown>> | undefined,
  builtin: Readonly<Record<string, unknown>> | undefined,
  at: "load" | "add",
): string | undefined {
  if (!reservedServerName(name)) return undefined
  if (name === DATUM_STUDIO_MCP) {
    if (at === "load") return undefined
    if (builtin !== undefined && entry !== undefined && isDeepStrictEqual(serverIdentity(entry), serverIdentity(builtin)))
      return undefined
  }
  return (
    `MCP server "${name}" refused: the name is reserved for Swarm's built-in DATUM Studio server ` +
    `(a name that sanitises to "${DATUM_STUDIO_MCP}" or starts with "${DATUM_STUDIO_MCP}_" would share its tool names). ` +
    `Rename the server.`
  )
}

/**
 * SEC-13: the part of a server entry that decides which program answers; `enabled` and `timeout` are left out. Shared
 * with the subagent binding (agent/subagent-permissions.ts studioToolsBound, gate M2 S4) so both compare the same way.
 */
export function serverIdentity(entry: Readonly<Record<string, unknown>>) {
  const { enabled: _enabled, timeout: _timeout, ...rest } = entry
  return rest
}

export function prompts(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.prompts) return Promise.resolve([])
  return paginate(
    (cursor) => client.listPrompts(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.prompts,
  )
}

export function resources(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResources(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resources,
  )
}

export function resourceTemplates(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resourceTemplates,
  )
}

function listTools(client: Client, timeout: number) {
  return Effect.tryPromise({
    try: () =>
      paginate(
        async (cursor) => {
          const params = cursor === undefined ? undefined : { cursor }
          try {
            return await client.listTools(params, { timeout })
          } catch (error) {
            if (!(error instanceof Error) || !isOutputSchemaValidationError(error)) throw error
            return client.request({ method: "tools/list", params }, TolerantListToolsResultSchema, { timeout })
          }
        },
        (result) => result.tools,
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

export * as McpCatalog from "./catalog"
