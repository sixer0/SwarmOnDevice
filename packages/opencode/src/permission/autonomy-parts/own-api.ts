// Part of the autonomy table (R-1, 1.2.8): Calls to Swarm's own server: loopback names, person-only routes, curl/wget/httpie readers, and the autonomy/graft guards.
// Moved unchanged from `autonomy-table.ts`, which re-exports the public names; import from there, not from here.
import fs from "node:fs"
import { homedir, networkInterfaces } from "node:os"
import path from "node:path"
import { NetOptions } from "../net-options"
import { SelfAddress } from "../../server/self-address"
import { Reach } from "../../tool/reach"
import { DeletionWords } from "../../tool/deletion"
import type { OwnApiReason } from "../autonomy-texts"
import { homes, protectedOutside } from "./outside"
import type { Input, Verdict } from "./types"
// Hosts that are this computer, whatever the listener's own name. `0` and `0.0.0.0` connect to it on macOS and Linux.
const LOOPBACK_NAME = /^(?:localhost|ip6-localhost|ip6-loopback|[\w.-]+\.localhost|127(?:\.\d{1,3}){3}|0|0\.0\.0\.0|::|::1|::ffff:127(?:\.\d{1,3}){3}|0:0:0:0:0:0:0:1)$/i
const WILDCARD = new Set(["0.0.0.0", "::", ""])

/**
 * 1.2.7 F-4 (SR7-08): one spelling per host, so every spelling of loopback reads as one. An IPv4 address in any form
 * `inet_aton` takes (1 to 4 parts, each decimal, hex `0x…` or octal `0…`: `127.1`, `2130706433`, `0x7f000001`,
 * `0177.0.0.1`, `0`) becomes its dotted quad; an IPv6 address its short form, an IPv4-mapped one (`::ffff:127.0.0.1`)
 * that IPv4 address; a name loses its trailing dot (`localhost.`). Lower case, brackets dropped.
 */
function normaliseHost(host: string): string {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase()
  const v4 = ipv4(name)
  if (v4 !== undefined) return v4
  if (name.includes(":")) return ipv6(name) ?? name
  return name.replace(/\.$/, "")
}

function ipv4(name: string): string | undefined {
  if (!/^[0-9a-fx]+(?:\.[0-9a-fx]+){0,3}$/.test(name)) return undefined
  const values = name.split(".").map((part) =>
    /^0x[0-9a-f]*$/.test(part)
      ? parseInt(part.slice(2) || "0", 16)
      : /^0[0-7]*$/.test(part)
        ? parseInt(part, 8)
        : /^[1-9]\d*$/.test(part)
          ? parseInt(part, 10)
          : NaN,
  )
  if (values.some((value) => !Number.isFinite(value))) return undefined
  const last = values.pop()!
  if (values.some((value) => value > 255) || last >= 256 ** (4 - values.length)) return undefined
  const whole = values.reduce((sum, value, index) => sum + value * 256 ** (3 - index), last)
  return [Math.floor(whole / 2 ** 24) % 256, Math.floor(whole / 2 ** 16) % 256, Math.floor(whole / 2 ** 8) % 256, whole % 256].join(".")
}

function ipv6(name: string): string | undefined {
  let text = name.replace(/%.*$/, "")
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const quad = ipv4(tail[1]!)
    if (quad === undefined) return undefined
    const [a, b, c, d] = quad.split(".").map(Number) as [number, number, number, number]
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(":") : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0) return undefined
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest]
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined
  const words = groups.map((group) => parseInt(group, 16))
  // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) addresses reach that IPv4 address.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || (words[5] === 0 && words[6] !== 0)))
    return [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255].join(".")
  if (words.every((word) => word === 0)) return "::"
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return "::1"
  return words.map((word) => word.toString(16)).join(":")
}

const isIpAddress = (normal: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normal) || normal.includes(":")

/** Whether a host names this computer as Swarm's own listener at `listener` can be reached there. */
function ownHost(host: string, listener: SelfAddress.Address) {
  const name = normaliseHost(host)
  const bound = normaliseHost(listener.hostname)
  if (name === "" || LOOPBACK_NAME.test(name) || name === bound) return true
  if (!WILDCARD.has(bound)) return false
  // Bound on every interface: this computer's own addresses reach it too.
  return Object.values(networkInterfaces()).some((list) => list?.some((item) => normaliseHost(item.address) === name))
}

/**
 * D1 (1.2.6 FX-14): whether a text names `listener` literally: `host:port` (a URL or not), `[v6]:port`,
 * `/dev/tcp/host/port`, httpie's bare `:port`, and `host port` (`nc 127.0.0.1 port`) for a host that is not a bare number.
 */
