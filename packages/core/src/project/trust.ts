export * as ProjectTrust from "./trust"

import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "fs"
import path from "path"
import { parse } from "jsonc-parser"
import { Schema } from "effect"
import { ConfigMarkdown } from "../config/markdown"
import { Flag } from "../flag/flag"
import { programSetting } from "./git-config"
import { Global } from "../global"
import { Glob } from "../util/glob"

// A folder is untrusted until a person says otherwise, and the answer lives only here, under the user's own state. Nothing
// read from a project decides this: no config key, no file in the repository, no environment value.

export const Item = Schema.Struct({
  label: Schema.String,
  source: Schema.String,
}).annotate({ identifier: "ProjectTrustItem" })
export type Item = typeof Item.Type

export const State = Schema.Literals(["clean", "ask", "later", "trusted"])
export const Status = Schema.Struct({
  state: State,
  directory: Schema.String,
  items: Schema.Array(Item),
}).annotate({ identifier: "ProjectTrustStatus" })
export type Status = typeof Status.Type

export const Decision = Schema.Literals(["trust", "later"])
export type Decision = typeof Decision.Type

// "Not now" lasts as long as this process. The next launch asks again, because the folder is still not trusted.
const later = new Set<string>()

let assumed = false
/** Most tests are about what a project's config does, not about who decided to load it. Reachable only from code. */
export function assumeTrustedForTests(value: boolean) {
  assumed = value
}

function storeFile() {
  return path.join(Global.Path.state, "trust.json")
}

function readStore(): Record<string, { at: number }> {
  try {
    const data = JSON.parse(readFileSync(storeFile(), "utf8"))
    return typeof data?.directories === "object" && data.directories !== null ? data.directories : {}
  } catch {
    return {}
  }
}

function writeStore(directories: Record<string, { at: number }>) {
  const file = storeFile()
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ directories }, null, 2), { mode: 0o600 })
  renameSync(temp, file)
}

function real(input: string) {
  try {
    return realpathSync(input)
  } catch {
    return path.resolve(input)
  }
}

function exists(input: string) {
  try {
    statSync(input)
    return true
  } catch {
    return false
  }
}

/** The folder a trust answer belongs to: the checkout's top level, or the folder itself when there is no repository. */
export function rootOf(directory: string) {
  const start = real(directory)
  for (let current = start; ; current = path.dirname(current)) {
    if (exists(path.join(current, ".git"))) return current
    if (path.dirname(current) === current) return start
  }
}

export function isTrusted(directory: string) {
  return assumed || Object.hasOwn(readStore(), rootOf(directory))
}

export function trust(directory: string) {
  const root = rootOf(directory)
  writeStore({ ...readStore(), [root]: { at: Date.now() } })
  later.delete(root)
  return root
}

export function revoke(directory: string) {
  const root = rootOf(directory)
  const { [root]: _removed, ...rest } = readStore()
  writeStore(rest)
  return root
}

export function notNow(directory: string) {
  later.add(rootOf(directory))
}

export function status(directory: string): Status {
  const root = rootOf(directory)
  const items = scan(directory)
  if (isTrusted(directory)) return { state: "trusted", directory: root, items }
  if (!items.length) return { state: "clean", directory: root, items }
  return { state: later.has(root) ? "later" : "ask", directory: root, items }
}

