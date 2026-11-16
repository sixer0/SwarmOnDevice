// Admission pipeline of the office bridge (row 58, plan M5-01). Server-delta spec §9.1 stages 2-14 (14, the upstream
// ownership check, belongs to the upstream builder M5-02 and is not done here), §10.2 body rules, §11.1 local routes;
// register rev 5 §4, §5, §7.3-§7.6; security spec SC-01..SC-09, SC-27..SC-30, ST-14.
//
// `admit()` decides what a request is before anything else touches it: a static asset, a bridge-local route, a proxied
// route (P1-P8) with its validated input, or a rejection with the register status and code. It does no I/O of its own:
// the request arrives as plain data (method, raw target, raw header pairs, the body bytes the server already read) and
// the token check is an injected verifier (the pairing store's SHA-256 + constant-time lookup, SC-04). The first failing
// stage answers. Electron-free (TS-RC-2).
//
// Path rule (SC-27): every allowed path consists of `[A-Za-z0-9_.-]` segments only, so the bridge does not decode.
// A path with any `%`, `\`, `;`, empty segment (`//`), dot segment, or other character is not canonical and is
// rejected rather than normalised. Matching is exact and case-sensitive.
import {
  OFFICE_BODY_LIMIT_BYTES,
  OFFICE_CSRF_HEADER,
  OFFICE_CSRF_HEADER_VALUE,
  OFFICE_ERROR_BODY_TOO_LARGE,
  OFFICE_ERROR_CSRF_HEADER_MISSING,
  OFFICE_ERROR_FIELD_NOT_ALLOWED,
  OFFICE_ERROR_HOST_REJECTED,
  OFFICE_ERROR_ORIGIN_REJECTED,
  OFFICE_ERROR_ROUTE_NOT_ALLOWED,
  OFFICE_ERROR_TOKEN_INVALID,
  OFFICE_HISTORY_LIMIT,
  OFFICE_PATH_PANE_PAGE,
  OFFICE_TITLE_MAX_CHARS,
  OFFICE_TOKEN_HEADER,
} from "@swarm/office-addin/constants"
import { OFFICE_HOSTS, type OfficeHost } from "./protocol"

/** Session ids are `ses_` + 12 hex time digits + 14 base62 characters (`packages/opencode/src/id/id.ts` `create`). */
const OFFICE_SESSION_ID_PATTERN = /^ses_[0-9A-Za-z]{26}$/
/** Pairing request ids: 16 random bytes, base64url, no padding (spec §11.1). */
const OFFICE_PAIR_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/
/** P3 `limit` range upper bound (REG §7.3: 1-50). */
const OFFICE_SESSION_LIST_LIMIT_MAX = 50
/** Headers that ask an intermediary to change the method (ST-14). Their presence alone rejects the request. */
const OFFICE_METHOD_OVERRIDE_HEADERS = ["x-http-method-override", "x-http-method", "x-method-override"]

/** @internal test seam */
export type AdmitRequest = {
  method: string
  /** The request target exactly as received (Node `req.url`): origin-form path plus optional query. */
  target: string
  /** Header pairs in arrival order, duplicates kept (Node `req.rawHeaders` via `headerPairs`). */
  headers: readonly (readonly [string, string])[]
  /** Body bytes read so far; undefined or empty when the request has no body. */
  body?: Uint8Array
  /** True when the server stopped reading because the body passed the limit (stage 8, counted while streaming). */
  bodyOverflow?: boolean
}

export type AdmitConfig = {
  /** Bridge port; Host and Origin are derived from it (register §4, TS-RC-1). */
  port: number
  /** Token lookup: the paired host, or undefined for an unknown token (SC-04). */
  verifyToken: (token: string) => OfficeHost | undefined | Promise<OfficeHost | undefined>
  /** Defaults to OFFICE_BODY_LIMIT_BYTES (2 MiB). */
  bodyLimit?: number
}

type AdmitTextPart = { type: "text"; text: string }

/** Inbound headers the upstream builder may forward (SC-28); Content-Type is set by the builder itself. */
type AdmitForwardHeaders = { accept?: string; lastEventId?: string }

type Proxied = { kind: "proxy"; token: string; tokenHost: OfficeHost; forward: AdmitForwardHeaders }

export type Admission =
  | { kind: "reject"; status: number; code: string }
  | { kind: "static"; action: "redirect"; location: string }
  | { kind: "static"; action: "file"; path: string; head: boolean }
  | { kind: "local"; route: "pair-request"; host: OfficeHost }
  | { kind: "local"; route: "pair-status"; requestId: string }
  | { kind: "local"; route: "pair-verify"; host: OfficeHost; token: string }
  | { kind: "local"; route: "health" }
  | (Proxied & { route: "P1" })
  | (Proxied & { route: "P2"; title?: string; host: OfficeHost })
  | (Proxied & { route: "P3"; limit?: number })
  | (Proxied & { route: "P4"; sessionID: string })
  | (Proxied & { route: "P5"; sessionID: string; limit?: number })
  | (Proxied & { route: "P6"; sessionID: string; parts: AdmitTextPart[] })
  | (Proxied & { route: "P7"; sessionID: string })
  | (Proxied & { route: "P8" })

