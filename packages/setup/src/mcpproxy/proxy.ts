// The Swarm thin MCP proxy — `swarm-web` (row 94 dispatch = blueprint rows 94+95 merged;
// contract = masterplan/01f_tool_wiring_spec.md §6). A stdio JSON-RPC server exposing EXACTLY
// three tools (search / fetch / vault_inbox, §6.2), no resources and no prompts (§6.2 non-goals:
// MCP resources are gated under the `read` permission name which the baseline cannot deny while
// file reads stay allowed — so the control is server-side: expose none). The URL policy runs
// BEFORE any request; every response body is sanitised, enveloped and audited; every call —
// including refusals — writes exactly one audit line (§6.6).
//
// WHY HAND-ROLLED JSON-RPC AND NOT @modelcontextprotocol/sdk: the SDK is not resolvable from
// packages/setup in this checkout (it lives under packages/opencode's node_modules), and 01f
// §6.1 forbids adding a dependency to package.json (WP-02's file). The stdio MCP wire format is
// newline-delimited JSON-RPC 2.0; this module implements exactly the four methods a tools-only
// server needs (initialize, tools/list, tools/call, ping) plus the initialized notification.
// Row 106 may swap the SDK in at build finalisation without touching the tool handlers.
//
// NO NETWORK AT IMPORT TIME (§6.2): nothing here opens a socket until a tool call arrives, so
// the audit log has no unlogged traffic. All effect enters through the injected Transport.
//
// SEAM DISCIPLINE (r82-r93 convention): `deps.transport` is the TEST SEAM — units drive allowed/
// denied/error paths with a recording fake and assert zero connection attempts on refusals
// (T-W7-5). The real transport is wired only in main.ts.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, openSync, readFileSync, writeSync, closeSync, readdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { MODES } from "../constants.ts"
import { expandTilde } from "../paths.ts"
import { sanitise, wrapUntrusted, decodeUtf8Strict } from "./sanitise.ts"
import { checkUrl } from "./urlpolicy.ts"
import { appendAudit, type AuditOptions, type AuditRecord } from "./audit.ts"
import { ENV_NAMES, MCP_SERVER_NAME, VAULT_INBOX } from "./register.ts"

// --- transport seam -------------------------------------------------------------------

export interface TransportRequest {
  readonly method?: string
  readonly headers?: Record<string, string>
  /** Request body for POST legs (crawl). Never carries anything secret except the bearer
   *  header, which lives in `headers` and is excluded from every log by construction. */
  readonly body?: string
}

export interface TransportResponse {
  /** HTTP status, or 0 when the transport could not connect at all. */
  readonly status: number
  /** Response body bytes; null when none arrived. */
  readonly bytes: Uint8Array | null
  /** Location header on a 3xx (redirect hop), else absent. */
  readonly location?: string
  /** Transport-level failure text (DNS/refused/timeout/too-large), never a secret. */
  readonly error?: string
}

export interface Transport {
  /** Perform ONE request with redirects NOT followed (the caller re-checks every hop). */
  request(url: string, req: TransportRequest): Promise<TransportResponse>
}

// --- dependencies ---------------------------------------------------------------------

export interface ProxyDeps {
  readonly transport: Transport
  /** Estate SearXNG base URL (no trailing slash) or null when unresolvable. Implementations
   *  READ it from env/artefacts — this module never sees a port literal. */
  searxngBase(): string | null
  firecrawlBase(): string | null
  firecrawlToken(): string | null
  /** Absolute canonical inbox dir (PC-PATH-12). Created 0700 on demand by vault handlers. */
  inboxDir(): string
  /** Audit destination options forwarded to appendAudit (path override for tests). */
  readonly audit: AuditOptions
  now(): Date
  nonce(): string
}

const MAX_QUERY_BYTES = 512 // §6.2 search argument bound
const MAX_WRITE_BYTES = 64 * 1024 // vault note bound (design choice; notes are small by contract)
const MAX_REDIRECT_HOPS = 3 // §6.4 rule 6

