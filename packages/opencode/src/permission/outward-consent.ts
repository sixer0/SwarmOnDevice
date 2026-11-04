// Swarm 1.1.1 F26 (decision P42): what the consented bypass lets leave the machine. Without consent nothing here is asked,
// so 1.1.0 is unchanged. Pure: no Effect, no network (one local `git ls-files` per classify for a publish, F39). It reads
// the project's own deploy configuration and manifests (`firebase.json`, `netlify.toml`, `package.json`, `Cargo.toml`,
// `pyproject.toml`) and `.npmrc` files line by line (F39, V15-1); of the other registry configuration files (`.yarnrc*`,
// `bunfig.toml`, `.cargo/config.toml`, `uv.toml`, `poetry.toml`, `.pypirc`, `pip.conf`) it only asks whether they exist (F36, P52).
//
// 1. A request (curl, wget, httpie `http`/`https`, xh/xhs, the webfetch tool) opens when every host it names is local
//    (`localHost`) or one the person named in the mission or ticked in the consent list (`namedHost`). Any method, any
//    header or body, tokens included. It stays held when it sends a file from disk (`upload`), takes stdin with a `<`
//    anywhere in the call, uses an option this reader does not know, or names a host neither local nor named.
// 2. `git push` without force to a remote the consent snapshot knew, unchanged since (`pushWords`), a package publish to
//    the tool's public default registry, an image push, a hosted deploy, `gh pr create`, `gh release create` (`sendForm`).
//
// Host matching rule (D-F26-1): host names are compared lower case without a trailing dot. A named host matches only
// itself. A name the person wrote with a leading dot or a wildcard (`.example.com`, `*.example.com`) matches that name and
// every name below it. IP addresses are compared as the URL parser writes them, so `0x7f.1` is `127.0.0.1`.
//
// 1.1.1 F30 (P46): URLs are read as curl, wget and httpie read them (one to three slashes after the scheme, scheme-less
// forms, a user part, IPv6 brackets, ports), and a word whose host cannot be told for certain holds. A `$NAME` or `${NAME}`
// may stand in a request's header or body value (never in the URL, an option that names a file, or the program). Cloud
// metadata addresses and `.internal` names are not local. A publish opens only to the default public registry of its
// tool (a registry the person named holds since D-F33-2).
//
// 1.1.1 F33 (P49): a publish or deploy opens by a FORM allowlist (`sendForm`): only the plain form with a few known
// options, and no registry setting anywhere the tool reads one; destinations are the default registries. TOML files are
// read by `TomlReader`, not the Bun global's parser, since the packaged app's server runs on Node (P48).
//
// 1.1.1 F39 (P54): what a publish carries must land inside the project too: the files a manifest names (CR15-1) and the
// links git tracks under the package (CR15-2). `.npmrc` is judged by a strict line allowlist and `netlify.toml` by a
// plain-table allowlist (V15-1); every other registry config file still holds by presence. A write in the same call as
// a publish or deploy keeps the call at 1.1.0 (G15-1, `bypass-screen.ts`).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { OutwardKnown } from "./outward-known"
import { Reach } from "../tool/reach"
import { Risk } from "../tool/risk"
import { TomlReader } from "./toml-reader"

/** What the table passes in from the consent: hosts the person named in the mission (ticked or not) and those ticked. */
export type Known = {
  readonly named?: readonly OutwardKnown.Destination[]
  readonly allowed: readonly { id: string; destination: OutwardKnown.Destination }[]
}

/** A step P42 opens, with where it goes (`host[:port]`, a remote name, a registry or deploy target). */
export type Opened = { destinations: string[]; outputs: string[] }
/** Why a step that sends is not opened. */
export type Held = { held: "upload" | "unread" | "host" | "form" }
export type Reading = Opened | Held

/** 1.1.1 F30: what `sendForm` may read beside the words: the project's top folders. */
export type FormContext = {
  readonly instance?: { readonly directory: string; readonly worktree: string }
}

export const REQUEST_TOOLS: ReadonlySet<string> = new Set(["curl", "wget", "http", "https", "xh", "xhs"])
/** Every program a step P42 may open runs (`request`, `sendForm`, `git push`). */
export const SEND_PROGRAMS: ReadonlySet<string> = new Set([
  ...REQUEST_TOOLS,
  "npm", "pnpm", "yarn", "bun", "cargo", "poetry", "uv", "twine", "docker", "podman", "vercel", "netlify", "firebase", "fly",
  "flyctl", "gh", "git",
])

const normal = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")

function v4(host: string): number[] | undefined {
  const parts = host.split(".")
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return undefined
  return parts.map(Number)
}

function localV4([a, b]: number[]) {
  // 1.1.1 F33 (P49 1, CR13-3): no address of the link-local range 169.254/16 is local. The clouds serve credentials there
  // (169.254.169.254, the ECS endpoint 169.254.170.2, the EKS agent 169.254.170.23), and nothing else is expected there.
  return a === 127 || a === 10 || a === 0 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
}

