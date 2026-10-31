// What a command printed for a person is mostly not for a model: colours, progress bars redrawn in place, and hundreds of
// lines that differ only by a number. The model pays for those again on every later step of the run, so they are removed
// before the output enters the conversation. The transcript still shows the command's output as printed.

// Runs of near-identical lines shorter than this are left alone: a few similar lines are usually the content.
const MIN_RUN = 12
const KEEP_START = 3
const KEEP_END = 2

// Never hide one of these inside a run, however alike they look. A list of failures is the point of the output.
const SIGNAL = /\b(fail(ed|ure|ing)?|errors?|panic|exception|fatal|traceback|assert\w*|denied)\b|[✗✕✖×]/i

// The agent chose this output by asking for it, so a table of similar rows is the answer rather than noise.
const SELECTIVE =
  /(^|[|;&]\s*)(cat|sed|awk|head|tail|grep|egrep|rg|jq|cut|sort|uniq|wc|nl|less|more|find|ls|git\s+(show|diff|log|blame|status))\b/

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\^_]/g

export function condense(input: { text: string; command?: string }) {
  const lines = input.text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line
      // A carriage return redraws the line, so only what was drawn last was ever visible.
      return clean.includes("\r") ? (clean.split("\r").findLast((part) => part.trim() !== "") ?? "") : clean
    })
  const stripped = lines.join("\n")
  if (input.command !== undefined && SELECTIVE.test(input.command)) return { text: stripped, hidden: 0 }

  const shape = (line: string) => line.replace(/\d+/g, "#")
  const out: string[] = []
  let hidden = 0
  let start = 0
  while (start < lines.length) {
    let end = start + 1
    const current = shape(lines[start]!)
    const collapsible = current.trim() !== "" && !SIGNAL.test(current)
    if (collapsible) while (end < lines.length && shape(lines[end]!) === current) end++
    const size = end - start
    if (size < MIN_RUN) {
      out.push(...lines.slice(start, end))
      start = end
      continue
    }
    const removed = size - KEEP_START - KEEP_END
    hidden += removed
    out.push(...lines.slice(start, start + KEEP_START), `... ${removed} similar lines ...`, ...lines.slice(end - KEEP_END, end))
    start = end
  }
  return { text: out.join("\n"), hidden }
}

export * as Condense from "./condense"
