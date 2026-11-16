// Swarm Office Add-in constants: the one definition point for the values in
// masterplan/00_register.md (revision 5) sections 4-8, imported by the pane and the
// desktop as `@swarm/office-addin/constants`. This module must stay import-free so
// it is safe in both Node and the browser.
//
// Every value is a literal transcription of the register. Change the register
// first (section 9.5), then this file.

// Section 4: network
export const OFFICE_BRIDGE_PORT = 46317
export const OFFICE_ORIGIN = "https://localhost:46317"
export const OFFICE_BIND_ADDRESSES = ["127.0.0.1", "::1"] as const

export const OFFICE_PATH_PANE = "/pane"
export const OFFICE_PATH_PANE_PAGE = "/pane/index.html"
export const OFFICE_PATH_PROXY = "/swarm"
export const OFFICE_PATH_PAIR_REQUEST = "/pair/request"
export const OFFICE_PATH_PAIR_STATUS = "/pair/status"
export const OFFICE_PATH_PAIR_VERIFY = "/pair/verify"
export const OFFICE_PATH_BRIDGE_HEALTH = "/bridge/health"
export const OFFICE_PANE_URL = "https://localhost:46317/pane/index.html"
export const OFFICE_ICON_32_URL = "https://localhost:46317/pane/icons/icon-32.png"
export const OFFICE_ICON_64_URL = "https://localhost:46317/pane/icons/icon-64.png"
export const OFFICE_PROXY_BASE_URL = "https://localhost:46317/swarm"

// Section 5: headers and pairing
export const OFFICE_CSRF_HEADER = "X-Swarm-Office"
export const OFFICE_CSRF_HEADER_VALUE = "1"
export const OFFICE_TOKEN_HEADER = "X-Swarm-Office-Token"
export const OFFICE_TOKEN_PREFIX = "swo1_"
export const OFFICE_TOKEN_LENGTH = 48
export const OFFICE_PAIR_POLL_MS = 1000
export const OFFICE_PAIR_REQUEST_TTL_MS = 120_000
export const OFFICE_PAIR_RATE_LIMIT = 5
export const OFFICE_PAIR_RATE_WINDOW_MS = 60_000
export const OFFICE_PAIR_IDLE_DAYS = 90
export const OFFICE_PAIR_CODE_DIGITS = 4

// Section 4 limits (RC-2, RC-5)
export const OFFICE_BODY_LIMIT_BYTES = 2 * 1024 * 1024
export const OFFICE_STREAM_LIMIT = 4
export const OFFICE_RECENT_CHATS_LIMIT = 20
export const OFFICE_HISTORY_LIMIT = 50
export const OFFICE_TITLE_MAX_CHARS = 200
export const OFFICE_EXCEL_CELL_MAX_CHARS = 32_767

// Section 6: manifest filename (repo, packaged resources and wef folders; C31)
export const OFFICE_MANIFEST_FILE = "swarm-office-addin.xml"

// Section 4.1: pane CSP (rev 3 D4: frame-ancestors 'none')
export const OFFICE_PANE_CSP =
  "default-src 'self'; script-src 'self' https://officeapis.public.onecdn.static.microsoft; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// Section 6.2: Office.js source (RC-1)
export const OFFICE_JS_URL = "https://officeapis.public.onecdn.static.microsoft/1/office.js"

// Section 5: pane storage keys
export const OFFICE_TOKEN_STORAGE_KEY = "swarm.office.token"
export const OFFICE_SESSION_STORAGE_PREFIX = "swarm.office.session."
export const OFFICE_DISCLOSURE_ACK_KEY = "swarm.office.disclosureAck"
export const OFFICE_CONTEXT_SCOPE_KEY = "swarm.office.contextScope"

// Section 5 (rev 3 D7): session key = `${OFFICE_SESSION_STORAGE_PREFIX}<docKey>`, docKey is
// the lowercase hex SHA-256 of Office.context.document.url as returned (bare POSIX path).
export const OFFICE_SESSION_KEY_FORMAT = "swarm.office.session.<docKey>"

