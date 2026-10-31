import path from "node:path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { jobWords } from "@opencode-ai/core/util/same-job"
import { ConfigMarkdown } from "@/config/markdown"
import { MemoryLearn } from "@/memory/learn"

// Pure half of saved commands: what a run comes down to, and how that becomes something the next agent can follow.
// Only the user's own words, the commands that ran and the paths that changed go in. File contents and tool output
// stay out: they cost the most, can hold secrets, and are where text written to steer an agent would come from.

export const MAX_TEMPLATE = 8000
const MAX_DESCRIPTION = 200
const MAX_LINE = 400
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const LOOKING_ONLY = /^(ls|cat|pwd|cd|echo|grep|rg|find|head|tail|sed -n|wc|which|file|tree|git (status|diff|log|show))\b/
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"])
const ARGUMENTS = "$ARGUMENTS"

// `bun test 2>&1 | tail -20` reports tail's exit code, so whoever reads the next run cannot tell whether the check passed.
// Only a final tail or head, which trims and adds nothing: anything else in a pipe may be the point of the command.
const TRIMMED = /^([^|]+?)(?:\s+2>&1)?\s*\|\s*(?:tail|head)(?:\s+(?:-n\s*)?-?\d+)?\s*$/

/** A command as it should be repeated, with the exit code left showing. */
export const untrimmed = (command: string) => command.match(TRIMMED)?.[1]?.trim() ?? command

export type Digest = {
  prompts: string[]
  worked: string[]
  failed: string[]
  files: string[]
  closing?: string
}

export type Draft = { name: string; description: string; template: string }

const line = (text: string) => {
  const trimmed = text.trim()
  return trimmed.length > MAX_LINE ? trimmed.slice(0, MAX_LINE - 1) + "…" : trimmed
}
const lastUnique = (values: string[], limit: number) => [...new Set(values.toReversed())].slice(0, limit).toReversed()

/** A text the user typed, not one the runtime added. */
export function askedText(part: { type: string; text?: string; synthetic?: boolean; ignored?: boolean }) {
  if (part.type !== "text" || part.synthetic || part.ignored) return undefined
  return part.text?.trim() || undefined
}

export function digest(messages: readonly SessionV1.WithParts[], directory: string): Digest {
  const result: Digest = { prompts: [], worked: [], failed: [], files: [] }
  for (const message of messages) {
    if (message.info.role === "user") {
      const text = message.parts.map((part) => askedText(part as Parameters<typeof askedText>[0]) ?? "").join("\n").trim()
      if (text && !MemoryLearn.looksSecret(text)) result.prompts.push(line(text))
      continue
    }
    for (const part of message.parts) {
      if (part.type === "text" && !part.synthetic && part.text.trim()) {
        result.closing = part.text.trim().slice(-1500)
        continue
      }
      if (part.type !== "tool") continue
      const state = part.state
      if (state.status !== "completed" && state.status !== "error") continue
      if (part.tool === "bash") {
        const command = untrimmed(typeof state.input.command === "string" ? state.input.command.trim() : "")
        if (!command || command.length > MAX_LINE || MemoryLearn.looksSecret(command)) continue
        const exit = state.status === "completed" ? state.metadata?.exit : 1
        if (exit === 0 || exit === undefined) {
          if (!LOOKING_ONLY.test(command)) result.worked.push(command)
        } else result.failed.push(command)
        continue
      }
      if (EDIT_TOOLS.has(part.tool) && state.status === "completed" && typeof state.input.filePath === "string") {
        result.files.push(path.relative(directory, path.resolve(directory, state.input.filePath)))
      }
    }
  }
  // A command that failed once and then worked was a retry, not something to avoid.
  const worked = new Set(result.worked)
  result.failed = lastUnique(result.failed.filter((command) => !worked.has(command)), 8)
  result.worked = lastUnique(result.worked, 10)
  result.files = lastUnique(result.files, 15)
  if (result.closing && MemoryLearn.looksSecret(result.closing)) result.closing = undefined
  return result
}

