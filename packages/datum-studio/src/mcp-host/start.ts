/**
 * `startStudioHostServer` (row 31): the Studio MCP server that the datum-studio-host utility process serves
 * (studio spec §3.1, §3.2, §9.1, §9.4; U13). Contract: desktop src/main/datum-studio-host/protocol.ts
 * `StudioHostModule` (row 111). The runner has already called `openHostStore` (which installs the store with
 * setStudioStore) and `configureTemplateSource`; this function only checks that, then serves.
 *
 * Environment read (never required beyond what row 111 sets): STUDIO_WORKSPACE_ROOT (= store root; used for
 * the file-root rule and the API log), HOME, process.resourcesPath. NOT read: STUDIO_MCP_FILE_ROOTS and
 * INTERNAL_API_SECRET (per-session root from the bridge header; per-process secret generated here).
 * The token arrives only as an argument and is never logged.
 */
import { randomBytes } from "node:crypto"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { loadConfig, parseToolsets, type StudioMcpConfig, type Toolset } from "../../vendor/scripts/studio/mcp/config"
import { REPO_ROOT } from "../../vendor/scripts/studio/_repo-alias"
import { getStudioEnv } from "../../vendor/src/lib/studio/contract/env"
import { appendJsonlDaily } from "../../vendor/src/lib/studio/http/jsonl"
import { createTemplateGuard } from "../../vendor/src/lib/studio/services/templates/guard"
import { setTemplatesLogSink, type TemplatesLogEntry } from "../../vendor/src/lib/studio/services/templates/log"
import { configureTemplateGuard, installedTemplateGuard } from "../../vendor/src/lib/studio/services/templates/service"
import { getStudioStore } from "../store/index.ts"
import { createStoreFileLogger } from "../store-bridge/log.ts"
import { FileRootError, resolveSessionRoot } from "./file-root.ts"
import { SessionRefused, startEndpoint } from "./http-server.ts"
import { createLocalStudioApi } from "./local-api/router.ts"
import { LOCAL_ROUTES } from "./local-api/routes.ts"
import { createHostMcpServer } from "./mcp-server.ts"
import { missionHostExtension } from "./mission/index.ts"
import { templateHostExtension } from "./templates/index.ts"
import { assertExtensions, callerSessionOf, type HostToolExtension } from "./tool-table.ts"

/** I-2 (C72): the template service and guard log, next to the store's own log (<store>/logs/datum-studio-store.jsonl). */
export const TEMPLATES_LOG_FILE = "datum-studio-templates.jsonl"

/** Base URL of the in-process API. Port 1 (tcpmux): even a stray real fetch would find nothing. */
export const LOCAL_API_BASE_URL = "http://127.0.0.1:1"
const TOKEN_RE = /^[0-9a-fA-F]{64}$/

export type HostLogLevel = "info" | "warn" | "error"

/** = protocol.ts HostServerStartOptions, plus optional seams (extensions, toolsets, path facts for tests). */
export interface StudioHostServerOptions {
  store: { close(): Promise<void> } & object
  token: string
  hostname: "127.0.0.1"
  port: number
  log: (level: HostLogLevel, source: string, message: string, context?: Record<string, unknown>) => void
  /** Rows 68 and 119-121: extra tools (templates, missions). */
  extensions?: readonly HostToolExtension[]
  /** Narrow the toolsets (default all, spec §5.1). */
  toolsets?: readonly Toolset[]
  /** Overrides for the file-root rule (tests; production reads HOME and process.resourcesPath). */
  facts?: { home?: string | null; resourcesPath?: string | null; execPath?: string | null }
}

export interface StudioHostServer {
  url: string
  close(): Promise<void>
  /** Diagnostics for tests. */
  port: number
  sessionCount(): number
}

export class HostConfigError extends Error {
  readonly code = "CONFIG_INVALID"
}