// Section 8.5: performance marks (rev 3 D9: firstText is the first rendered delta of an
// assistant `text` part)
export const OFFICE_PERF_MARK_SEND = "swarm.office.send"
export const OFFICE_PERF_MARK_REQUEST = "swarm.office.request"
export const OFFICE_PERF_MARK_FIRST_TEXT = "swarm.office.firstText"
export const OFFICE_PERF_MARK_BUSY = "swarm.office.busy"

// Section 7.1 and 7.8: session metadata
export const OFFICE_ORIGIN_METADATA_KEY = "swarm.origin"
export const OFFICE_ORIGIN_VALUE = "office-addin"
export const OFFICE_HOST_METADATA_KEY = "swarm.office.host"

// Section 7.1: host identifiers (Office.HostType string values)
export const OFFICE_HOST_WORD = "Word"
export const OFFICE_HOST_EXCEL = "Excel"
export const OFFICE_HOSTS = ["Word", "Excel"] as const

// Section 7.2: restricted session ruleset (literal, C1 + C4)
export const OFFICE_SESSION_RULESET = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" },
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "webfetch", pattern: "*", action: "deny" },
  { permission: "websearch", pattern: "*", action: "deny" },
  { permission: "task", pattern: "*", action: "deny" },
  { permission: "external_directory", pattern: "*", action: "deny" },
] as const

// Section 7.6: bridge error codes
export const OFFICE_ERROR_ORIGIN_REJECTED = "ORIGIN_REJECTED"
export const OFFICE_ERROR_CSRF_HEADER_MISSING = "CSRF_HEADER_MISSING"
export const OFFICE_ERROR_HOST_REJECTED = "HOST_REJECTED"
export const OFFICE_ERROR_TOKEN_INVALID = "TOKEN_INVALID"
export const OFFICE_ERROR_ROUTE_NOT_ALLOWED = "ROUTE_NOT_ALLOWED"
export const OFFICE_ERROR_FIELD_NOT_ALLOWED = "FIELD_NOT_ALLOWED"
export const OFFICE_ERROR_BODY_TOO_LARGE = "BODY_TOO_LARGE"
export const OFFICE_ERROR_PAIR_RATE_LIMITED = "PAIR_RATE_LIMITED"
export const OFFICE_ERROR_STREAM_LIMIT = "STREAM_LIMIT"
export const OFFICE_ERROR_SWARM_UNAVAILABLE = "SWARM_UNAVAILABLE"
export const OFFICE_ERROR_PORT_IN_USE = "PORT_IN_USE"
export const OFFICE_ERROR_CERT_UNTRUSTED = "CERT_UNTRUSTED"
export const OFFICE_ERROR_CERT_MISSING = "CERT_MISSING"
export const OFFICE_ERROR_DATA_DIR_UNSAFE = "DATA_DIR_UNSAFE"
export const OFFICE_ERROR_BRIDGE_EXITED = "BRIDGE_EXITED"
export const OFFICE_ERROR_START_TIMEOUT = "START_TIMEOUT"

// Section 8.2: pane names
export const OFFICE_CONTEXT_SELECTION = "selection"
export const OFFICE_CONTEXT_WHOLE = "whole"
export const OFFICE_CONNECTION_STATES = [
  "loading",
  "unavailable",
  "unpaired",
  "pairing",
  "denied",
  "connected",
  "unsupported-host",
] as const
// Rev 4 (U12 Q3): any other providerID shows the external warning.
export const INTERNAL_PROVIDER_IDS = ["gsp-ai-tail"] as const

// Section 8.3: locales
export const OFFICE_LOCALES = ["en", "id"] as const

// Section 8.4: Excel write rules (C14 number rule, C12/C15 formula-leading guard)
export const EXCEL_NUMBER_PATTERN = /^-?\d+(\.\d+)?$/
// First characters that make a cell text: = + - @ tab space CR, and fullwidth = + - @.
// A leading - or + is text unless the whole cell matches EXCEL_NUMBER_PATTERN.
export const EXCEL_FORMULA_LEADING = ["=", "+", "-", "@", "\t", " ", "\r", "＝", "＋", "－", "＠"] as const
export const EXCEL_TEXT_NUMBER_FORMAT = "@"
