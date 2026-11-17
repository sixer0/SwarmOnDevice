// MC-1 (1.3.3): is the final assistant text a tool call written as text?
//
// A model sometimes answers with the call itself as text and the turn then ends as "Finished" with nothing run. The
// provider passes the model's own call markup through as text when the named tool is not in the request's list, and its
// parser leaks the tail of a call whose argument values contain the markup strings. This module only recognises such a
// text and says what it is; what to do about it (a correction message, or ending the turn) belongs to the session loop.
//
// THIS MODULE NEVER EXECUTES ANYTHING. It is a pure function of its input: it has no imports at all, so it cannot reach
// the tool runner, the session, the file system, the network or a logger, and it must stay that way (the test file
// asserts that this file has no import). The `args` it returns are a parse of text for reporting and for the schema
// check only. They are never to be passed to a tool: the model has to repeat the call as a real tool call.
//
// Forms
// - `markup`      `<tool_call><function=NAME><parameter=K>V</parameter>…</function></tool_call>` (the wrapper is optional)
// - `name-json`   `NAME {json}`: a line that starts with a tool name, followed by one JSON object that ends the text
// - `values-only` `true {json}`: the whole text is two or more JSON values, read as argument values in schema order
//
// What counts
// - Text inside a fenced code block is a quotation and is ignored.
// - `name-json` and `values-only` count only when the tool is registered and the arguments pass its input schema;
//   `values-only` also only when exactly one registered tool fits.
// - `markup` naming a registered tool counts; with arguments that fail the schema it is `damaged` / `args-invalid`.
// - `markup` naming a tool that is NOT registered is still reported, with `registered: false` (and `server` when the name
//   belongs to a known server), because a correction cannot succeed for a tool the model cannot call. Without a known
//   server it is reported only when the markup is the whole text.
// - Markup that is cut short or has lost pieces is `damaged` / `truncated`; markup closing tags in the text of a step
//   that also made a structured call are `damaged` / `leaked-markup`.

export type TextCallForm = "markup" | "name-json" | "values-only"
export type TextCallCause = "leaked-markup" | "truncated" | "args-invalid"

export type TextCall =
  | { kind: "none" }
  | {
      kind: "call"
      form: TextCallForm
      /** The registered name. When `registered` is false: the name the tool would have (server prefix added if known). */
      tool: string
      /** The name as the text has it; empty for `values-only`, which has none. */
      written: string
      /** Parsed from the text for reporting. Never execute these. */
      args: Record<string, unknown>
      registered: boolean
      /** The server whose prefix the tool name carries, when it is a known one. */
      server?: string
    }
  | {
      kind: "damaged"
      form: TextCallForm
      /** Present when the text names a tool that is registered or belongs to a known server. */
      tool?: string
      written?: string
      registered?: boolean
      server?: string
      cause: TextCallCause
    }

export type TextCallTool = {
  /** The key the tool is registered under, server prefix included (`datum-studio_studio_mission_create`). */
  readonly name: string
  /** The tool's input schema as plain JSON Schema. Without one, arguments only have to be an object. */
  readonly schema?: unknown
}

export type TextCallInput = {
  /** The final assistant text of the step. */
  readonly text: string
  readonly tools: readonly TextCallTool[]
  /** True when the same step also made a structured tool call. */
  readonly hasToolCalls?: boolean
  /** Configured MCP server names. The built-in Studio server is always known. */
  readonly servers?: readonly string[]
}

/** The built-in Studio server (`DATUM_STUDIO_MCP`, mcp/datum-studio.ts) and the prefix its tool names start with. */
const STUDIO_SERVER = "datum-studio"
const STUDIO_TOOL_PREFIX = "studio_"

const NONE: TextCall = { kind: "none" }
const MAX_DEPTH = 64
const MAX_VALUES = 12

type Json = Record<string, unknown>
type Resolved = { tool?: string; registered: boolean; server?: string; schema?: unknown }

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/** The prefix rule of mcp/catalog.ts: `sanitize(server) + "_" + sanitize(tool)`. */
const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_")

export function detectTextCall(input: TextCallInput): TextCall {
  const body = stripFences(input.text)
  if (body.trim() === "") return NONE
  if (input.hasToolCalls) {
    // The step made a real call. Text is normal beside it; only the markup's closing tags mean the parser cut the call.
    return /<\/parameter>|<\/tool_call>/.test(body) ? { kind: "damaged", form: "markup", cause: "leaked-markup" } : NONE
  }
  const servers = [...new Set([STUDIO_SERVER, ...(input.servers ?? [])])].map(sanitize)
  const markup = detectMarkup(body, input.tools, servers)
  if (markup) return markup
  return detectNameJson(body, input.tools, servers) ?? detectValuesOnly(body, input.tools, servers) ?? NONE
}