type AdmitReject = Extract<Admission, { kind: "reject" }>

/** Converts Node's flat `rawHeaders` (`[name, value, name, value, ...]`) into pairs. */
export function headerPairs(raw: readonly string[]) {
  return raw.flatMap((value, index) => (index % 2 === 0 ? [[value, raw[index + 1] ?? ""] as const] : []))
}

const reject = (status: number, code: string): AdmitReject => ({ kind: "reject", status, code })
const field = () => reject(400, OFFICE_ERROR_FIELD_NOT_ALLOWED)
const route = () => reject(404, OFFICE_ERROR_ROUTE_NOT_ALLOWED)

const SEGMENT = /^[A-Za-z0-9_.-]+$/
const LIMIT = /^[1-9][0-9]{0,2}$/

/** Canonical path segments, or undefined when the path is not canonical (SC-27). */
function segments(path: string) {
  if (!path.startsWith("/")) return
  const parts = path.slice(1).split("/")
  if (parts.some((part) => !SEGMENT.test(part) || part === "." || part === "..")) return
  return parts
}

/** Query pairs, or undefined when a key repeats or the query cannot be read. */
function queryPairs(query: string) {
  if (query === "") return new Map<string, string>()
  const pairs = query.split("&").map((item) => {
    const at = item.indexOf("=")
    return at === -1 ? ([item, ""] as const) : ([item.slice(0, at), item.slice(at + 1)] as const)
  })
  const keys = pairs.map((pair) => pair[0])
  if (new Set(keys).size !== keys.length) return
  if (pairs.some((pair) => !/^[A-Za-z0-9_.~-]*$/.test(pair[0]) || !/^[A-Za-z0-9_.~-]*$/.test(pair[1]))) return
  return new Map(pairs)
}

/** Validates the query against the allowed keys; `limit` is an integer in 1..max. */
function limitQuery(query: Map<string, string> | undefined, max: number | undefined) {
  if (!query) return { ok: false as const }
  if ([...query.keys()].some((key) => max === undefined || key !== "limit")) return { ok: false as const }
  const raw = query.get("limit")
  if (raw === undefined) return { ok: true as const, limit: undefined }
  if (!LIMIT.test(raw) || max === undefined || Number(raw) > max) return { ok: false as const }
  return { ok: true as const, limit: Number(raw) }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Exact key set: every own key must be allowed (`__proto__` and `constructor` count as unknown, spec §10.2). */
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))

const isHost = (value: unknown): value is OfficeHost => OFFICE_HOSTS.some((host) => host === value)

const isTextPart = (value: unknown): value is AdmitTextPart =>
  isRecord(value) &&
  onlyKeys(value, ["type", "text"]) &&
  Object.keys(value).length === 2 &&
  value.type === "text" &&
  typeof value.text === "string"

/** Parses a JSON body. `undefined` = no body; `null` = unreadable (invalid UTF-8 or JSON). */
function parseBody(body: Uint8Array | undefined): { value: unknown } | undefined | null {
  if (!body || body.length === 0) return
  const text = (() => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(body)
    } catch {
      return
    }
  })()
  if (text === undefined) return null
  try {
    return { value: JSON.parse(text) }
  } catch {
    return null
  }
}

/**
 * Runs stages 2-13 of spec §9.1 over one request. Never throws for request content; the verifier's own failure
 * propagates to the caller.
 */
