import { Risk } from "@/tool/risk"

// "Run again" sends a command straight to the shell with no permission prompt, so it is only offered for a command that is
// one plain program, optionally after a `cd`. Whether that program is dangerous is the question the shell tool already asks
// of every call before running it, so it gets the same answer here. Anything with more syntax than that is not offered:
// this reads no shell grammar, and a person can always send it as a message.

const MAX_LENGTH = 200
// Run whatever they are given, so what they run is not what this would be judging.
const WRAPPERS = new Set(["sudo", "doas", "env", "sh", "bash", "zsh", "fish", "eval", "exec", "xargs", "nohup", "nice", "command", "ssh"])

export function rerunnable(command: string) {
  if (command.length > MAX_LENGTH || command.includes("\n")) return false
  const segments = command.split("&&").map(words)
  if (segments.some((segment) => !segment)) return false
  const programs = (segments as string[][]).filter((segment) => !(segment[0] === "cd" && segment.length === 2))
  if (programs.length !== 1) return false
  const tokens = programs[0].slice(programs[0].findIndex((word) => !/^\w+=/.test(word)))
  if (tokens.length === 0 || /^\w+=/.test(tokens[0]) || WRAPPERS.has(tokens[0])) return false
  const verdict = Risk.classify(tokens)
  return verdict.kind === "harmless" || verdict.kind === "unknown"
}

// The words of one simple command, or undefined when it has any shell syntax beyond plain words and quotes.
function words(segment: string) {
  if (!/^\s*(?:(?:"[^"]*"|'[^']*'|[^\s"']+)\s*)+$/.test(segment)) return
  const found = segment.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? []
  if (found.some((word) => !word.startsWith("'") && /[;&|<>$`()\\]/.test(word))) return
  return found.map((word) => word.replace(/^(["'])(.*)\1$/, "$2"))
}

export * as SessionRerunnable from "./rerunnable"