interface ToolOutcome {
  readonly text: string
  readonly isError: boolean
}

// --- tool definitions (T-W7-3 asserts exactly this set) ---------------------------------

export function toolDefinitions(): readonly {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}[] {
  return [
    {
      name: "search",
      description:
        "Search the public web via the estate SearXNG instance. Returns a sanitised, untrusted-envelope result list. Query <=512 bytes.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: MAX_QUERY_BYTES },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
        },
        required: ["query"],
      },
    },
    {
      name: "fetch",
      description:
        "Fetch one public URL through the proxy's URL policy + sanitiser. mode=page direct, mode=crawl via the estate Firecrawl. Denied targets refuse without any network call.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          mode: { type: "string", enum: ["page", "crawl"], default: "page" },
        },
        required: ["url"],
      },
    },
    {
      name: "vault_inbox",
      description:
        "Write/list/read notes in the Swarm vault INBOX only (create-only writes; reads come back marked untrusted). No other vault path is reachable.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["write", "list", "read"] },
          name: { type: "string" },
          content: { type: "string" },
        },
        required: ["action"],
      },
    },
  ]
}

// --- JSON-RPC dispatch ------------------------------------------------------------------

export interface RpcRequest {
  readonly jsonrpc?: string
  readonly id?: number | string | null
  readonly method?: string
  readonly params?: Record<string, unknown>
}

export interface RpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: number | string | null
  readonly result?: unknown
  readonly error?: { code: number; message: string }
}

