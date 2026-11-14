// Part of the autonomy table (R-1, 1.2.8): Outward push, send and fetch, MCP calls, credential changes and deletion words.
// Moved unchanged from `autonomy-table.ts`, which re-exports the public names; import from there, not from here.
import fs from "node:fs"
import path from "node:path"
import { McpCatalog } from "../../mcp/catalog"
import { OutwardKnown } from "../outward-known"
import { OutwardConsent } from "../outward-consent"
import { GitGuard } from "../../tool/git-guard"
import { Reach } from "../../tool/reach"
import { Risk } from "../../tool/risk"
import { DeletionWords, type Deletion } from "../../tool/deletion"
import { held, refused, type Input, type Outward, type Verdict } from "./types"
import { unwrapped } from "./read-class"
import { homeWords, nearLibrary, within } from "./outside"
import { OUTPUT_TAIL, canRunIn, noRepositoryBetween, safePath } from "./routine"
// U11 rule 3. Something leaves the machine without a person only for a destination the person named in the mission and
// ticked, matched by code against what the gate passes in. No model judges "part of the mission": the agent writes the
// command and repository text can shape where it points. Every other way out waits for a person as `outward_not_in_mission`.
// 1.1.0's push flags; narrower than P42's (`OutwardConsent.pushWords`) on purpose, so 1.1.0 is unchanged (n63).
const PUSH_FLAGS = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose"])
const REF = OutwardConsent.REF
const RCLONE_FLAGS = new Set(["-P", "--progress", "-v", "--verbose", "--ignore-existing", "-n", "--dry-run"])
// `-e`, `--rsh`, `--rsync-path`, `-o` and `-S` run a program; `--delete` and `--remove-source-files` remove. None is here.
const SCP_FLAGS = new Set(["-p", "-q", "-C"])
const RSYNC_FLAGS = /^-[avzhPtpqc]+$|^--(progress|partial|verbose|archive|compress|times|checksum)$/
const SSH_TARGET = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.*)$/

/**
 * The repository and remote of a plain `git push <remote> [<ref>...]`, as the snapshot taken before the mode knew them, or
 * undefined. The gate runs `OutwardKnown.recheck` on what this returns. A raw URL, a remote added since, a push with no
 * remote named, or a `.git` made between the folder and that repository gives nothing.
 */
export function pushTarget(input: Pick<Input, "metadata" | "cwd">, snapshot: OutwardKnown.Snapshot) {
  const command = input.metadata.command
  const words = typeof command === "string" ? Risk.plainWords(unwrapped(command)) : undefined
  if (!words || words[0] !== "git" || words[1] !== "push") return
  const [remote, ...refs] = words.slice(2).filter((word) => !PUSH_FLAGS.has(word))
  if (!remote || !REF.test(remote) || refs.some((ref) => ref.split(":").length > 2 || !ref.split(":").every((part) => REF.test(part) && !part.includes(".."))))
    return
  const here = Reach.real(input.cwd)
  if (here === undefined) return
  const repo = snapshot.repos.filter((item) => within(item.dir, here)).toSorted((a, b) => b.dir.length - a.dir.length)[0]
  if (!repo || !noRepositoryBetween(here, repo.dir) || !repo.remotes.some((item) => item.name === remote)) return
  return { repo: repo.dir, remote }
}

export function classifyPush(input: Input): Verdict {
  const outward = input.outward
  const target = outward?.snapshot && canRunIn(input.cwd, input.instance) ? pushTarget(input, outward.snapshot) : undefined
  // The repository's own hooks and config run with the push, so it has to be one the guard can vouch for.
  if (!outward || !target || GitGuard.inspect(target.repo).refused !== undefined) return held("outward_not_in_mission")
  const check = outward.recheck
  if (!check || check.repo !== target.repo || check.remote !== target.remote || !check.result.ok) return held("outward_not_in_mission")
  return sentTo(input, (destination) => destination.kind === "git" && destination.repo === target.repo && destination.remote === target.remote)
}