// --- code fences -----------------------------------------------------------------------------------------------------

/** Blank out fenced code blocks (``` or ~~~, closed or not), keeping the line structure of everything else. */
function stripFences(text: string) {
  if (!text.includes("```") && !text.includes("~~~")) return text
  let open: { char: string; length: number } | undefined
  return text
    .split("\n")
    .map((line) => {
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (!open) {
        if (!fence) return line
        open = { char: fence[1][0], length: fence[1].length }
        return ""
      }
      if (fence && fence[1][0] === open.char && fence[1].length >= open.length) open = undefined
      return ""
    })
    .join("\n")
}

// --- names -----------------------------------------------------------------------------------------------------------

function serverOf(name: string, servers: readonly string[]) {
  const lower = name.toLowerCase()
  return servers
    .filter((server) => lower.startsWith(`${server.toLowerCase()}_`))
    .sort((a, b) => b.length - a.length)[0]
}

/**
 * Which registered tool a written name means. Exact name first, then the name with a known server's prefix added
 * (`studio_x` is registered as `datum-studio_studio_x`). A bare suffix match is not enough here: `list` must not turn
 * into `some-server_route_list` when the question is whether ordinary text is a call.
 */
function resolveName(written: string, tools: readonly TextCallTool[], servers: readonly string[]): Resolved {
  const wanted = written.toLowerCase()
  const exact = tools.find((tool) => tool.name === written) ?? tools.find((tool) => tool.name.toLowerCase() === wanted)
  const prefixed = exact
    ? []
    : tools.filter((tool) => servers.some((server) => tool.name.toLowerCase() === `${server.toLowerCase()}_${wanted}`))
  const studio = prefixed.find((tool) => tool.name.toLowerCase().startsWith(`${STUDIO_SERVER}_`))
  const found = exact ?? (wanted.startsWith(STUDIO_TOOL_PREFIX) ? studio : undefined) ?? prefixed[0]
  if (found) return { tool: found.name, registered: true, server: serverOf(found.name, servers), schema: found.schema }
  const server = serverOf(written, servers)
  if (server) return { tool: written, registered: false, server }
  if (wanted.startsWith(STUDIO_TOOL_PREFIX)) return { tool: `${STUDIO_SERVER}_${written}`, registered: false, server: STUDIO_SERVER }
  return { registered: false }
}

const named = (resolved: Resolved, written: string) => ({
  ...(resolved.tool ? { tool: resolved.tool } : {}),
  written,
  registered: resolved.registered,
  ...(resolved.server ? { server: resolved.server } : {}),
})

// --- markup form -----------------------------------------------------------------------------------------------------

const MARKUP_START = /^[ \t]*(<tool_call>|<function=)/m
const TOOL_CALL_OPEN = "<tool_call>"
const FUNCTION_OPEN = "<function="
const truncated = (extra: object = {}): TextCall => ({ kind: "damaged", form: "markup", ...extra, cause: "truncated" })

function detectMarkup(body: string, tools: readonly TextCallTool[], servers: readonly string[]): TextCall | undefined {
  const start = MARKUP_START.exec(body)
  if (!start) {
    // No opening at a line start, but the text ends with the markup's closing tags: the head of the call was cut off.
    return /<\/(parameter|function|tool_call)>\s*$/.test(body) && /<\/parameter>|<\/tool_call>/.test(body) ? truncated() : undefined
  }
  const pretext = body.slice(0, start.index).trim()
  let rest = body.slice(start.index).trimStart()
  if (rest.startsWith(TOOL_CALL_OPEN)) {
    rest = rest.slice(TOOL_CALL_OPEN.length).trimStart()
    if (!rest.startsWith(FUNCTION_OPEN)) {
      // Cut right after the wrapper (or inside "<function="): a call that never got its name.
      return FUNCTION_OPEN.startsWith(rest) ? truncated() : undefined
    }
  }
  const written = /^[A-Za-z0-9_.:-]*/.exec(rest.slice(FUNCTION_OPEN.length))![0]
  rest = rest.slice(FUNCTION_OPEN.length + written.length)
  // The name runs to the end of the text: it may itself be cut, so it is not resolved.
  if (rest === "") return truncated(written ? { written } : {})
  if (!written) return undefined
  const resolved = resolveName(written, tools, servers)
  if (!rest.startsWith(">")) return truncated(named(resolved, written))

  const parsed = parseParameters(rest.slice(1))
  if (!parsed) return truncated(named(resolved, written))

  const properties = isObject(resolved.schema) && isObject(resolved.schema.properties) ? resolved.schema.properties : {}
  const args: Json = {}
  for (const [key, raw] of parsed.parameters) args[key] = coerce(raw, properties[key])

  if (resolved.registered) {
    if (resolved.schema !== undefined && !valid(args, resolved.schema, resolved.schema, 0))
      return { kind: "damaged", form: "markup", ...named(resolved, written), cause: "args-invalid" }
    return { kind: "call", form: "markup", tool: resolved.tool!, written, args, registered: true, ...(resolved.server ? { server: resolved.server } : {}) }
  }
  if (resolved.server) return { kind: "call", form: "markup", tool: resolved.tool!, written, args, registered: false, server: resolved.server }
  // An unknown name of no known server: only when the markup is all there is (not an explanation of the format).
  if (pretext === "" && parsed.trailing === "") return { kind: "call", form: "markup", tool: written, written, args, registered: false }
  return undefined
}