export async function admit(request: AdmitRequest, config: AdmitConfig): Promise<Admission> {
  const all = (name: string) =>
    request.headers.filter((pair) => pair[0].toLowerCase() === name.toLowerCase()).map((pair) => pair[1])
  const one = (name: string) => {
    const values = all(name)
    if (values.length === 0) return { present: false as const }
    if (values.length > 1) return { present: true as const, duplicate: true as const }
    return { present: true as const, duplicate: false as const, value: values[0] }
  }

  // Stage 2: Host, checked first (SC-09). One value, exactly localhost:<port> or 127.0.0.1:<port>.
  const host = one("host")
  if (!host.present || host.duplicate) return reject(421, OFFICE_ERROR_HOST_REJECTED)
  if (host.value !== `localhost:${config.port}` && host.value !== `127.0.0.1:${config.port}`)
    return reject(421, OFFICE_ERROR_HOST_REJECTED)

  // Ambiguous framing (SC-30), before anything reads the body: TE with CL, repeated CL, non-numeric CL, TE not chunked.
  const length = all("content-length")
  const encoding = all("transfer-encoding")
  if (length.length > 1 || encoding.length > 1) return field()
  if (length.length === 1 && encoding.length === 1) return field()
  if (length.length === 1 && !/^[0-9]+$/.test(length[0].trim())) return field()
  if (encoding.length === 1 && encoding[0].trim().toLowerCase() !== "chunked") return field()

  // Stage 3: OPTIONS on every path (SC-03).
  const method = request.method.toUpperCase()
  if (method === "OPTIONS") return reject(403, OFFICE_ERROR_ORIGIN_REJECTED)

  // Stage 4: Origin absent or exactly the pane origin; never reflected (SC-06).
  const origin = one("origin")
  if (origin.present && (origin.duplicate || origin.value !== `https://localhost:${config.port}`))
    return reject(403, OFFICE_ERROR_ORIGIN_REJECTED)

  if (request.target.includes("#")) return route()
  const queryAt = request.target.indexOf("?")
  const path = queryAt === -1 ? request.target : request.target.slice(0, queryAt)
  const query = queryAt === -1 ? "" : request.target.slice(queryAt + 1)

  // Stage 5: static branch. GET/HEAD on `/` (redirect) or `/pane/*`; the query is ignored (Office appends
  // `_host_Info`). The static module still does the realpath prefix check (spec §9.4).
  if (path === "/" || path === "/pane" || path.startsWith("/pane/")) {
    if (method !== "GET" && method !== "HEAD") return route()
    if (path === "/") return { kind: "static", action: "redirect", location: OFFICE_PATH_PANE_PAGE }
    const parts = segments(path)
    if (!parts || parts.length < 2) return route()
    return { kind: "static", action: "file", path: parts.slice(1).join("/"), head: method === "HEAD" }
  }

  const api = ["/swarm", "/pair", "/bridge"].some((prefix) => path === prefix || path.startsWith(prefix + "/"))
  if (!api) return route()

  // Stage 6: anti-CSRF header before any side effect (SC-01).
  const csrf = one(OFFICE_CSRF_HEADER)
  if (!csrf.present || csrf.duplicate || csrf.value !== OFFICE_CSRF_HEADER_VALUE)
    return reject(403, OFFICE_ERROR_CSRF_HEADER_MISSING)

  // Stage 7: a request with a body needs Content-Type: application/json exactly (SC-02).
  const declared = length.length === 1 ? Number(length[0].trim()) : 0
  const hasBody = declared > 0 || encoding.length === 1 || (request.body?.length ?? 0) > 0 || request.bodyOverflow === true
  const contentType = one("content-type")
  if (hasBody && (!contentType.present || contentType.duplicate || contentType.value.trim().toLowerCase() !== "application/json"))
    return field()

  // Stage 8: body size (413 when the declared length or the bytes read pass the limit).
  const limit = config.bodyLimit ?? OFFICE_BODY_LIMIT_BYTES
  if (declared > limit || request.bodyOverflow === true || (request.body?.length ?? 0) > limit)
    return reject(413, OFFICE_ERROR_BODY_TOO_LARGE)

  const parsed = parseBody(request.body)
  if (parsed === null) return field()

  // Token check shared by /pair/verify and /swarm/* (SC-04).
  const token = async () => {
    const value = one(OFFICE_TOKEN_HEADER)
    if (!value.present || value.duplicate || value.value === "") return
    const paired = await config.verifyToken(value.value)
    if (!paired) return
    return { token: value.value, host: paired }
  }

  // Stage 9: bridge-local routes (spec §11.1, SC-13).
  if (!path.startsWith("/swarm/") && path !== "/swarm") {
    const local = queryPairs(query)
    if (path === "/pair/request" && method === "POST") {
      if (!local || local.size > 0) return field()
      if (!parsed || !isRecord(parsed.value) || !onlyKeys(parsed.value, ["host"]) || !isHost(parsed.value.host))
        return field()
      return { kind: "local", route: "pair-request", host: parsed.value.host }
    }
    if (path === "/pair/status" && method === "GET") {
      if (parsed) return field()
      if (!local || local.size !== 1) return field()
      const requestId = local.get("requestId")
      if (requestId === undefined || !OFFICE_PAIR_REQUEST_ID_PATTERN.test(requestId)) return field()
      return { kind: "local", route: "pair-status", requestId }
    }
    if (path === "/pair/verify" && method === "GET") {
      const verified = await token()
      if (!verified) return reject(401, OFFICE_ERROR_TOKEN_INVALID)
      if (parsed || !local || local.size > 0) return field()
      return { kind: "local", route: "pair-verify", host: verified.host, token: verified.token }
    }
    if (path === "/bridge/health" && method === "GET") {
      if (parsed || !local || local.size > 0) return field()
      return { kind: "local", route: "health" }
    }
    return route()
  }

  // Stage 10: token on /swarm/* (SC-04).
  const verified = await token()
  if (!verified) return reject(401, OFFICE_ERROR_TOKEN_INVALID)

  // Stage 11: route allow-list on the canonical path (REG §7.3, SC-27). Method-override headers are refused (ST-14).
  if (OFFICE_METHOD_OVERRIDE_HEADERS.some((name) => all(name).length > 0)) return route()
  const parts = segments(path)
  if (!parts) return route()
  const shape = parts.slice(1).join("/")
  const sessionID = parts[1] === "session" && parts.length >= 3 ? parts[2] : undefined
  if (sessionID !== undefined && !OFFICE_SESSION_ID_PATTERN.test(sessionID)) return route()
  const pattern = sessionID === undefined ? shape : ["session", ":id", ...parts.slice(3)].join("/")
  const matched = (() => {
    if (method === "GET" && pattern === "global/health") return "P1" as const
    if (method === "POST" && pattern === "session") return "P2" as const
    if (method === "GET" && pattern === "session") return "P3" as const
    if (method === "GET" && pattern === "session/:id") return "P4" as const
    if (method === "GET" && pattern === "session/:id/message") return "P5" as const
    if (method === "POST" && pattern === "session/:id/prompt_async") return "P6" as const
    if (method === "POST" && pattern === "session/:id/abort") return "P7" as const
    if (method === "GET" && pattern === "event") return "P8" as const
    return
  })()
  if (!matched) return route()

  // Headers the pane never sends and the sidecar must never see (SC-28): refused, not dropped (C5 reject rule).
  if (request.headers.some((pair) => /^x-opencode-/i.test(pair[0]) || /^x-swarm-desktop-nonce$/i.test(pair[0])))
    return field()
  const accept = one("accept")
  const lastEventId = one("last-event-id")
  if ((accept.present && accept.duplicate) || (lastEventId.present && lastEventId.duplicate)) return field()
  const base = {
    kind: "proxy" as const,
    token: verified.token,
    tokenHost: verified.host,
    forward: {
      ...(accept.present && !accept.duplicate ? { accept: accept.value } : {}),
      ...(lastEventId.present && !lastEventId.duplicate ? { lastEventId: lastEventId.value } : {}),
    },
  }

  // Stage 12: query allow-list (SC-29). Only P3 and P5 take `limit`; any other key, including `directory`,
  // `workspace` and `auth_token`, is rejected.
  const pairs = queryPairs(query)
  const limitMax = matched === "P3" ? OFFICE_SESSION_LIST_LIMIT_MAX : matched === "P5" ? OFFICE_HISTORY_LIMIT : undefined
  const queried = limitQuery(pairs, limitMax)
  if (!queried.ok) return field()

  // Stage 13: body validation (spec §10.2), exact key sets.
  if (matched === "P2") {
    if (!parsed || !isRecord(parsed.value) || !onlyKeys(parsed.value, ["title", "host"])) return field()
    const title = parsed.value.title
    if (title !== undefined && (typeof title !== "string" || title.length > OFFICE_TITLE_MAX_CHARS)) return field()
    if (!isHost(parsed.value.host)) return field()
    return { ...base, route: "P2", host: parsed.value.host, ...(title === undefined ? {} : { title }) }
  }
  if (matched === "P6") {
    if (!parsed || !isRecord(parsed.value) || !onlyKeys(parsed.value, ["parts"])) return field()
    const list = parsed.value.parts
    if (!Array.isArray(list) || list.length < 1 || list.length > 2 || !list.every(isTextPart)) return field()
    return {
      ...base,
      route: "P6",
      sessionID: sessionID ?? "",
      parts: list.map((part: AdmitTextPart) => ({ type: "text" as const, text: part.text })),
    }
  }
  if (matched === "P7") {
    if (parsed && (!isRecord(parsed.value) || Object.keys(parsed.value).length > 0)) return field()
    return { ...base, route: "P7", sessionID: sessionID ?? "" }
  }
  // GET routes: no body.
  if (parsed) return field()
  if (matched === "P1") return { ...base, route: "P1" }
  if (matched === "P3") return { ...base, route: "P3", ...(queried.limit === undefined ? {} : { limit: queried.limit }) }
  if (matched === "P4") return { ...base, route: "P4", sessionID: sessionID ?? "" }
  if (matched === "P5")
    return { ...base, route: "P5", sessionID: sessionID ?? "", ...(queried.limit === undefined ? {} : { limit: queried.limit }) }
  return { ...base, route: "P8" }
}