/**
 * A copy off the machine through the shell: `rclone copy`, `scp` or `rsync` of files in the folder, or `cp` of one to a new
 * name on a mounted drive (G2). Undefined when the command is none of these, so the other rules judge it. A `cp` that does
 * not land on a ticked drive is left to rule 1, which refuses writing out there.
 */
export function classifySend(command: string, input: Input): Verdict | undefined {
  const words = homeWords(command.replace(OUTPUT_TAIL, ""))
  if (!words) return undefined
  if (words[0] === "cp") return driveCopy(words, input)
  if (words[0] !== "rclone" && words[0] !== "scp" && words[0] !== "rsync") return undefined
  if (!canRunIn(input.cwd, input.instance)) return held("outward_not_in_mission")
  const match = words[0] === "rclone" ? rcloneTo(words, input) : sshTo(words, input)
  return match ? sentTo(input, match) : held("outward_not_in_mission")
}

/** `rclone copy|copyto <file> <remote>:<path>`. `sync` makes the far side match, which removes there, so it waits. */
function rcloneTo(words: readonly string[], input: Input) {
  if (words[1] !== "copy" && words[1] !== "copyto") return
  const args = words.slice(2)
  const names = args.filter((word) => !word.startsWith("-"))
  if (names.length !== 2 || args.some((word) => word.startsWith("-") && !RCLONE_FLAGS.has(word))) return
  const name = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):/.exec(names[1]!)?.[1]
  if (!name || !localFiles([names[0]!], input)) return
  return (destination: OutwardKnown.Destination) => destination.kind === "rclone" && destination.name === name
}

/** `scp|rsync <file>... <user>@<host>:<path>`, to the login the person wrote with ssh, scp or rsync. */
function sshTo(words: readonly string[], input: Input) {
  const args = words.slice(1)
  const allowed = (word: string) => (words[0] === "scp" ? SCP_FLAGS.has(word) : RSYNC_FLAGS.test(word))
  const names = args.filter((word) => !word.startsWith("-"))
  if (names.length < 2 || args.some((word) => word.startsWith("-") && !allowed(word))) return
  const target = SSH_TARGET.exec(names.at(-1)!)
  if (!target || !localFiles(names.slice(0, -1), input)) return
  const user = target[1]!
  const host = target[2]!.toLowerCase()
  return (destination: OutwardKnown.Destination) => destination.kind === "ssh" && destination.user === user && destination.host === host
}

/** Regular files in the folder that are neither secret nor sensitive. A folder is not walked here, so it waits. */
function localFiles(names: readonly string[], input: Input) {
  return names.every((name) => {
    if (name.includes(":")) return false
    const file = path.resolve(input.cwd, name)
    const target = Reach.real(file)
    return (
      target !== undefined &&
      Reach.inside(file, input.instance) &&
      Reach.readable(file) &&
      !Reach.secret(file) &&
      !Reach.sensitive(file, input.instance) &&
      fs.statSync(target, { throwIfNoEntry: false })?.isFile() === true
    )
  })
}

/** `cp [-p] <file in the folder> <new name on a ticked drive>`: a new file only, nothing over one that is there (G2). */
function driveCopy(words: readonly string[], input: Input): Verdict | undefined {
  const args = words.slice(1)
  const names = args.filter((word) => !word.startsWith("-"))
  if (names.length !== 2 || args.some((word) => word.startsWith("-") && word !== "-p") || names[1]!.split("/").includes("..")) return
  const target = path.resolve(input.cwd, names[1]!)
  const into = Reach.real(path.dirname(target))
  const given = input.outward?.allowed.find(
    ({ destination }) => destination.kind === "drive" && into !== undefined && within(Reach.real(destination.path) ?? destination.path, into),
  )
  if (!given || into === undefined || Reach.inside(target, input.instance) || nearLibrary([target])) return
  if (fs.lstatSync(target, { throwIfNoEntry: false }) || fs.statSync(into, { throwIfNoEntry: false })?.isDirectory() !== true) return
  if (!canRunIn(input.cwd, input.instance) || !localFiles([names[0]!], input)) return
  return sent(given)
}