/** `<parameter=K>V</parameter>` repeated, then `</function>` and an optional `</tool_call>`. Undefined when incomplete. */
function parseParameters(text: string) {
  const parameters: Array<[string, string]> = []
  let rest = text
  for (;;) {
    rest = rest.trimStart()
    if (rest.startsWith("</function>")) {
      rest = rest.slice("</function>".length).trimStart()
      if (rest.startsWith("</tool_call>")) rest = rest.slice("</tool_call>".length)
      return { parameters, trailing: rest.trim() }
    }
    const open = /^<parameter=([^<>\n]+)>/.exec(rest)
    if (!open) return undefined
    const close = rest.indexOf("</parameter>", open[0].length)
    if (close < 0) return undefined
    parameters.push([open[1].trim(), rest.slice(open[0].length, close).trim()])
    rest = rest.slice(close + "</parameter>".length)
  }
}

const PYTHON_LITERALS: Record<string, unknown> = { True: true, False: false, None: null }

function typesOf(schema: unknown): string[] {
  if (!isObject(schema)) return []
  if (typeof schema.type === "string") return [schema.type]
  return Array.isArray(schema.type) ? schema.type.filter((item): item is string => typeof item === "string") : []
}

/** A markup value is raw text. Read it as JSON unless the schema asks for a string (the model writes `False` too). */
function coerce(raw: string, schema: unknown): unknown {
  const types = typesOf(schema)
  if (types.length === 1 && types[0] === "string") return raw
  if (raw in PYTHON_LITERALS) return PYTHON_LITERALS[raw]
  const parsed = parseJson(raw)
  return parsed.ok ? parsed.value : raw
}

// --- name-plus-JSON form ---------------------------------------------------------------------------------------------

function detectNameJson(body: string, tools: readonly TextCallTool[], servers: readonly string[]): TextCall | undefined {
  const line = /^[ \t]*([A-Za-z][\w.:-]*)[ \t]*(?=\{)/gm
  for (let match = line.exec(body); match; match = line.exec(body)) {
    const written = match[1]
    const resolved = resolveName(written, tools, servers)
    if (!resolved.registered) continue
    const open = match.index + match[0].length
    const end = balancedEnd(body, open)
    if (end < 0) {
      // The object never closes: the text was cut inside the arguments.
      return { kind: "damaged", form: "name-json", ...named(resolved, written), cause: "truncated" }
    }
    if (body.slice(end).trim() !== "") continue
    const parsed = parseJson(body.slice(open, end))
    if (!parsed.ok || !isObject(parsed.value)) continue
    if (resolved.schema !== undefined && !valid(parsed.value, resolved.schema, resolved.schema, 0)) continue
    return { kind: "call", form: "name-json", tool: resolved.tool!, written, args: parsed.value, registered: true, ...(resolved.server ? { server: resolved.server } : {}) }
  }
  return undefined
}

// --- values-only form ------------------------------------------------------------------------------------------------

/** The whole text as two or more JSON values (`true {"id":…}`), or undefined. */
function readValues(text: string): unknown[] | undefined {
  const values: unknown[] = []
  let at = 0
  while (at < text.length) {
    if (/\s/.test(text[at])) {
      at++
      continue
    }
    if (values.length >= MAX_VALUES) return undefined
    const bracket = text[at] === "{" || text[at] === "["
    const end = bracket ? balancedEnd(text, at) : text[at] === '"' ? stringEnd(text, at) : tokenEnd(text, at)
    if (end < 0) return undefined
    const token = text.slice(at, end)
    const parsed = token in PYTHON_LITERALS ? { ok: true as const, value: PYTHON_LITERALS[token] } : parseJson(token)
    if (!parsed.ok) return undefined
    values.push(parsed.value)
    at = end
  }
  return values.length >= 2 && values.some((value) => typeof value === "object" && value !== null) ? values : undefined
}

function detectValuesOnly(body: string, tools: readonly TextCallTool[], servers: readonly string[]): TextCall | undefined {
  const values = readValues(body.trim())
  if (!values) return undefined
  const fits: Array<{ tool: TextCallTool; args: Json }> = []
  for (const tool of tools) {
    if (!isObject(tool.schema) || !isObject(tool.schema.properties)) continue
    const keys = Object.keys(tool.schema.properties)
    if (values.length > keys.length) continue
    const args: Json = {}
    values.forEach((value, index) => (args[keys[index]] = value))
    if (valid(args, tool.schema, tool.schema, 0)) fits.push({ tool, args })
  }
  // More than one tool fits: naming one of them would be a guess.
  if (fits.length !== 1) return undefined
  const server = serverOf(fits[0].tool.name, servers)
  return { kind: "call", form: "values-only", tool: fits[0].tool.name, written: "", args: fits[0].args, registered: true, ...(server ? { server } : {}) }
}

// --- scanning --------------------------------------------------------------------------------------------------------

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    // Not JSON is an answer here, not a failure: the caller treats the text as ordinary text.
    return { ok: false }
  }
}