export function digestText(input: Digest) {
  const section = (title: string, items: string[]) =>
    items.length ? [`${title}:`, ...items.map((item) => `- ${item}`), ""] : []
  return [
    ...section("What the person asked, in order", input.prompts),
    ...section("Commands that worked", input.worked),
    ...section("Commands that failed", input.failed),
    ...section("Files changed", input.files),
    ...(input.closing ? ["The agent's closing message:", input.closing] : []),
  ].join("\n")
}

/** Built from the run alone, for when no model can be reached. Worse prose, nothing invented, no tokens spent. */
export function fallbackDraft(input: Digest): Draft {
  const [first = "", ...corrections] = input.prompts
  const section = (title: string, items: string[]) =>
    items.length ? ["", `${title}:`, ...items.map((item) => `- ${item}`)] : []
  const template = [
    first,
    ...section("Corrections from the last run", corrections.slice(0, 6)),
    ...section(
      "Commands that worked last time",
      input.worked.map((command) => `\`${command}\``),
    ),
    ...section(
      "Commands that failed last time",
      input.failed.map((command) => `\`${command}\``),
    ),
    "",
    `Details for this run, if any: ${ARGUMENTS}`,
  ]
    .join("\n")
    .trim()
  return {
    name: cleanName(jobWords(first).slice(0, 3).join("-")) || "saved-job",
    description: oneLine(first),
    template: disarm(template),
  }
}

/** What the model returned, or undefined when it is not usable and the run's own record should be used instead. */
export function parseDraft(text: string): Draft | undefined {
  const body = text.replace(/<think>[\s\S]*?<\/think>/g, "")
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const { name, description, instructions } = parsed as Record<string, unknown>
  if (typeof instructions !== "string" || !instructions.trim()) return undefined
  // Last, on the final text: rewriting a command can leave a `!` right before a backtick, which is a live marker again.
  const steps = disarm(instructions.trim().replace(/`([^`\n]+)`/g, (_, command: string) => `\`${untrimmed(command)}\``))
  const template = steps.includes(ARGUMENTS) ? steps : `${steps}\n\nDetails for this run, if any: ${ARGUMENTS}`
  if (template.length > MAX_TEMPLATE || MemoryLearn.looksSecret(template)) return undefined
  return {
    name: cleanName(typeof name === "string" ? name : "") || "saved-job",
    description: typeof description === "string" ? oneLine(description) : "",
    template,
  }
}

/**
 * A template can run shell when used: !`command` executes before the agent sees anything, without asking, and @path puts
 * a file in the prompt. The person can write those themselves. A draft must not contain them, because a model's words may
 * trace back to what it read. Judged on the final form with the same patterns a command is run with, so `!!` cannot turn
 * into a live marker once the first one is gone.
 */
export function disarm(template: string): string {
  const quoted = template.replace(ConfigMarkdown.FILE_REGEX, (match) => (match === "@" ? match : `\`${match}\``))
  // `!$ARGUMENTS` would turn what the person types next into a marker.
  const next = quoted.replace(/!+`/g, "`").replace(/!+(?=\$)/g, "")
  return armed(next) ? disarm(next) : next
}

const armed = (template: string) =>
  ConfigMarkdown.shell(template).length > 0 || ConfigMarkdown.files(template).some((match) => match[1])

export function cleanName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")
}

export const validName = (name: string) => NAME.test(name)

export function oneLine(text: string) {
  const first = text.trim().split(/\r?\n/)[0]!.trim()
  const sentence = first.match(/^.{20,}?[.!?](?=\s|$)/)?.[0] ?? first
  return sentence.length > MAX_DESCRIPTION ? sentence.slice(0, MAX_DESCRIPTION - 1) + "…" : sentence
}

export function freeName(name: string, taken: (candidate: string) => boolean) {
  if (!taken(name)) return name
  for (let suffix = 2; ; suffix++) {
    const candidate = `${name.slice(0, 37)}-${suffix}`
    if (!taken(candidate)) return candidate
  }
}

export * as SavedCommandModel from "./saved-model"