/** `webfetch` of a URL on a host the person wrote. A search goes to a provider nobody named, so it waits. */
export function classifyFetch(input: Input): Verdict {
  const url = input.metadata.url
  if (input.permission !== "webfetch" || typeof url !== "string" || !input.patterns.every((pattern) => pattern === url))
    return held("outward_not_in_mission")
  const host = URL.canParse(url) ? new URL(url) : undefined
  if (!host || (host.protocol !== "https:" && host.protocol !== "http:")) return held("outward_not_in_mission")
  return sentTo(input, (destination) => destination.kind === "host" && destination.host === host.hostname.toLowerCase())
}

function sentTo(input: Input, match: (destination: OutwardKnown.Destination) => boolean): Verdict {
  const given = input.outward?.allowed.find((item) => match(item.destination))
  return given ? sent(given) : held("outward_not_in_mission")
}

const sent = (given: Outward["allowed"][number]): Verdict => ({
  class: "A",
  decidedBy: "gate",
  via: "outward",
  consentID: given.id,
  destination: OutwardKnown.label(given.destination),
})

/**
 * U11 rules 5 and 7, for a tool of an MCP server. Its request says which server, how it is reached, and whose config set it
 * up (`session/tools.ts`); anything else said there is read as the stricter case. A local server from the user's own config,
 * or from the project's in a folder a person approved, runs on record. A project's server in a folder nobody approved is code
 * nobody has looked at. A remote one takes what it is sent off the machine, so it is a way out like any other (G4, rule 3).
 */
/** The shipped MCP servers that only read (C100): the plan agent may call their tools. */
const READ_ONLY_SERVERS = new Set(["swarm-web", "graft"])

/** A tool of a read-only server, by its name as well, so a request cannot borrow such a server's source. */
export function readOnlyServer(input: Input, mcp: Readonly<Record<string, unknown>>) {
  return (
    typeof mcp.server === "string" &&
    READ_ONLY_SERVERS.has(mcp.server) &&
    input.permission.startsWith(McpCatalog.toolName(mcp.server, ""))
  )
}

export function classifyMcp(input: Input, mcp: Readonly<Record<string, unknown>>): Verdict {
  // A tool is named after its server, so a request cannot borrow another server's source.
  if (typeof mcp.server !== "string" || !input.permission.startsWith(McpCatalog.toolName(mcp.server, ""))) return held("external_tool")
  if (mcp.origin !== "global" && input.folder !== "clean" && input.folder !== "trusted") return held("folder_not_trusted")
  // Rule 3 lets a way out through only to a destination it can match, and the source names the server, not its host.
  if (mcp.transport !== "local") return held("outward_not_in_mission")
  return { class: "A", decidedBy: "gate", category: "mcp_tool" }
}

// U11 rule 3: while the mode is on, nothing may change where a push goes or who it goes as, so the snapshot a person
// consented over stays true. Read on every piece of the command and with quotes dropped, since a refusal that a spelling
// slips past would leave it held for a person at best. Looking (`git remote -v`, `git remote get-url`) is not a change.
const REMOTE_CHANGES = new Set(["add", "set-url", "rename", "remove", "rm", "set-head", "set-branches"])
// `include.*` pulls a remote in from another file; `http.*.extraHeader`, `core.sshCommand` and `core.askPass` pick the
// credential a push goes with.
const CREDENTIAL_KEY = /^(remote|url|credential|include|includeif)\.|^http\..*extraheader$|^core\.(sshcommand|askpass)$/i
// Environment that gives git or `gh` another config, credential or account for the command it is set on.
const CREDENTIAL_ENV = /^(GIT_CONFIG|GIT_ASKPASS|GIT_SSH|SSH_ASKPASS|GH_|GITHUB_TOKEN)/
const COMMAND_WRAPPERS = new Set(["rtk", "command", "builtin", "exec", "env", "nohup", "time", "nice", "sudo", "doas", "xargs"])
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"])
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec"])
const RAW_URL = /:\/\/|^[^/:\s]+@[^:\s]+:|^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+:/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