/** Index just past the string that opens at `start`, or -1. */
function stringEnd(text: string, start: number) {
  for (let at = start + 1; at < text.length; at++) {
    if (text[at] === "\\") at++
    else if (text[at] === '"') return at + 1
  }
  return -1
}

function tokenEnd(text: string, start: number) {
  let at = start
  while (at < text.length && !/[\s{}[\]"]/.test(text[at])) at++
  return at === start ? -1 : at
}

/** Index just past the bracket that closes the one at `start` (strings skipped), or -1 when it never closes. */
function balancedEnd(text: string, start: number) {
  let depth = 0
  for (let at = start; at < text.length; at++) {
    const char = text[at]
    if (char === '"') {
      const end = stringEnd(text, at)
      if (end < 0) return -1
      at = end - 1
    } else if (char === "{" || char === "[") depth++
    else if (char === "}" || char === "]") {
      depth--
      if (depth === 0) return at + 1
    }
  }
  return -1
}

// --- schema check ----------------------------------------------------------------------------------------------------

function typeMatches(value: unknown, type: string) {
  if (type === "string") return typeof value === "string"
  if (type === "number") return typeof value === "number"
  if (type === "integer") return typeof value === "number" && Number.isInteger(value)
  if (type === "boolean") return typeof value === "boolean"
  if (type === "null") return value === null
  if (type === "array") return Array.isArray(value)
  if (type === "object") return isObject(value)
  return true
}

function deref(schema: Json, root: unknown): unknown {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return schema
  let at: unknown = root
  for (const part of schema.$ref.slice(2).split("/")) {
    if (!isObject(at)) return {}
    at = at[part.replace(/~1/g, "/").replace(/~0/g, "~")]
  }
  return at
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The part of JSON Schema that tool inputs use: type, enum, const, required, properties, additionalProperties, items,
 * anyOf / oneOf / allOf and local $ref. A keyword it does not know is not checked, so an exotic schema lets more
 * through, never less; the name and form rules above still have to hold.
 */
function valid(value: unknown, schemaInput: unknown, root: unknown, depth: number): boolean {
  if (schemaInput === false) return false
  if (!isObject(schemaInput) || depth > MAX_DEPTH) return true
  const target = deref(schemaInput, root)
  if (target !== schemaInput) return valid(value, target, root, depth + 1)
  // Past the $ref: the schema itself, as the narrowed object type.
  const schema: Json = schemaInput
  const next = (item: unknown, sub: unknown) => valid(item, sub, root, depth + 1)

  const types = typesOf(schema)
  if (types.length > 0 && !types.some((type) => typeMatches(value, type))) return false
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => same(item, value))) return false
  if ("const" in schema && !same(schema.const, value)) return false
  if (Array.isArray(schema.allOf) && !schema.allOf.every((sub) => next(value, sub))) return false
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((sub) => next(value, sub))) return false
  if (Array.isArray(schema.oneOf) && !schema.oneOf.some((sub) => next(value, sub))) return false

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required) && !schema.required.every((key) => typeof key !== "string" || key in value)) return false
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) {
        if (!next(item, properties[key])) return false
      } else if (schema.additionalProperties === false) return false
      else if (isObject(schema.additionalProperties) && !next(item, schema.additionalProperties)) return false
    }
  }
  if (Array.isArray(value) && isObject(schema.items) && !value.every((item) => next(item, schema.items))) return false
  return true
}
