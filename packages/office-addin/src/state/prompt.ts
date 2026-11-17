// Prompt composition (FS FR-23..FR-27, FR-23a; REG §7.4, §8.2). Pure: no Office.js, no SDK.
import {
  OFFICE_BODY_LIMIT_BYTES,
  OFFICE_CONTEXT_SELECTION,
  OFFICE_CONTEXT_WHOLE,
  OFFICE_HOST_WORD,
  OFFICE_HOSTS,
  OFFICE_TITLE_MAX_CHARS,
} from "../constants"

export type OfficeHost = (typeof OFFICE_HOSTS)[number]
export type ContextScope = typeof OFFICE_CONTEXT_SELECTION | typeof OFFICE_CONTEXT_WHOLE

export type TextPart = { type: "text"; text: string }
// FR-27 / REG §7.4: the body carries `parts` only, 1 or 2 text parts.
/** @internal test seam */
export type PromptBody = { parts: TextPart[] }

type ComposedPrompt = {
  body: PromptBody
  // Context tag of the sent turn (FR-24, FR-58): "none" when no context part was sent.
  tag: ContextScope | "none"
}

// FR-23a (D15): Word context: every \r becomes \n and every U+0002 (footnote
// reference mark) is removed. Excel context is returned unchanged (FR-10 owns it).
export function normaliseContext(host: OfficeHost, context: string) {
  if (host !== OFFICE_HOST_WORD) return context
  return context.replaceAll("\r", "\n").replaceAll("\u0002", "")
}

// FR-23 / FR-24. `context` is the raw read; it is normalised here so no caller can
// skip FR-23a. An empty context (after normalisation) sends the instruction only.
export function composePrompt(input: {
  host: OfficeHost
  scope: ContextScope
  context: string
  instruction: string
}): ComposedPrompt {
  const context = normaliseContext(input.host, input.context)
  const instruction: TextPart = { type: "text", text: input.instruction }
  if (context === "") return { body: { parts: [instruction] }, tag: "none" }
  return {
    body: {
      parts: [{ type: "text", text: `[Office context: ${input.host} ${input.scope}]\n` + context }, instruction],
    },
    tag: input.scope,
  }
}

// FR-25: UTF-8 byte length of the JSON request body.
export function bodyBytes(body: PromptBody) {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength
}

// FR-25: exactly 2 MiB is allowed; one byte more is refused with office.error.tooLarge.
/** @internal test seam */
export function checkBodySize(body: PromptBody) {
  return bodyBytes(body) <= OFFICE_BODY_LIMIT_BYTES ? ("ok" as const) : ("office.error.tooLarge" as const)
}

// FR-26: Send is disabled while the instruction is blank or whitespace only.
export function canSend(instruction: string) {
  return instruction.trim() !== ""
}

// The one gate in front of prompt_async: FR-26 (blank), SC-50 (no send before the
// provider disclosure is acknowledged for this host), FR-25 (size). Undefined = send.
export function sendBlocker(input: { instruction: string; acknowledged: boolean; body: PromptBody }) {
  if (!canSend(input.instruction)) return "blank" as const
  if (!input.acknowledged) return "disclosure" as const
  if (checkBodySize(input.body) !== "ok") return "office.error.tooLarge" as const
  return undefined
}

// FR-32: session title = first line of the instruction, cut to 200 characters
// (UTF-16 code units, the unit the server counts). A cut never leaves a lone high
// surrogate at the end.
export function sessionTitle(instruction: string) {
  const line = instruction.trimStart().split(/\r\n|\r|\n/)[0] ?? ""
  if (line.length <= OFFICE_TITLE_MAX_CHARS) return line
  const cut = line.slice(0, OFFICE_TITLE_MAX_CHARS)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

// FR-04 / FR-13: text written to the document (Insert, Replace, Excel matrix) and to the
// clipboard (Copy) = reply text with \r\n normalised to \n, leading whitespace-only lines
// removed (M8-02b, C91: thinker replies start with "\n\n"), and trailing line breaks
// removed. The first non-empty line keeps its own indentation; inner breaks are kept.
// The thread may still show the raw reply.
export function writeText(reply: string) {
  return reply
    .replaceAll("\r\n", "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/[\r\n]+$/, "")
}