export async function startStudioHostServer(opts: StudioHostServerOptions): Promise<StudioHostServer> {
  if (opts.hostname !== "127.0.0.1") throw new HostConfigError("hostname must be 127.0.0.1")
  if (typeof opts.token !== "string" || !TOKEN_RE.test(opts.token)) throw new HostConfigError("token must be 32 random bytes as hex")
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new HostConfigError("port must be 0..65535")
  if (getStudioStore() !== (opts.store as unknown)) throw new HostConfigError("the store passed is not the installed store (call openHostStore first)")
  const storeRoot = process.env.STUDIO_WORKSPACE_ROOT?.trim() ?? ""
  if (!path.isAbsolute(storeRoot)) throw new HostConfigError("STUDIO_WORKSPACE_ROOT must be the absolute store root")
  const openedRoot = assertSameStoreRoot(opts.store)
  const toolsets = opts.toolsets ? parseToolsets(opts.toolsets.join(",")) : parseToolsets(undefined)
  const proc = process as NodeJS.Process & { resourcesPath?: string }
  const facts = {
    home: opts.facts?.home !== undefined ? opts.facts.home : process.env.HOME?.trim() || homedir(),
    resourcesPath: opts.facts?.resourcesPath !== undefined ? opts.facts.resourcesPath : (proc.resourcesPath ?? null),
    execPath: opts.facts?.execPath !== undefined ? opts.facts.execPath : process.execPath,
    storeRoot,
  }
  // Per-process secret of the in-process API (spec §3.2): random, never logged or exported.
  const secret = randomBytes(32).toString("hex")

  // Durable log: the runner's channel (main) plus a daily JSONL under <store>/logs/mcp-host.
  const write = (level: HostLogLevel, source: string, message: string, context?: Record<string, unknown>) => {
    try {
      opts.log(level, source, message, context)
    } catch {
      // a failing log sink must not break a request
    }
    const entry: { timestamp: string } & Record<string, unknown> = { timestamp: new Date().toISOString(), level, source, message, ...(context ? { context } : {}) }
    void appendJsonlDaily("mcp-host", "datum-studio-host", entry).catch(() => undefined)
  }
  const lineLog = (line: string) => {
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line) as Record<string, unknown>
    } catch {
      rec = { message: line }
    }
    const level = rec.level === "error" || rec.level === "warn" ? rec.level : "info"
    write(level, String(rec.source ?? "datum-studio-host.mcp"), String(rec.event ?? rec.message ?? "event"), rec)
  }

  // I-2 (rows 68, 119b; C76, C77): the template tools (5) and the mission tools (11 + 4 report wrappers) are
  // registered by default. A default group is left out when the caller already passes a tool of that group
  // (by name; the caller's own instance wins, e.g. a test exporter), so no name is registered twice.
  const given = opts.extensions ?? []
  const taken = new Set(given.filter((e) => e.wraps !== true).map((e) => e.name))
  const unlessGiven = (group: HostToolExtension[]) => (group.some((e) => e.wraps !== true && taken.has(e.name)) ? [] : group)
  // Order: the template tools, then the caller's, then the mission tools (row 68 unshift, row 119b append).
  const extensions = [...unlessGiven(templateHostExtension({ log: write })), ...given, ...unlessGiven(missionHostExtension(opts.store, { log: write }))]
  assertExtensions(extensions)

  // Row 67: install the Rev A template guard before serving, so the row 66 service can save user templates
  // (without it every save is refused GUARD_NOT_CONFIGURED). Removed on close only if it is still this server's.
  const templateGuard = createTemplateGuard()
  configureTemplateGuard(templateGuard)
  // I-2 (C72): the template service and guard log lines (TEMPLATE_*, GUARD_*) go to <store>/logs/ with the
  // store log's JSONL fields and size rotation; the default sink is restored on close.
  setTemplatesLogSink(templatesFileSink(path.join(openedRoot, "logs", TEMPLATES_LOG_FILE)))

  const endpoint = await startEndpoint({
    port: opts.port,
    token: opts.token,
    log: (rec) => write((rec.level as HostLogLevel) ?? "info", "datum-studio-host.http", String(rec.event ?? "event"), rec),
    openSession: ({ sessionId, agentId, callerCwd, callerSession }) => {
      let root: string
      try {
        root = resolveSessionRoot(callerCwd, facts)
      } catch (e) {
        if (e instanceof FileRootError) throw new SessionRefused(403, `FILE_ROOT_FORBIDDEN: ${e.message}`)
        throw e
      }
      let config: StudioMcpConfig
      config = loadConfig(
        {
          STUDIO_BASE_URL: LOCAL_API_BASE_URL,
          INTERNAL_API_SECRET: secret,
          STUDIO_AGENT_ID: agentId,
          STUDIO_MCP_LOCK_AGENT_ID: "1",
          STUDIO_MCP_FILE_ROOTS: root,
          STUDIO_MCP_TOOLSETS: toolsets.join(","),
        },
        root,
      )
      const api = createLocalStudioApi({ baseUrl: config.baseUrl, secret, agentId, routes: LOCAL_ROUTES })
      const server = createHostMcpServer({ config, fetchImpl: api.fetch, session: { sessionId, agentId, fileRoot: root, ...(callerSessionOf(callerSession) ? { callerSession: callerSessionOf(callerSession) } : {}) }, extensions, repoRoot: REPO_ROOT, log: lineLog })
      let closed = false
      return {
        server,
        close: async () => {
          if (closed) return
          closed = true
          await server.close()
        },
      }
    },
  }).catch((e: unknown) => {
    if (installedTemplateGuard() === templateGuard) configureTemplateGuard(null)
    setTemplatesLogSink(null)
    throw e
  })
  write("info", "datum-studio-host", "Studio MCP server listening", { url: endpoint.url, toolsets, extensions: extensions.map((e) => e.name), templateGuard: "installed" })
  const close = async () => {
    if (installedTemplateGuard() === templateGuard) configureTemplateGuard(null)
    setTemplatesLogSink(null)
    await endpoint.close()
  }
  return { url: endpoint.url, port: endpoint.port, sessionCount: endpoint.sessionCount, close }
}

/**
 * I-2 (C66): the store must be the one at the root the vendored services use. contract/env.ts caches
 * STUDIO_WORKSPACE_ROOT once per process (getStudioEnv); a store opened at another root would split files
 * (services) from rows (store). Compared as realpaths. Returns the store's real root.
 */
function assertSameStoreRoot(store: object): string {
  const opened = (store as { rootDir?: unknown }).rootDir
  if (typeof opened !== "string" || !path.isAbsolute(opened)) throw new HostConfigError("the store has no open root")
  let envRoot: string
  try {
    envRoot = getStudioEnv().workspaceRoot
  } catch (e) {
    throw new HostConfigError(`STUDIO_WORKSPACE_ROOT is not a usable store root: ${e instanceof Error ? e.message : String(e)}`)
  }
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  const openedReal = real(opened)
  if (openedReal !== real(envRoot)) throw new HostConfigError("the store was opened at another root than the cached STUDIO_WORKSPACE_ROOT")
  return openedReal
}

function templatesFileSink(file: string) {
  const persist = createStoreFileLogger(file)
  return (e: TemplatesLogEntry) =>
    persist({
      timestamp: Date.parse(e.timestamp),
      level: e.level,
      source: e.source,
      message: e.message,
      ...(e.stack_trace ? { stack: e.stack_trace } : {}),
      ...(e.code || e.context ? { context: { ...(e.code ? { code: e.code } : {}), ...e.context } } : {}),
      ...(e.correlationId ? { correlationId: e.correlationId } : {}),
    })
}