export function changesCredentials(input: Input) {
  const command = input.metadata.command
  if (typeof command !== "string") return false
  return command
    .split(/&&|\|\||\$\(|[;&|\n()`{}]/)
    .map((piece) => piece.replace(/["'\\]/g, "").trim().split(/\s+/).filter(Boolean))
    .some((words) => pieceChangesCredentials(words, input.outward?.snapshot))
}

function pieceChangesCredentials(words: readonly string[], snapshot: OutwardKnown.Snapshot | undefined) {
  const start = words.findIndex((word, index) => {
    if (ASSIGNMENT.test(word)) return false
    if (COMMAND_WRAPPERS.has(word)) return false
    // A wrapper's own flags, such as `env -i` or `nice -n 5`.
    return !(index > 0 && COMMAND_WRAPPERS.has(words[index - 1]!) && word.startsWith("-"))
  })
  const head = start < 0 ? words : words.slice(0, start)
  if (head.some((word) => ASSIGNMENT.test(word) && CREDENTIAL_ENV.test(word))) return true
  if (start < 0) return false
  const name = words[start]!.split("/").at(-1)!
  const args = words.slice(start + 1)
  if (name === "export") return args.some((word) => CREDENTIAL_ENV.test(word))
  if (name === "gh") return args[0] === "auth"
  if (name !== "git") return false
  const configs: string[] = []
  let index = 0
  while (args[index]?.startsWith("-")) {
    const option = args[index]!
    if (option === "-c" || option === "--config-env") configs.push(args[index + 1] ?? "")
    if (option.startsWith("-c") && option.length > 2) configs.push(option.slice(2))
    if (option.startsWith("--config-env=")) configs.push(option.slice("--config-env=".length))
    index += GIT_VALUE_OPTIONS.has(option) ? 2 : 1
  }
  if (configs.some((value) => CREDENTIAL_KEY.test(value.split("=")[0]!))) return true
  const [sub, ...rest] = args.slice(index)
  if (sub === "remote") return REMOTE_CHANGES.has(rest[0] ?? "")
  if (sub === "credential" || sub?.startsWith("credential-")) return true
  if (sub === "config")
    return rest.some((word) => word === "-e" || Risk.abbreviates(word, ["--edit"]) || (!word.startsWith("-") && CREDENTIAL_KEY.test(word.split("=")[0]!)))
  if (sub === "push") return pushesToRawUrl(rest, snapshot)
  return false
}

/** `git push <url>` or `--repo=<url>` with a URL that is none of the push URLs the snapshot holds. */
function pushesToRawUrl(args: readonly string[], snapshot: OutwardKnown.Snapshot | undefined) {
  // 1.1.1 F10a (G3-1): git takes `--repo` by any shortening of it too.
  const isRepo = (word: string) => Risk.abbreviates(word, ["--repo"])
  const repo = args.flatMap((word, index) =>
    isRepo(word) ? (word.includes("=") ? [word.slice(word.indexOf("=") + 1)] : [args[index + 1] ?? ""]) : [],
  )
  const positional = args.find((word, index) => !word.startsWith("-") && !PUSH_VALUE_OPTIONS.has(args[index - 1] ?? "") && !isRepo(args[index - 1] ?? ""))
  return [...repo, ...(positional ? [positional] : [])].some(
    (target) =>
      RAW_URL.test(target) && !(snapshot !== undefined && snapshot.repos.some((item) => OutwardKnown.pushTarget(snapshot, item.dir, target))),
  )
}

// U11 rule 4. The program, the flags and the paths are read as the shell reads them (`tool/deletion.ts`): a plain deletion
// the table lets through must be one the shell moves, never one it runs.
// One command of words nothing rewrites: bare words the shell takes as written, single quotes, and double quotes without
// `$`, backquotes, `\` or `!`, with spaces between, so the text the shell parses is one command and nothing else.
const PLAIN_DELETE_WORD = /[\w./@%+:,-][\w./@%+:,=-]*|'[^']*'|"[^"$`\\!]*"/
export const PLAIN_DELETION = new RegExp(`^(?:${PLAIN_DELETE_WORD.source})(?: +(?:${PLAIN_DELETE_WORD.source}))*$`)
const unquoteWord = (word: string) => (/^(['"]).*\1$/s.test(word) && word.length >= 2 ? word.slice(1, -1) : word)

/**
 * The commands of a text, as words, roughly as a shell would find them: split at `;`, `&`, `|`, newlines, brackets and
 * command substitution outside single quotes. It only has to find a deletion wherever one could run; what it lets through
 * as plain is decided by `PLAIN_DELETION` alone.
 */
export function commandWords(command: string) {
  const pieces: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote === "'") {
      current += char
      if (char === "'") quote = undefined
      continue
    }
    const opens = char === "`" || (char === "$" && command[index + 1] === "(")
    if (quote === '"') {
      if (char === "\\") {
        current += char + (command[++index] ?? "")
        continue
      }
      if (char === '"') quote = undefined
      if (opens || char === ")") {
        pieces.push(current)
        current = ""
        if (char === "$") index++
        continue
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === "\\") {
      current += char + (command[++index] ?? "")
      continue
    }
    if (opens || /[;&|\n\r()]/.test(char) || ((char === "{" || char === "}") && /(^|\s)$/.test(current))) {
      pieces.push(current)
      current = ""
      if (char === "$") index++
      continue
    }
    current += char
  }
  pieces.push(current)
  return pieces.map((piece) => piece.trim().split(/\s+/).filter(Boolean).map(unquoteWord)).filter((words) => words.length > 0)
}

/** The paths of a plain deletion whose flags the shell knows, or undefined, which the shell refuses as `compound`. */
function deletionPaths(name: Deletion["name"], words: readonly string[]) {
  return DeletionWords.deletionFlags(name, words)?.paths
}

/**
 * U11 rule 4. In autonomous mode the shell runs no deletion: `rm`, `rmdir`, `unlink` or `git rm` alone, with literal paths
 * and flags it knows, has its paths moved to the archive, and any other text that deletes is refused with the register's
 * text. So a plain one of safe paths in the folder is class A `archived`, since code only moves and a person empties, and
 * any other deletion is X `delete_compound`. A plain one naming a path that is not safe here (beyond the folder, a secret,
 * the folder itself, the archive under `.swarm`) is left to the rules below, which hold it. `find -delete` and a script that
 * deletes name no deletion program, so they stay held as before. A plain one is `archived` only when the shell said it moves
 * it (`metadata.archive`, row 113): PowerShell, cmd or Windows would run it, so without that it is D `not_reversible`.
 */
export function classifyDeletion(input: Input): Verdict | undefined {
  const command = input.metadata.command
  if (typeof command !== "string") return undefined
  if (!commandWords(command).some((words) => DeletionWords.deletes(words))) return undefined
  // A name with a line break, a control or a bidi mark in it is no plain line for anyone to read: the rules below hold it.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command.trim())) return undefined
  const text = command.trim()
  if (!PLAIN_DELETION.test(text)) return refused("delete_compound")
  // The program's own name as written: the shell takes no quoted name for one it moves.
  const raw = text.match(new RegExp(PLAIN_DELETE_WORD.source, "g")) ?? []
  const name: Deletion["name"] | undefined =
    raw[0] === "git" && raw[1] === "rm"
      ? "git rm"
      : raw[0] === "rm" || raw[0] === "rmdir" || raw[0] === "unlink"
        ? raw[0]
        : undefined
  const paths = name && deletionPaths(name, raw.slice(name === "git rm" ? 2 : 1).map(unquoteWord))
  if (!paths) return refused("delete_compound")
  if (!canRunIn(input.cwd, input.instance)) return undefined
  const roots = [input.cwd, input.instance.directory, input.instance.worktree].map((root) => Reach.real(root))
  const safe = paths.every(
    (word) => safePath(word, input.cwd, input.instance) && !roots.includes(Reach.real(path.resolve(input.cwd, word))),
  )
  if (!safe) return undefined
  // Only the shell knows it will move instead of run (a POSIX shell it parsed, with the mode on). Without its word the
  // command would delete for good, which this mode never lets happen unseen: a person decides.
  return input.metadata.archive === true ? { class: "A", decidedBy: "gate", category: "archived" } : held("not_reversible")
}
