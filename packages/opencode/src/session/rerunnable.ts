import { Risk } from "@/tool/risk"

// "Run again" sends a command straight to the shell with no permission prompt, so it is only offered for a command that is
// one plain program, optionally after a `cd`, and that program has to be a recognised check. Anything the classifier labels
// as changing something or leaving the machine is not offered, and nor is anything else: this reads no shell grammar, and a
// person can always send it as a message.

const MAX_LENGTH = 200
// Run whatever they are given, so what they run is not what this would be judging.
const WRAPPERS = new Set(["sudo", "doas", "env", "sh", "bash", "zsh", "fish", "eval", "exec", "xargs", "nohup", "nice", "command", "ssh"])
// Settings for a run. Others (PATH, NODE_OPTIONS, LD_PRELOAD) decide what actually runs.
const SETTINGS = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ|LANG|LC_ALL|RUST_BACKTRACE|VERBOSE)=/
// Programs that are themselves a check.
const CHECKERS = new Set(["pytest", "vitest", "jest", "mocha", "tsc", "tsgo", "mypy", "pyright", "rspec", "phpunit", "ctest", "flake8", "rubocop"])
const SCRIPTS = new Set(["test", "lint", "typecheck", "type-check", "check", "build"])
const SUBCOMMANDS: Record<string, Set<string>> = {
  go: new Set(["test", "vet", "build"]),
  cargo: new Set(["test", "check", "clippy", "build", "nextest"]),
  deno: new Set(["test", "lint", "check"]),
  dotnet: new Set(["test"]),
  ruff: new Set(["check"]),
  biome: new Set(["check"]),
}
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"])
// Flags that load or run something else, so the program's name no longer says what happens.
const LOADS_CODE = /^--?(exec|toolexec|vettool|preload|require|config|project|plugin|rootdir|globalsetup|setupfiles)\b/i
// The short forms of the same, except for cargo, whose -p only picks a package of the workspace.
const LOADS_CODE_SHORT = /^-[rpc]$/

export function rerunnable(command: string) {
  // A control character is a separator to one shell and part of a word to another.
  if (command.length > MAX_LENGTH || /[^\x20-\x7e]/.test(command)) return false
  const segments = command.split("&&").map(words)
  if (segments.some((segment) => !segment)) return false
  const programs = (segments as string[][]).filter((segment) => !(segment[0] === "cd" && segment.length === 2))
  if (programs.length !== 1) return false
  const start = programs[0].findIndex((word) => !/^\w+=/.test(word))
  if (start === -1 || !programs[0].slice(0, start).every((word) => SETTINGS.test(word))) return false
  const tokens = programs[0].slice(start)
  if (WRAPPERS.has(tokens[0])) return false
  return Risk.classify(tokens).kind === "unknown" && isCheck(tokens)
}

function isCheck([program, first, second, ...rest]: string[]): boolean {
  const args = [first, second, ...rest].filter((word) => word !== undefined)
  if (args.some((word) => LOADS_CODE.test(word) || (program !== "cargo" && LOADS_CODE_SHORT.test(word)))) return false
  if (CHECKERS.has(program)) return true
  if (SUBCOMMANDS[program]?.has(first)) return true
  if ((program === "npx" || program === "bunx") && CHECKERS.has(first)) return true
  if ((program === "python" || program === "python3") && first === "-m") return CHECKERS.has(second)
  // One target only: `make test deploy` also deploys.
  if (program === "make") return args.length === 1 && SCRIPTS.has(first)
  if (!PACKAGE_MANAGERS.has(program)) return false
  if (first === "run") return SCRIPTS.has(second)
  // `npm build` is not a script run, while `pnpm build` and `bun build` differ again: only `test` means the same to all.
  return first === "test" || (program !== "npm" && program !== "bun" && SCRIPTS.has(first))
}

// The words of one simple command, or undefined when it has any shell syntax beyond plain words and quotes.
function words(segment: string) {
  if (!/^\s*(?:(?:"[^"]*"|'[^']*'|[^\s"']+)\s*)+$/.test(segment)) return
  const found = segment.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? []
  if (found.some((word) => !word.startsWith("'") && /[;&|<>$`()\\#]/.test(word))) return
  return found.map((word) => word.replace(/^(["'])(.*)\1$/, "$2"))
}

export * as SessionRerunnable from "./rerunnable"
