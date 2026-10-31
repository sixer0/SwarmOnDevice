// What of a stored part is worth finding later. The index holds what people and agents said and what was changed, not
// every byte that passed through: a `read` result is someone else's file, and indexing it would make every common word
// match every session that ever opened that file.

const TOOL_OUTPUT_HEAD = 2_000
const TOOL_OUTPUT_TAIL = 2_000
const EDIT_LIMIT = 64_000
const TEXT_LIMIT = 64_000

export type Kind = "prompt" | "said" | "thought" | "edit" | "tool"

export type Doc = {
  kind: Kind
  text: string
  /** A file the part was about, or for a tool the command or tool name: shown beside the snippet. */
  label: string
}

type Data = Record<string, unknown>

const record = (value: unknown): Data | undefined =>
  value && typeof value === "object" ? (value as Data) : undefined
const string = (value: unknown) => (typeof value === "string" ? value : "")

/** Null means there is nothing to index yet, or ever: a running tool, an empty step marker, an injected reminder. */
export function extract(data: Data, role: string | undefined): Doc | null {
  if (data.type === "text") {
    if (data.synthetic || data.ignored) return null
    const text = string(data.text).slice(0, TEXT_LIMIT)
    if (!text.trim()) return null
    return { kind: role === "user" ? "prompt" : "said", text, label: "" }
  }
  if (data.type === "reasoning") {
    const text = string(data.text).slice(0, TEXT_LIMIT)
    return text.trim() ? { kind: "thought", text, label: "" } : null
  }
  if (data.type === "tool") return extractTool(string(data.tool), record(data.state) ?? {})
  return null
}

function extractTool(tool: string, state: Data): Doc | null {
  if (state.status !== "completed" && state.status !== "error") return null
  const input = record(state.input) ?? {}
  const edit = editOf(tool, input)
  if (edit && state.status === "completed") return { kind: "edit", text: edit.text.slice(0, EDIT_LIMIT), label: edit.path }

  const output = toolOutput(tool, state)
  if (tool === "bash" || tool === "shell") {
    const command = string(input.command)
    return { kind: "tool", text: [command, output].filter(Boolean).join("\n"), label: command.split("\n")[0].slice(0, 80) }
  }
  const subject = string(input.filePath) || string(input.path) || string(input.pattern) || string(input.query) || string(input.url)
  const description = string(input.description) || string(input.prompt) || string(state.title)
  const text = [subject, description, output].filter(Boolean).join("\n")
  return text.trim() ? { kind: "tool", text, label: subject.slice(0, 80) || tool } : null
}

/** Only tools whose output is the agent's own conclusion or a failure keep their output. */
function toolOutput(tool: string, state: Data) {
  if (state.status === "error") return string(state.error).slice(0, TOOL_OUTPUT_HEAD)
  if (["read", "glob", "grep", "list", "webfetch", "websearch", "skill", "todowrite", "todoread"].includes(tool)) return ""
  const output = string(state.output)
  if (output.length <= TOOL_OUTPUT_HEAD + TOOL_OUTPUT_TAIL) return output
  return `${output.slice(0, TOOL_OUTPUT_HEAD)}\n${output.slice(-TOOL_OUTPUT_TAIL)}`
}

export function editOf(tool: string, input: Data): { path: string; text: string } | undefined {
  if (tool === "edit") return { path: string(input.filePath), text: string(input.newString) }
  if (tool === "write") return { path: string(input.filePath), text: string(input.content) }
  if (tool === "apply_patch") {
    const patch = string(input.patchText)
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((match) => match[1])
    const added = patch
      .split("\n")
      .filter((line) => line.startsWith("+"))
      .map((line) => line.slice(1))
    return { path: paths.join(" "), text: added.join("\n") }
  }
  return undefined
}

/**
 * Did this edit write this exact line, and was it new? "Wrote" is the real answer to why a line changed; an edit that
 * only carried the line along inside a larger replacement is a weaker one.
 */
export function editWroteLine(tool: string, input: Data, line: string): "introduced" | "carried" | undefined {
  const want = line.trim()
  if (!want) return undefined
  const has = (text: string) => text.split("\n").some((candidate) => candidate.trim() === want)
  const edit = editOf(tool, input)
  if (!edit || !has(edit.text)) return undefined
  if (tool === "edit" && has(string(input.oldString))) return "carried"
  if (tool === "apply_patch") {
    const removed = string(input.patchText)
      .split("\n")
      .filter((text) => text.startsWith("-"))
      .map((text) => text.slice(1))
    return removed.some((text) => text.trim() === want) ? "carried" : "introduced"
  }
  return "introduced"
}

export * as SessionSearchExtract from "./extract"