function namesListener(raw: string, listener: SelfAddress.Address) {
  const text = raw.replace(/['"\\]/g, "")
  const at = String.raw`0*${listener.port}(?!\d)`
  const named = new RegExp(String.raw`(\[[0-9A-Fa-f:.]*\]|[\w.-]+):${at}|/dev/(?:tcp|udp)/([^/\s]+)/${at}`, "g")
  for (const match of text.matchAll(named)) if (ownHost(match[1] ?? match[2]!, listener)) return true
  // httpie and xh read a bare `:port` as localhost; `nc 127.0.0.1 port` names the host and the port apart.
  if (new RegExp(String.raw`(?:^|\s):${at}`).test(text)) return true
  for (const match of text.matchAll(new RegExp(String.raw`(?:^|\s)(\[[0-9A-Fa-f:.]*\]|[\w.:-]*[A-Za-z.:][\w.:-]*)\s+${at}`, "g")))
    if (ownHost(match[1]!, listener)) return true
  return false
}

/** 1.2.7 F-4: an X `own_api`; a reason (N7-136) when the address could not be worked out (N7-135), none when it was. */
// 1.2.7 row 47k (U10-1, C76): a hit without a reason may carry the request it makes (`route`); such a hit runs under the
// consent unless the route is one only the person may call (`personOnlyRoute`). A hit with neither is refused as before.
type OwnApiHit = { readonly reason?: OwnApiReason; readonly route?: OwnRoute }

/**
 * 1.2.7 row 47k (U10-1): the request one call makes of Swarm's own server, read from its words: the method (undefined when
 * it could not be worked out: a variable, a method-override header, an unread config) and the path, normalised as the
 * server would route it (percent-decoded once, `.`/`..` and empty segments folded, lower case).
 */
type OwnRoute = { readonly method: string | undefined; readonly path: string }

/**
 * 1.2.7 row 47k (U10-1, U10 user ruling): the routes of Swarm's own server only the person calls, whatever the method:
 * the autonomous mode and the person's "that change was mine" (`/autonomy/mode`, `/autonomy/confirm`), every consent route,
 * emptying the archive and putting a checkpoint back (the desktop nonce routes), answering a permission, a question or a
 * TUI control request on the person's behalf, and folder trust; since row 47l (C79) also the user's shell, the person's
 * UI, repository commits and patches, upgrade and dispose. Matched as segments anywhere in the path, so a prefix
 * (a workspace proxy) does not hide them.
 */
const PERSON_ONLY_ROUTES: readonly RegExp[] = [
  /(?:^|\/)autonomy\/(?:mode|confirm)(?:\/|$)/,
  /(?:^|\/)consent(?:\/|$)/,
  /(?:^|\/)autonomy\/archive\/empty(?:\/|$)/,
  /(?:^|\/)autonomy\/checkpoint(?:\/|$)/,
  /(?:^|\/)permission\/[^/]+\/reply(?:\/|$)/,
  /(?:^|\/)session\/[^/]+\/permissions(?:\/|$)/,
  /(?:^|\/)question\/[^/]+\/(?:reply|reject)(?:\/|$)/,
  /(?:^|\/)tui\/control\/response(?:\/|$)/,
  /(?:^|\/)trust(?:\/|$)/,
  // 1.2.7 row 47l (C79): routes that run a command or change files outside the permission system, or act in the person's
  // UI. `session/:id/shell` runs a command recorded as "executed by the user" with no permission check (session/prompt.ts
  // shellImpl); every `tui` route drives the person's terminal UI (submit or append a prompt, execute a command, open a
  // dialog, show a toast, select a session, the control queue); `vcs/commit` and `vcs/apply` and `project/git/init` write
  // the repository outside the checkpoint and classifier path; `global/upgrade` replaces Swarm; the dispose routes stop the
  // person's instances.
  /(?:^|\/)session\/[^/]+\/shell(?:\/|$)/,
  /(?:^|\/)tui(?:\/|$)/,
  /(?:^|\/)vcs\/(?:commit|apply)(?:\/|$)/,
  /(?:^|\/)project\/git\/init(?:\/|$)/,
  /(?:^|\/)global\/upgrade(?:\/|$)/,
  /(?:^|\/)(?:global|instance)\/dispose(?:\/|$)/,
  // Attaching to a terminal session types into it (a GET that upgrades to a websocket).
  /(?:^|\/)pty\/[^/]+\/connect(?:\/|$)/,
  // 1.2.7 row 47m (C80): the same principle for the routes row 47l left open. Reverting a session is the person's (U6);
  // moving a session into a workspace (`experimental/workspace/warp`), taking over a sync (`sync/steal`) and connecting an
  // MCP server (`mcp/:name/connect`, which starts the server's process from configuration) change files or start programs
  // outside the permission system.
  /(?:^|\/)session\/[^/]+\/(?:revert|unrevert)(?:\/|$)/,
  /(?:^|\/)experimental\/workspace\/warp(?:\/|$)/,
  /(?:^|\/)sync\/steal(?:\/|$)/,
  /(?:^|\/)mcp\/[^/]+\/connect(?:\/|$)/,
  // 1.2.8 row 28 (P-3, AC-PROJi, R20-C13): moving the project's folder (`POST /project/rehome`, N8-130) is the person's
  // click only, whatever the method; the route also needs the desktop nonce.
  /(?:^|\/)project\/rehome(?:\/|$)/,
]
/**
 * 1.2.7 row 47k (U10-1): routes whose writes only the person makes: configuration (`/config`, `/global/config`, the lane
 * controls `/global/lanes`, provider and MCP credentials under `auth`) and every write under `autonomy`. A read of them
 * (GET, HEAD, OPTIONS) runs under the consent; a method not worked out counts as a write.
 */
const PERSON_ONLY_WRITES: readonly RegExp[] = [
  /(?:^|\/)config(?:\/|$)/,
  /(?:^|\/)global\/lanes(?:\/|$)/,
  /(?:^|\/)auth(?:\/|$)/,
  /(?:^|\/)autonomy(?:\/|$)/,
  // 1.2.7 row 47l (C79): a terminal session (`pty`) spawns any program it is given, with no permission check.
  /(?:^|\/)pty(?:\/|$)/,
  // 1.2.7 row 47m (C80): worktree create, remove and reset (`experimental/worktree`, `.../reset`; the list is a GET and
  // runs), workspace remove (`DELETE experimental/workspace/:id`; its other routes have fixed names), and adding an MCP
  // server (`POST /mcp`; the status is a GET and runs).
  /(?:^|\/)experimental\/worktree(?:\/|$)/,
  /(?:^|\/)experimental\/workspace\/(?!(?:adapter|sync-list|status|warp)(?:\/|$))[^/]+(?:\/|$)/,
  /(?:^|\/)mcp$/,
  // 1.2.8 row 28 (P-3, AC-SKd, R20-C13): saving, deleting (archive first) and approving or discarding a draft skill are
  // the person's (`PUT`/`DELETE /skill`, `POST`/`DELETE /skill/drafts/:name...`); `GET /skill`, `/skill/source` and
  // `/skill/drafts` still run. The routes also need the desktop nonce.
  /(?:^|\/)skill(?:\/|$)/,
]
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"])

/** 1.2.7 row 47k (U10-1): whether a request of Swarm's own server is one only the person makes. */
export function personOnlyRoute(route: OwnRoute) {
  if (PERSON_ONLY_ROUTES.some((pattern) => pattern.test(route.path))) return true
  const writes = route.method === undefined || !READ_METHODS.has(route.method)
  return writes && PERSON_ONLY_WRITES.some((pattern) => pattern.test(route.path))
}

/**
 * 1.2.7 row 47k (U10-1): the path a URL-like word asks for, as the server routes it; undefined when it is not written out
 * (a variable or command, curl's `{}`/`[]` globbing, a `;` parameter, a double encoding, a backslash) or a `_method`
 * override rides in the query.
 */
function routePath(word: string): string | undefined {
  const rest = word.replace(/^[A-Za-z][\w+.-]*:\/\//, "")
  const start = rest.search(/[/?#]/)
  if (start < 0) return "/"
  const tail = rest.slice(start)
  if (/[$`{}[\]\s\\;]/.test(tail)) return undefined
  const cut = tail.search(/[?#]/)
  const raw = cut < 0 ? tail : tail.slice(0, cut)
  if (cut >= 0 && /_method/i.test(tail.slice(cut))) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return undefined
  }
  if (/%[0-9A-Fa-f]{2}/.test(decoded) || /[\\;]/.test(decoded)) return undefined
  const parts: string[] = []
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part.toLowerCase())
  }
  return `/${parts.join("/")}`
}

/** 1.2.7 row 47k (U10-1): what a call's options say of its request: the method, and whether the path is not the URL's. */
type RequestInfo = { method: string | undefined; targetUnknown: boolean }

/** curl's short options that shape the request, by their long name. */
const CURL_SHORT_REQUEST: Readonly<Record<string, string>> = {
  X: "--request", d: "--data", F: "--form", T: "--upload-file", I: "--head", G: "--get", H: "--header", K: "--config", ":": "--next",
}
/** curl's long options that shape the method or the path; a word that abbreviates one of them is not worked out. */
const CURL_REQUEST_LONG = [
  "--request", "--request-target", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json",
  "--form", "--form-string", "--upload-file", "--head", "--get", "--header", "--next", "--variable", "--expand-url",
  "--expand-data", "--url",
]

/** The request curl makes from its options, those given on the line and those its config files add (`configs`). */
function curlRequest(options: readonly [string, string | undefined][]): RequestInfo {
  let method: string | undefined
  let unknown = false
  let targetUnknown = false
  let [body, upload, head, get] = [false, false, false, false]
  for (const [flag, value] of options) {
    if (flag === "?") {
      unknown = true
      targetUnknown = true
    } else if (flag === "--request") {
      if (value === undefined || /[$`]/.test(value)) unknown = true
      else method = value.toUpperCase()
    } else if (flag === "--request-target" || flag === "--next" || flag === "--variable" || flag.startsWith("--expand-"))
      targetUnknown = true
    else if (flag.startsWith("--data") || flag === "--json" || flag.startsWith("--form")) body = true
    else if (flag === "--upload-file") upload = true
    else if (flag === "--head") head = true
    else if (flag === "--get") get = true
    else if (flag === "--header" && (value === undefined || /method-override|[$`]/i.test(value))) unknown = true
  }
  if (unknown) return { method: undefined, targetUnknown }
  return { method: method ?? (head ? "HEAD" : get ? "GET" : upload ? "PUT" : body ? "POST" : "GET"), targetUnknown }
}

/** One curl option word (and its value) as a long name: an abbreviation of a request option reads as `?`. */
function curlLong(flag: string): string {
  if (CURL_REQUEST_LONG.includes(flag) || netOptions.curl.long.has(flag)) return flag
  return CURL_REQUEST_LONG.some((name) => name.startsWith(flag) && flag.length >= 3) ? "?" : flag
}

/** The curl options of a config file's lines (`request = PATCH`, `-X PATCH`, `head`, `-sI`), nested configs two deep. */
function curlConfigOptions(file: string, depth = 0): [string, string | undefined][] {
  const text = configText(file)
  if (text === undefined) return [["?", undefined]]
  const options: [string, string | undefined][] = []
  for (const line of text.split(/\r?\n/)) {
    const entry = /^\s*(-{0,2})([A-Za-z:][\w-]*)\s*(?:[=:\s]\s*"?([^"]*?)"?\s*)?$/.exec(line)
    if (!entry || line.trim().startsWith("#")) continue
    const [dashes, key, value] = [entry[1]!, entry[2]!, entry[3] || undefined]
    if (dashes === "-" || (dashes === "" && key.length === 1)) {
      for (let at = 0; at < key.length; at++) {
        const long = CURL_SHORT_REQUEST[key[at]!]
        if (long) options.push([long, netOptions.curl.short.has(key[at]!) ? key.slice(at + 1) || value : undefined])
        if (netOptions.curl.short.has(key[at]!)) break
      }
      continue
    }
    const long = curlLong(`--${key.toLowerCase()}`)
    if (long === "--config" && value !== undefined && depth < 2) {
      const next = commandFile(value, path.dirname(file))
      options.push(...(next === undefined ? [["?", undefined] as [string, undefined]] : curlConfigOptions(next, depth + 1)))
    } else options.push([long, value])
  }
  return options
}

/** wget's long options that shape the method or the path; a word that abbreviates one of them is not worked out. */
const WGET_REQUEST_LONG = ["--method", "--post-data", "--post-file", "--body-data", "--body-file", "--header", "--execute"]

/** The method wget asks with: `--method`, a post option, a `.wgetrc` command (`-e`, a config file) or GET. */
function wgetRequest(args: readonly string[], configs: readonly string[]): RequestInfo {
  let method: string | undefined
  let unknown = false
  let body = false
  const command = (key: string, value: string | undefined) => {
    const name = key.toLowerCase().replace(/[-_]/g, "")
    if (name === "method") {
      if (value === undefined || /[$`]/.test(value)) unknown = true
      else method = value.trim().toUpperCase()
    } else if (name === "postdata" || name === "postfile") body = true
    else if (name === "header" && (value === undefined || /method-override|[$`]/i.test(value))) unknown = true
  }
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === "--") break
    if (word === "-e" || word.startsWith("-e") || word === "--execute" || word.startsWith("--execute=")) {
      const value = word === "-e" || word === "--execute" ? args[++index] : word.startsWith("--execute=") ? word.slice(10) : word.slice(2)
      const match = value === undefined ? undefined : /^\s*([\w-]+)\s*=\s*(.*)$/.exec(value)
      if (match) command(match[1]!, match[2])
      else unknown = true
      continue
    }
    if (!word.startsWith("--")) continue
    const equals = word.indexOf("=")
    const flag = equals < 0 ? word : word.slice(0, equals)
    const value = equals < 0 ? (netOptions.wget.long.has(flag) ? args[++index] : undefined) : word.slice(equals + 1)
    if (WGET_REQUEST_LONG.includes(flag)) command(flag.slice(2), value)
    else if (!netOptions.wget.long.has(flag) && WGET_REQUEST_LONG.some((name) => name.startsWith(flag) && flag.length >= 4)) unknown = true
  }
  for (const file of configs) {
    const text = configText(file)
    if (text === undefined) {
      unknown = true
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([\w-]+)\s*=\s*(.*)$/.exec(line)
      if (match) command(match[1]!, match[2])
    }
  }
  if (unknown) return { method: undefined, targetUnknown: false }
  return { method: method ?? (body ? "POST" : "GET"), targetUnknown: false }
}

/** httpie's and xh's method: the first word when it is a bare word with a URL after it, else POST with data items, GET without. */
function httpieRequest(positional: readonly string[]): RequestInfo {
  const named = positional.length > 1 && /^[A-Za-z]+$/.test(positional[0]!)
  const items = positional.slice(named ? 2 : 1)
  if (items.some((item) => /^[^:=]*:(?!=)/.test(item) && /method-override/i.test(item))) return { method: undefined, targetUnknown: false }
  if (named) return { method: positional[0]!.toUpperCase(), targetUnknown: false }
  // Without a method, data items (`a=b`, `a:=1`, `f@file`) make it a POST; with none, a body from stdin may too.
  if (items.some((item) => /(?:^|[^=:])(?:=|:=|@)/.test(item) && !/^[^=]*==/.test(item))) return { method: "POST", targetUnknown: false }
  return { method: items.length === 0 ? undefined : "GET", targetUnknown: false }
}

/** F-4: the network clients whose address a call may hide (`BypassLists.OUTWARD` less the remote shells, mail and sync). */
// 1.2.7 row 47j (U9-5): zsh's `ztcp` and `zftp` too, so a call to Swarm's own server through them is judged as curl's is.
const NETWORK_CLIENTS: ReadonlySet<string> = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "http", "https", "xh", "telnet", "ztcp", "zftp"])
/** Words that run the command after them; `xargs` builds it at run time, a shell's `-c` and `eval` run a text. */
const CLIENT_WRAPPERS: ReadonlySet<string> = new Set([
  "rtk", "env", "exec", "command", "builtin", "nohup", "time", "nice", "timeout", "stdbuf", "sudo", "doas", "eval", "xargs",
  "sh", "bash", "zsh", "dash",
])
/**
 * 1.2.7 47f (M1-08): curl's and wget's value-taking options, the same table objects the outward-consent reader uses.
 * 1.2.8 row 27 (R-2, N8-201): httpie's and xh's too (`NetOptions.HTTPIE`), which replaces this file's own copy.
 */
export const netOptions = { curl: NetOptions.CURL, wget: NetOptions.WGET, httpie: NetOptions.HTTPIE } as const
/** nc, ncat, netcat and telnet options that take a value; `x` and `--proxy` are an address. */
const NC_VALUE = new Set(["-p", "-s", "-w", "-x", "-X", "-i", "-O", "-I", "-T", "-V", "-e", "-c", "-o", "--proxy", "--proxy-type", "--sh-exec", "--exec"])
const TELNET_VALUE = new Set(["-l", "-e", "-n", "-b"])
const SOCAT_ADDRESS = /^(?:tcp[46]?(?:-connect)?|udp[46]?(?:-connect|-sendto)?|openssl(?:-connect)?|ssl|socks4a?|socks5|proxy):(.*)$/i
/** F-4 (D2, OP-4): a config file is read only as a regular file of 64 KiB or less, never from a protected place. */
const CONFIG_MAX_BYTES = 64 * 1024

const unresolvedWord = (word: string | undefined) => word !== undefined && /[$`]/.test(word)

/** The host and port a URL-like word names; scheme, user info, path and query left out. */
function hostAndPort(word: string): { host: string; port?: string } {
  const rest = word.replace(/^[A-Za-z][\w+.-]*:\/\//, "")
  const end = rest.search(/[/?#]/)
  let auth = end < 0 ? rest : rest.slice(0, end)
  const at = auth.lastIndexOf("@")
  if (at >= 0) auth = auth.slice(at + 1)
  const v6 = /^(\[[^\]]*\])(?::(.*))?$/.exec(auth)
  if (v6) return { host: v6[1]!, port: v6[2] }
  const colon = auth.lastIndexOf(":")
  return colon < 0 ? { host: auth } : { host: auth.slice(0, colon), port: auth.slice(colon + 1) }
}

/**
 * One word in an address position. U2: the host is not written out. U3: a loopback host with a port that is not.
 * D: the listener's port on one of its hosts. SR7-08: a name that is not an IP address with a listener's port, which a
 * DNS name could point back here. A literal host that is not this computer's is not refused, whatever the port.
 */
function judgeAddress(word: string, listeners: readonly SelfAddress.Address[], literal = false): OwnApiHit | undefined {
  const { host, port } = hostAndPort(word)
  if (!literal && unresolvedWord(host)) return { reason: "unresolved_target" }
  const normal = normaliseHost(host)
  for (const listener of listeners) {
    const own = ownHost(host, listener)
    if (own && !literal && unresolvedWord(port)) return { reason: "unresolved_target" }
    if (port === undefined || !/^\d+$/.test(port) || Number(port) !== listener.port) continue
    if (own) return {}
    if (normal !== "" && !isIpAddress(normal)) return { reason: "unresolved_target" }
  }
  return undefined
}

/** A config file's text, or undefined when it may not or cannot be read. Only checked, never shown (OP-4). */
function configText(file: string): string | undefined {
  try {
    if (protectedOutside(file, "read") || !Reach.readable(file)) return undefined
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > CONFIG_MAX_BYTES) return undefined
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** Where a file named in a command is: `~`, `$HOME` and `${HOME}` under the home the shell has, the rest from `cwd`. */
function commandFile(word: string, cwd: string) {
  const home = /^(?:~|\$HOME\b|\$\{HOME\})(?=\/|$)/.exec(word)
  if (home) return path.join(homedir(), word.slice(home[0].length))
  return unresolvedWord(word) ? undefined : path.resolve(cwd, word)
}

/** D2/D4: what a curl or wget config file (or wget URL list) names, followed into the configs it names, two deep. */
function judgeConfig(file: string, listeners: readonly SelfAddress.Address[], info: RequestInfo, depth = 0): OwnApiHit[] {
  const text = configText(file)
  if (text === undefined) return [{ reason: "config_file" }]
  const hits: OwnApiHit[] = []
  for (const line of text.split(/\r?\n/)) {
    const entry = /^\s*-{0,2}([A-Za-z][\w-]*)\s*(?:=|:|\s)\s*"?([^"\s]+)"?/.exec(line)
    const bare = /^\s*([a-z]+:\/\/\S+)\s*$/i.exec(line)
    if (bare) {
      // 1.2.7 row 47k (U10-1): a URL of a list (`wget -i`) is a request, judged by its route.
      const hit = judgeAddress(bare[1]!, listeners, true)
      if (hit) hits.push(routed(bare[1]!, hit, info))
      continue
    }
    if (!entry) continue
    const [key, value] = [entry[1]!.toLowerCase(), entry[2]!]
    if (/^(?:url|x|proxy|preproxy|https?_proxy|ftp_proxy|all_proxy)$/.test(key)) {
      const hit = judgeAddress(value, listeners, true)
      // A `url` is a request; a proxy entry reaches the server with no route that can be read.
      if (hit) hits.push(key === "url" ? routed(value, hit, info) : hit)
    }
    if ((key === "k" || key === "config") && depth < 2) {
      const next = commandFile(value, path.dirname(file))
      hits.push(...(next === undefined ? [{ reason: "config_file" as const }] : judgeConfig(next, listeners, info, depth + 1)))
    }
  }
  // The listener named anywhere else in the file (a header, an unread option): refused as before (D2).
  if (listeners.some((listener) => namesListener(text, listener)) && !hits.some((hit) => hit.reason === undefined)) hits.push({})
  return hits
}

/**
 * 1.2.7 row 47k (U10-1): a request word's hit with the route it asks for. A hit with a reason stays; a path that is not
 * written out, or a request whose path an option replaces (`--request-target`), is `unresolved_target` (refused).
 */
function routed(word: string, hit: OwnApiHit, info: RequestInfo): OwnApiHit {
  if (hit.reason !== undefined) return hit
  const route = routePath(word)
  if (route === undefined || info.targetUnknown) return { reason: "unresolved_target" }
  return { route: { method: info.method, path: route } }
}

/** D4: the config files curl or wget reads by itself, those that exist. */
function defaultConfigs(program: "curl" | "wget") {
  const env = process.env
  const files =
    program === "curl"
      ? [
          ...(env.CURL_HOME ? [path.join(env.CURL_HOME, ".curlrc")] : []),
          ...(env.XDG_CONFIG_HOME ? [path.join(env.XDG_CONFIG_HOME, ".curlrc"), path.join(env.XDG_CONFIG_HOME, "curlrc")] : []),
          ...homes().map((home) => path.join(home, ".curlrc")),
        ]
      : [...(env.WGETRC ? [env.WGETRC] : []), ...homes().map((home) => path.join(home, ".wgetrc"))]
  return [...new Set(files)].filter((file) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined)
}

type ClientCall = { program: string; args: string[]; runtime: boolean }

/**
 * A command's simple commands as the shell splits them into words: quotes and backslashes removed, `;`, `|`, `&` and line
 * breaks between commands, and every redirection (`> out`, `2>&1`, `< cfg`) left out with its target.
 */
export function shellSegments(text: string): string[][] {
  const segments: string[][] = [[]]
  let word = ""
  let inWord = false
  let drop = false
  let quote: string | undefined
  const end = () => {
    if (inWord) {
      if (!drop) segments.at(-1)!.push(word)
      drop = false
    }
    word = ""
    inWord = false
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === '"' && index + 1 < text.length) word += text[++index]
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      inWord = true
      continue
    }
    if (char === "\\" && index + 1 < text.length) {
      word += text[++index]
      inWord = true
      continue
    }
    if (char === "<" || char === ">") {
      if (inWord && /^\d+$/.test(word)) {
        word = ""
        inWord = false
      } else end()
      while (index + 1 < text.length && "<>&|".includes(text[index + 1]!)) index++
      drop = true
      continue
    }
    if (char === "\n" || char === ";" || char === "|" || char === "&") {
      end()
      if (segments.at(-1)!.length > 0) segments.push([])
      continue
    }
    if (/\s/.test(char)) {
      end()
      continue
    }
    word += char
    inWord = true
  }
  end()
  return segments.filter((segment) => segment.length > 0)
}

/**
 * The network client one simple command runs, past the words that run what follows them; or the text a shell's `-c` or
 * an `eval` runs, to be read as a command of its own; or undefined.
 */
function clientCall(words: readonly string[]): ClientCall | { nested: string } | undefined {
  let runtime = false
  let index = 0
  while (index < words.length) {
    const word = words[index]!
    if (/^[A-Za-z_]\w*=/.test(word)) {
      // A proxy set from something not written out may point anywhere, this computer included.
      if (/^(?:https?|all|ftp)_proxy=.*[$`]/i.test(word)) runtime = true
      index++
      continue
    }
    const name = path.basename(word)
    if (!CLIENT_WRAPPERS.has(name)) break
    index++
    if (name === "xargs") runtime = true
    while (index < words.length && (words[index]!.startsWith("-") || /^\d+[smhd]?$/.test(words[index]!))) index++
    if (name === "eval" || DeletionWords.SHELLS.has(name)) return { nested: words.slice(index).join(" ") }
  }
  const program = words[index] === undefined ? undefined : path.basename(words[index]!)
  if (program === undefined || !NETWORK_CLIENTS.has(program)) return undefined
  return { program, args: words.slice(index + 1), runtime }
}

/**
 * What one client call names: address words, config files, URL lists, and whether it reads its default config. 1.2.7 row
 * 47k (U10-1): `requests` are the URLs it asks for (curl's and wget's operands and `--url`, httpie's URL), `curl` the
 * options that shape curl's request, `positional` httpie's words; every other address (a proxy, `--resolve`, a socket)
 * reaches a server with no route that can be read.
 */
function clientParts(call: ClientCall) {
  const addresses: string[] = []
  const requests: string[] = []
  const configs: string[] = []
  const lists: string[] = []
  const curlOptions: [string, string | undefined][] = []
  const { program, args } = call
  // 1.2.7 row 47j (U9-5): `ztcp [-v] [-d fd] host [port]` (a listen, accept, close or list names no host to call) and
  // `zftp open|params host [port]`.
  if (program === "ztcp" || program === "zftp") {
    const named: string[] = []
    let local = false
    for (let index = 0; index < args.length; index++) {
      const word = args[index]!
      if (word === "-d") index++
      else if (program === "ztcp" && /^-[lacL]/.test(word)) local = true
      else if (!word.startsWith("-")) named.push(word)
    }
    const [host, port] = program === "zftp" ? (["open", "params"].includes(named[0] ?? "") ? named.slice(1) : []) : named
    if (!local && host !== undefined) addresses.push(port === undefined || !/^\d+$/.test(port) ? host : `${host}:${port}`)
    return { addresses, requests, configs, lists, defaults: false, curlOptions, positional: [] as string[] }
  }
  let defaults = program === "curl" || program === "wget"
  if (program === "curl" && (args[0] === "-q" || args[0] === "--disable")) defaults = false
  if (program === "wget" && args.includes("--no-config")) defaults = false
  const curl = program === "curl"
  const wget = program === "wget"
  const httpie = program === "http" || program === "https" || program === "xh"
  const socat = program === "socat"
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === "--") {
      positional.push(...args.slice(index + 1))
      break
    }
    if (word.startsWith("--")) {
      const equals = word.indexOf("=")
      const flag = equals < 0 ? word : word.slice(0, equals)
      const takes = (curl ? netOptions.curl.long : wget ? netOptions.wget.long : httpie ? netOptions.httpie.long : NC_VALUE).has(flag)
      const value = equals < 0 ? (takes ? args[++index] : undefined) : word.slice(equals + 1)
      if (curl) curlOptions.push([curlLong(flag), value])
      if (value === undefined) continue
      if (flag === "--config") configs.push(value)
      else if (curl && flag === "--url") requests.push(value)
      else if (flag === "--input-file") lists.push(value)
      else if (curl && netOptions.curl.address.has(flag)) addresses.push(flag === "--resolve" ? value.split(":").slice(-1)[0]! : flag === "--connect-to" ? value.split(":").slice(2).join(":") : value)
      else if (flag === "--proxy") addresses.push(value.replace(/^(?:https?|all):(?!\/\/)/, ""))
      else if (wget && flag === "--execute") addresses.push(...wgetProxy(value))
      continue
    }
    if (word.startsWith("-") && word.length > 1 && !socat) {
      if (httpie || !(curl || wget)) {
        const values = program === "telnet" ? TELNET_VALUE : NC_VALUE
        if (httpie ? NetOptions.takesValue(netOptions.httpie, word) : values.has(word)) {
          const value = args[++index]
          if (value !== undefined && (word === "-x" || word === "--proxy")) addresses.push(value)
        }
        continue
      }
      const shorts = curl ? netOptions.curl.short : netOptions.wget.short
      for (let at = 1; at < word.length; at++) {
        const letter = word[at]!
        const long = curl ? CURL_SHORT_REQUEST[letter] : undefined
        if (!shorts.has(letter)) {
          if (long) curlOptions.push([long, undefined])
          continue
        }
        const value = word.slice(at + 1) || args[++index]
        if (long) curlOptions.push([long, value])
        if (value === undefined) break
        if (curl && letter === "K") configs.push(value)
        else if (curl && letter === "x") addresses.push(value)
        else if (wget && letter === "i") lists.push(value)
        else if (wget && letter === "e") addresses.push(...wgetProxy(value))
        break
      }
      continue
    }
    positional.push(word)
  }
  if (curl || wget) requests.push(...positional)
  else if (httpie) {
    // 1.2.7 row 47k: a bare first word with more after it is the method (`http post :4096/x`), as `httpieRequest` reads it.
    const url = positional.length > 1 && /^[A-Za-z]+$/.test(positional[0]!) ? positional[1] : positional[0]
    if (url !== undefined) requests.push(url)
  } else if (socat) {
    for (const word of positional) {
      const match = SOCAT_ADDRESS.exec(word)
      if (match) addresses.push(match[1]!.split(",")[0]!.split(":").slice(-2).join(":"))
    }
  } else if (positional.length > 0) {
    // nc, ncat, netcat, telnet: `host [port]`. A host alone may still carry a port once the shell splits it.
    addresses.push(positional[1] === undefined ? positional[0]! : `${positional[0]}:${positional[1]}`)
  }
  return { addresses, requests, configs, lists, defaults, curlOptions, positional }
}

/** A `.wgetrc` command given with `-e`: a proxy setting is an address. */
const wgetProxy = (command: string) => {
  const match = /^\s*(\w+)\s*=\s*(.*)$/.exec(command)
  return match && /proxy$/i.test(match[1]!) ? [match[2]!] : []
}

/** The verdicts one client call gets (D2, D4, U1-U4), none when it cannot reach Swarm's server. */
function judgeClient(call: ClientCall, cwd: string, listeners: readonly SelfAddress.Address[]): OwnApiHit[] {
  if (call.runtime) return [{ reason: "unresolved_target" }]
  const { addresses, requests, configs, lists, defaults, curlOptions, positional } = clientParts(call)
  const hits: OwnApiHit[] = []
  for (const word of addresses) {
    if (word === "") continue
    const hit = judgeAddress(word, listeners)
    if (hit) hits.push(hit)
  }
  // 1.2.7 row 47k (U10-1): what the request asks for, from the line and from every config file the client reads.
  const read = [...configs.filter((word) => word !== "").map((word) => (word === "-" ? undefined : commandFile(word, cwd)))]
  const defaultFiles = defaults && (call.program === "curl" || call.program === "wget") ? defaultConfigs(call.program) : []
  const info: RequestInfo =
    call.program === "curl"
      ? curlRequest([
          ...curlOptions,
          ...[...read, ...defaultFiles].flatMap((file): [string, string | undefined][] =>
            file === undefined ? [["?", undefined]] : curlConfigOptions(file),
          ),
        ])
      : call.program === "wget"
        ? read.includes(undefined)
          ? { method: undefined, targetUnknown: false }
          : wgetRequest(call.args, [...read.filter((file) => file !== undefined), ...defaultFiles])
        : call.program === "http" || call.program === "https" || call.program === "xh"
          ? httpieRequest(positional)
          : { method: undefined, targetUnknown: true }
  for (const word of requests) {
    if (word === "") continue
    const hit = judgeAddress(word, listeners)
    if (hit) hits.push(routed(word, hit, info))
  }
  for (const [word, stdin] of [
    ...configs.map((word) => [word, "config_file"] as const),
    ...lists.map((word) => [word, "unresolved_target"] as const),
  ]) {
    // U1/U4: read from stdin, or from a file whose name is not written out.
    const file = word === "-" ? undefined : commandFile(word, cwd)
    if (file === undefined) hits.push({ reason: word === "-" ? stdin : "config_file" })
    else hits.push(...judgeConfig(file, listeners, info))
  }
  for (const file of defaultFiles) hits.push(...judgeConfig(file, listeners, info))
  return hits
}

/** `$(…)` and backquoted commands, each a text of its own, and the text with each replaced by a word not written out. */
function liftSubstitutions(text: string) {
  const inner: string[] = []
  let outer = text
  for (let round = 0; round < 8; round++) {
    const next = outer.replace(/\$\(([^()]*)\)|`([^`]*)`/g, (_whole, a: string | undefined, b: string | undefined) => {
      inner.push(a ?? b ?? "")
      return "$__"
    })
    if (next === outer) break
    outer = next
  }
  return [outer, ...inner]
}

/**
 * D3: the text with `$NAME` and `${NAME}` replaced by a literal value assigned earlier in it (`H=127.0.0.1; curl $H:…`,
 * `export P=…`), in text order. Anything else (`${H:-x}`, an assignment from a command) stays as written.
 */
function substituteAssignments(text: string) {
  const known = new Map<string, string>()
  const reference = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g
  return text.replace(
    /(?<=^|[\s;&|(])(?:export\s+)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|()]*)|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
    (whole, name: string | undefined, value: string | undefined, braced: string | undefined, bare: string | undefined) => {
      if (name !== undefined) {
        const literal = value!.replace(/^(['"])([\s\S]*)\1$/, "$2")
        known.set(name, literal.replace(reference, (ref, a: string | undefined, b: string | undefined) => known.get((a ?? b)!) ?? ref))
        return whole
      }
      return known.get((braced ?? bare)!) ?? whole
    },
  )
}

/** The verdicts for a call by its words (D1, D3, and per client D2, D4, U1-U4), shell `-c` and `eval` text two deep. */
function judgeOwnServer(text: string, cwd: string, listeners: readonly SelfAddress.Address[], depth = 0): OwnApiHit[] {
  const hits: OwnApiHit[] = []
  for (const part of liftSubstitutions(text)) {
    const resolved = substituteAssignments(part)
    const names = (text: string) => listeners.some((listener) => namesListener(text, listener))
    for (const match of resolved.matchAll(/\/dev\/(?:tcp|udp)\/([^/\s]+)\/([^\s;&|)]+)/g)) {
      const hit = judgeAddress(`${match[1]}:${match[2]}`, listeners)
      if (hit) hits.push(hit)
    }
    // 1.2.7 row 47k (U10-1): the listener named in a simple command counts as a call with no route that can be read (a
    // socket, interpreter code, an echo), unless that command is a client whose call to it was read (routed or refused).
    let segmentNamed = false
    for (const words of shellSegments(resolved)) {
      const named = names(words.join(" "))
      segmentNamed ||= named
      const call = clientCall(words)
      if (call !== undefined && "nested" in call) {
        if (depth < 2) hits.push(...judgeOwnServer(call.nested, cwd, listeners, depth + 1))
        else if (named) hits.push({})
        continue
      }
      const found = call === undefined ? [] : judgeClient(call, cwd, listeners)
      hits.push(...found)
      if (named && found.length === 0) hits.push({})
    }
    // Named only where the words leave it out (a redirection's target, a here-document): refused as before.
    if (!segmentNamed && names(resolved)) hits.push({})
  }
  return hits
}

/**
 * 1.2.6 FX-14 (F-1, decision C24), 1.2.7 F-4 (OP-4, SR7-08): a shell or fetch call that talks to Swarm's own running
 * server, the listener this process opened (`SelfAddress`). With the password from `app-server.env` such a call could
 * answer the agent's own prompts or change its mode, past every hold. Only that host and port: every other local port
 * runs as C19c decided, and nothing is refused while no listener exists.
 * - D1-D5, no reason: the call names it, literally, through a variable assigned in the same text, or through a config
 *   file (`-K`, `--config`, `.curlrc`, `.wgetrc`, `-i`) that was read.
 * - U1 `config_file`: a config file from stdin, or one that is missing, unreadable, larger than 64 KiB or protected.
 * - U2-U4 `unresolved_target`: a network client whose host is not written out (`$URL`, `$(…)`, `eval`, `xargs`, `-i -`),
 *   a loopback host with a port that is not, or a name that is not an IP address with a listener's port (SR7-08).
 * Residual (R-F4, SR7-03): interpreter code that builds the address at run time (`python -c`, `node -e`, a script) is not
 * decidable here; a subagent's goes to the main agent by the script screen's `network` flag. The backstop is the masking
 * of the server password file (U16), X `app_state` for any shell write out of app state (C8), the app-state read
 * allowlist (no oracle), and the desktop nonce on revert and archive-empty only. The permission reply, consent and mode
 * routes are password-only.
 * 1.2.7 row 47k (U10-1, user ruling U10, C76): narrowed to the routes only the person calls. A request whose method and
 * path were read from its words (curl/wget operands and options, their config files, httpie's method and items, a
 * webfetch URL) runs under the consent like any other local call unless `personOnlyRoute` names it; that one is X
 * `own_api` with no reason. Every form whose route cannot be read stays refused as before: a path or method not written
 * out (`unresolved_target`), an unread config (`config_file`), a socket, a proxy or interpreter code naming the listener
 * (no reason).
 */
export function ownServerCall(input: Input): OwnApiHit | undefined {
  const listeners = SelfAddress.list()
  if (listeners.length === 0) return undefined
  const hits: OwnApiHit[] = []
  const url = input.metadata.url
  if (typeof url === "string") {
    // A webfetch only ever asks with GET.
    const hit = judgeAddress(url, listeners, true)
    if (hit) hits.push(routed(url, hit, { method: "GET", targetUnknown: false }))
    else if (listeners.some((listener) => namesListener(url, listener))) hits.push({})
  }
  const command = input.metadata.command
  if (typeof command === "string") hits.push(...judgeOwnServer(command, input.cwd, listeners))
  if (hits.some((hit) => hit.route !== undefined && personOnlyRoute(hit.route))) return {}
  const refused = hits.filter((hit) => hit.route === undefined)
  if (refused.length === 0) return undefined
  return refused.find((hit) => hit.reason === undefined) ?? refused.find((hit) => hit.reason === "config_file") ?? refused[0]
}

/** Whether a call to Swarm's own running server is refused, by `ownServerCall` (1.2.7 row 47k: a readable, not person-only route is not). */
export function callsOwnServer(input: Input) {
  return ownServerCall(input) !== undefined
}

/**
 * 1.2.8 row 28 (H-U10, N8-387, SR8-01, C13): the routes of Swarm's own server an agent may read under the consent without
 * the main agent, each the exact path as registered in `server/routes/instance/httpapi/groups/*.ts` (OP20-10; `:name` is
 * one path segment). Matched on the whole normalised path (`routePath`), so a prefix (a workspace proxy) or a longer path
 * is not on it. Off the list on purpose (they return unmasked secrets, search any folder or reach other servers):
 * `file*`, `find*`, `config*`, `global/config`, `provider*`, `GET /memory`, `experimental/*`, the event streams,
 * `autonomy/*`, `pty*`, `saved-command/*`, `workspace*`, and every route added later. The list may shrink in review; it
 * never grows without a security re-review (01_specs §3.3 rule 1). `/memory/vault` is row 43e's route (AC-OBSe).
 */
export const OWN_API_READ_ROUTES: readonly { readonly route: string; readonly pattern: RegExp }[] = [
  "/global/health",
  "/global/agents",
  "/session",
  "/session/status",
  "/session/:sessionID",
  "/session/:sessionID/children",
  "/session/:sessionID/todo",
  "/session/:sessionID/message",
  "/session/:sessionID/message/:messageID",
  "/session/:sessionID/diff",
  "/project",
  "/project/current",
  "/path",
  "/vcs",
  "/vcs/status",
  "/vcs/diff",
  "/agent",
  "/command",
  "/skill",
  "/skill/drafts",
  "/skill/source",
  "/lsp",
  "/formatter",
  "/mcp",
  "/question",
  "/permission",
  "/memory/vault",
].map((route) => ({ route, pattern: new RegExp(`^${route.toLowerCase().replace(/:[a-z]+/g, "[^/]+")}$`) }))

/** The verdict of an own-server read under the consent (N8-386): run by the gate, nobody asked, the main agent included. */
export const OWN_API_READ: Verdict = { class: "A", decidedBy: "gate", category: "own_api_read" }

/** A request read from a call's words for `ownApiRead`: its URL, method, headers and query items (httpie's `a==b`). */
type ReadRequest = { url: string; method: "GET" | "HEAD"; headers: [string, string][]; query: [string, string][] }

const READ_CURL_FLAGS: ReadonlySet<string> = new Set(NetOptions.OWN_API_READ_OPTIONS.curl.flags)
const READ_CURL_VALUES: ReadonlySet<string> = new Set(NetOptions.OWN_API_READ_OPTIONS.curl.values)
const READ_METHODS_HTTPIE: ReadonlySet<string> = new Set(NetOptions.OWN_API_READ_OPTIONS.httpie.methods)
/** Outside quotes, a character that makes the text more than one plain command: an operator, a redirection, a glob, `~`, a comment. */
const READ_UNQUOTED = new Set(";&|<>()*?[]{}~\\!#")

/** Whether the text is one plain command: nothing expanded (`$`, backquotes), no line break, no unquoted operator or glob. */
function plainCommand(text: string) {
  if (/[$`\r\n]/.test(text)) return false
  let quote: string | undefined
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === "'" || char === '"') quote = char
    else if (READ_UNQUOTED.has(char)) return false
  }
  return quote === undefined
}

/** curl with only the N8-388 options and one URL; undefined for anything else. */
function curlRead(args: readonly string[]): ReadRequest | undefined {
  const urls: string[] = []
  const headers: [string, string][] = []
  let head = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word.startsWith("--")) {
      if (READ_CURL_FLAGS.has(word)) continue
      if (!READ_CURL_VALUES.has(word) || args[index + 1] === undefined) return undefined
      index++
      continue
    }
    if (word.startsWith("-")) {
      if (word.length < 2) return undefined
      for (let at = 1; at < word.length; at++) {
        const option = `-${word[at]}`
        if (READ_CURL_FLAGS.has(option)) {
          if (option === "-I") head = true
          continue
        }
        if (!READ_CURL_VALUES.has(option)) return undefined
        const value = word.slice(at + 1) || args[++index]
        if (value === undefined) return undefined
        if (option === "-H") {
          const colon = value.indexOf(":")
          if (value.startsWith("@") || colon < 1) return undefined
          headers.push([value.slice(0, colon).trim(), value.slice(colon + 1).trim()])
        }
        break
      }
      continue
    }
    urls.push(word)
  }
  if (urls.length !== 1) return undefined
  return { url: urls[0]!, method: head ? "HEAD" : "GET", headers, query: [] }
}

/** httpie or xh with no option, an optional GET/HEAD, one URL, and only `a==b` and `a:b` items; undefined otherwise. */
function httpieRead(args: readonly string[]): ReadRequest | undefined {
  if (args.length === 0 || args.some((word) => word.startsWith("-"))) return undefined
  const named = args.length > 1 && /^[A-Za-z]+$/.test(args[0]!)
  const method = named ? args[0]!.toUpperCase() : "GET"
  if (!READ_METHODS_HTTPIE.has(method)) return undefined
  const headers: [string, string][] = []
  const query: [string, string][] = []
  for (const item of args.slice(named ? 2 : 1)) {
    // `@` reads a value from a file; `=`, `:=` and `=@` items are data, which make it a POST.
    if (item.includes("@")) return undefined
    const pair = /^([^:=]+)==(.*)$/.exec(item)
    if (pair) {
      query.push([pair[1]!, pair[2]!])
      continue
    }
    const header = /^([^:=]+):(?!=)(.*)$/.exec(item)
    if (!header) return undefined
    headers.push([header[1]!.trim(), header[2]!.trim()])
  }
  return { url: args[named ? 1 : 0]!, method: method as "GET" | "HEAD", headers, query }
}

/** Config files httpie and xh read by themselves, which may add options (`default_options`) nobody wrote on the line. */
function httpieConfigs(program: string) {
  const env = process.env
  const files =
    program === "xh"
      ? [
          ...(env.XH_CONFIG_DIR ? [path.join(env.XH_CONFIG_DIR, "config.json")] : []),
          ...(env.XDG_CONFIG_HOME ? [path.join(env.XDG_CONFIG_HOME, "xh", "config.json")] : []),
          ...homes().flatMap((home) => [
            path.join(home, ".config", "xh", "config.json"),
            path.join(home, "Library", "Application Support", "xh", "config.json"),
          ]),
        ]
      : [
          ...(env.HTTPIE_CONFIG_DIR ? [path.join(env.HTTPIE_CONFIG_DIR, "config.json")] : []),
          ...(env.XDG_CONFIG_HOME ? [path.join(env.XDG_CONFIG_HOME, "httpie", "config.json")] : []),
          ...homes().flatMap((home) => [path.join(home, ".config", "httpie", "config.json"), path.join(home, ".httpie", "config.json")]),
        ]
  return files.filter((file) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined)
}

/** The request of a shell call that is one plain curl, http, https or xh command with only listed options. */
function shellRead(command: string): ReadRequest | undefined {
  if (!plainCommand(command)) return undefined
  const segments = shellSegments(command)
  if (segments.length !== 1) return undefined
  const [program, ...args] = segments[0]!
  if (program === "curl") return defaultConfigs("curl").length === 0 ? curlRead(args) : undefined
  if (program === "http" || program === "https" || program === "xh")
    return httpieConfigs(program).length === 0 ? httpieRead(args) : undefined
  return undefined
}

/** Whether a directory a request names is the caller's worktree or inside it, by its spelling and by where it really is. */
function insideWorktree(value: string, instance: Input["instance"]) {
  if (!path.isAbsolute(value) || value.includes("%")) return false
  const root = instance.worktree && instance.worktree !== "/" ? instance.worktree : instance.directory
  const within = (base: string, file: string) => {
    const relative = path.relative(base, file)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }
  const real = (file: string) => {
    try {
      return fs.realpathSync(file)
    } catch {
      return undefined
    }
  }
  const resolved = path.resolve(value)
  const rootReal = real(root) ?? path.resolve(root)
  if (!within(path.resolve(root), resolved) && !within(rootReal, resolved)) return false
  const valueReal = real(resolved)
  return valueReal === undefined || within(rootReal, valueReal)
}

/**
 * 1.2.8 row 28 (H-U10, C5, C13; SR8-01/02): whether a call is a read of Swarm's own server that runs under the consent
 * as class A `own_api_read`. All of these hold: a listener exists and the call names it (no reason); the call is a
 * webfetch, or one plain curl/http/https/xh command with only the N8-388 options and one URL (no default config file that
 * could add options); the method is GET or HEAD and no header overrides it; the route is on `OWN_API_READ_ROUTES`; no
 * `workspace` query parameter or `x-opencode-workspace` header; any `directory` query parameter or `x-opencode-directory`
 * header names the caller's worktree or a folder inside it; and `ownServerCall` refuses nothing in it. Only the consent
 * layer reads this (`classify` with `bypass`); with the mode off the person is still asked (U10).
 */
export function ownApiRead(input: Input): boolean {
  const listeners = SelfAddress.list()
  if (listeners.length === 0) return false
  // Only a call written as it is: a step of a longer text, or the text a shell's `-c` runs (`whole` is the outer call),
  // keeps its 1.2.7 verdict.
  if (input.whole !== undefined && input.whole !== input.metadata.command) return false
  const webfetch = input.permission === "webfetch"
  const request: ReadRequest | undefined = webfetch
    ? typeof input.metadata.url === "string" && input.metadata.command === undefined
      ? { url: input.metadata.url, method: "GET", headers: [], query: [] }
      : undefined
    : input.permission === "bash" && typeof input.metadata.command === "string"
      ? shellRead(input.metadata.command)
      : undefined
  if (request === undefined) return false
  const hit = judgeAddress(request.url, listeners, webfetch)
  if (hit === undefined || hit.reason !== undefined) return false
  const route = routePath(request.url)
  if (route === undefined || !OWN_API_READ_ROUTES.some((entry) => entry.pattern.test(route))) return false
  if (personOnlyRoute({ method: request.method, path: route })) return false
  const directories: string[] = []
  const query = /\?([^#]*)/.exec(request.url.replace(/^[A-Za-z][\w+.-]*:\/\//, ""))?.[1]
  let params: [string, string][]
  try {
    params = [...new URLSearchParams(query ?? "").entries(), ...request.query]
  } catch {
    return false
  }
  for (const [name, value] of params) {
    const key = name.toLowerCase()
    if (key === "workspace" || key === "_method") return false
    if (key === "directory") directories.push(value)
  }
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase()
    if (/method-override/.test(key) || key === "x-opencode-workspace") return false
    if (key === "x-opencode-directory") directories.push(value)
  }
  if (!directories.every((value) => insideWorktree(value, input.instance))) return false
  return ownServerCall(input) === undefined
}

/** The Swarm CLI by any name it ships under (`swarm`, `swarm-launcher.sh`, `opencode`), as a program's last path part. */
const SWARM_CLI = /^(?:swarm|opencode)(?:-launcher)?(?:\.sh|\.exe)?$/i
/** Programs that run other code: their arguments are read as text for the CLI followed by `autonomy`. */
const AUTONOMY_RUNNERS = new Set([
  "script", "expect", "unbuffer", "python", "python3", "node", "bun", "bunx", "npx", "deno", "tsx", "perl", "ruby",
  "osascript",
])
const AUTONOMY_IN_TEXT =
  /(?:^|[\s'"[(,/=])(?:(?:swarm|opencode)(?:-launcher)?(?:\.sh|\.exe)?|index\.[cm]?[jt]s)['"]?(?:\s*,\s*|[\s\\]+)['"]?autonomy(?![\w.-])/i

/**
 * 1.2.7 U-10 (C63, D-10b): a shell command that runs `swarm autonomy …`, by its name or a path to it, a program name not
 * written out (`$B`, `$(…)`), through `sh -c`/`eval` two deep, or inside a program that runs other code (a pseudo
 * terminal wrapper, an interpreter's code). A mention in another program's arguments (`git commit -m`) is not a run.
 * Residual, as R-F4: a script file that calls it is not read here.
 */
export function runsAutonomyCommand(command: unknown, depth = 0): boolean {
  if (typeof command !== "string") return false
  return liftSubstitutions(command).some((part) =>
    shellSegments(substituteAssignments(part)).some((words) => {
      // Past assignments and the words that run what follows them, as `clientCall` reads them.
      let index = 0
      while (index < words.length) {
        const word = words[index]!
        if (/^[A-Za-z_]\w*=/.test(word)) {
          index++
          continue
        }
        const name = path.basename(word)
        if (!CLIENT_WRAPPERS.has(name)) break
        index++
        while (index < words.length && (words[index]!.startsWith("-") || /^\d+[smhd]?$/.test(words[index]!))) index++
        if (name === "eval" || DeletionWords.SHELLS.has(name))
          return depth < 2 && runsAutonomyCommand(words.slice(index).join(" "), depth + 1)
      }
      const program = words[index]
      if (program === undefined) return false
      const rest = words.slice(index + 1)
      if (SWARM_CLI.test(path.basename(program)) || program.startsWith("$")) return rest.includes("autonomy")
      return AUTONOMY_RUNNERS.has(path.basename(program)) && AUTONOMY_IN_TEXT.test(` ${rest.join(" ")}`)
    }),
  )
}

/**
 * 1.2.7 row 47j (U9-3): a simple command (past assignments and wrappers, through a shell's `-c` or an `eval`, as
 * `runsAutonomyCommand` reads it) whose program is `graft` and whose first word that is no option is `init`. A program
 * not written out (`$G init`) is not read here; the consent's other rules judge it (`unreadable_command`).
 */
export function runsGraftInit(command: unknown, depth = 0): boolean {
  if (typeof command !== "string") return false
  return liftSubstitutions(command).some((part) =>
    shellSegments(substituteAssignments(part)).some((words) => {
      let index = 0
      while (index < words.length) {
        const word = words[index]!
        if (/^[A-Za-z_]\w*=/.test(word)) {
          index++
          continue
        }
        const name = path.basename(word)
        if (!CLIENT_WRAPPERS.has(name)) break
        index++
        while (index < words.length && (words[index]!.startsWith("-") || /^\d+[smhd]?$/.test(words[index]!))) index++
        if (name === "eval" || DeletionWords.SHELLS.has(name))
          return depth < 2 && runsGraftInit(words.slice(index).join(" "), depth + 1)
      }
      const program = words[index]
      if (program === undefined || path.basename(program) !== "graft") return false
      return words.slice(index + 1).find((word) => !word.startsWith("-")) === "init"
    }),
  )
}