function inside(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** The user's own folders. A project can sit under one of them, but these never need a question. */
export function isUserLevel(file: string) {
  const roots = [
    Global.Path.config,
    path.join(Global.Path.home, ".swarm"),
    path.join(Global.Path.home, ".claude"),
    path.join(Global.Path.home, ".agents"),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ]
  return roots.some((root) => inside(root, file) || inside(real(root), real(file)))
}

const keptKeys = new Set(["$schema", "logLevel", "username", "watcher", "tool_output", "compaction", "attachment", "media"])
const ignoredKeys = new Set(["theme", "keybinds", "tui", "layout", "websearch", "warming"])
const textAgentKeys = new Set([
  "name",
  "description",
  "prompt",
  "system",
  "mode",
  "hidden",
  "color",
  "steps",
  "maxSteps",
  "disable",
  "disabled",
  "temperature",
  "top_p",
])
const textCommandKeys = new Set(["name", "template", "description", "agent", "subtask"])
const shellInTemplate = /!`[^`]+`/

/** Text only: it can say things to the model, but it cannot run anything or widen what an agent may do. */
export function isTextAgent(input: Record<string, unknown>) {
  return Object.keys(input).every((key) => textAgentKeys.has(key))
}

export function isTextCommand(input: Record<string, unknown>) {
  return (
    Object.keys(input).every((key) => textCommandKeys.has(key)) &&
    !shellInTemplate.test(typeof input.template === "string" ? input.template : "")
  )
}

/** A skill is also offered as a slash command, and a command's template runs what it marks with !`...`. */
export function isTextSkill(content: string) {
  return !shellInTemplate.test(content)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function names(value: unknown) {
  return isRecord(value) ? Object.keys(value) : []
}

function mcpLabel(name: string, value: unknown) {
  if (!isRecord(value)) return `Change MCP server "${name}"`
  if (Array.isArray(value.command)) return `Start MCP server "${name}": ${value.command.join(" ")}`
  if (typeof value.url === "string") return `Connect to MCP server "${name}" at ${value.url}`
  return `Change MCP server "${name}"`
}

function pluginLabel(value: unknown) {
  return `Load plugin ${Array.isArray(value) ? value[0] : isRecord(value) ? value.package : value}`
}

function commandsLabel(kind: string, value: unknown) {
  const list = names(value).filter((name) => {
    const entry = isRecord(value) ? value[name] : undefined
    return isRecord(entry) && Array.isArray(entry.command)
  })
  return list.map((name) => {
    const entry = (value as Record<string, { command: string[] }>)[name]
    return `Run its own ${kind} "${name}": ${entry.command.join(" ")}`
  })
}

const labels: Record<string, (value: unknown) => string[]> = {
  permission: () => ["Change which tools run without asking"],
  permissions: () => ["Change which tools run without asking"],
  tools: () => ["Change which tools run without asking"],
  mcp: (value) => {
    const servers = isRecord(value) && isRecord(value.servers) ? { ...value, ...value.servers } : value
    return names(servers)
      .filter((name) => name !== "servers" && name !== "timeout")
      .map((name) => mcpLabel(name, (servers as Record<string, unknown>)[name]))
  },
  plugin: (value) => (Array.isArray(value) ? value.map(pluginLabel) : []),
  plugins: (value) => (Array.isArray(value) ? value.map(pluginLabel) : []),
  provider: (value) => names(value).map((name) => `Add or change model provider "${name}"`),
  providers: (value) => names(value).map((name) => `Add or change model provider "${name}"`),
  formatter: (value) => {
    const list = commandsLabel("formatter", value)
    return list.length ? list : ["Turn on or change formatters"]
  },
  lsp: (value) => {
    const list = commandsLabel("language server", value)
    return list.length ? list : ["Turn on or change language servers"]
  },
  shell: (value) => [`Use ${value} as the shell`],
  model: (value) => [`Use model ${value}`],
  small_model: (value) => [`Use model ${value}`],
  default_agent: (value) => [`Start with agent ${value}`],
  server: () => ["Change how the server listens"],
  share: () => ["Change how sessions are shared"],
  autoshare: () => ["Change how sessions are shared"],
  enterprise: () => ["Change where sessions are shared"],
  autoupdate: () => ["Change update checks"],
  disabled_providers: () => ["Change which model providers are on"],
  enabled_providers: () => ["Change which model providers are on"],
  skills: (value) => {
    const list = Array.isArray(value) ? value : isRecord(value) ? [...asArray(value.paths), ...asArray(value.urls)] : []
    return list.map((item) => `Load skills from ${item}`)
  },
  references: (value) => names(value).map((name) => `Fetch reference "${name}"`),
  reference: (value) => names(value).map((name) => `Fetch reference "${name}"`),
  experimental: () => ["Change experimental settings"],
  subagent_depth: () => ["Change how deep subagents may go"],
  spend_limit: () => ["Change the spending limit"],
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : []
}

function isContained(instruction: string) {
  if (/^https?:\/\//.test(instruction) || instruction.startsWith("~") || path.isAbsolute(instruction)) return false
  return !path.normalize(instruction).startsWith("..")
}

function partition(
  value: unknown,
  isText: (input: Record<string, unknown>) => boolean,
  label: (name: string) => string,
) {
  const entries = Object.entries(isRecord(value) ? value : {})
  const text = entries.filter((entry) => isRecord(entry[1]) && isText(entry[1]))
  const held = entries.filter((entry) => !text.includes(entry)).map((entry) => label(entry[0]))
  return { text: Object.fromEntries(text), held }
}

/**
 * Splits one project config document into what takes effect while the folder is untrusted and what waits for a person.
 * The list of kept keys is closed: anything else, under any spelling, does nothing until the folder is trusted.
 */
export function keep(raw: unknown, source: string) {
  const kept: Record<string, unknown> = {}
  const held: string[] = []
  for (const [key, value] of Object.entries(isRecord(raw) ? raw : {})) {
    if (keptKeys.has(key)) {
      kept[key] = value
      continue
    }
    if (ignoredKeys.has(key)) continue
    if ((key === "formatter" || key === "lsp") && value === false) {
      kept[key] = value
      continue
    }
    if (key === "snapshot" || key === "snapshots") {
      if (value === false) held.push("Turn off undo")
      continue
    }
    if (key === "instructions") {
      const list = asArray(value).filter((item): item is string => typeof item === "string")
      const contained = list.filter(isContained)
      if (contained.length) kept.instructions = contained
      held.push(...list.filter((item) => !isContained(item)).map((item) => `Read instructions from ${item}`))
      continue
    }
    if (key === "agent" || key === "agents" || key === "mode") {
      const split = partition(value, isTextAgent, (name) => `Change what agent "${name}" may do`)
      if (Object.keys(split.text).length) kept[key] = split.text
      held.push(...split.held)
      continue
    }
    if (key === "command" || key === "commands") {
      const split = partition(value, isTextCommand, (name) => `Add command "/${name}" that can run programs`)
      if (Object.keys(split.text).length) kept[key] = split.text
      held.push(...split.held)
      continue
    }
    held.push(...(labels[key]?.(value) ?? []))
  }
  return { kept, held: held.map((label): Item => ({ label, source })) }
}

function read(file: string) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function configItems(file: string) {
  const text = read(file)
  if (!text) return []
  return [
    ...keep(parse(text, [], { allowTrailingComma: true }), file).held,
    ...(/\{(env|file):[^}]+\}/.test(text)
      ? [{ label: "Read your environment variables or files into its settings", source: file }]
      : []),
  ]
}

function tuiItems(file: string) {
  const text = read(file)
  if (!text) return []
  const raw: unknown = parse(text, [], { allowTrailingComma: true })
  const flat = isRecord(raw) && isRecord(raw.tui) ? { ...raw.tui, ...raw } : raw
  const plugins = isRecord(flat) ? asArray(flat.plugin) : []
  return plugins.map((item): Item => ({ label: pluginLabel(item), source: file }))
}

function markdownItems(pattern: string, directory: string, label: (file: string) => string, isText: (file: string) => boolean) {
  return Glob.scanSync(pattern, { cwd: directory, absolute: true, dot: true, symlink: true })
    .filter((file) => !isText(file))
    .map((file): Item => ({ label: label(file), source: file }))
}

function frontmatter(file: string, body: string) {
  const parsed = ConfigMarkdown.parseOption(read(file) ?? "")
  if (!parsed) return { [body]: "" } as Record<string, unknown>
  return { ...parsed.data, [body]: parsed.content.trim() } as Record<string, unknown>
}

function folderItems(directory: string): Item[] {
  const code = (pattern: string, label: string) =>
    Glob.scanSync(pattern, { cwd: directory, absolute: true, dot: true, symlink: true }).map(
      (file): Item => ({ label: `${label} ${path.basename(file)}`, source: file }),
    )
  const base = (file: string) => path.basename(file, ".md")
  return [
    ...code("{plugin,plugins}/*.{ts,js}", "Load plugin"),
    ...code("{tool,tools}/*.{ts,js}", "Add tool"),
    ...markdownItems(
      "{agent,agents}/**/*.md",
      directory,
      (file) => `Change what agent "${base(file)}" may do`,
      (file) => isTextAgent(frontmatter(file, "prompt")),
    ),
    ...markdownItems(
      "{mode,modes}/*.md",
      directory,
      (file) => `Change what agent "${base(file)}" may do`,
      (file) => isTextAgent(frontmatter(file, "prompt")),
    ),
    ...markdownItems(
      "{command,commands}/**/*.md",
      directory,
      (file) => `Add command "/${base(file)}" that can run programs`,
      (file) => isTextCommand(frontmatter(file, "template")),
    ),
    ...skillItems(path.join(directory, "{skill,skills}/**/SKILL.md")),
  ]
}

function skillItems(pattern: string) {
  return Glob.scanSync(pattern, { absolute: true, dot: true, symlink: true })
    .filter((file) => !isTextSkill(read(file) ?? ""))
    .map((file): Item => ({ label: `Add skill "${path.basename(path.dirname(file))}" that can run programs`, source: file }))
}

function levels(directory: string) {
  const result: string[] = []
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    result.push(current)
    if (exists(path.join(current, ".git")) || path.dirname(current) === current) return result
  }
}

function gitConfigText(root: string) {
  const dotGit = path.join(root, ".git")
  const direct = read(path.join(dotGit, "config"))
  if (direct !== undefined) return direct
  // A linked worktree: .git is a file that names its git directory, and the config is in the common one.
  const named = /^gitdir:\s*(.+)$/m.exec(read(dotGit) ?? "")?.[1]?.trim()
  if (!named) return undefined
  const gitDir = path.resolve(root, named)
  const common = read(path.join(gitDir, "commondir"))?.trim()
  return read(path.join(common ? path.resolve(gitDir, common) : gitDir, "config"))
}

/** The first setting in this repository's own git config not known to run nothing, while nobody has trusted the folder. */
export function heldGitSetting(directory: string) {
  if (isTrusted(directory)) return undefined
  return gitSetting(rootOf(directory))
}

function gitSetting(root: string) {
  const text = gitConfigText(root)
  return text === undefined ? undefined : programSetting(text)
}

/** Everything at project level that would run code or loosen a rule, read fresh from disk, in plain words. */
export function scan(directory: string): Item[] {
  if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) return []
  const found = levels(directory).flatMap((level) => {
    const folder = path.join(level, ".swarm")
    return [
      ...["swarm.jsonc", "swarm.json"].flatMap((name) => atProject(path.join(level, name), configItems)),
      ...["tui.jsonc", "tui.json"].flatMap((name) => atProject(path.join(level, name), tuiItems)),
      ...(exists(folder) && !isUserLevel(folder)
        ? [
            ...["swarm.jsonc", "swarm.json"].flatMap((name) => configItems(path.join(folder, name))),
            ...["tui.jsonc", "tui.json"].flatMap((name) => tuiItems(path.join(folder, name))),
            ...folderItems(folder),
          ]
        : []),
      ...[".claude", ".agents"].flatMap((name) =>
        isUserLevel(path.join(level, name)) ? [] : skillItems(path.join(level, name, "skills/**/SKILL.md")),
      ),
    ]
  })
  const setting = gitSetting(rootOf(directory))
  const all = setting
    ? [...found, { label: `Let git use its own setting ${setting}`, source: path.join(rootOf(directory), ".git/config") }]
    : found
  const seen = new Set<string>()
  return all.filter((item) => {
    if (seen.has(item.label)) return false
    seen.add(item.label)
    return true
  })
}

function atProject(file: string, items: (file: string) => Item[]) {
  return isUserLevel(file) ? [] : items(file)
}
