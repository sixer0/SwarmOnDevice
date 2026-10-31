import { Effect, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@opencode-ai/core/shell"
import { ShellID } from "./shell/id"
import { ShellOrphans } from "./shell/orphans"

import * as Truncate from "./truncate"
import { condense } from "./condense"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { Risk } from "./risk"
import { Reach } from "./reach"
import { Secrets } from "./secrets"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
// Shown from the start of an output that gets cut. Setup failures print there, and the rest of the budget goes to the end.
const HEAD_BYTES = 4 * 1024
const SHELL_MAX_BYTES = 24 * 1024
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
  harmless: Set<string>
  risk?: Risk.Risk
  /** Secret files the command names, so what it prints from them can be recognised. */
  secretFiles: Set<string>
  /** Set when it reshapes one of them, because a secret cut into pieces or re-encoded can no longer be recognised. */
  withheld?: string
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

// Unless `tool_output` says otherwise. Commands are the largest thing that enters a run, and whatever enters is paid for
// again on every later step. The full output is always saved, and the agent can search it for what it needs.
function shellLimits(limits: { maxLines: number; maxBytes: number }) {
  return { ...limits, maxBytes: limits.maxBytes === Truncate.MAX_BYTES ? SHELL_MAX_BYTES : limits.maxBytes }
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

// What a command is allowed to be made of before anything in it is taken at face value. Everything else, such as a group,
// a subshell, a loop, an expansion or a heredoc, means the arguments the parser sees are not what the shell will use.
const UNDERSTOOD = new Set([
  "program",
  "comment",
  "command",
  "command_name",
  "word",
  "number",
  "string",
  "string_content",
  "raw_string",
  "concatenation",
  "list",
  "pipeline",
  "redirected_statement",
  "file_redirect",
  "file_descriptor",
])

function understood(node: Node): boolean {
  if (!UNDERSTOOD.has(node.type) || node.isError || node.isMissing) return false
  return node.namedChildren.every((child) => child !== null && understood(child))
}

// The shell rewrites these before the command sees them: globs, braces, escapes, `~user`, and quotes inside a word.
const REWRITTEN = /[*?[\]{}\\"'`$]|^~[^/]/

function literal(part: { type: string; text: string }) {
  if (part.type === "string" || part.type === "raw_string") return !/[$`]/.test(part.text) || part.type === "raw_string"
  if (part.type === "number") return true
  return part.type === "word" && !REWRITTEN.test(part.text)
}

/** Every redirect in the command, wherever it sits, and whether each is one this file can vouch for. */
function redirectsIn(root: Node) {
  const writes: string[] = []
  const reads: string[] = []
  const loose: string[] = []
  let unproven = false
  for (const redirect of root.descendantsOfType("file_redirect")) {
    if (!redirect) continue
    const destinations = redirect.childrenForFieldName("destination").filter((node) => node !== null)
    const destination = destinations[0]
    // `echo x > a b` passes `b` to echo, and the grammar files it under the redirect.
    if (destinations.length !== 1 || !destination) {
      unproven = true
      continue
    }
    const operator = redirect.text.slice(0, destination.startIndex - redirect.startIndex).trim()
    const owner = redirect.parent
    const plain =
      owner?.type === "command" ||
      (owner?.type === "redirected_statement" && owner.childForFieldName("body")?.type === "command")
    if (!plain) loose.push((owner ?? redirect).text.trim())
    // `2>&1` and `>&-` move a stream and name no file.
    if (/[<>]&$/.test(operator) && /^(\d+|-)$/.test(destination.text)) continue
    if (!literal({ type: destination.type, text: destination.text })) {
      unproven = true
      continue
    }
    const target = unquote(destination.text)
    if (target === "/dev/null") continue
    if (operator.includes(">")) writes.push(target)
    else reads.push(target)
  }
  return { writes, reads, loose, unproven }
}

// These change the shape of what they read, so no search for the value would find it in their output.
const RESHAPES = new Set([
  "cut", "jq", "yq", "sed", "awk", "gawk", "tr", "rev", "base64", "base32", "xxd", "od", "hexdump", "strings", "fold",
  "openssl", "iconv", "gzip", "zip", "tar",
])
const INLINE_CODE = new Set(["python", "python3", "node", "bun", "deno", "ruby", "perl", "php", "sh", "bash", "zsh"])

function reshapes(tokens: string[]) {
  const name = tokens[0]
  if (!name) return false
  const args = tokens.slice(1)
  if (RESHAPES.has(name)) return true
  if (name === "grep" || name === "rg") return args.some((arg) => /^(-[a-zA-Z]*o|--only-matching)/.test(arg))
  if (name === "head" || name === "tail") return args.some((arg) => /^(-c|--bytes)/.test(arg))
  return INLINE_CODE.has(name) && args.some((arg) => /^-[a-zA-Z]*[ce]/.test(arg))
}

const WORD_BREAK = /[\s'"|;&<>()=,:]+/

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan, input: { command: string }) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: scan.risk ? [] : globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
        ...(scan.risk ? { risk: scan.risk } : {}),
      },
    })
  }

  if (scan.harmless.size > 0)
    yield* ctx.ask({
      permission: ShellID.ToolID,
      patterns: Array.from(scan.harmless),
      always: [],
      metadata: { command: input.command },
      harmless: true,
    })

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    // "Allow always" on something Undo cannot take back would approve the next, different, one.
    always: scan.risk ? [] : Array.from(scan.always),
    metadata: {
      command: input.command,
      ...(scan.risk ? { risk: scan.risk } : {}),
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
      trust: Tool.Context["trust"],
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
        harmless: new Set<string>(),
        secretFiles: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))
      // A changed directory, variable or function means no argument here can be taken at face value.
      const posix = Boolean(trust) && !ps && shellKind !== "cmd"
      const redirects = ps ? { writes: [], reads: [], loose: [], unproven: false } : redirectsIn(root)
      const proven = !ps && understood(root)
      const uncertain =
        !posix || !proven || redirects.unproven || commands(root).some((node) => CWD.has(node.firstChild?.text ?? ""))
      const absolute = (file: string) => path.resolve(cwd, home(file))

      const judge = Effect.fn("ShellTool.judge")(function* (command: Part[], tokens: string[]) {
        const verdict = Risk.classify(tokens.map(unquote))
        if (verdict.kind === "risky" || verdict.kind === "unknown" || uncertain) {
          return verdict.kind === "risky" ? verdict : ({ kind: "unknown" } as const)
        }
        const prints = tokens[0] === "echo" || tokens[0] === "printf" || tokens[0] === "sleep"
        if (!prints && !command.slice(1).every((part) => part.text.startsWith("-") || literal(part)))
          return { kind: "unknown" } as const
        const removes = verdict.kind === "undoable" && verdict.removes
        const changed = [...(verdict.kind === "undoable" ? verdict.paths : []), ...redirects.writes].map(absolute)
        const lost = { kind: "risky", risk: "irreversible" } as const
        for (const file of [...verdict.paths, ...redirects.reads, ...redirects.writes].map(absolute)) {
          // Reached through a symlink, the name says nothing about where this lands, and the snapshot does not go there.
          if (!containsPath(file, instance) || !Reach.inside(file, instance)) return removes ? lost : ({ kind: "unknown" } as const)
          if (changed.includes(file) && Reach.sensitive(file, instance)) return removes ? lost : ({ kind: "unknown" } as const)
        }
        const repository = tokens[0] === "git"
        if (repository && (yield* Effect.promise(() => Reach.hasGitPrograms(cwd)))) return { kind: "unknown" } as const
        if (verdict.kind === "harmless" && changed.length === 0) return { kind: "harmless" } as const
        if (!trust?.canUndo) return { kind: "unknown" } as const
        if (verdict.kind === "undoable" && verdict.hooks) {
          const names = verdict.hooks === true ? undefined : verdict.hooks
          if (yield* Effect.promise(() => Reach.hasGitHooks(cwd, names))) return { kind: "unknown" } as const
        }
        const untrackedOnly = verdict.kind === "undoable" && verdict.untrackedOnly
        if (changed.length > 0 && (yield* Effect.promise(() => Reach.outsideSnapshot(instance.worktree, changed, { untrackedOnly }))))
          return lost
        if (changed.some(Secrets.secretFile)) return { kind: "unknown" } as const
        return { kind: "harmless" } as const
      })

      const named = new Set(redirects.reads.filter(Secrets.secretFile).map(absolute))
      let reshaped = false
      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]
        if (!ps) {
          const plain = tokens.map(unquote)
          reshaped = reshaped || reshapes(plain)
          for (const word of plain.slice(1).flatMap((token) => token.split(WORD_BREAK)))
            if (word && Secrets.secretFile(word)) named.add(absolute(word))
        }

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          const verdict = posix ? yield* judge(command, tokens) : undefined
          if (verdict?.kind === "harmless") {
            scan.harmless.add(source(node))
            continue
          }
          if (verdict?.kind === "risky") scan.risk = scan.risk === "irreversible" ? scan.risk : verdict.risk
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      // A redirect on a whole group belongs to no one command, and "allow echo" does not stretch to where this one writes.
      if (scan.patterns.size > 0 || scan.harmless.size === 0) redirects.loose.forEach((text) => scan.patterns.add(text))
      // Nothing was recognised as a command, such as `[[ -f x ]]` or `x=1`, so nothing has been judged.
      if (posix && !proven && scan.patterns.size === 0 && scan.harmless.size === 0) {
        const whole = root.text.trim()
        if (whole) scan.patterns.add(whole)
      }
      scan.secretFiles = named
      if (reshaped && named.size > 0) scan.withheld = path.relative(instance.worktree, [...named][0]!)

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        withheld?: string
      },
      ctx: Tool.Context,
    ) {
      const limits = shellLimits(yield* trunc.limits())
      const keep = limits.maxBytes * 2
      let head = ""
      let dropped = false
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      const root = (yield* InstanceState.context).worktree
      yield* ctx.metadata({
        metadata: {
          output: "",
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))
          // Windows commands are not in a group of their own here, so there is nothing to end later.
          if (process.platform !== "win32") {
            const pid = Number(handle.pid)
            yield* Effect.try({ try: () => ShellOrphans.record(ctx.sessionID, pid), catch: String }).pipe(
              Effect.catch((error) => Effect.logWarning("could not record running command", { error })),
            )
            yield* Effect.addFinalizer(() =>
              Effect.try({ try: () => ShellOrphans.clear(ctx.sessionID, pid), catch: String }).pipe(Effect.ignore),
            )
          }

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              if (input.withheld) return Effect.void
              const size = Buffer.byteLength(chunk, "utf-8")
              if (head.length < HEAD_BYTES) head += chunk
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                dropped = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: Secrets.scrub(last, root),
                        },
                      }),
                    ),
                  )
                }
              }

              // Shown and stored while the command runs, before the final result gets its own pass.
              return ctx.metadata({
                metadata: {
                  output: Secrets.scrub(last, root),
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const condensed = condense({ text: raw, command: input.command })
      const whole = tail(condensed.text, limits.maxLines, limits.maxBytes)
      // Saving a large output to a file along the way is not a cut: what matters is whether the agent sees all of it.
      cut = dropped || whole.cut
      // What was hidden stays one read away, so nothing the agent might need is gone.
      if (!file && (cut || condensed.hidden > 0)) file = yield* trunc.write(raw)

      let output = whole.text || "(no output)"
      if (cut) {
        const shown = condense({ text: head, command: input.command }).text.slice(0, HEAD_BYTES)
        const opening = shown.slice(0, Math.max(shown.lastIndexOf("\n"), 0))
        const end = tail(condensed.text, limits.maxLines, limits.maxBytes - HEAD_BYTES).text
        output = `${opening ? opening + "\n\n" : ""}...output truncated...\n\nFull output saved to: ${file}\n\n${end}`
      }
      if (input.withheld)
        output = `[hidden: output withheld. This command reshapes ${input.withheld}, a file that holds secrets, so the values in its output could not be recognised and hidden. Programs you run can still read the file. Do not try to get the same values another way.]`
      if (!cut && condensed.hidden > 0) output += `\n\n(${condensed.hidden} similar lines hidden. Full output saved to: ${file})`

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(file && (cut || condensed.hidden > 0) ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = shellLimits(yield* trunc.limits())
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              const scanned = yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx, ctx.trust)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                  return scan
                }),
              )
              scanned.secretFiles.forEach(Secrets.learnFile)

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  withheld: scanned.withheld,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