/** Handle one parsed request. Returns null for notifications (no response allowed). */
export async function handleRpc(req: RpcRequest, deps: ProxyDeps): Promise<RpcResponse | null> {
  const id = req.id ?? null
  if (req.method === undefined) return { jsonrpc: "2.0", id, error: { code: -32600, message: "missing method" } }
  if (req.method === "notifications/initialized" || req.method === "initialized") return null
  if (req.method === "ping") return { jsonrpc: "2.0", id, result: {} }
  if (req.method === "initialize") {
    const requested =
      typeof req.params?.protocolVersion === "string" ? (req.params.protocolVersion as string) : "2024-11-05"
    // Echo the client's version (tools-only server behaviour is stable across the shipped
    // revisions); capabilities deliberately carry ONLY tools — no resources, no prompts (§6.2).
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
      },
    }
  }
  if (req.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: toolDefinitions() } }
  }
  if (req.method === "tools/call") {
    const toolName = String(req.params?.name ?? "")
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>
    const meta = (req.params?._meta ?? {}) as Record<string, unknown>
    const agent = typeof meta.agent === "string" ? meta.agent : null
    const session = typeof meta.session === "string" ? meta.session : null
    const outcome = await callTool(toolName, args, deps, agent, session)
    if (outcome === null) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool "${toolName}"` } }
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: outcome.text }], isError: outcome.isError } }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } }
}

/** Tool entry with the one-line-per-call audit guarantee wrapped around every path (§6.6).
 *  Returns null for an unknown tool (JSON-RPC error, NO audit line: no call happened). */
async function callTool(
  tool: string,
  args: Record<string, unknown>,
  deps: ProxyDeps,
  agent: string | null,
  session: string | null,
): Promise<ToolOutcome | null> {
  if (tool === "search") return runSearch(String(args.query ?? ""), args.limit, deps, agent, session)
  if (tool === "fetch")
    return runFetch(String(args.url ?? ""), args.mode === "crawl" ? "crawl" : "page", deps, agent, session)
  if (tool === "vault_inbox") return runVault(String(args.action ?? ""), args.name, args.content, deps, agent, session)
  return null
}

// --- search -----------------------------------------------------------------------------

async function runSearch(
  query: string,
  limitRaw: unknown,
  deps: ProxyDeps,
  agent: string | null,
  session: string | null,
): Promise<ToolOutcome> {
  const started = deps.now().getTime()
  const ts = () => deps.now().toISOString()
  const limit = clampLimit(limitRaw)
  if (query.trim() === "" || byteLen(query) > MAX_QUERY_BYTES) {
    audit(deps, {
      ts: ts(),
      component: "swarm-web",
      tool: "search",
      action: "query",
      decision: "error",
      reason: "invalid_query",
      query,
      url: null,
      host: null,
      latency_ms: deps.now().getTime() - started,
      nonce: null,
      agent,
      session,
    })
    return {
      text: `BLOCKED_BY_POLICY: query must be a non-empty string of at most ${MAX_QUERY_BYTES} bytes.`,
      isError: true,
    }
  }
  const base = deps.searxngBase()
  if (base === null) {
    audit(deps, {
      ts: ts(),
      component: "swarm-web",
      tool: "search",
      action: "query",
      decision: "error",
      reason: "BLOCKED_BY_NETWORK: SearXNG base URL unavailable",
      query,
      url: null,
      host: null,
      latency_ms: deps.now().getTime() - started,
      nonce: null,
      agent,
      session,
    })
    return {
      text: "BLOCKED_BY_NETWORK: web search unavailable — the estate SearXNG base URL is not configured or not healthy (host: unset). Run swarm-setup install first.",
      isError: true,
    }
  }
  const target = `${base}/search?q=${encodeURIComponent(query)}&format=json`
  const allow = allowListForBase(base)
  const decision = checkUrl(target, { allowList: allow })
  if (!decision.ok) {
    audit(deps, {
      ts: ts(),
      component: "swarm-web",
      tool: "search",
      action: "query",
      decision: "denied",
      reason: decision.reason,
      query,
      url: target,
      host: hostOf(target),
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return { text: `BLOCKED_BY_POLICY: ${decision.reason} for ${target}`, isError: true }
  }
  const res = await getChecked(target, { allowList: allow }, deps, { headers: { Accept: "application/json" } })
  if (res.kind !== "ok") {
    audit(deps, {
      ts: ts(),
      component: "swarm-web",
      tool: "search",
      action: "query",
      decision: res.kind === "denied" ? "denied" : "error",
      reason: res.reason,
      query,
      url: res.finalUrl ?? target,
      host: hostOf(res.finalUrl ?? target),
      status: res.status,
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return { text: `BLOCKED_BY_NETWORK: SearXNG unreachable (${res.reason}; host ${decision.host})`, isError: true }
  }
  const decoded = decodeUtf8Strict(res.bytes)
  if (!decoded.ok) {
    audit(deps, {
      ts: ts(),
      component: "swarm-web",
      tool: "search",
      action: "query",
      decision: "error",
      reason: "undecodable",
      query,
      url: target,
      host: decision.host,
      status: res.status,
      bytes_in: res.bytes.length,
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return { text: "BLOCKED_BY_POLICY: undecodable response from SearXNG (fail-closed, §6.3).", isError: true }
  }
  const bodyText = formatResults(decoded.text, limit)
  const nonce = deps.nonce()
  const safe = sanitise({ text: bodyText })
  const envelope = wrapUntrusted({
    body: safe.safe,
    source: "searxng query",
    fetchedAt: ts(),
    nonce,
    sanitised: safe.removed,
    originalBytes: safe.originalBytes,
    safeBytes: safe.safeBytes,
    truncated: safe.truncated,
  })
  audit(deps, {
    ts: ts(),
    component: "swarm-web",
    tool: "search",
    action: "query",
    decision: "allowed",
    reason: null,
    query,
    url: null,
    host: decision.host,
    status: res.status,
    bytes_in: res.bytes.length,
    bytes_out: safe.safeBytes,
    sha256: sha256Hex(safe.safe),
    truncated: safe.truncated,
    latency_ms: deps.now().getTime() - started,
    nonce,
    agent,
    session,
  })
  return { text: envelope, isError: false }
}

function clampLimit(limitRaw: unknown): number {
  const n = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 8
  return Math.min(20, Math.max(1, n))
}

/** SearXNG JSON shape tolerance: read .results[] of {title,url,content|snippet}; anything
 *  unparsable becomes an honest empty-list text (the raw error never reaches the model). */
function formatResults(json: string, limit: number): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return "(SearXNG returned a response that is not JSON — no results extracted)"
  }
  const results = parsed && typeof parsed === "object" ? (parsed as { results?: unknown }).results : undefined
  if (!Array.isArray(results)) return "(no results)"
  const lines: string[] = []
  for (const item of results.slice(0, limit)) {
    if (!item || typeof item !== "object") continue
    const r = item as { title?: unknown; url?: unknown; content?: unknown; snippet?: unknown }
    const title = typeof r.title === "string" ? r.title : "(untitled)"
    const url = typeof r.url === "string" ? r.url : "(no url)"
    const snippet = typeof r.content === "string" ? r.content : typeof r.snippet === "string" ? r.snippet : ""
    lines.push(`${lines.length + 1}. ${title}\n   ${url}${snippet ? `\n   ${snippet}` : ""}`)
  }
  return lines.length > 0 ? lines.join("\n") : "(no results)"
}

// --- fetch / crawl ------------------------------------------------------------------------

async function runFetch(
  url: string,
  mode: "page" | "crawl",
  deps: ProxyDeps,
  agent: string | null,
  session: string | null,
): Promise<ToolOutcome> {
  const started = deps.now().getTime()
  const ts = () => deps.now().toISOString()
  const decision = checkUrl(url) // NO allow-list: public targets can never reach estate services
  if (!decision.ok) {
    audit(deps, {
      ts: ts(),
      component: "swarm-web",
      tool: "fetch",
      action: mode,
      decision: "denied",
      reason: decision.reason,
      query: null,
      url,
      host: hostOf(url),
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return { text: `BLOCKED_BY_POLICY: ${decision.reason} — refused without any network request.`, isError: true }
  }
  if (mode === "crawl") return runCrawl(url, decision.host, deps, started, agent, session)
  const res = await getChecked(url, {}, deps, {})
  if (res.kind !== "ok") {
    audit(deps, {
      ts: ts(),
      component: "swarm-web",
      tool: "fetch",
      action: "page",
      decision: res.kind === "denied" ? "denied" : "error",
      reason: res.reason,
      query: null,
      url: res.finalUrl ?? url,
      host: hostOf(res.finalUrl ?? url),
      status: res.status,
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return {
      text:
        res.kind === "denied"
          ? `BLOCKED_BY_POLICY: ${res.reason} — redirect hop refused.`
          : `BLOCKED_BY_NETWORK: ${res.reason}`,
      isError: true,
    }
  }
  return finishBody(res.bytes, res.status, url, "page", deps, started, agent, session)
}

async function runCrawl(
  url: string,
  host: string,
  deps: ProxyDeps,
  started: number,
  agent: string | null,
  session: string | null,
): Promise<ToolOutcome> {
  const ts = deps.now().toISOString()
  const base = deps.firecrawlBase()
  const token = deps.firecrawlToken()
  if (base === null || token === null) {
    audit(deps, {
      ts,
      component: "swarm-web",
      tool: "fetch",
      action: "crawl",
      decision: "error",
      reason: "BLOCKED_BY_NETWORK: Firecrawl base/token unavailable",
      query: null,
      url,
      host,
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return {
      text: "BLOCKED_BY_NETWORK: crawl unavailable — the estate Firecrawl service is not configured or not healthy. Use mode=page instead.",
      isError: true,
    }
  }
  // The crawl TARGET was already policy-checked by the caller (public rules, no allow-list);
  // Firecrawl itself is reached over its estate loopback base via its own allow-list, and the
  // bearer token goes ONLY into the header map below — never argv, never audit (§6.1/P-8).
  const crawlDecision = checkUrl(base, { allowList: allowListForBase(base) })
  if (!crawlDecision.ok) {
    audit(deps, {
      ts,
      component: "swarm-web",
      tool: "fetch",
      action: "crawl",
      decision: "denied",
      reason: crawlDecision.reason,
      query: null,
      url: base,
      host: hostOf(base),
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return { text: `BLOCKED_BY_POLICY: Firecrawl base refused (${crawlDecision.reason}).`, isError: true }
  }
  const endpoint = `${base}/v1/scrape`
  const res = await postChecked(
    endpoint,
    {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
    },
    deps,
  )
  if (res.kind !== "ok") {
    audit(deps, {
      ts: deps.now().toISOString(),
      component: "swarm-web",
      tool: "fetch",
      action: "crawl",
      decision: res.kind === "denied" ? "denied" : "error",
      reason: res.reason,
      query: null,
      url,
      host,
      status: res.status,
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return { text: `BLOCKED_BY_NETWORK: Firecrawl unreachable (${res.reason}).`, isError: true }
  }
  return finishBody(res.bytes, res.status, url, "crawl", deps, started, agent, session)
}

/** Sanitise + envelope + audit for a fetched/crawled body (shared tail of both fetch modes). */
async function finishBody(
  bytes: Uint8Array,
  status: number,
  url: string,
  action: "page" | "crawl",
  deps: ProxyDeps,
  started: number,
  agent: string | null,
  session: string | null,
): Promise<ToolOutcome> {
  const ts = deps.now().toISOString()
  const decoded = decodeUtf8Strict(bytes)
  if (!decoded.ok) {
    audit(deps, {
      ts,
      component: "swarm-web",
      tool: "fetch",
      action,
      decision: "error",
      reason: "undecodable",
      query: null,
      url,
      host: hostOf(url),
      status,
      bytes_in: bytes.length,
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return { text: "BLOCKED_BY_POLICY: undecodable response (fail-closed, §6.3).", isError: true }
  }
  const nonce = deps.nonce()
  const safe = sanitise({ text: decoded.text })
  const envelope = wrapUntrusted({
    body: safe.safe,
    source: url,
    fetchedAt: ts,
    nonce,
    sanitised: safe.removed,
    originalBytes: safe.originalBytes,
    safeBytes: safe.safeBytes,
    truncated: safe.truncated,
  })
  audit(deps, {
    ts,
    component: "swarm-web",
    tool: "fetch",
    action,
    decision: "allowed",
    reason: null,
    query: null,
    url,
    host: hostOf(url),
    status,
    bytes_in: bytes.length,
    bytes_out: safe.safeBytes,
    sha256: sha256Hex(safe.safe),
    truncated: safe.truncated,
    latency_ms: deps.now().getTime() - started,
    nonce,
    agent,
    session,
  })
  return { text: envelope, isError: false }
}

// --- redirect-aware request helpers ---------------------------------------------------------

type CheckedResult =
  | { readonly kind: "ok"; readonly status: number; readonly bytes: Uint8Array; readonly finalUrl: string }
  | { readonly kind: "network"; readonly reason: string; readonly status: number; readonly finalUrl?: string }
  | { readonly kind: "denied"; readonly reason: string; readonly status: number; readonly finalUrl: string }

/** GET with §6.4 rule 6: each hop re-checked with the SAME policy options, maximum 3 hops.
 *  A hop failing the policy aborts the call (audited denied by the caller) with finalUrl set
 *  to the refused hop. */
async function getChecked(
  startUrl: string,
  policyOpts: { allowList?: readonly string[] },
  deps: ProxyDeps,
  req: TransportRequest,
): Promise<CheckedResult> {
  let current = startUrl
  let lastStatus = 0
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const decision = checkUrl(current, policyOpts)
    if (!decision.ok) return { kind: "denied", reason: decision.reason, status: lastStatus, finalUrl: current }
    const res = await deps.transport.request(current, req)
    lastStatus = res.status
    if (res.error || res.bytes === null)
      return { kind: "network", reason: res.error ?? "no response", status: res.status, finalUrl: current }
    if (res.status >= 300 && res.status < 400) {
      // §6.4 rule 6: every hop is re-checked; past the budget (or without a usable Location)
      // the chain is REFUSED, never returned as content — a 302 body must not reach the model.
      if (hop >= MAX_REDIRECT_HOPS)
        return { kind: "denied", reason: "too_many_redirects", status: res.status, finalUrl: current }
      const next = res.location ? resolveRelative(current, res.location) : null
      if (next === null)
        return { kind: "network", reason: "redirect without usable Location", status: res.status, finalUrl: current }
      current = next
      continue
    }
    if (res.status >= 400)
      return { kind: "network", reason: `HTTP ${res.status}`, status: res.status, finalUrl: current }
    return { kind: "ok", status: res.status, bytes: res.bytes, finalUrl: current }
  }
  return { kind: "denied", reason: "too_many_redirects", status: lastStatus, finalUrl: current }
}

/** POST variant for the crawl leg (estate base already allow-listed; no redirect following —
 *  §6.4 rule 6 gives crawl targets 0 redirects, and the estate API answers directly). */
async function postChecked(
  url: string,
  req: TransportRequest & { body: string },
  deps: ProxyDeps,
): Promise<CheckedResult> {
  const res = await deps.transport.request(url, { ...req, method: "POST", headers: req.headers })
  if (res.error || res.bytes === null)
    return { kind: "network", reason: res.error ?? "no response", status: res.status }
  if (res.status >= 400) return { kind: "network", reason: `HTTP ${res.status}`, status: res.status }
  return { kind: "ok", status: res.status, bytes: res.bytes, finalUrl: url }
}

// --- vault inbox (§7) -----------------------------------------------------------------------

async function runVault(
  action: string,
  nameRaw: unknown,
  contentRaw: unknown,
  deps: ProxyDeps,
  agent: string | null,
  session: string | null,
): Promise<ToolOutcome> {
  const started = deps.now().getTime()
  const ts = () => deps.now().toISOString()
  if (action !== "write" && action !== "list" && action !== "read") {
    audit(deps, {
      ts: ts(),
      component: "swarm-web",
      tool: "vault_inbox",
      action: String(action),
      decision: "error",
      reason: "invalid_action",
      query: null,
      url: null,
      host: null,
      latency_ms: deps.now().getTime() - started,
      nonce: null,
      agent,
      session,
    })
    return { text: "BLOCKED_BY_POLICY: action must be write | list | read.", isError: true }
  }
  const inbox = ensureInbox(deps.inboxDir())
  if (action === "list") {
    const names = readdirSync(inbox)
      .filter((n) => n.endsWith(".md"))
      .sort()
    const nonce = deps.nonce()
    const body = names.length > 0 ? names.join("\n") : "(empty inbox)"
    const envelope = wrapUntrusted({
      body,
      source: `file://${inbox}`,
      fetchedAt: ts(),
      nonce,
      originalBytes: byteLen(body),
      safeBytes: byteLen(body),
      truncated: false,
    })
    audit(deps, {
      ts: ts(),
      component: "swarm-web",
      tool: "vault_inbox",
      action: "list",
      decision: "allowed",
      reason: null,
      query: null,
      url: `file://${inbox}`,
      host: null,
      bytes_out: byteLen(body),
      sha256: sha256Hex(body),
      truncated: false,
      latency_ms: deps.now().getTime() - started,
      nonce,
      agent,
      session,
    })
    return { text: envelope, isError: false }
  }
  const name = typeof nameRaw === "string" ? nameRaw : ""
  const resolved = confine(inbox, name)
  if (resolved === null) {
    audit(deps, {
      ts: ts(),
      component: "swarm-web",
      tool: "vault_inbox",
      action,
      decision: "denied",
      reason: "path_confined",
      query: null,
      url: `name:${JSON.stringify(name)}`,
      host: null,
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return {
      text: "BLOCKED_BY_POLICY: name must be a safe basename inside the inbox (no traversal, absolute paths, NUL, newlines, or symlink escapes).",
      isError: true,
    }
  }
  if (action === "read") return vaultRead(resolved, deps, started, agent, session)
  return vaultWrite(
    resolved,
    name,
    typeof contentRaw === "string" ? contentRaw : "",
    inbox,
    deps,
    started,
    agent,
    session,
  )
}

function vaultRead(
  resolvedPath: string,
  deps: ProxyDeps,
  started: number,
  agent: string | null,
  session: string | null,
): ToolOutcome {
  const ts = deps.now().toISOString()
  if (!existsSync(resolvedPath)) {
    audit(deps, {
      ts,
      component: "swarm-web",
      tool: "vault_inbox",
      action: "read",
      decision: "error",
      reason: "not_found",
      query: null,
      url: `file://${resolvedPath}`,
      host: null,
      latency_ms: deps.now().getTime() - started,
      nonce: null,
      agent,
      session,
    })
    return { text: "BLOCKED_BY_POLICY: no such note in the inbox.", isError: true }
  }
  const bytes = readFileSync(resolvedPath) // env.d.ts overload returns Uint8Array
  const decoded = decodeUtf8Strict(bytes)
  if (!decoded.ok) {
    audit(deps, {
      ts,
      component: "swarm-web",
      tool: "vault_inbox",
      action: "read",
      decision: "error",
      reason: "undecodable",
      query: null,
      url: `file://${resolvedPath}`,
      host: null,
      bytes_in: bytes.length,
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return { text: "BLOCKED_BY_POLICY: stored note is not valid UTF-8 (fail-closed).", isError: true }
  }
  const nonce = deps.nonce()
  const safe = sanitise({ text: decoded.text })
  const envelope = wrapUntrusted({
    body: safe.safe,
    source: `file://${resolvedPath}`,
    fetchedAt: ts,
    nonce,
    sanitised: safe.removed,
    originalBytes: safe.originalBytes,
    safeBytes: safe.safeBytes,
    truncated: safe.truncated,
  })
  audit(deps, {
    ts,
    component: "swarm-web",
    tool: "vault_inbox",
    action: "read",
    decision: "allowed",
    reason: null,
    query: null,
    url: `file://${resolvedPath}`,
    host: null,
    bytes_in: bytes.length,
    bytes_out: safe.safeBytes,
    sha256: sha256Hex(safe.safe),
    truncated: safe.truncated,
    latency_ms: deps.now().getTime() - started,
    nonce,
    agent,
    session,
  })
  return { text: envelope, isError: false }
}

function vaultWrite(
  intendedPath: string,
  nameHint: string,
  content: string,
  inbox: string,
  deps: ProxyDeps,
  started: number,
  agent: string | null,
  session: string | null,
): ToolOutcome {
  const ts = deps.now().toISOString()
  if (byteLen(content) > MAX_WRITE_BYTES) {
    audit(deps, {
      ts,
      component: "swarm-web",
      tool: "vault_inbox",
      action: "write",
      decision: "error",
      reason: "content_too_large",
      query: null,
      url: `file://${intendedPath}`,
      host: null,
      bytes_in: byteLen(content),
      latency_ms: deps.now().getTime() - started,
      agent,
      session,
    })
    return { text: `BLOCKED_BY_POLICY: content exceeds the ${MAX_WRITE_BYTES}-byte note bound.`, isError: true }
  }
  // Create-only (§7): filename is GENERATED `<UTC ts>-<slug>.md`; collisions take a numeric
  // suffix; "wx" makes overwrite structurally impossible, and no delete/rename exists here.
  const slug = slugify(nameHint)
  let target = join(inbox, `${ts.replace(/[:]/g, "-")}-${slug}.md`)
  for (let n = 1; existsSync(target) && n <= 99; n++) target = join(inbox, `${ts.replace(/[:]/g, "-")}-${slug}-${n}.md`)
  if (existsSync(target))
    return { text: "BLOCKED_BY_CONFLICT: too many same-named notes this second; retry.", isError: true }
  // "wx" = O_CREAT|O_EXCL: the create FAILS if anything already holds the name (incl. a
  // dangling symlink, whose EEXIST lands in the refusal below rather than writing through it).
  let fd: number
  try {
    fd = openSync(target, "wx", MODES.FILE_0600)
  } catch (err) {
    audit(deps, {
      ts,
      component: "swarm-web",
      tool: "vault_inbox",
      action: "write",
      decision: "error",
      reason: `create_failed: ${(err as Error).message}`,
      query: null,
      url: `file://${target}`,
      host: null,
      latency_ms: deps.now().getTime() - started,
      nonce: null,
      agent,
      session,
    })
    return { text: `BLOCKED_BY_CONFLICT: cannot create ${target} (name held by another object).`, isError: true }
  }
  try {
    writeSync(fd, new TextEncoder().encode(content))
  } finally {
    closeSync(fd)
  }
  const body = content
  audit(deps, {
    ts,
    component: "swarm-web",
    tool: "vault_inbox",
    action: "write",
    decision: "allowed",
    reason: null,
    query: null,
    url: `file://${target}`,
    host: null,
    bytes_out: byteLen(body),
    sha256: sha256Hex(body),
    truncated: false,
    latency_ms: deps.now().getTime() - started,
    nonce: null,
    agent,
    session,
  })
  return { text: `Wrote ${target}`, isError: false }
}

/** §7 confinement, fail-closed (refuse the whole call, never clamp): reject empty, `..`,
 *  absolute paths, any path separator, NUL, CR/LF, and dotfiles; then require the realpath of
 *  an EXISTING candidate to carry the canonical inbox as a prefix — a symlink whose target
 *  escapes the vault fails that test. For a NON-existing candidate (create-only write) the
 *  canonical inbox itself is returned so the caller writes inside it; a dangling symlink at the
 *  name resolves via its PARENT (the inbox) and is later overwritten by the create-only open. */
export function confine(inbox: string, name: string): string | null {
  if (name === "" || name.includes("\0") || name.includes("\n") || name.includes("\r")) return null
  if (name.startsWith("/") || name.includes("..") || name.includes("/")) return null
  if (name.startsWith(".")) return null // dotfiles are not notes
  const inboxReal = safeRealpath(inbox)
  if (inboxReal === null) return null
  const candidate = safeRealpath(join(inbox, name))
  if (candidate !== null) {
    // Existing object (read, or a write over a real prior file): must be IN the inbox.
    if (candidate !== inboxReal && !candidate.startsWith(`${inboxReal}/`)) return null
    return candidate
  }
  // Non-existing: the create-only write lands at join(inboxReal, name), which is by construction
  // inside the canonical inbox. Return that so the caller never writes through a symlinked inbox.
  return join(inboxReal, name)
}

// --- helpers --------------------------------------------------------------------------------

function ensureInbox(dirRaw: string): string {
  const dir = expandTilde(dirRaw)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: MODES.DIR_0700 })
  return dir
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function allowListForBase(base: string): readonly string[] {
  try {
    const u = new URL(base)
    return [u.port === "" ? u.hostname : `${u.hostname}:${u.port}`]
  } catch {
    return []
  }
}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return null
  }
}

function resolveRelative(base: string, ref: string): string | null {
  try {
    // Two-arg constructor cast per bun-net.d.ts precedent (shim declares one-arg ctors).
    const Ctor = URL as unknown as new (input: string, base?: string) => URL
    return new Ctor(ref, base).href
  } catch {
    return null
  }
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return s === "" ? "note" : s
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length
}

function sha256Hex(body: string): string {
  return createHash("sha256").update(body).digest("hex")
}

function audit(deps: ProxyDeps, rec: AuditRecord): void {
  appendAudit(rec, deps.audit)
}

export { MCP_SERVER_NAME, ENV_NAMES, VAULT_INBOX }