/** 1.1.1 F30 (n62): the eight 16-bit groups of an IPv6 address (a dotted IPv4 tail included), or undefined. */
function v6(host: string): number[] | undefined {
  let text = host
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const ip = v4(tail[1]!)
    if (!ip) return undefined
    text = `${text.slice(0, -tail[1]!.length)}${((ip[0]! << 8) | ip[1]!).toString(16)}:${((ip[2]! << 8) | ip[3]!).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const groups = (part: string) => (part === "" ? [] : part.split(":"))
  const head = groups(halves[0]!)
  const back = halves.length === 2 ? groups(halves[1]!) : []
  if (![...head, ...back].every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined
  const missing = 8 - head.length - back.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined
  return [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...back].map((group) => parseInt(group, 16))
}

// 1.1.1 F30 (P46), F33 (P49 1, CR13-3): the cloud metadata prefix of IPv6, fd00:ec2::/32 (`fd00:ec2::254`, the EKS agent
// `fd00:ec2::23`), is not local, though it lies in fc00::/7.
const METADATA_V6_PREFIX = [0xfd00, 0x0ec2]
// 1.1.1 F33 (P49 1, CR13-3): dot-less names that resolve to a cloud's metadata server (GCE `metadata`, EC2 `instance-data`).
const METADATA_NAMES = new Set(["metadata", "instance-data"])

/**
 * Loopback, private and link-local ranges (127/8, 10/8, 172.16/12, 192.168/16, 0.0.0.0, ::1, fe80::/10, fc00::/7, and an
 * IPv4 address mapped into IPv6), `localhost`, names ending in `.local`, `.test` or `.localhost`, and a name with no dot
 * (a compose or container service). Carrier-grade NAT (100.64/10) is not local. 1.1.1 F30 (P46): nor are names ending in
 * `.internal`. 1.1.1 F33 (P49 1): nor is any of 169.254/16, fd00:ec2::/32, or the names `metadata` and `instance-data`.
 */
export function localHost(given: string): boolean {
  const host = normal(given)
  if (!host) return false
  const ip = v4(host)
  if (ip) return localV4(ip)
  if (host.includes(":")) {
    const groups = v6(host)
    if (!groups) return false
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number]
    if (g0 === METADATA_V6_PREFIX[0] && g1 === METADATA_V6_PREFIX[1]) return false
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
      if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true
      if (g5 === 0xffff) return localV4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255])
      return false
    }
    return (g0 & 0xffc0) === 0xfe80 || (g0 & 0xfe00) === 0xfc00
  }
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(host)) return false
  if (host === "localhost" || /\.(local|test|localhost)$/.test(host)) return true
  if (METADATA_NAMES.has(host)) return false
  // A word of digits only is an address the parser did not write as one; never taken for a service name.
  return !host.includes(".") && !/^\d+$/.test(host)
}

// 1.1.1 F30 (n65): the hosts of one consent, normalised once.
const hostCache = new WeakMap<Known, string[]>()

/** The hosts of the consent, ticked or named: exact names and wildcard parents. */
function hostsOf(known: Known | undefined) {
  if (!known) return []
  const cached = hostCache.get(known)
  if (cached) return cached
  const all = [...(known.named ?? []), ...known.allowed.map((item) => item.destination)]
  const found = all.flatMap((destination) => (destination.kind === "host" ? [normal(destination.host)] : []))
  hostCache.set(known, found)
  return found
}

/** Whether the person named this remote host (rule D-F26-1). */
export function namedHost(given: string, known: Known | undefined): boolean {
  const host = normal(given)
  return hostsOf(known).some((name) => {
    if (name.startsWith("*.") || name.startsWith(".")) {
      const parent = name.replace(/^\*?\./, "")
      return host === parent || host.endsWith(`.${parent}`)
    }
    return host === name
  })
}

export const hostOpens = (host: string, known: Known | undefined) => localHost(host) || namedHost(host, known)

// 1.1.1 F30 (CR12-1): a host spelled as a scheme's name is what a mistyped scheme leaves behind; never judged as a host.
const SCHEME_NAMES = new Set(["http", "https", "ftp", "ftps", "file", "ws", "wss", "sftp", "scp", "ssh", "git", "dict", "ldap", "gopher"])

/**
 * A URL as a request tool reads it, scheme-less taken as `fallback`. undefined: not one this reads with certainty.
 * 1.1.1 F30 (G12-3, CR12-1): read as curl reads one. A scheme is followed by one to three slashes (`http:/host` is the
 * host `host`); a word with a scheme-like name, a colon and no slash is read only as `host:port`. The host part may carry
 * a user part (one `@`), an IPv6 address in brackets and a port of digits; anything else in it (a second `@`, a percent
 * sign, a letter outside ASCII, a bracket after the host) holds.
 */
export function urlOf(word: string, fallback: "http" | "https" = "http"): URL | undefined {
  if (/[{}\s\\$`]/.test(word) || word.startsWith("-")) return undefined
  let scheme: string = fallback
  let rest = word
  const lead = /^([a-z][a-z0-9+.-]*):(\/*)/i.exec(word)
  if (lead) {
    const slashes = lead[2]!.length
    if (slashes === 0) {
      if (!/^[a-z0-9_.-]+:\d*(?:[/?#]|$)/i.test(word)) return undefined
    } else {
      if (slashes > 3) return undefined
      scheme = lead[1]!.toLowerCase()
      rest = word.slice(lead[0].length)
    }
  }
  if (scheme !== "http" && scheme !== "https") return undefined
  const end = rest.search(/[/?#]/)
  const authority = end < 0 ? rest : rest.slice(0, end)
  const tail = end < 0 ? "/" : rest.slice(end)
  // A bracket after the host is a curl range or glob, never a path.
  if (/[[\]]/.test(tail)) return undefined
  const at = authority.split("@")
  if (at.length > 2) return undefined
  const hostPort = at.at(-1)!
  const bracketed = /^(\[[0-9a-f:.]+\])(?::(\d*))?$/i.exec(hostPort)
  const plain = bracketed ? undefined : /^([a-z0-9_.-]+)(?::(\d*))?$/i.exec(hostPort)
  const found = bracketed ?? plain
  if (!found) return undefined
  const port = found[2] ? `:${found[2]}` : ""
  const text = `${scheme}://${found[1]}${port}${tail}`
  if (!URL.canParse(text)) return undefined
  const url = new URL(text)
  if (!url.hostname || SCHEME_NAMES.has(normal(url.hostname))) return undefined
  return url
}

/** `host[:port]` of a URL, as the audit records it. */
export const label = (url: URL) => (url.port ? `${normal(url.hostname)}:${url.port}` : normal(url.hostname))

/** 1.1.1 F30 (P46): a `$NAME` or `${NAME}` the shell expands; nothing else that starts with `$`. */
const EXPANSION = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/g
const expands = (word: string) => word.includes("$")
/** Only plain expansions, and none in the first `before` characters (`$` there could make the value name a file). */
function plainExpansions(word: string, literalUntil = 0) {
  const rest = word.replace(EXPANSION, "")
  if (/[$`]/.test(rest)) return false
  const first = word.search(EXPANSION)
  return first < 0 || first >= literalUntil
}

// curl, read option by option. Anything not listed here is not read, so the step stays held.
const CURL_FLAGS = new Set([
  "-s", "--silent", "-S", "--show-error", "-f", "--fail", "--fail-with-body", "--fail-early", "-L", "--location", "-i",
  "--include", "-I", "--head", "-v", "--verbose", "-k", "--insecure", "-g", "--globoff", "-N", "--no-buffer", "-#",
  "--progress-bar", "--no-progress-meter", "-G", "--get", "--compressed", "--http1.0", "--http1.1", "--http2",
  "--http2-prior-knowledge", "-4", "--ipv4", "-6", "--ipv6", "-q", "--disable", "--raw", "-j", "--junk-session-cookies",
  "--retry-all-errors", "--retry-connrefused", "--no-keepalive", "--tcp-nodelay", "--path-as-is", "--styled-output",
  "--no-styled-output", "-Z", "--parallel", "-O", "--remote-name", "--remote-name-all", "--create-dirs", "--trace-time",
])
// Options taking a value that names no file and sends none.
const CURL_VALUES = new Set([
  "-X", "--request", "-A", "--user-agent", "-e", "--referer", "-u", "--user", "--oauth2-bearer", "-m", "--max-time",
  "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--max-redirs", "-w", "--write-out", "-r", "--range",
  "--limit-rate", "--max-filesize", "--expect100-timeout", "--keepalive-time", "--aws-sigv4",
])
// Options taking data that is sent: from a file when it starts with `@` (any of them) or, for a form, `@` or `<` after `=`.
// 1.1.1 F30 (G12-1, CR12-2): `--url-query` takes the `--data-urlencode` syntax, `@file` and `name@file` included.
const CURL_DATA = new Set(["-d", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "--url-query"])
const CURL_ENCODED = new Set(["--data-urlencode", "--url-query"])
const CURL_FORM = new Set(["-F", "--form"])
// 1.1.1 F30 (G12-4): every option that writes a file of its own; each is judged as a redirect is.
const CURL_OUTPUT = new Set([
  "-o", "--output", "-D", "--dump-header", "-c", "--cookie-jar", "--trace", "--trace-ascii", "--stderr", "--libcurl",
  "--etag-save", "--output-dir",
])
// Always send a file from disk, or read options from one.
const CURL_UPLOAD = new Set(["-T", "--upload-file", "-K", "--config", "--form-escape"])
const CURL_SHORT_VALUE = "XAeumwrdFHoDcbTK"
// 1.1.1 F30 (P46): the options whose value may hold a `$NAME`, and how many leading characters must be literal first.
// A value that starts with an expansion could start with `@` and name a file; a cookie needs its `=` written out.
const CURL_EXPANDS: Readonly<Record<string, (value: string) => boolean>> = {
  "-H": (value) => plainExpansions(value, 1),
  "--header": (value) => plainExpansions(value, 1),
  "-A": (value) => plainExpansions(value),
  "--user-agent": (value) => plainExpansions(value),
  "-e": (value) => plainExpansions(value),
  "--referer": (value) => plainExpansions(value),
  "-u": (value) => plainExpansions(value),
  "--user": (value) => plainExpansions(value),
  "--oauth2-bearer": (value) => plainExpansions(value),
  "-d": (value) => plainExpansions(value, 1),
  "--data": (value) => plainExpansions(value, 1),
  "--data-ascii": (value) => plainExpansions(value, 1),
  "--data-binary": (value) => plainExpansions(value, 1),
  "--json": (value) => plainExpansions(value, 1),
  "--data-raw": (value) => plainExpansions(value),
  "--data-urlencode": (value) => value.indexOf("=") >= 0 && plainExpansions(value, value.indexOf("=") + 1),
  "-b": (value) => value.indexOf("=") >= 0 && plainExpansions(value, value.indexOf("=") + 1),
  "--cookie": (value) => value.indexOf("=") >= 0 && plainExpansions(value, value.indexOf("=") + 1),
}
// curl guesses these protocols from a scheme-less host's first label.
const CURL_GUESSED = /^(ftp|dict|ldap|imap|pop3|smtp)\./i

type Parsed = { options: [string, string | undefined][]; positional: string[] } | undefined

/** Options and positional words; short clusters split (`-sSL`, `-XPOST`, `-d@f`), `--opt=value` split. */
function parse(args: readonly string[], flags: ReadonlySet<string>, values: ReadonlySet<string>, shortValue: string): Parsed {
  const options: [string, string | undefined][] = []
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === "--") {
      positional.push(...args.slice(index + 1))
      break
    }
    if (word.startsWith("--")) {
      const at = word.indexOf("=")
      const name = at < 0 ? word : word.slice(0, at)
      if (flags.has(name) && at < 0) options.push([name, undefined])
      else if (values.has(name)) {
        const value = at < 0 ? args[++index] : word.slice(at + 1)
        if (value === undefined) return undefined
        options.push([name, value])
      } else return undefined
      continue
    }
    if (word.startsWith("-") && word.length > 1) {
      for (let at = 1; at < word.length; at++) {
        const name = `-${word[at]}`
        if (shortValue.includes(word[at]!) && values.has(name)) {
          const value = at + 1 < word.length ? word.slice(at + 1) : args[++index]
          if (value === undefined) return undefined
          options.push([name, value])
          break
        }
        if (!flags.has(name)) return undefined
        options.push([name, undefined])
      }
      continue
    }
    positional.push(word)
  }
  return { options, positional }
}

const ALL_CURL_VALUES = new Set([...CURL_VALUES, ...CURL_DATA, ...CURL_FORM, ...CURL_OUTPUT, ...CURL_UPLOAD, "-H", "--header", "--url", "-b", "--cookie", "--form-string"])

/** 1.1.1 F30 (G12-4): the files a `--write-out` format writes (`%output{name}`, `%output{>>name}`), or undefined. */
function writeOutFiles(format: string): string[] | undefined {
  if (format.startsWith("@")) return undefined
  const files: string[] = []
  for (const match of format.matchAll(/%output\{(>>)?([^}]*)\}/g)) {
    if (!match[2]) return undefined
    files.push(match[2])
  }
  // A directive this does not see whole (an `%output` without its braces) is not read.
  return /%output(?!\{)/.test(format) ? undefined : files
}

function curl(args: readonly string[], known: Known | undefined): Reading {
  const found = parse(args, CURL_FLAGS, ALL_CURL_VALUES, CURL_SHORT_VALUE)
  if (!found) return { held: "unread" }
  if (found.positional.some(expands)) return { held: "unread" }
  const urls = [...found.positional]
  const named: string[] = []
  let outputDir: string | undefined
  let remoteName = false
  for (const [name, value] of found.options) {
    if (value !== undefined && expands(value) && !CURL_EXPANDS[name]?.(value)) return { held: "unread" }
    if (CURL_UPLOAD.has(name)) return { held: "upload" }
    if (CURL_DATA.has(name) && value !== undefined) {
      if (value.startsWith("@")) return { held: "upload" }
      // `name@file` reads the file; a leading `+` (url-query, sent as written) changes nothing about that.
      if (CURL_ENCODED.has(name) && /^[^=]*@/.test(value.replace(/^\+/, ""))) return { held: "upload" }
    }
    // 1.1.1 F30 (G12-1): any `@` or `<` in a form part may read a file (`f=@x`, `f=<x`, `@x`); `--form-string` sends text.
    if (CURL_FORM.has(name) && value !== undefined && /[@<]/.test(value)) return { held: "upload" }
    // A header or a cookie read from a file sends what is in it.
    if ((name === "-H" || name === "--header") && value?.startsWith("@")) return { held: "upload" }
    if ((name === "-b" || name === "--cookie") && value !== undefined && !value.includes("=")) return { held: "upload" }
    if (name === "-w" || name === "--write-out") {
      const files = value === undefined ? undefined : writeOutFiles(value)
      if (!files) return { held: "unread" }
      named.push(...files)
    }
    // A URL list read from a file (newer curl) is not read here.
    if (name === "--url" && value !== undefined) {
      if (value.startsWith("@")) return { held: "unread" }
      urls.push(value)
    }
    if (name === "--output-dir") outputDir = value
    else if (CURL_OUTPUT.has(name) && value !== undefined) named.push(value)
    if (name === "-O" || name === "--remote-name" || name === "--remote-name-all") remoteName = true
  }
  if (urls.some((word) => !/^[a-z][a-z0-9+.-]*:/i.test(word) && CURL_GUESSED.test(word))) return { held: "unread" }
  const reading = hosts(urls, known, "http", [])
  if ("held" in reading) return reading
  // `-O` saves each URL under the last name of its path, in the output folder when one is given.
  const saved = remoteName
    ? urls.map((word) => {
        const name = path.posix.basename(urlOf(word)!.pathname)
        return name ? name : undefined
      })
    : []
  if (saved.some((name) => name === undefined)) return { held: "unread" }
  const place = (file: string) => (outputDir !== undefined && !path.isAbsolute(file) ? path.join(outputDir, file) : file)
  const outputs = [...named.filter((file) => file !== "-" && file !== "/dev/null"), ...(saved as string[])].map(place)
  if (outputDir !== undefined) outputs.push(outputDir)
  return { destinations: reading.destinations, outputs }
}

const WGET_FLAGS = new Set([
  "-q", "--quiet", "-v", "--verbose", "-nv", "--no-verbose", "-S", "--server-response", "--spider", "-4", "--inet4-only",
  "-6", "--inet6-only", "--no-check-certificate", "--no-cache", "--content-on-error", "--no-proxy", "-nc", "--no-clobber",
])
const WGET_VALUES = new Set([
  "-O", "--output-document", "--header", "--method", "--body-data", "--post-data", "-U", "--user-agent", "--user",
  "--password", "-t", "--tries", "-T", "--timeout", "--wait", "--max-redirect", "--post-file", "--body-file", "-i",
  "--input-file", "-o", "--output-file", "-a", "--append-output", "-P", "--directory-prefix",
])
// 1.1.1 F30 (P46): the wget options whose value may hold a `$NAME`.
const WGET_EXPANDS = new Set(["--header", "--body-data", "--post-data", "--user", "--password", "-U", "--user-agent"])

function wget(args: readonly string[], known: Known | undefined): Reading {
  // `-nv` and `-nc` are single words of two letters each, not clusters.
  const words = args.map((word) => (word === "-nv" ? "--no-verbose" : word === "-nc" ? "--no-clobber" : word))
  const found = parse(words, WGET_FLAGS, WGET_VALUES, "OUtTioaP")
  if (!found) return { held: "unread" }
  if (found.positional.some(expands)) return { held: "unread" }
  const outputs: string[] = []
  let document: string | undefined
  let prefix: string | undefined
  let spider = false
  for (const [name, value] of found.options) {
    if (value !== undefined && expands(value) && !(WGET_EXPANDS.has(name) && plainExpansions(value))) return { held: "unread" }
    if (name === "--post-file" || name === "--body-file") return { held: "upload" }
    if (name === "-i" || name === "--input-file") return { held: "unread" }
    if (name === "-O" || name === "--output-document") document = value
    if (name === "-P" || name === "--directory-prefix") prefix = value
    if ((name === "-o" || name === "--output-file" || name === "-a" || name === "--append-output") && value !== undefined) outputs.push(value)
    if (name === "--spider") spider = true
  }
  const reading = hosts(found.positional, known, "http", outputs)
  if ("held" in reading) return reading
  if (document !== undefined) {
    if (document !== "-" && document !== "/dev/null") reading.outputs.push(document)
  } else if (!spider) {
    // Without -O wget saves each URL under its last name (or index.html) in the folder, or below the prefix.
    for (const word of found.positional) {
      const name = path.posix.basename(urlOf(word)!.pathname) || "index.html"
      reading.outputs.push(prefix === undefined ? name : path.join(prefix, name))
    }
  }
  return reading
}

const HTTPIE_FLAGS = new Set([
  "-v", "--verbose", "-h", "--headers", "-b", "--body", "-f", "--form", "-j", "--json", "-m", "--multipart", "-F",
  "--follow", "-I", "--ignore-stdin", "-q", "--quiet", "-S", "--stream", "--check-status", "--offline",
  "--https", "--native-tls", "-4", "--ipv4", "-6", "--ipv6", "--no-check-status",
])
const HTTPIE_VALUES = new Set([
  "-p", "--print", "-a", "--auth", "-A", "--auth-type", "--timeout", "--pretty", "-s", "--style", "--verify",
  "--max-redirects", "--bearer", "-o", "--output",
])
const HTTPIE_EXPANDS = new Set(["-a", "--auth", "--bearer"])

function httpie(program: string, args: readonly string[], known: Known | undefined, whole: string): Reading {
  const found = parse(args, HTTPIE_FLAGS, HTTPIE_VALUES, "paAso")
  if (!found) return { held: "unread" }
  for (const [name, value] of found.options)
    if (value !== undefined && expands(value) && !(HTTPIE_EXPANDS.has(name) && plainExpansions(value))) return { held: "unread" }
  const ignoresStdin = found.options.some(([name]) => name === "-I" || name === "--ignore-stdin")
  // With stdin from a pipe or a redirect, httpie and xh send it as the body.
  if (!ignoresStdin && /[|<]/.test(whole)) return { held: "upload" }
  const outputs = found.options.flatMap(([name, value]) => ((name === "-o" || name === "--output") && value !== undefined ? [value] : []))
  const words = [...found.positional]
  // 1.1.1 F30 (G12-2): with two or more words, a first word of letters only is the method, in any letter case (httpie and
  // xh both read it so), and the URL is the word after it.
  if (words.length > 1 && /^[a-zA-Z]+$/.test(words[0]!)) words.shift()
  const [target, ...items] = words
  if (target === undefined || expands(target)) return { held: "unread" }
  for (const item of items) {
    if (item.includes("\\")) return { held: "unread" }
    const at = item.search(/[:=@]/)
    if (at <= 0) return { held: "unread" }
    if (expands(item.slice(0, at))) return { held: "unread" }
    // 1.1.1 F30 (G12-1): the separator is every separator character in a row (`=`, `:`, `==`, `:=`, `@`, `=@`, `:=@`,
    // `==@`, `:@`); any `@` in it reads a file.
    const sep = /^[:=@]+/.exec(item.slice(at))![0]
    if (sep.includes("@")) return { held: "upload" }
    // 1.1.1 F33 (CR13-5, G13-3): one literal character after the separator first, as curl's `-H` and `-d` ask: a value that
    // starts with an expansion could start with `@` once expanded, and httpie and xh would read that file.
    if (expands(item) && !plainExpansions(item, at + sep.length + 1)) return { held: "unread" }
  }
  // `:3000/x` is localhost, as httpie and xh read it.
  const spelled = target.startsWith(":") ? `localhost${target}` : target
  const secure = program === "https" || program === "xhs" || found.options.some(([name]) => name === "--https")
  return hosts([spelled], known, secure ? "https" : "http", outputs)
}

function hosts(words: readonly string[], known: Known | undefined, fallback: "http" | "https", outputs: string[]): Reading {
  if (words.length === 0) return { held: "unread" }
  const destinations: string[] = []
  for (const word of words) {
    const url = urlOf(word, fallback)
    if (!url) return { held: "unread" }
    if (!hostOpens(url.hostname, known)) return { held: "host" }
    destinations.push(label(url))
  }
  return { destinations: [...new Set(destinations)], outputs }
}

/**
 * A request tool's step under consent, or undefined for any other program. `whole` is the call's whole text: a `<` in it
 * (a file or heredoc on stdin) holds every request step of the call.
 */
export function request(name: string, args: readonly string[], known: Known | undefined, whole: string): Reading | undefined {
  if (!REQUEST_TOOLS.has(name)) return undefined
  if (whole.includes("<")) return { held: "upload" }
  if (name === "curl") return curl(args, known)
  if (name === "wget") return wget(args, known)
  return httpie(name, args, known, whole)
}

/** The webfetch tool's URL under consent, as `classifyFetch` takes it. */
export function fetch(url: unknown, patterns: readonly string[], known: Known | undefined): Reading {
  if (typeof url !== "string" || !patterns.every((pattern) => pattern === url) || !URL.canParse(url)) return { held: "unread" }
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { held: "unread" }
  return hostOpens(parsed.hostname, known) ? { destinations: [label(parsed)], outputs: [] } : { held: "host" }
}

const positional = (args: readonly string[]) => args.filter((word) => !word.startsWith("-"))
const valueOf = (args: readonly string[], ...names: string[]) => {
  for (const [index, word] of args.entries()) {
    for (const name of names) {
      if (word === name) return args[index + 1]
      if (word.startsWith(`${name}=`)) return word.slice(name.length + 1)
    }
  }
  return undefined
}

/** npm-family managers whose publish runs the manifest's publish lifecycle scripts (`PUBLISH_HOOKS`). */
export const NODE_PUBLISHERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"])
/**
 * 1.1.1 F39 (G15-1, P54): the programs whose `sendForm` answer is a package publish or a hosted deploy. Such a tool reads
 * its configuration when it runs, so a file written beside it in the same call is judged by the screen (`interferes`).
 */
export const PUBLISH_PROGRAMS: ReadonlySet<string> = new Set([
  ...NODE_PUBLISHERS, "cargo", "poetry", "uv", "twine", "netlify", "firebase", "vercel", "fly", "flyctl",
])
/** The lifecycle scripts a publish of the npm family runs, in order. */
export const PUBLISH_HOOKS = ["prepublish", "prepublishOnly", "prepack", "prepare", "postpack", "publish", "postpublish"]

/**
 * A publish, image push, hosted deploy, pull request or release P42 opens, with its target, or undefined when the step is
 * none of them. `cwd` is where it runs. 1.1.1 F30: `context` gives the project's top folders (where the tool's own
 * configuration is looked for).
 *
 * 1.1.1 F33 (P49 3): a publish or deploy opens by its FORM, not by working out where the tool would send it. A publish
 * opens only as the plain subcommand, run in the project's top folder beside its root manifest, with options from a short
 * list per tool (`PUBLISH_FORMS`), no word naming a folder, tarball, package, workspace or filter, no option naming a
 * configuration file, registry, index or repository in any spelling (`Risk.abbreviates`), and no registry setting found in
 * the configuration the tool reads (`registrySet`): any such setting, or one that cannot be read, holds it. It is
 * recorded as going to the tool's default registry. Its hooks are screened by the caller (`bypass-screen.ts`).
 *
 * 1.1.1 F36 (P52): the tool's registry configuration is not parsed any more. A publish holds when any configuration file
 * the tool could take a registry from is there at all, or any of its environment variables is set (`registrySet`). One
 * classify reads each form once (`Reach.classifyMemo`, G14-P1).
 */
export function sendForm(name: string, args: readonly string[], cwd: string, context: FormContext = {}): Reading | undefined {
  const top = topOf(cwd, context)
  const found = Reach.classifyMemo(["sendForm", name, cwd, top, ...args].join("\0"), () => formReading(name, args, cwd, top))
  if (!found || "held" in found) return found && { ...found }
  return { destinations: [...found.destinations], outputs: [...found.outputs] }
}

/** For tests (1.1.1 F36, G14-P1): how many times a publish's registry configuration has been looked for. */
export const formCounters = { settings: 0 }

function formReading(name: string, args: readonly string[], cwd: string, top: string): Reading | undefined {
  const words = positional(args)
  const one = (destination: string): Reading => ({ destinations: [destination], outputs: [] })
  if (NODE_PUBLISHERS.has(name)) {
    const berry = name === "yarn" && words[0] === "npm" && words[1] === "publish"
    if (words[0] !== "publish" && !berry) return undefined
    const lead = berry ? 2 : 1
    if (args[0] !== words[0] || (berry && args[1] !== "publish")) return { held: "form" }
    if (!formOpens(args.slice(lead), PUBLISH_FORMS[name]!) || !rootManifest(cwd, top, "package.json")) return { held: "form" }
    return registrySet(name as Publisher, cwd) || !linksInside(cwd, top) ? { held: "form" } : one("registry.npmjs.org")
  }
  if (name === "cargo" && words[0] === "publish") {
    if (args[0] !== "publish" || !formOpens(args.slice(1), PUBLISH_FORMS.cargo!) || !rootManifest(cwd, top, "Cargo.toml"))
      return { held: "form" }
    return registrySet("cargo", cwd) || !linksInside(cwd, top) ? { held: "form" } : one("crates.io")
  }
  if ((name === "poetry" || name === "uv") && words[0] === "publish") {
    if (args[0] !== "publish" || !formOpens(args.slice(1), PUBLISH_FORMS[name]!) || !rootManifest(cwd, top, "pyproject.toml"))
      return { held: "form" }
    // 1.1.1 F36 (CR14-7): uv and poetry upload what `dist` holds; every entry must land inside once links are followed.
    if (!distInside(cwd, top)) return { held: "form" }
    return registrySet(name, cwd) || !linksInside(cwd, top) ? { held: "form" } : one("pypi.org")
  }
  if (name === "twine" && words[0] === "upload") {
    // Only `twine upload dist/<files>`, every word a file below the project's `dist` folder, and no option at all.
    const files = args.slice(1)
    if (args[0] !== "upload" || files.length === 0) return { held: "form" }
    if (!files.every((word) => /^dist\/[^/]+$/.test(word) && !word.startsWith("dist/.."))) return { held: "form" }
    if (!landsWithin("dist", cwd, top)) return { held: "form" }
    // 1.1.1 F36 (CR14-7): each file judged where it lands; a pattern (twine expands one itself) by every entry of `dist`.
    if (!files.every((word) => (/[*?[]/.test(word) ? distInside(cwd, top) : landsWithin(word, cwd, top)))) return { held: "form" }
    return registrySet("twine", cwd) || !linksInside(cwd, top) ? { held: "form" } : one("pypi.org")
  }
  if (name === "docker" || name === "podman") {
    const text = words.join(" ")
    const image = /^push (\S+)$/.exec(text)?.[1] ?? /^image push (\S+)$/.exec(text)?.[1]
    if (!/^(image )?push\b/.test(text)) return undefined
    return image ? one(image) : { held: "form" }
  }
  if (name === "vercel") {
    if (words.length === 0 || (words[0] === "deploy" && words.length <= 2)) return one("vercel")
    return undefined
  }
  if (name === "netlify" && words[0] === "deploy") return netlifyOpens(args, cwd, top) ? one("netlify") : { held: "form" }
  if (name === "firebase" && words[0] === "deploy") return firebaseOpens(args, cwd, top) ? one(`firebase${projectOf(args)}`) : { held: "form" }
  if ((name === "fly" || name === "flyctl") && words[0] === "deploy") return one("fly.io")
  if (name === "gh" && words[0] === "pr" && words[1] === "create")
    return args.some((word) => word === "-F" || word.startsWith("--body-file")) ? { held: "upload" } : one(ghTarget(args, "pr"))
  if (name === "gh" && words[0] === "release" && words[1] === "create") {
    // Assets after the tag, or notes read from a file, send files from disk.
    const values = new Set(["-t", "--title", "-n", "--notes", "--target", "-R", "--repo", "--discussion-category"])
    const rest: string[] = []
    for (let index = 2; index < args.length; index++) {
      const word = args[index]!
      if (values.has(word)) index++
      else if (!word.startsWith("-")) rest.push(word)
    }
    if (args.some((word) => word === "-F" || word.startsWith("--notes-file")) || rest.length > 1) return { held: "upload" }
    return one(ghTarget(args, "release"))
  }
  return undefined
}

const projectOf = (args: readonly string[]) => {
  const project = valueOf(args, "--project", "-P")
  return project ? ` ${project}` : ""
}
const ghTarget = (args: readonly string[], what: string) => {
  const repo = valueOf(args, "-R", "--repo")
  return repo ? `github ${repo} ${what}` : `github ${what}`
}

/** The project's top folder for `cwd` (its worktree, or its folder without Git), or `cwd` when none is given. */
function topOf(cwd: string, context: FormContext) {
  const instance = context.instance
  if (!instance) return cwd
  const worktree = instance.worktree === "/" ? instance.directory : instance.worktree
  return within(cwd, worktree) ? worktree : within(cwd, instance.directory) ? instance.directory : cwd
}
const within = (file: string, root: string) => {
  const relative = path.relative(root, file)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
/** `cwd` and every folder above it up to `top`, nearest first. */
function upTo(cwd: string, top: string) {
  const found: string[] = []
  for (let at = cwd; ; at = path.dirname(at)) {
    found.push(at)
    if (at === top || path.dirname(at) === at || !within(at, top)) break
  }
  return found
}
/** `cwd` and every folder above it up to `/`, nearest first. */
function upToRoot(cwd: string) {
  const found: string[] = []
  for (let at = path.resolve(cwd); ; at = path.dirname(at)) {
    found.push(at)
    if (path.dirname(at) === at) return found
  }
}
const MAX_CONFIG = 1024 * 1024
/** A configuration file's text: undefined when it is not there; null when it is there but cannot be read (held). */
function readConfig(file: string): string | undefined | null {
  try {
    const info = fs.statSync(file, { throwIfNoEntry: false })
    if (!info) return undefined
    if (!info.isFile() || info.size > MAX_CONFIG) return null
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}
const home = () => process.env.HOME || os.homedir()

/**
 * 1.1.1 F33 (P49 3): the options each publisher opens with. Each is a long option written out in full; a value is a plain
 * word (`next`, `public`, `123456`). Anything else holds: a short option, a word that is no option (a folder, a tarball, a
 * package spec), `--`, and every option not listed here.
 */
type Form = { readonly flags: ReadonlySet<string>; readonly values: ReadonlySet<string> }
const NPM_FORM: Form = { flags: new Set(["--dry-run", "--provenance"]), values: new Set(["--access", "--tag", "--otp"]) }
const PUBLISH_FORMS: Readonly<Record<string, Form>> = {
  npm: NPM_FORM,
  pnpm: { flags: new Set([...NPM_FORM.flags, "--no-git-checks"]), values: NPM_FORM.values },
  yarn: { flags: new Set([...NPM_FORM.flags, "--tolerate-republish"]), values: NPM_FORM.values },
  bun: { flags: new Set(["--dry-run"]), values: NPM_FORM.values },
  cargo: { flags: new Set(["--dry-run", "--allow-dirty", "--no-verify", "--locked"]), values: new Set() },
  poetry: { flags: new Set(["--dry-run", "--build"]), values: new Set() },
  uv: { flags: new Set(["--dry-run"]), values: new Set() },
}
/**
 * Options that move a publish to another registry, configuration, folder or package. Never in any form; also caught when
 * shortened, as npm and Python's option parsers take an unambiguous prefix (`--reg`, `--userc`).
 */
const PUBLISH_FORBIDDEN = [
  "--registry", "--userconfig", "--globalconfig", "--config", "--config-file", "--index", "--index-url", "--publish-url",
  "--repository", "--repository-url", "--workspace", "--workspaces", "--recursive", "--filter", "--package",
  "--manifest-path", "--directory", "--dir", "--prefix", "--cwd",
]
const PLAIN_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function formOpens(words: readonly string[], form: Form) {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    if (!word.startsWith("--") || word === "--" || Risk.abbreviates(word, PUBLISH_FORBIDDEN)) return false
    const at = word.indexOf("=")
    const name = at < 0 ? word : word.slice(0, at)
    if (at < 0 && form.flags.has(name)) continue
    if (!form.values.has(name)) return false
    const value = at < 0 ? words[++index] : word.slice(at + 1)
    if (value === undefined || !PLAIN_VALUE.test(value)) return false
  }
  return true
}

/** The step runs in the project's top folder, and the tool's manifest is a file there. */
function rootManifest(cwd: string, top: string, manifest: string) {
  const here = path.resolve(cwd)
  if (here !== path.resolve(top) && Reach.real(here) !== Reach.real(path.resolve(top))) return false
  return fs.statSync(path.join(here, manifest), { throwIfNoEntry: false })?.isFile() === true
}

/** Some server environment variable's name matches; its value is never read. */
const environment = (pattern: RegExp) => Object.keys(process.env).some((key) => pattern.test(key))

/**
 * 1.1.1 F38 (D-F36-3, P52 refined): the npm family's environment holds only where it can move a publish. A variable
 * with `registry` in its name (`npm_config_registry`, `npm_config_@corp:registry`, any case), or one that points npm at
 * another config file or prefix, when that file is there (`npm run` sets these to the user's and the global npmrc, so a
 * publish from an npm script holds exactly when those files exist). A pointer that is not an absolute path holds, as
 * npm resolves `~` and relative paths itself. `npm_config_cache` and the other settings npm exports do not hold.
 */
const NPM_REGISTRY_ENV = /^(npm|pnpm)_config_.*registry/i
// 1.1.1 F39 (n82): the variable spellings of `--workspace` / `--workspaces`, which `PUBLISH_FORBIDDEN` refuses as options.
const NPM_WORKSPACE_ENV = /^(npm|pnpm)_config_(workspace|workspaces|include[-_]workspace[-_]root)$/i
const NPM_FILE_ENV = /^(npm|pnpm)_config_(userconfig|globalconfig)$/i
const NPM_PREFIX_ENV = /^(npm|pnpm)_config_(prefix|global_prefix|local_prefix|global-prefix|local-prefix)$/i
function npmEnvironment() {
  for (const [key, value] of Object.entries(process.env)) {
    if (NPM_REGISTRY_ENV.test(key) || NPM_WORKSPACE_ENV.test(key)) return true
    const file = NPM_FILE_ENV.test(key)
    if (!file && !NPM_PREFIX_ENV.test(key)) continue
    if (!value) continue
    if (!path.isAbsolute(value)) return true
    const places = file ? [value] : [path.join(value, "etc", "npmrc"), path.join(value, ".npmrc")]
    // 1.1.1 F39 (V15-1): the file a pointer names is an npmrc, judged by its lines as the user's and the global one are.
    if (places.some(npmrcHolds)) return true
  }
  return false
}

type Publisher = "npm" | "pnpm" | "yarn" | "bun" | "cargo" | "poetry" | "uv" | "twine"

/**
 * 1.1.1 F36 (P52, G14-1..G14-5, CR14-1, CR14-4, CR14-8): fail-closed by presence. A publish keeps its 1.1.0 verdict when
 * the server's environment sets any variable the tool takes a registry from, when any configuration file the tool could
 * take one from exists (in the folder the step runs in or any folder above it, or in the user's and the system's config
 * locations), or when its root manifest is not plain (`RegistryRule.manifest`). No file is parsed for its registry but an
 * `.npmrc`, whose lines must each be one of a short list (`npmrcHolds`, V15-1, P54). Three rounds
 * of reading these formats as the tools do left spellings the tools decode and a reader did not (P52).
 */
function registrySet(tool: Publisher, cwd: string) {
  formCounters.settings++
  const rule = REGISTRY_RULES[tool]
  if (rule.env()) return true
  const user = userPlaces(cwd)
  const files = [...upToRoot(cwd).flatMap((dir) => rule.project.map((name) => path.join(dir, name))), ...rule.user(user)]
  if (files.some((file) => (NPMRC_NAMES.has(path.basename(file)) ? npmrcHolds(file) : present(file)))) return true
  if (rule.fileOnly?.(user).some(fileThere)) return true
  return !rule.manifest(cwd)
}

/**
 * 1.1.1 F39 (n83): the user's places, and `dir` for a folder variable, as the tool run in `cwd` takes them: a relative
 * value is resolved from the step's folder, as the tool itself resolves it from its working folder.
 */
type Places = { cwd: string; home: string; config: string; dir: (name: string) => string | undefined }
type RegistryRule = {
  /** 1.1.1 F38: a destination-relevant variable is set (names only, but for the npm family's file pointers). */
  readonly env: () => boolean
  /** File names looked for in the step's folder and every folder above it. */
  readonly project: readonly string[]
  readonly user: (places: Places) => string[]
  /** 1.1.1 F39 (G15-3): paths that are a config file only when something other than a folder is there. */
  readonly fileOnly?: (places: Places) => string[]
  /** Whether the root manifest is plain (true for a tool that reads none). */
  readonly manifest: (cwd: string) => boolean
}

const userPlaces = (cwd: string): Places => {
  const dir = (name: string) => {
    const value = process.env[name]
    return value ? path.resolve(cwd, value) : undefined
  }
  const at = path.resolve(cwd, home())
  return { cwd, home: at, config: dir("XDG_CONFIG_HOME") ?? path.join(at, ".config"), dir }
}
/** The user's npmrc and the global ones near the `node`/`npm` on the server's PATH (best effort, D-F33-3). */
const npmUser = (places: Places) => [path.join(places.home, ".npmrc"), ...globalNpmrc()]
// pnpm's global rc: `$XDG_CONFIG_HOME/pnpm/rc`, `~/Library/Preferences/pnpm/rc` (macOS), `%LOCALAPPDATA%/pnpm/config/rc`.
const pnpmUser = (places: Places) => [
  path.join(places.config, "pnpm", "rc"),
  path.join(places.home, ".config", "pnpm", "rc"),
  path.join(places.home, "Library", "Preferences", "pnpm", "rc"),
  path.join(places.dir("LOCALAPPDATA") ?? path.join(places.home, "AppData", "Local"), "pnpm", "config", "rc"),
]
/**
 * 1.1.1 F39 (G15-3): yarn 1's own rc files besides the home and project `.yarnrc` (its `rc.js`, not run offline): the
 * system `/etc/yarn/config` and `/etc/yarnrc`, the user config folder (`$XDG_CONFIG_HOME/yarn`, `~/.config/yarn`, on
 * Windows `%LOCALAPPDATA%/Yarn/config`) and `config` in it, and `~/.yarn/config`. The config folder itself is also where
 * yarn 1 keeps its global packages, so there it counts only as a file (`fileThere`).
 */
const yarnUser = (places: Places) => [
  path.join(places.home, ".yarnrc"),
  path.join(places.home, ".yarnrc.yml"),
  "/etc/yarn/config",
  "/etc/yarnrc",
  path.join(places.config, "yarn", "config"),
  path.join(places.home, ".config", "yarn", "config"),
  path.join(places.home, ".yarn", "config"),
]
const yarnFolders = (places: Places) => [
  path.join(places.config, "yarn"),
  path.join(places.home, ".config", "yarn"),
  path.join(places.dir("LOCALAPPDATA") ?? path.join(places.home, "AppData", "Local"), "Yarn", "config"),
]
const REGISTRY_RULES: Readonly<Record<Publisher, RegistryRule>> = {
  npm: { env: npmEnvironment, project: [".npmrc"], user: npmUser, manifest: (cwd) => packagePlain(cwd) },
  pnpm: {
    env: npmEnvironment,
    project: [".npmrc", "pnpm-workspace.yaml"],
    user: (places) => [...npmUser(places), ...pnpmUser(places)],
    manifest: (cwd) => packagePlain(cwd),
  },
  yarn: {
    // 1.1.1 F39 (G15-3): `yarn_config` names another rc file for yarn 1.
    env: () =>
      npmEnvironment() ||
      environment(/^YARN_(NPM_REGISTRY_SERVER|NPM_SCOPES|NPM_PUBLISH_REGISTRY|REGISTRY|RC_FILENAME|CONFIG)$/i),
    project: [".npmrc", ".yarnrc", ".yarnrc.yml"],
    user: (places) => [...npmUser(places), ...yarnUser(places)],
    fileOnly: yarnFolders,
    manifest: (cwd) => packagePlain(cwd),
  },
  bun: {
    env: () => npmEnvironment() || environment(/^BUN_CONFIG_REGISTRY$/i),
    project: [".npmrc", "bunfig.toml"],
    user: (places) => [...npmUser(places), path.join(places.home, ".bunfig.toml"), path.join(places.config, ".bunfig.toml")],
    manifest: (cwd) => packagePlain(cwd),
  },
  cargo: {
    // 1.1.1 F39 (V15-3): the crates.io token is a credential, not a destination; the credential-provider variables run
    // a program and still hold.
    env: () => Object.keys(process.env).some((key) => /^CARGO_(REGISTR|SOURCE_)/i.test(key) && key !== "CARGO_REGISTRY_TOKEN"),
    project: [path.join(".cargo", "config"), path.join(".cargo", "config.toml")],
    user: (places) => {
      const cargoHome = places.dir("CARGO_HOME") ?? path.join(places.home, ".cargo")
      return [path.join(cargoHome, "config"), path.join(cargoHome, "config.toml")]
    },
    manifest: (cwd) => !aboveHas(cwd, "Cargo.toml") && cargoPlain(cwd),
  },
  uv: {
    // Indexes and publish targets, and the variables that pick another config file or project (UV_CONFIG_FILE,
    // UV_PROJECT, UV_WORKING_DIR): those can bring in a `publish-url` this does not look at. UV_CACHE_DIR and the like do not hold.
    env: () =>
      environment(/^UV_(INDEX.*|DEFAULT_INDEX|EXTRA_INDEX_URL|PUBLISH_URL|PUBLISH_CHECK_URL|PUBLISH_INDEX|CONFIG_FILE|PROJECT|WORKING_DIR|WORKING_DIRECTORY)$/i),
    project: ["uv.toml"],
    user: (places) => [
      path.join(places.config, "uv", "uv.toml"),
      path.join(places.home, ".config", "uv", "uv.toml"),
      ...(process.env.XDG_CONFIG_DIRS || "/etc/xdg")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(path.resolve(places.cwd, dir), "uv", "uv.toml")),
      "/etc/uv/uv.toml",
    ],
    manifest: (cwd) => !aboveHas(cwd, "pyproject.toml") && pyprojectPlain(cwd),
  },
  poetry: {
    env: () => environment(/^POETRY_REPOSITORIES/i),
    project: ["poetry.toml"],
    user: (places) => [
      ...[places.dir("POETRY_CONFIG_DIR")].filter((dir) => dir !== undefined).map((dir) => path.join(dir, "config.toml")),
      path.join(places.config, "pypoetry", "config.toml"),
      path.join(places.home, ".config", "pypoetry", "config.toml"),
      path.join(places.home, "Library", "Application Support", "pypoetry", "config.toml"),
    ],
    manifest: (cwd) => !aboveHas(cwd, "pyproject.toml") && pyprojectPlain(cwd),
  },
  twine: {
    // TWINE_USERNAME / TWINE_PASSWORD do not hold; the repository and the config file twine reads do.
    env: () => environment(/^(TWINE_REPOSITORY.*|TWINE_CONFIG_FILE|PIP_CONFIG_FILE)$/i),
    project: [".pypirc"],
    user: (places) => [
      path.join(places.home, ".pypirc"),
      path.join(places.config, "pip", "pip.conf"),
      path.join(places.home, ".config", "pip", "pip.conf"),
      path.join(places.home, ".pip", "pip.conf"),
      path.join(places.home, "Library", "Application Support", "pip", "pip.conf"),
      ...[places.dir("VIRTUAL_ENV")].filter((dir) => dir !== undefined).map((dir) => path.join(dir, "pip.conf")),
      "/etc/pip.conf",
      "/Library/Application Support/pip/pip.conf",
    ],
    manifest: () => true,
  },
}

/** Something is at `file` (a dangling link too); a file that cannot be looked at counts as there. */
function present(file: string) {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined
  } catch {
    return true
  }
}
/** 1.1.1 F39 (G15-3): something other than a folder is at `file` (a dangling link too); one that cannot be looked at counts. */
function fileThere(file: string) {
  try {
    const info = fs.lstatSync(file, { throwIfNoEntry: false })
    return info !== undefined && !info.isDirectory()
  } catch {
    return true
  }
}

/**
 * 1.1.1 F39 (V15-1, P54): an npmrc (`.npmrc` in the project or a folder above, the user's, a global one, or the file a
 * pointer variable names) holds unless it is a regular file of at most `MAX_CONFIG` bytes whose every line is one of
 * `NPMRC_LINES`. npm's reader splits lines on CR or LF and trims keys and values, takes `[section]`, quotes, `key[]`,
 * `${VAR}` in keys and values and a key with no `=`; none of these matches, so each holds. A link, a folder, a file that
 * cannot be read: held. Absent: nothing to hold.
 */
const NPMRC_NAMES = new Set([".npmrc", "npmrc"])
const NPMRC_NEUTRAL =
  "save-exact|save-prefix|engine-strict|package-lock|fund|audit|legacy-peer-deps|progress|loglevel|auto-install-peers|strict-peer-dependencies"
// 1.1.1 F40 (n89, P56): spaces or tabs around the `=` of an allowed key (npm trims both sides), and the default registry
// spelled out, with or without its trailing slash, as `npm config set registry` writes it.
const NPMRC_LINES = [
  /^[ \t]*\r?$/,
  /^[ \t]*[#;][^\r\n]*\r?$/,
  /^\/\/registry\.npmjs\.org\/:_authToken[ \t]*=[ \t]*(\$\{NPM_TOKEN\}|[A-Za-z0-9_.+\/=-]+)\r?$/,
  /^\/\/registry\.npmjs\.org\/:always-auth[ \t]*=[ \t]*(true|false)\r?$/,
  /^registry[ \t]*=[ \t]*https:\/\/registry\.npmjs\.org\/?\r?$/,
  new RegExp(`^(${NPMRC_NEUTRAL})[ \\t]*=[ \\t]*[A-Za-z0-9._^~-]*\\r?$`),
]
function npmrcHolds(file: string) {
  try {
    const info = fs.lstatSync(file, { throwIfNoEntry: false })
    if (!info) return false
    if (!info.isFile() || info.size > MAX_CONFIG) return true
    return !fs
      .readFileSync(file, "utf8")
      .split("\n")
      .every((line) => NPMRC_LINES.some((allowed) => allowed.test(line)))
  } catch {
    return true
  }
}

/** A file named `name` in a folder above `cwd` (a workspace root the tool may read settings from). */
const aboveHas = (cwd: string, name: string) => upToRoot(cwd).slice(1).some((dir) => present(path.join(dir, name)))

/** The global `npmrc` files near the `node`/`npm` on the server's PATH, and npm's own beside its package folder. */
function globalNpmrc() {
  const binaries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => dir && (fs.existsSync(path.join(dir, "npm")) || fs.existsSync(path.join(dir, "node"))))
  return [
    ...binaries.map((dir) => path.join(path.dirname(dir), "etc", "npmrc")),
    // npm's own `npmrc`, beside its package folder (`<npm>/bin/npm-cli.js`).
    ...binaries.flatMap((dir) => {
      const cli = Reach.real(path.join(dir, "npm"))
      return cli && fs.existsSync(cli) ? [path.join(path.dirname(path.dirname(cli)), "npmrc")] : []
    }),
  ]
}

/**
 * 1.1.1 F36 (P52), F38: the root `package.json` is plain: `JSON.parse` reads it as an object (every npm-family tool
 * decodes the same escapes, so a backslash no longer holds) and its `publishConfig`, if any, is an object with no key.
 * An empty one opens only when it is the only spelling of the key in the text: `JSON.parse` keeps the last of two
 * duplicate keys, and a tool with its own parser might keep the first (D-F38-2).
 */
function packagePlain(cwd: string) {
  const text = readConfig(path.join(cwd, "package.json"))
  if (typeof text !== "string") return false
  const parsed = json(text)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false
  if (!Object.prototype.hasOwnProperty.call(parsed, "publishConfig")) return true
  const config = (parsed as { publishConfig?: unknown }).publishConfig
  if (config === null || typeof config !== "object" || Array.isArray(config) || Object.keys(config).length > 0) return false
  return text.split('"publishConfig"').length === 2 && !text.includes("\\u")
}

// 1.1.1 F36 (P52): words that may name where a publish goes, in any part of a key's path or its value.
const DESTINATION_WORDS = /registr|index|source|repositor|publish|url|credential/i
const inlineTable = (raw: string) => raw.startsWith("{") || (raw.startsWith("[") && raw.includes("{"))
const QUOTE_OR_ESCAPE = /["'\\]/
// 1.1.1 F38 (P52 refined): the Cargo.toml tables a publish's destination or package can be set in.
const CHECKED_TABLES = new Set(["tool", "registries", "registry", "source", "publish", "workspace", "patch", "replace"])
const cargoChecked = (parts: readonly string[]) =>
  CHECKED_TABLES.has(parts[0]!) || (parts[0] === "package" && parts[1] === "metadata")
// 1.1.1 F39 (V15-2, P54): in pyproject.toml only the tables uv and poetry read, `[tool.uv*]` and `[tool.poetry*]`, and
// `tool` itself (a `tool = { uv = … }` written inline).
const pyprojectChecked = (parts: readonly string[]) =>
  parts[0] === "tool" && (parts.length === 1 || parts[1] === "uv" || parts[1] === "poetry")
// The first segment of a key as written, when it is a bare word (`target` in `target.'cfg(unix)'.dependencies`).
const bareFirst = (written: string) => /^([A-Za-z0-9_-]+)\s*(\.|$)/.exec(written)?.[1]

/**
 * 1.1.1 F38 (P52 refined, D-F36-5): a TOML manifest is plain when
 *  (c) it can be read, and the reader walks all of it (so a header inside a multi-line string is never taken for one);
 *  (a) no table header is written with a quote or a backslash, unless its first segment is a bare name of a table that
 *      never moves a publish (`plainFirst`: `[target.'cfg(unix)'.dependencies]`, `[project."optional-dependencies"]`).
 *      An escaped or quoted header could spell a tool or registry table. A key before the first header is judged the
 *      same way, as it names its own table;
 *  (b) no entry in a checked table (`checked`) has a backslash, a quoted key, an inline table, or a destination word in
 *      its path or its value. A header alone counts too.
 * Every other table is not looked into: `[project]`, `[project.urls]`, `[dependencies]` and the rest, whatever their
 * keys and values say. `special` judges an entry first (Cargo's `[package]`, the files a manifest names): true holds,
 * false is plain, undefined leaves it to the rules above.
 */
function tomlPlain(
  text: string | undefined | null,
  plainFirst: ReadonlySet<string>,
  checked: (parts: readonly string[]) => boolean,
  special: (entry: TomlReader.Entry) => boolean | undefined,
) {
  if (typeof text !== "string") return undefined
  const found = TomlReader.entries(text)
  if (!found) return undefined
  let rooted = true
  for (const entry of found) {
    if (entry.table) rooted = false
    if ((entry.table || rooted) && QUOTE_OR_ESCAPE.test(entry.key) && !plainFirst.has(bareFirst(entry.key) ?? "")) return undefined
    const own = special(entry)
    if (own === true) return undefined
    if (own === false || !checked(entry.path)) continue
    if (entry.path.some((part) => DESTINATION_WORDS.test(part))) return undefined
    if (entry.table) continue
    if (QUOTE_OR_ESCAPE.test(entry.key) || entry.raw.includes("\\") || inlineTable(entry.raw) || DESTINATION_WORDS.test(entry.raw))
      return undefined
  }
  return found
}

const PYPROJECT_PLAIN_FIRST = new Set(["project", "build-system", "dependency-groups"])
/**
 * 1.1.1 F36 (P52), F38, F39: the root `pyproject.toml` is plain (`tomlPlain`): `[tool.uv*]` and `[tool.poetry*]` are
 * checked (V15-2); a quoted or escaped key anywhere under `tool` holds; and the files the manifest names land inside the
 * project (`pyprojectFiles`, CR15-1).
 */
function pyprojectPlain(cwd: string) {
  const special = (entry: TomlReader.Entry) =>
    entry.path[0] === "tool" && QUOTE_OR_ESCAPE.test(entry.key) ? true : pyprojectFiles(entry, cwd)
  return tomlPlain(readConfig(path.join(cwd, "pyproject.toml")), PYPROJECT_PLAIN_FIRST, pyprojectChecked, special) !== undefined
}

/**
 * 1.1.1 F39 (CR15-1, P54): the files a Python build carries by name land inside the project once links are followed
 * (`packedInside`): `[project] readme` (a path, or `file` in an inline table), `license = { file = … }`, `license-files`,
 * and `[tool.poetry] readme`, `include` and `exclude` (paths or lists of them). `[tool.poetry] packages` (a list of inline
 * tables) holds. true: held; undefined: the other rules judge the entry.
 */
const POETRY_FILES = new Set(["readme", "include", "exclude", "packages"])
function pyprojectFiles(entry: TomlReader.Entry, cwd: string): boolean | undefined {
  if (entry.table) return undefined
  const [first, second, third] = entry.path
  // 1.1.1 F40 (G16-2): a readme or licence file is a literal path; `license-files`, poetry `include` and `exclude` are globs.
  const inside = (raw: string, form: "glob" | "literal" = "glob") => {
    const words = raw.startsWith("[") ? TomlReader.strings(raw) : [TomlReader.string(raw)]
    return words !== undefined && words.every((word) => word !== undefined && packedInside(word, cwd, form))
  }
  if (first === "project" && (second === "readme" || second === "license")) {
    if (entry.path.length === 3) return third === "file" ? !inside(entry.raw, "literal") || undefined : undefined
    if (entry.path.length !== 2) return true
    if (entry.raw.startsWith("{")) {
      const pairs = TomlReader.table(entry.raw)
      if (!pairs) return true
      return pairs.some((pair) => pair.path.length !== 1 || (pair.path[0] === "file" && !inside(pair.raw, "literal"))) || undefined
    }
    // A license as a plain string is an SPDX expression, not a file.
    return second === "readme" && !inside(entry.raw, "literal") ? true : undefined
  }
  if (first === "project" && second === "license-files") return entry.path.length !== 2 || !inside(entry.raw) || undefined
  if (first === "tool" && second === "poetry" && POETRY_FILES.has(third ?? "")) {
    if (entry.path.length !== 3 || third === "packages") return true
    return !inside(entry.raw, third === "readme" ? "literal" : "glob") || undefined
  }
  return undefined
}

/**
 * 1.1.1 F39 (CR15-1, P54): a file or glob a package is built from lands inside the project. Absolute, `~`, `$`, a
 * backslash or a `..` segment: held. A glob is judged by the folder before its first pattern character; a plain path by
 * where it lands once links are followed (`landsWithin`). `anchored` (Cargo's gitignore-style `include`/`exclude`): a
 * leading `!` and one leading `/` belong to the pattern and name the package's own folder. `literal` (1.1.1 F40, G16-2):
 * a path the tool opens as written (a readme, a licence file), glob characters included.
 */
function packedInside(word: string, cwd: string, form: "glob" | "anchored" | "literal" = "glob") {
  const pattern = form === "anchored" ? word.replace(/^!/, "").replace(/^\//, "") : word
  if (pattern === "" || path.isAbsolute(pattern) || pattern.includes("\\") || Reach.upward(pattern)) return false
  // 1.1.1 F40 (G16-2, P56): a readme or licence file is opened by its name, whatever characters it holds, so it is
  // judged where that name lands once links are followed; only `include`, `exclude` and `license-files` are patterns.
  if (form === "literal") return landsWithin(pattern, cwd, cwd)
  const glob = pattern.search(/[*?[\]{}]/)
  const fixed = glob < 0 ? pattern : pattern.slice(0, pattern.lastIndexOf("/", glob) + 1)
  return fixed === "" || landsWithin(fixed, cwd, cwd)
}

// Cargo.toml tables that never move a publish (dependencies, targets, features, build profiles). A dependency's own
// `registry = "corp"` is not read: it says where the dependency comes from, not where the package goes (D-F38-3).
const CARGO_PLAIN_TABLES = new Set([
  "dependencies", "dev-dependencies", "build-dependencies", "target", "features", "lib", "bin", "example", "test", "bench",
  "profile", "lints", "badges",
])
// 1.1.1 F39 (CR15-1): the `[package]` keys that name files cargo packs.
const CARGO_FILES = new Set(["readme", "license-file", "include", "exclude"])

/**
 * 1.1.1 F38: Cargo's `[package]`. `publish` holds unless it is the plain `publish = true` (a list names the registries
 * it may go to); a quoted key holds (it may spell `publish`); `package.metadata` is a checked table; a key with a
 * destination word in its name holds but for `repository`, which is plain metadata like name, version, description,
 * license and authors. 1.1.1 F39 (CR15-1, P54): `readme` (or `true`/`false`), `license-file`, and each pattern of
 * `include` and `exclude` lands inside the project (`packedInside`); any other form of these keys holds. Other values
 * in `[package]` are prose and URLs and are not looked into.
 */
function cargoPackage(entry: TomlReader.Entry, cwd: string): boolean | undefined {
  if (entry.path[0] !== "package") return false
  if (entry.path[1] === "metadata") return undefined
  if (entry.table) return entry.path.length > 1 && entry.path.slice(1).some((part) => DESTINATION_WORDS.test(part))
  // The whole package written inline (`package = { … }`).
  if (entry.path.length === 1) return true
  if (QUOTE_OR_ESCAPE.test(entry.key)) return true
  if (entry.path[1] === "publish") return !(entry.path.length === 2 && entry.raw === "true")
  if (CARGO_FILES.has(entry.path[1]!)) {
    if (entry.path.length !== 2) return true
    if (entry.path[1] === "readme" && (entry.raw === "true" || entry.raw === "false")) return false
    const list = entry.path[1] === "include" || entry.path[1] === "exclude"
    const words = list ? TomlReader.strings(entry.raw) : [TomlReader.string(entry.raw)]
    return words === undefined || !words.every((word) => word !== undefined && packedInside(word, cwd, list ? "anchored" : "literal"))
  }
  if (entry.path.length === 2 && entry.path[1] === "repository") return false
  return entry.path.slice(1).some((part) => DESTINATION_WORDS.test(part))
}

/**
 * 1.1.1 F36 (P52), F38: the root `Cargo.toml` is plain (`tomlPlain`, `cargoPackage`) with a `[package]` key and no
 * `[workspace]` (an empty one too, G14-7).
 */
function cargoPlain(cwd: string) {
  const found = tomlPlain(readConfig(path.join(cwd, "Cargo.toml")), CARGO_PLAIN_TABLES, cargoChecked, (entry) =>
    entry.path[0] === "package" ? cargoPackage(entry, cwd) : CARGO_PLAIN_TABLES.has(entry.path[0]!) ? false : undefined,
  )
  if (!found || !found.some((entry) => entry.path[0] === "package" && !entry.table && entry.path.length > 1)) return false
  return !found.some((entry) => entry.path[0] === "workspace")
}

/**
 * 1.1.1 F39 (CR15-2, P54): every link git tracks under the package folder lands inside the project once followed
 * (`Reach.trackedLinks`, one `git ls-files -s` per classify). No Git, or a folder outside any repository: nothing is
 * listed, and the earlier checks alone decide, as before (untracked links are not listed: an agent step cannot make one,
 * since every link-making form is held). Git failing in a repository: held.
 */
function linksInside(cwd: string, top: string) {
  const links = Reach.trackedLinks(cwd)
  if (links === null) return false
  return links.every((link) => landsWithin(link, cwd, top))
}

/**
 * 1.1.1 F36 (CR14-7): `dist` lands inside the project and so does each of its entries once links are followed. No
 * `dist` at all: nothing is uploaded (G14-6). More entries than `MAX_DIST`, or a `dist` that cannot be listed: held.
 */
const MAX_DIST = 1000
function distInside(cwd: string, top: string) {
  if (!landsWithin("dist", cwd, top)) return false
  const names = (() => {
    try {
      return fs.readdirSync(path.join(cwd, "dist"))
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined
    }
  })()
  if (!names || names.length > MAX_DIST) return false
  return names.every((name) => landsWithin(`dist/${name}`, cwd, top))
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 1.1.1 F30 (G12-6, CR12-4), F33 (P49 3): `firebase deploy` opens only as `firebase deploy --only hosting` (or
 * `hosting:<site>`, a comma list of those), with options this knows. Its configuration is the file `-c`/`--config` names,
 * else the first `firebase.json` from the folder upward, as the firebase CLI finds it; it must be inside the project,
 * parse as JSON, name no `predeploy`/`postdeploy` hook anywhere, no `functions` or `remoteconfig` section, and no
 * hosting `source` or `frameworksBackend` (a web framework the CLI builds and deploys server code for), and every folder
 * it names (`public`, `rules`, `indexes`) lands inside the project once links are followed. No configuration found: nothing is deployed by it.
 */
const FIREBASE_VALUES = new Set(["--only", "-P", "--project", "-m", "--message", "-c", "--config"])
const FIREBASE_FLAGS = new Set(["--non-interactive", "--json", "--debug"])
const FIREBASE_HOSTING = /^hosting(:[A-Za-z0-9_-]+)?(,hosting(:[A-Za-z0-9_-]+)?)*$/
function firebaseOpens(args: readonly string[], cwd: string, top: string) {
  let config: string | undefined
  const only: string[] = []
  for (let index = 1; index < args.length; index++) {
    const word = args[index]!
    if (!word.startsWith("-")) return false
    const at = word.indexOf("=")
    const name = at < 0 ? word : word.slice(0, at)
    if (FIREBASE_FLAGS.has(name) && at < 0) continue
    if (!FIREBASE_VALUES.has(name)) return false
    const value = at < 0 ? args[++index] : word.slice(at + 1)
    if (value === undefined) return false
    if (name === "-c" || name === "--config") config = value
    if (name === "--only") only.push(value)
  }
  if (only.length !== 1 || !FIREBASE_HOSTING.test(only[0]!)) return false
  let file: string | undefined
  if (config !== undefined) file = path.resolve(cwd, config)
  else
    for (let at = cwd; ; at = path.dirname(at)) {
      if (fs.existsSync(path.join(at, "firebase.json"))) {
        file = path.join(at, "firebase.json")
        break
      }
      if (path.dirname(at) === at) break
    }
  if (file === undefined) return true
  if (!within(file, top)) return false
  const real = realOf(file)
  if (real === undefined || !within(real, realOf(top) ?? top)) return false
  const text = readConfig(file)
  if (typeof text !== "string") return false
  const parsed = json(text)
  if (parsed === null || typeof parsed !== "object") return false
  if (["functions", "remoteconfig"].some((key) => Object.hasOwn(parsed, key))) return false
  const hosting = (parsed as { hosting?: unknown }).hosting
  const sites = Array.isArray(hosting) ? hosting : [hosting]
  if (sites.some((site) => site !== null && typeof site === "object" && ["source", "frameworksBackend"].some((key) => Object.hasOwn(site, key))))
    return false
  let ok = true
  const folder = path.dirname(file)
  const walk = (value: unknown) => {
    if (!ok || value === null || typeof value !== "object") return
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "predeploy" || key === "postdeploy") ok = false
      else if (FIREBASE_PLACES.has(key) && typeof item === "string" && !landsWithin(item, folder, top)) ok = false
      walk(item)
    }
  }
  walk(parsed)
  return ok
}
const FIREBASE_PLACES = new Set(["public", "rules", "indexes"])

/**
 * 1.1.1 F30 (G12-5), F33 (P49 3, CR13-4, G13-5): `netlify deploy` opens only with `--no-build` (netlify-cli builds before
 * a deploy otherwise, running the build command unscreened) and a `--dir` that lands inside the project, with options
 * this knows. 1.1.1 F36 (P52, CR14-2), F39 (V15-1): every `netlify.toml` from the folder up to the project's top is plain
 * (`netlifyPlain`). 1.1.1 F39 (G15-2): no other netlify config file (`NETLIFY_OTHER`) is there in any of those folders.
 * 1.1.1 F40 (CR16-3): nor a default functions folder (`NETLIFY_FUNCTIONS`).
 */
const NETLIFY_FLAGS = new Set(["--no-build", "--prod", "--json"])
const NETLIFY_VALUES = new Set(["--dir", "-d", "--message", "-m"])
const NETLIFY_OTHER = ["netlify.yml", "netlify.yaml", "netlify.json"]
// 1.1.1 F40 (CR16-3, P56): netlify-cli's default functions folders. A deploy bundles what is there, and its bundlers
// follow imports to any file on the disk, `--no-build` or not, so anything at either name holds.
const NETLIFY_FUNCTIONS = ["netlify/functions", "netlify/edge-functions"]
function netlifyOpens(args: readonly string[], cwd: string, top: string) {
  let dir: string | undefined
  let noBuild = false
  for (let index = 1; index < args.length; index++) {
    const word = args[index]!
    if (!word.startsWith("-")) return false
    const at = word.startsWith("--") ? word.indexOf("=") : -1
    const name = at < 0 ? word : word.slice(0, at)
    if (at < 0 && NETLIFY_FLAGS.has(name)) {
      if (name === "--no-build") noBuild = true
      continue
    }
    if (!NETLIFY_VALUES.has(name)) return false
    const value = at < 0 ? args[++index] : word.slice(at + 1)
    if (value === undefined || value === "") return false
    if (name === "--dir" || name === "-d") {
      if (dir !== undefined) return false
      dir = value
    }
  }
  if (!noBuild || dir === undefined || !landsWithin(dir, cwd, top)) return false
  return upTo(cwd, top).every((folder) => {
    if ([...NETLIFY_OTHER, ...NETLIFY_FUNCTIONS].some((name) => present(path.join(folder, name)))) return false
    const text = readConfig(path.join(folder, "netlify.toml"))
    return text === undefined || netlifyPlain(text, folder, top)
  })
}

/**
 * 1.1.1 F39 (V15-1, P54; was F36 CR14-2): a `netlify.toml` with no backslash and only these tables, each header bare:
 *  - `[build]`, once, with `command` (not run: the deploy has `--no-build`) and `publish` (a folder that lands inside
 *    the project) and no other key;
 *  - `[[redirects]]` and `[[headers]]`, and a `[headers.values]` right after a `[[headers]]`.
 * Every key in them is bare and one segment below its table, and every value one plain line: a one-line string, a whole
 * number, `true` or `false`. A key before the first table, an inline table, an array, a multi-line string, any other
 * table (`[build.environment]`, `[context.*]`, `[functions]`, `[[plugins]]`, `[dev]`), or a file the reader cannot walk:
 * held.
 */
const NETLIFY_TABLES: Readonly<Record<string, boolean>> = { build: false, redirects: true, headers: true, "headers.values": false }
const netlifyValue = (raw: string) => /^(true|false|[0-9]+)$/.test(raw) || TomlReader.string(raw) !== undefined
function netlifyPlain(text: string | null, folder: string, top: string) {
  if (text === null || text.includes("\\")) return false
  const found = TomlReader.entries(text)
  if (!found) return false
  let table: string | undefined
  let builds = 0
  for (const entry of found) {
    if (QUOTE_OR_ESCAPE.test(entry.key)) return false
    if (entry.table) {
      const name = entry.path.join(".")
      if (!Object.hasOwn(NETLIFY_TABLES, name) || NETLIFY_TABLES[name] !== entry.array) return false
      if (name === "headers.values" && table !== "headers") return false
      if (name === "build" && ++builds > 1) return false
      table = name
      continue
    }
    if (table === undefined || entry.path.length !== table.split(".").length + 1 || !netlifyValue(entry.raw)) return false
    if (table !== "build") continue
    const key = entry.path[1]
    if (key !== "publish" && key !== "command") return false
    const value = TomlReader.string(entry.raw)
    if (key === "publish" && (value === undefined || !landsWithin(value, folder, top))) return false
  }
  return true
}

const realOf = (file: string) => Reach.real(file)
/** `word` from `folder` lands inside `top` by its name and, once links are followed (`Reach.physical`), where it lands. */
function landsWithin(word: string, folder: string, top: string) {
  if (word.startsWith("~") || word.includes("$")) return false
  if (!within(path.resolve(folder, word), top)) return false
  const landing = Reach.physical(word, folder)
  return landing !== undefined && (within(landing, realOf(top) ?? top) || within(landing, top))
}

// 1.1.1 F30 (G12-9): `--all` and `--branches` push every branch without force, as P42 lets a push to a known remote.
const PUSH_FLAGS = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--tags", "--follow-tags", "--no-verify", "--atomic", "-n", "--dry-run", "--porcelain", "--progress", "--no-progress", "--all", "--branches"])
const PUSH_OPTION_VALUE = /^[\w.,:=@/+-]+$/
/** A plain git ref or remote name. 1.1.1 F30 (n63): one copy, which `autonomy-table.ts` reads too. */
export const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/**
 * The remote of `git push [<flags>] [<remote> [<ref>[:<ref>]...]]` with no force, mirror, delete, `--repo`, URL or
 * option this does not know; `""` when no remote is named (the caller picks the repository's only remote). undefined:
 * not such a push. The irreversible forms are refused by the screen before this is asked. These flags are wider than the
 * 1.1.0 push reader's (`autonomy-table.ts`) on purpose: 1.1.0 is unchanged, P42 opens more.
 */
export function pushWords(argv: readonly string[]): string | undefined {
  if (argv[0] !== "git" || argv[1] !== "push") return undefined
  // 1.1.1 F30 (G12-9): a push option (`-o`, `--push-option`) is text for the server's hooks; its value is plain.
  const words: string[] = []
  for (let index = 2; index < argv.length; index++) {
    const word = argv[index]!
    if (word === "-o" || word === "--push-option") {
      if (!PUSH_OPTION_VALUE.test(argv[++index] ?? "")) return undefined
      continue
    }
    if (word.startsWith("--push-option=")) {
      if (!PUSH_OPTION_VALUE.test(word.slice("--push-option=".length))) return undefined
      continue
    }
    words.push(word)
  }
  if (words.some((word) => word.startsWith("-") && !PUSH_FLAGS.has(word))) return undefined
  const [remote, ...refs] = words.filter((word) => !word.startsWith("-"))
  if (remote === undefined) return ""
  if (!REF.test(remote) || remote.includes("..")) return undefined
  const plain = (ref: string) => {
    const parts = ref.split(":")
    return parts.length <= 2 && parts.every((part) => REF.test(part) && !part.includes(".."))
  }
  return refs.every(plain) ? remote : undefined
}

const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec"])

/**
 * 1.1.1 F30 (G12-7): the repository words of a `git push` step (`--repo` values and the first word after the options),
 * or undefined when the step is no `git push`. `[]`: no repository named.
 */
export function pushRepositories(argv: readonly string[]): string[] | undefined {
  if (argv[0] !== "git" || argv[1] !== "push") return undefined
  const args = argv.slice(2)
  // git takes `--repo` by any unambiguous shortening (`--rep`).
  const isRepo = (word: string) => /^--repo?(=|$)/.test(word)
  const found: string[] = []
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (word === "--") {
      if (args[index + 1] !== undefined) found.push(args[index + 1]!)
      break
    }
    if (isRepo(word)) {
      found.push(word.includes("=") ? word.slice(word.indexOf("=") + 1) : (args[++index] ?? ""))
      continue
    }
    if (PUSH_VALUE_OPTIONS.has(word)) {
      index++
      continue
    }
    if (word.startsWith("-")) continue
    found.push(word)
    break
  }
  return found
}

/** 1.1.1 F30 (G12-7): a repository word that is a place, not a remote name: a URL, `host:path`, or a path to a folder. */
export function pushPlace(word: string) {
  return (
    word === "" ||
    word.includes("://") ||
    /^[^/:\s]+@[^:\s]+:/.test(word) ||
    /^[A-Za-z0-9.-]+:/.test(word) ||
    word.includes("/") ||
    word.startsWith(".") ||
    word.startsWith("~") ||
    !REF.test(word)
  )
}

export * as OutwardConsent from "./outward-consent"
